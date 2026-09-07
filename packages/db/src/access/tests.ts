import { ensureProjectPersonaOn } from "./project-personas.ts";
import { isId, newId } from "@egma/ids";
import {
  and,
  asc,
  desc,
  eq,
  inArray,
  isNull,
  lt,
  type SQL,
} from "drizzle-orm";

import { db, type Queryable, type Transaction } from "../client.ts";
import { persona } from "../schema/personas.ts";
import {
  test,
  testPersona,
  testSuite,
  testVersion,
} from "../schema/tests.ts";
import type { AuthContext } from "./context.ts";
import {
  IdentityConflictError,
  ProjectOutsideOrganizationError,
  TestMovedOnError,
  UnprocessableInputError,
  type TestNamingPersona,
} from "./errors.ts";
import { pageOf, pageWindow, type PageRequest } from "./pages.ts";
import { personaAvailableToProject } from "./persona-availability.ts";
import { authorize, here } from "./permissions.ts";
import { lockRepositoryProject } from "./repository-lock.ts";
import { isProjectOfOrganization } from "./projects.ts";
import { within } from "./within.ts";

/**
 * Project-scoped test authoring and version reads. Create requires an acting
 * project; organization-scoped reads and edits use each row's project.
 * Tests require a scenario, expected behaviors, and personas. Mock tools and
 * environment are versioned content. Applicable project graders are resolved
 * separately from their scopes.
 */

/**
 * One expected behavior as a plain sentence. The expected-behaviors grader treats
 * it as an assertion, keyed by list position, within one grade for the trace.
 */
export type ExpectedBehavior = string;

/**
 * A test-owned, versioned mock tool matched by name. It returns an authored value
 * or raises an authored error. Keep answer and error as separate variants so
 * null remains a valid answer.
 */
export type TestMockTool =
  | { tool: string; answer: unknown }
  | { tool: string; error: string };

/**
 * Agent platform environment for this test: Retell dynamic variables and LiveKit
 * job dispatch metadata. Preserve the platform field names in the contract.
 */
export type TestEnv = {
  retell_dynamic_variables?: Record<string, string>;
  job_dispatch_metadata?: Record<string, unknown>;
};

/**
 * Maximum UTF-8 bytes of the tagged RPC reply: {"answer":…} or {"error":…}.
 * Validate at authoring time against the transport limit; seam fixtures keep
 * this value aligned with the simulator.
 */
export const LARGEST_MOCK_TOOL_ANSWER_BYTES = 15 * 1024;

/**
 * How large the dispatch metadata may be, in bytes.
 *
 * LiveKit accepts 512 KiB in any one metadata field, and egma writes the string
 * onto the dispatch verbatim, so this gate is exactly LiveKit's own. Measured
 * on the UTF-8 bytes of `serializedJobDispatchMetadata`, which is the one string
 * egma will actually send — measuring anything else here would admit a value
 * the dispatch then refuses, on a run that has already started.
 */
export const LARGEST_JOB_DISPATCH_METADATA_BYTES = 512 * 1024;

/**
 * The prefix egma keeps for itself among the dynamic variables.
 *
 * Egma writes its own variables into every mocked conversation — the run and
 * the simulation a tool call belongs to, among them — so a test that could
 * author one would be a test able to rewrite the identifiers its own record is
 * filed under. Refused at authoring time, where the person who can rename it is
 * reading.
 */
export const RESERVED_ENV_VARIABLE_PREFIX = "egma_";

/**
 * Serialize LiveKit dispatch metadata identically at save and dispatch.
 * Measure the UTF-8 bytes of this string for the size limit.
 */
export function serializedJobDispatchMetadata(
  value: Record<string, unknown>,
): string {
  const written = JSON.stringify(value);
  if (written === undefined) {
    throw new UnprocessableInputError(
      "env.job_dispatch_metadata has to be something Egma can serialize and " +
        "hand to LiveKit, and this one is not.",
    );
  }
  return written;
}

/**
 * Immutable test content: scenario, ordered expected behaviors, mock tools, and
 * environment. Personas are versioned in their join table. Identity fields remain
 * on the test; the public create/read shapes expose content fields directly.
 */
type TestContent = {
  readonly scenario: string;
  readonly expectedBehaviors: readonly ExpectedBehavior[];
  readonly mockTools: readonly TestMockTool[];
  readonly env: TestEnv | null;
};

export type NewTest = {
  readonly suiteId: string;
  readonly name: string;
  readonly description?: string | undefined;
  readonly scenario: string;
  readonly expectedBehaviors: readonly ExpectedBehavior[];
  /**
   * Personas that conduct this test. The list must contain at least one ID;
   * no project default is substituted.
   */
  readonly personaIds?: readonly string[] | undefined;
  /**
   * The tools this scenario answers for itself. Naming none is the ordinary
   * case: a test that mocks nothing reaches the agent's real tools.
   */
  readonly mockTools?: readonly TestMockTool[] | undefined;
  /**
   * The world outside the conversation this scenario asks for. Absent and
   * `null` both mean it asks for none.
   */
  readonly env?: TestEnv | null | undefined;
};

/**
 * A persona as a test names them: by identity, with their current name, and
 * saying plainly whether they have since been archived. A read that hid that
 * would show a test whose simulations cannot all run and give no sign.
 */
export type TestPersona = {
  readonly id: string;
  readonly name: string;
  /** Set once they are archived; the test goes on naming them either way. */
  readonly archivedAt: Date | null;
};

/** One test identity, its immutable suite membership, and its current version. */
export type Test = {
  readonly id: string;
  readonly projectId: string;
  readonly suiteId: string;
  readonly name: string;
  readonly description: string | null;
  readonly version: number;
  /** The current version's own `tstv_` id — what a run pins. */
  readonly versionId: string;
  readonly scenario: string;
  readonly expectedBehaviors: readonly ExpectedBehavior[];
  /** In the order they were authored. */
  readonly personas: readonly TestPersona[];
  /** The tools this scenario answers for itself; usually none. */
  readonly mockTools: readonly TestMockTool[];
  /** The world outside the conversation; null when it asks for none. */
  readonly env: TestEnv | null;
  /**
   * The opaque token an identity write or a lifecycle change has to name. It
   * changes on every one of them and means nothing on its own.
   */
  readonly revision: string;
  /** When it was permanently removed from authoring, or null while active. */
  readonly deletedAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
};

/**
 * What an edit may touch. Name and description are identity and version
 * nothing; the scenario, the expected behaviors and the personas are what the
 * test checks, and version on any change. Absent means keep.
 */
export type TestChanges = {
  readonly name?: string;
  readonly description?: string | null;
  readonly scenario?: string;
  readonly expectedBehaviors?: readonly ExpectedBehavior[];
  /**
   * Replace the next version's persona list. Reject an empty list; omit to keep
   * the current selection. No default persona is inserted.
   */
  readonly personaIds?: readonly string[];
  /**
   * The tools the next version should answer for itself.
   *
   * An empty list means here what it means on a create — mock nothing — because
   * mocking nothing is a state a test can be in and is the one most tests are
   * in. So `[]` clears the mock tools, and leaving the field out keeps them.
   */
  readonly mockTools?: readonly TestMockTool[];
  /**
   * The world the next version should ask for.
   *
   * `null` clears it, for the same reason `[]` clears the mock tools: asking
   * for nothing is a state a test can be in. Leaving the field out keeps what
   * the current version asks for.
   */
  readonly env?: TestEnv | null;
  /**
   * Required for content edits and optional for identity-only edits. Compare under
   * the test lock and reject a mismatch with TestMovedOnError before writing.
   */
  readonly expectedVersionId?: string;
  /**
   * The identity revision this edit was written against, for the live half —
   * the name and the description.
   *
   * Separate from the version above because the two guard separate losses. A
   * rename that lost a race is retyped in a second; a scenario edit that lost
   * one may be an afternoon's work, and a writer has to be told which of the
   * two happened. An edit that changes both names both.
   */
  readonly expectedRevision?: string;
};

/** One version, frozen: the test exactly as some simulation executed it. */
export type TestVersion = {
  readonly id: string;
  readonly testId: string;
  /** The test's immutable suite membership. */
  readonly suiteId: string;
  /**
   * What the test is called now. Identity is never versioned, so this is the
   * test's current name rather than the name it carried when this version was
   * written — the only name that would help somebody go and find it.
   */
  readonly testName: string;
  readonly version: number;
  /**
   * Whether the test still stands on this version. False once a later one
   * exists, which is what tells a stale pin from a live one.
   */
  readonly current: boolean;
  readonly scenario: string;
  readonly expectedBehaviors: readonly ExpectedBehavior[];
  /** By identity, in the order they were authored. */
  readonly personas: readonly TestPersona[];
  /** The tools this version answers for itself, as it was frozen. */
  readonly mockTools: readonly TestMockTool[];
  /** The world this version asks for, as it was frozen; null for none. */
  readonly env: TestEnv | null;
  readonly createdAt: Date;
};

/**
 * The bounded part of one frozen version that execution and evidence need.
 *
 * It deliberately has no personas. A Simulation already pins the one persona
 * it executes, so reading every other persona named by the same test would make
 * one claim grow with the full audience for no execution reason.
 */
export type TestExecutionContent = {
  readonly id: string;
  readonly testId: string;
  readonly suiteId: string;
  readonly testName: string;
  readonly scenario: string;
  readonly expectedBehaviors: readonly ExpectedBehavior[];
  readonly mockTools: readonly TestMockTool[];
  readonly env: TestEnv | null;
};

const notDeleted: SQL = isNull(test.deletedAt);

/** An answer's columns, and no more — the tenant-free view. */
const COLUMNS = {
  id: test.id,
  projectId: test.projectId,
  suiteId: test.suiteId,
  name: test.name,
  description: test.description,
  revision: test.revision,
  deletedAt: test.deletedAt,
  createdAt: test.createdAt,
  updatedAt: test.updatedAt,
} as const;

/**
 * The name as it will be stored: trimmed, so a test somebody has to recognise
 * in a list is not named by invisible characters.
 */
function validName(name: string): string {
  const trimmed = name.trim();
  if (trimmed === "") throw new UnprocessableInputError("a test needs a name");
  return trimmed;
}

/**
 * Normalize scenario and expected behaviors, requiring both to be nonempty.
 * Validate mock tools and environment as part of the same test content.
 */
function validContent(input: {
  readonly scenario: string;
  readonly expectedBehaviors: readonly ExpectedBehavior[];
  readonly mockTools: readonly TestMockTool[];
  readonly env: TestEnv | null;
}): TestContent {
  const scenario = input.scenario.trim();
  if (scenario === "") {
    throw new UnprocessableInputError(
      "a test needs a scenario: the situation the agent is put in",
    );
  }

  if (input.expectedBehaviors.length === 0) {
    throw new UnprocessableInputError(
      "a test needs at least one expected behavior, because a test that cannot fail is not a test",
    );
  }
  const expectedBehaviors = input.expectedBehaviors.map((entry: unknown) => {
    // The shape that retired with the P0/P1/P2 ladder, named rather than
    // reported as an empty sentence: a writer sending last month's body should
    // be told what changed, not told their behavior says nothing.
    if (typeof entry === "object" && entry !== null && "behavior" in entry) {
      throw new UnprocessableInputError(
        'an expected behavior is a plain sentence now; the {"behavior", "priority"} ' +
          "shape retired with the P0/P1/P2 ladder. Send the sentence on its own.",
      );
    }
    const behavior = typeof entry === "string" ? entry.trim() : "";
    if (behavior === "") {
      throw new UnprocessableInputError(
        "an expected behavior needs to say something",
      );
    }
    return behavior;
  });

  return {
    scenario,
    expectedBehaviors,
    mockTools: validMockTools(input.mockTools),
    env: validEnv(input.env),
  };
}

/** How many bytes one answer takes on the wire, as the exchange counts it. */
function servedBytes(value: unknown, key: "answer" | "error"): number {
  let written: string | undefined;
  try {
    written = JSON.stringify(value);
  } catch {
    written = undefined;
  }
  if (written === undefined) {
    throw new UnprocessableInputError(
      `${key} has to be something Egma can serialize and hand to the agent, ` +
        `and this one is not.`,
    );
  }
  // The envelope written out rather than stringified a second time: this is
  // byte for byte what `JSON.stringify({ [key]: value })` produces, and the
  // customer's value is not serialized twice to count it once.
  return Buffer.byteLength(`{"${key}":${written}}`, "utf8");
}

/**
 * Validate one mock entry per tool name, with exactly one answer or error and
 * a reply within the RPC byte limit. Matching does not inspect arguments.
 */
function validMockTools(
  written: readonly TestMockTool[],
): readonly TestMockTool[] {
  const mockTools: TestMockTool[] = [];
  const seen = new Set<string>();

  for (const authored of written) {
    const entry = authored as unknown;
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new UnprocessableInputError(
        "each mock tool is an object naming the tool and what it answers " +
          "with, which looks like " +
          '{"tool": "get_availability", "answer": {"slots": []}}',
      );
    }
    const held = entry as Record<string, unknown>;
    const tool = held.tool;
    if (typeof tool !== "string") {
      throw new UnprocessableInputError(
        "tool is the name of the agent's tool this mock tool answers for, " +
          `written as text, and this request sent ${typeof tool}.`,
      );
    }
    const named = tool.trim();
    if (named === "") {
      throw new UnprocessableInputError(
        "tool is the name of the agent's tool this mock tool answers for, and " +
          "this one is blank. Send the tool's name exactly as the agent " +
          "registers it.",
      );
    }
    if (seen.has(named)) {
      throw new UnprocessableInputError(
        `this test answers for "${named}" twice; mock each tool once`,
      );
    }
    seen.add(named);

    // A key that is there *and* says something. `answer: null` is an answer a
    // tool can perfectly well give and counts; `answer: undefined` is a key
    // carrying nothing and does not, which is what lets the union's own
    // `error: string` shape reach the failure branch instead of being refused
    // for saying two things.
    const gives = "answer" in held && held.answer !== undefined;
    const fails = "error" in held && held.error !== undefined;
    if (gives && fails) {
      throw new UnprocessableInputError(
        `mock tool "${named}" answers with one thing: this one sent both ` +
          "answer and error. Send whichever branch the test needs.",
      );
    }
    if (!gives && !fails) {
      throw new UnprocessableInputError(
        `mock tool "${named}" answers with something: send answer with what ` +
          "the tool returns, or error with the failure it raises. This one " +
          "sent neither.",
      );
    }

    if (fails) {
      const message = held.error;
      if (typeof message !== "string") {
        throw new UnprocessableInputError(
          `error is the failure mock tool "${named}" raises, written as text, ` +
            `and this request sent ${typeof message}.`,
        );
      }
      if (message.trim() === "") {
        throw new UnprocessableInputError(
          `error is the failure mock tool "${named}" raises, and this one is ` +
            "blank. Say what the agent's backend would have said.",
        );
      }
      const bytes = servedBytes(message, "error");
      if (bytes > LARGEST_MOCK_TOOL_ANSWER_BYTES) {
        throw new UnprocessableInputError(tooLarge(named, "error", bytes));
      }
      mockTools.push({ tool: named, error: message });
      continue;
    }

    const bytes = servedBytes(held.answer, "answer");
    if (bytes > LARGEST_MOCK_TOOL_ANSWER_BYTES) {
      throw new UnprocessableInputError(tooLarge(named, "answer", bytes));
    }
    mockTools.push({ tool: named, answer: held.answer });
  }

  return mockTools;
}

/**
 * The one sentence both branches are refused with, written once.
 *
 * The number names the whole message, tag included, because that is the number
 * the exchange measures — an author told the size of their bare value would
 * count to the cap themselves and still be refused.
 */
function tooLarge(tool: string, key: "answer" | "error", bytes: number): string {
  return (
    `mock tool "${tool}": ${key} is ${bytes} bytes once serialized and tagged ` +
    `for the wire, and the exchange that carries it holds at most ` +
    `${LARGEST_MOCK_TOOL_ANSWER_BYTES}. An answer that needs more than that ` +
    `is a document rather than a tool answer.`
  );
}

/** The two keys an env may carry, and nothing else. */
const ENV_KEYS = ["retell_dynamic_variables", "job_dispatch_metadata"] as const;

/**
 * Normalize empty environment settings to null and reject unknown top-level keys.
 * Validate each supplied agent platform setting before storing it.
 */
function validEnv(written: TestEnv | null | undefined): TestEnv | null {
  if (written === null || written === undefined) return null;
  const value = written as unknown;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new UnprocessableInputError(
      "env is an object with at most retell_dynamic_variables and " +
        "job_dispatch_metadata in it",
    );
  }
  const held = value as Record<string, unknown>;
  for (const key of Object.keys(held)) {
    if (!(ENV_KEYS as readonly string[]).includes(key)) {
      throw new UnprocessableInputError(
        `env has no ${JSON.stringify(key)} in it. An env carries ` +
          `${ENV_KEYS.join(" and ")}, and nothing else.`,
      );
    }
  }

  const env: TestEnv = {};
  const variables = held.retell_dynamic_variables;
  if (variables !== undefined && variables !== null) {
    const checked = validDynamicVariables(variables);
    if (Object.keys(checked).length > 0) env.retell_dynamic_variables = checked;
  }
  const dispatch = held.job_dispatch_metadata;
  if (dispatch !== undefined && dispatch !== null) {
    const checked = validJobDispatchMetadata(dispatch);
    if (Object.keys(checked).length > 0) env.job_dispatch_metadata = checked;
  }

  return Object.keys(env).length === 0 ? null : env;
}

/**
 * The dynamic variables as they will be stored: text to text, with egma's own
 * prefix kept back.
 *
 * Text values only, because that is what the platform substitutes: a number or
 * an object here would be stringified by somebody downstream, and which
 * somebody decided the spelling would be a question nobody could answer from
 * the record.
 */
function validDynamicVariables(value: unknown): Record<string, string> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new UnprocessableInputError(
      "env.retell_dynamic_variables is an object of text values, which looks " +
        'like {"caller_name": "Margaret"}',
    );
  }
  const variables: Record<string, string> = {};
  for (const [name, held] of Object.entries(value as Record<string, unknown>)) {
    if (name.startsWith(RESERVED_ENV_VARIABLE_PREFIX)) {
      throw new UnprocessableInputError(
        `env.retell_dynamic_variables names ${JSON.stringify(name)}, and ` +
          `Egma keeps every variable beginning ` +
          `"${RESERVED_ENV_VARIABLE_PREFIX}" for the facts it writes into the ` +
          `conversation itself. Name the variable something else.`,
      );
    }
    if (typeof held !== "string") {
      throw new UnprocessableInputError(
        `env.retell_dynamic_variables.${name} is the text Retell substitutes ` +
          `into the prompt, and this request sent ${typeof held}.`,
      );
    }
    variables[name] = held;
  }
  return variables;
}

/**
 * A lone surrogate: half of a UTF-16 pair with no partner. Valid JSON, and
 * JavaScript keeps it, but it has no UTF-8 form, so the dispatch that carries
 * the metadata to LiveKit could not encode it. Refused at save, because a value
 * that saves must never fail at dispatch.
 */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/** Every string a JSON value holds, keys included, in document order. */
function* stringsIn(value: unknown): Generator<string> {
  if (typeof value === "string") {
    yield value;
  } else if (Array.isArray(value)) {
    for (const item of value) yield* stringsIn(item);
  } else if (typeof value === "object" && value !== null) {
    for (const [key, held] of Object.entries(value)) {
      yield key;
      yield* stringsIn(held);
    }
  }
}

/** The dispatch metadata as it will be stored: an object, within LiveKit's cap. */
function validJobDispatchMetadata(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new UnprocessableInputError(
      "env.job_dispatch_metadata is a JSON object handed to your worker, " +
        'which looks like {"tenant": "acme"}',
    );
  }
  const metadata = value as Record<string, unknown>;
  for (const text of stringsIn(metadata)) {
    if (LONE_SURROGATE.test(text)) {
      throw new UnprocessableInputError(
        "env.job_dispatch_metadata holds a lone surrogate, which is valid " +
          "JSON but has no UTF-8 form, so LiveKit could not carry it on the " +
          "dispatch. Send well-formed text.",
      );
    }
  }
  const bytes = Buffer.byteLength(
    serializedJobDispatchMetadata(metadata),
    "utf8",
  );
  if (bytes > LARGEST_JOB_DISPATCH_METADATA_BYTES) {
    throw new UnprocessableInputError(
      `env.job_dispatch_metadata is ${bytes} bytes once serialized, and ` +
        `LiveKit carries at most ${LARGEST_JOB_DISPATCH_METADATA_BYTES} on ` +
        `the dispatch; hold a large value in your own store and put its id ` +
        `here instead.`,
    );
  }
  return metadata;
}

/**
 * Require a nonempty list of distinct valid persona IDs before database access.
 * personaIdsFor rechecks availability within the write transaction.
 */
function validatePersonaIds(ids: readonly string[]): void {
  if (ids.length === 0) {
    throw new UnprocessableInputError(
      "a test needs at least one persona, because a test says who calls",
    );
  }
  const seen = new Set<string>();
  for (const id of ids) {
    if (!isId("prs", id)) {
      throw new UnprocessableInputError(`"${id}" is not a persona id`);
    }
    if (seen.has(id)) {
      throw new UnprocessableInputError(
        `persona ${id} is named twice on one test; name each persona once`,
      );
    }
    seen.add(id);
  }
}

/**
 * Validate stored JSON shapes without applying current authoring rules to old
 * versions. Read legacy {behavior, priority} entries as behavior strings without
 * rewriting immutable version rows.
 */
function contentFromRow(
  value: unknown,
  mockTools: unknown,
  env: unknown,
  versionId: string,
): TestContent {
  const malformed = () =>
    new Error(
      `version ${versionId} holds content in a shape Egma never writes; the row needs repairing before anybody can read it`,
    );

  if (typeof value !== "object" || value === null) throw malformed();
  const { scenario, expectedBehaviors } = value as Record<string, unknown>;
  if (typeof scenario !== "string" || scenario.trim() === "") throw malformed();
  if (!Array.isArray(expectedBehaviors) || expectedBehaviors.length === 0) {
    throw malformed();
  }
  return {
    mockTools: mockToolsFromRow(mockTools, malformed),
    env: envFromRow(env, malformed),
    scenario,
    expectedBehaviors: expectedBehaviors.map((entry): ExpectedBehavior => {
      if (typeof entry === "string") {
        if (entry.trim() === "") throw malformed();
        return entry;
      }
      if (typeof entry !== "object" || entry === null) throw malformed();
      const { behavior } = entry as Record<string, unknown>;
      if (typeof behavior !== "string" || behavior.trim() === "") {
        throw malformed();
      }
      return behavior;
    }),
  };
}

/**
 * The stored mock tools of one version, by that version's id.
 *
 * **Exported to the module, not from the package**, exactly as the two "which
 * tests name this" reads beside it are. The mock endpoint reads this column off
 * its own one-statement join rather than paying for a second read, and what a
 * version says is this file's business: a second reader of the same jsonb would
 * be a second opinion about its shape.
 */
export function mockToolsOfVersion(
  value: unknown,
  versionId: string,
): readonly TestMockTool[] {
  return mockToolsFromRow(
    value,
    () =>
      new Error(
        `version ${versionId} holds mock tools in a shape Egma never writes; the row needs repairing before anybody can read it`,
      ),
  );
}

/**
 * The stored mock tools, or the empty list for a test that mocks nothing.
 *
 * Shape only, deliberately, and the size cap is not re-applied: an answer
 * written when the cap was larger has to stay readable exactly as it was
 * written. A version row is frozen the moment a run can pin it.
 */
function mockToolsFromRow(
  value: unknown,
  malformed: () => Error,
): readonly TestMockTool[] {
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value)) throw malformed();
  return value.map((entry: unknown): TestMockTool => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw malformed();
    }
    const held = entry as Record<string, unknown>;
    if (typeof held.tool !== "string" || held.tool.trim() === "") {
      throw malformed();
    }
    if ("error" in held) {
      if (typeof held.error !== "string" || held.error === "") throw malformed();
      return { tool: held.tool, error: held.error };
    }
    if (!("answer" in held)) throw malformed();
    return { tool: held.tool, answer: held.answer };
  });
}

/** The stored env, or null for a test that asks for nothing. */
function envFromRow(value: unknown, malformed: () => Error): TestEnv | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "object" || Array.isArray(value)) throw malformed();
  const held = value as Record<string, unknown>;
  const env: TestEnv = {};

  const variables = held.retell_dynamic_variables;
  if (variables !== undefined && variables !== null) {
    if (
      typeof variables !== "object" ||
      Array.isArray(variables) ||
      Object.values(variables as Record<string, unknown>).some(
        (one) => typeof one !== "string",
      )
    ) {
      throw malformed();
    }
    env.retell_dynamic_variables = variables as Record<string, string>;
  }

  const dispatch = held.job_dispatch_metadata;
  if (dispatch !== undefined && dispatch !== null) {
    if (typeof dispatch !== "object" || Array.isArray(dispatch)) {
      throw malformed();
    }
    env.job_dispatch_metadata = dispatch as Record<string, unknown>;
  }

  return Object.keys(env).length === 0 ? null : env;
}

/**
 * One version's content as the three columns that hold it.
 *
 * **An empty list and an empty env are stored as null**, so the state "this
 * test mocks nothing" has exactly one spelling in the table — which is what
 * lets the claim gate ask `mock_tools is not null` and get a true answer
 * without reading the value.
 */
function storedColumns(content: TestContent): {
  content: Record<string, unknown>;
  mockTools: readonly TestMockTool[] | null;
  env: TestEnv | null;
} {
  return {
    content: {
      scenario: content.scenario,
      expectedBehaviors: [...content.expectedBehaviors],
    },
    mockTools: content.mockTools.length === 0 ? null : [...content.mockTools],
    env: content.env,
  };
}

/**
 * The three stored columns one read selects, written once so two readers can
 * never drift.
 */
const VERSION_CONTENT_COLUMNS = {
  content: testVersion.content,
  mockTools: testVersion.mockTools,
  env: testVersion.env,
} as const;

/** The read shape those three columns come back in. */
type StoredContentRow = {
  readonly content: unknown;
  readonly mockTools: unknown;
  readonly env: unknown;
};

/** The three columns of one row, read through this file's own guard. */
function contentOf(row: StoredContentRow, versionId: string): TestContent {
  return contentFromRow(row.content, row.mockTools, row.env, versionId);
}

/**
 * One value written out with every object's keys in one fixed order — the
 * comparison a stored jsonb has to be made through.
 *
 * Postgres re-orders a jsonb object's keys as it pleases, so a value read back
 * is almost never key-for-key what was written. Comparing the two as written
 * would call every edit a change and mint a version for typing the same thing
 * twice; comparing them canonically calls exactly the changes changes.
 */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((one) => canonicalJson(one)).join(",")}]`;
  }
  if (typeof value === "object" && value !== null) {
    const held = value as Record<string, unknown>;
    const written = Object.keys(held)
      .filter((key) => held[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(held[key])}`);
    return `{${written.join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/**
 * Two ordered lists of strings, compared as written. Order is content
 * everywhere this is asked: the personas are named in the order they were
 * authored, so a version that reorders them says something the version before
 * it did not.
 */
function sameOrderedList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((entry, index) => entry === b[index]);
}

/**
 * The behaviors, compared as written: the same statements, in the same order.
 *
 * The comparison a persona list gets, because a behavior is a plain sentence
 * now and there is nothing else on it to compare — but named separately,
 * because the reason order matters here is its own: nested assertion details
 * are keyed by a behavior's **position**, so moving a sentence rekeys the
 * details, and minting a version is what keeps old grade rows readable.
 */
function sameBehaviors(
  a: readonly ExpectedBehavior[],
  b: readonly ExpectedBehavior[],
): boolean {
  return sameOrderedList(a, b);
}

/**
 * Compare every JSON content field for a version change. The mapped type requires
 * a comparator for new fields. Compare ordered persona join rows separately.
 */
const sameContentField: {
  readonly [K in keyof TestContent]: (a: TestContent, b: TestContent) => boolean;
} = {
  scenario: (a, b) => a.scenario === b.scenario,
  expectedBehaviors: (a, b) =>
    sameBehaviors(a.expectedBehaviors, b.expectedBehaviors),
  mockTools: (a, b) => sameMockTools(a.mockTools, b.mockTools),
  env: (a, b) => canonicalJson(a.env) === canonicalJson(b.env),
};

/**
 * Compare ordered mock entries with canonical JSON answers. Object key order
 * changes from jsonb must not create versions; entry order remains test content.
 */
function sameMockTools(
  a: readonly TestMockTool[],
  b: readonly TestMockTool[],
): boolean {
  return (
    a.length === b.length &&
    a.every((entry, index) => {
      const other = b[index];
      return other !== undefined && canonicalJson(entry) === canonicalJson(other);
    })
  );
}

function sameContent(a: TestContent, b: TestContent): boolean {
  return Object.values(sameContentField).every((same) => same(a, b));
}

/** Acting in a project narrows to it; acting in none reaches the customer. */
function inActingProject(auth: AuthContext): SQL | undefined {
  return auth.projectId === undefined
    ? undefined
    : eq(test.projectId, auth.projectId);
}

/**
 * The named test within the caller's tenancy, including a permanently deleted
 * identity when a historical evidence read needs it.
 */
function anyTest(auth: AuthContext, id: string): SQL {
  return within(auth, test, and(eq(test.id, id), inActingProject(auth)));
}

/** The named test while it is still available for authoring. */
function theTest(auth: AuthContext, id: string): SQL {
  return and(anyTest(auth, id), notDeleted)!;
}

/**
 * Share-lock the named personas, require active availability in this project,
 * and ensure project settings exist. Out-of-scope IDs read as missing.
 * The lock orders test writes against persona deletion. Deletion can still follow
 * a committed test write; later test writes and run starts reject deleted personas.
 */
async function validateNamedPersonas(
  on: Queryable,
  auth: AuthContext,
  projectId: string,
  ids: readonly string[],
): Promise<void> {
  const found = new Map(
    (
      await on
        .select({ id: persona.id, archivedAt: persona.archivedAt })
        .from(persona)
        .where(
          personaAvailableToProject(
            auth,
            projectId,
            inArray(persona.id, [...ids]),
          ),
        )
        .for("share")
    ).map((row) => [row.id, row.archivedAt] as const),
  );

  for (const id of ids) {
    if (!found.has(id)) {
      throw new UnprocessableInputError(
        `there is no persona ${id} in this project`,
      );
    }
    if (found.get(id) !== null) {
      throw new UnprocessableInputError(
        `persona ${id} is deleted, and a test cannot name a deleted persona`,
      );
    }
    await ensureProjectPersonaOn(on, auth, projectId, id);
  }
}

/**
 * Require at least one active available persona and preserve authored order.
 * Check inside the write transaction for creates, explicit edits, and selections
 * carried forward from the current version.
 */
async function personaIdsFor(
  on: Queryable,
  auth: AuthContext,
  projectId: string,
  named: readonly string[],
): Promise<readonly string[]> {
  if (named.length === 0) {
    throw new UnprocessableInputError(
      "a test needs at least one persona, because a test says who calls",
    );
  }
  await validateNamedPersonas(on, auth, projectId, named);
  return named;
}

/** The join rows of one version, in the order the ids were authored. */
async function namePersonasOn(
  on: Queryable,
  versionId: string,
  personaIds: readonly string[],
): Promise<void> {
  await on.insert(testPersona).values(
    personaIds.map((personaId, index) => ({
      testVersionId: versionId,
      personaId,
      position: index + 1,
    })),
  );
}

/** Create one test inside one existing, active suite. */
export async function createTest(
  auth: AuthContext,
  input: NewTest,
): Promise<Test> {
  authorize(auth, "author_definitions", here(auth));

  const { projectId } = auth;
  if (projectId === undefined) {
    throw new Error(
      "a test belongs to a project, and this credential is for the whole organization and acting in none",
    );
  }

  // Everything answerable without the database is answered first; only an input
  // worth writing costs the reads below.
  if (!isId("ste", input.suiteId)) {
    throw new UnprocessableInputError(`"${input.suiteId}" is not a test suite id`);
  }
  const name = validName(input.name);
  const content = validContent({
    ...input,
    mockTools: input.mockTools ?? [],
    env: input.env ?? null,
  });
  const named = input.personaIds ?? [];
  validatePersonaIds(named);

  if (!(await isProjectOfOrganization(auth, projectId))) {
    throw new ProjectOutsideOrganizationError(auth.organizationId, projectId);
  }

  return db().transaction((tx) => createTestOn(tx, auth, input));
}

/** The table-owned half used by the repository transaction. */
async function createTestOn(
  on: Transaction,
  auth: AuthContext,
  input: NewTest,
): Promise<Test> {
  const projectId = auth.projectId;
  if (projectId === undefined) {
    throw new Error(
      "a test belongs to a project, and this credential is for the whole organization and acting in none",
    );
  }
  await lockRepositoryProject(on, projectId);
  if (!isId("ste", input.suiteId)) {
    throw new UnprocessableInputError(`"${input.suiteId}" is not a test suite id`);
  }
  const name = validName(input.name);
  const content = validContent({
    ...input,
    mockTools: input.mockTools ?? [],
    env: input.env ?? null,
  });
  const named = input.personaIds ?? [];
  validatePersonaIds(named);

  const id = newId("tst");
  const versionId = newId("tstv");

  const [suite] = await on
      .select({ id: testSuite.id })
      .from(testSuite)
      .where(
        within(
          auth,
          testSuite,
          and(
            eq(testSuite.id, input.suiteId),
            eq(testSuite.projectId, projectId),
            isNull(testSuite.deletedAt),
          ),
        ),
      )
      .limit(1)
      .for("update");
  if (suite === undefined) {
    throw new UnprocessableInputError(
      `there is no active test suite ${input.suiteId} in this project`,
    );
  }

  const personaIds = await personaIdsFor(on, auth, projectId, named);

  const [identity] = await on
      .insert(test)
      .values({
        id,
        organizationId: auth.organizationId,
        projectId,
        suiteId: suite.id,
        name,
        description: input.description ?? null,
        currentVersionId: versionId,
        revision: newId("rev"),
        createdBy: auth.userId,
      })
      .returning(COLUMNS);

  if (identity === undefined) throw new Error("the test was not written");

  await on.insert(testVersion).values({
    id: versionId,
    testId: id,
    version: 1,
    ...storedColumns(content),
    createdBy: auth.userId,
  });

  await namePersonasOn(on, versionId, personaIds);

  const written = {
    ...identity,
    personas: await personasOf(on, versionId),
  };

  return { ...written, version: 1, versionId, ...content };
}

/**
 * The personas of several versions at once, keyed by version and each list in
 * the order it was authored — one read for a whole page of tests rather than
 * one read per row.
 *
 * The `where` starts from a bare `inArray` rather than `within`: every caller
 * hands it version ids that have already come off tenancy-checked rows, so the
 * predicate cannot reach further than that check already did.
 */
async function personasOfVersions(
  on: Queryable,
  versionIds: readonly string[],
): Promise<Map<string, TestPersona[]>> {
  const byVersion = new Map<string, TestPersona[]>();
  if (versionIds.length === 0) return byVersion;

  const rows = await on
    .select({
      versionId: testPersona.testVersionId,
      id: persona.id,
      name: persona.name,
      archivedAt: persona.archivedAt,
    })
    .from(testPersona)
    .innerJoin(
      persona,
      eq(testPersona.personaId, persona.id),
    )
    .where(inArray(testPersona.testVersionId, [...versionIds]))
    .orderBy(
      asc(testPersona.testVersionId),
      asc(testPersona.position),
    );

  for (const { versionId, ...named } of rows) {
    const already = byVersion.get(versionId);
    if (already === undefined) byVersion.set(versionId, [named]);
    else already.push(named);
  }
  return byVersion;
}

/** The one version's personas, in the order they were authored. */
async function personasOf(
  on: Queryable,
  versionId: string,
): Promise<readonly TestPersona[]> {
  return (await personasOfVersions(on, [versionId])).get(versionId) ?? [];
}

/**
 * The identity row joined to its current version — the shape every read of a
 * whole test answers with, written once so two readers can never drift.
 */
function selectWithCurrentVersion(on: Queryable = db()) {
  return on
    .select({
      ...COLUMNS,
      version: testVersion.version,
      versionId: testVersion.id,
      ...VERSION_CONTENT_COLUMNS,
    })
    .from(test)
    .innerJoin(testVersion, eq(test.currentVersionId, testVersion.id));
}

/**
 * One test with what it currently checks: its name and description, its
 * scenario, its expected behaviors, and the personas who call about it — in the
 * order they were authored, deleted ones included and marked.
 */
export async function getTest(
  auth: AuthContext,
  id: string,
): Promise<Test | undefined> {
  authorize(auth, "read", here(auth));

  return readTestOn(db(), auth, id);
}

/**
 * The test as it stands on one connection.
 *
 * **A write reads its own answer back through this, on its own
 * transaction.** `getTest` asks the pool, which is a different connection and
 * cannot see an uncommitted write — so a write that answered through it
 * would hand back the row exactly as it was a moment before, and every caller
 * would believe nothing had happened.
 */
async function readTestOn(
  on: Queryable,
  auth: AuthContext,
  id: string,
): Promise<Test | undefined> {
  const [row] = await selectWithCurrentVersion(on)
    .where(theTest(auth, id))
    .limit(1);

  if (row === undefined) return undefined;

  // The three stored columns come off the row here so they cannot ride into
  // the answer raw; the guard below is the one thing that reads them.
  const { content: _content, mockTools: _mockTools, env: _env, ...rest } = row;
  return {
    ...rest,
    ...contentOf(row, row.versionId),
    personas: await personasOf(on, row.versionId),
  };
}

/**
 * Edit the locked test in one transaction. Metadata changes update identity;
 * changes to scenario, expected behaviors, personas, mock tools, or environment
 * create an immutable version. Omitted fields carry forward and are revalidated.
 * Content edits require expectedVersionId; check it and any expectedRevision
 * under the lock. If content and identity match, keep the test row unchanged.
 * Return undefined for an unseen test.
 */
export async function editTest(
  auth: AuthContext,
  id: string,
  changes: TestChanges,
): Promise<Test | undefined> {
  authorize(auth, "author_definitions", here(auth));

  // Everything answerable without the database is answered first, exactly as
  // create answers it, so an edit is refused on the same grounds a create is.
  const name = changes.name === undefined ? undefined : validName(changes.name);
  const named = changes.personaIds;
  if (named !== undefined) validatePersonaIds(named);
  return db().transaction((tx) => editTestOn(tx, auth, id, changes));
}

/** The table-owned half used by the repository transaction. */
async function editTestOn(
  on: Transaction,
  auth: AuthContext,
  id: string,
  changes: TestChanges,
): Promise<Test | undefined> {
  const name = changes.name === undefined ? undefined : validName(changes.name);
  const named = changes.personaIds;
  if (named !== undefined) validatePersonaIds(named);
  const changesContent =
    changes.scenario !== undefined ||
    changes.expectedBehaviors !== undefined ||
    changes.personaIds !== undefined ||
    changes.mockTools !== undefined ||
    changes.env !== undefined;
  if (changesContent && changes.expectedVersionId === undefined) {
    throw new UnprocessableInputError(
      "a test content edit needs expected_version_id from the version it read",
    );
  }
  if (
    changes.expectedVersionId !== undefined &&
    !isId("tstv", changes.expectedVersionId)
  ) {
    throw new UnprocessableInputError(
      `"${changes.expectedVersionId}" is not a test version id`,
    );
  }
  if (
    changes.expectedRevision !== undefined &&
    !isId("rev", changes.expectedRevision)
  ) {
    throw new UnprocessableInputError(
      `"${changes.expectedRevision}" is not a revision id`,
    );
  }
  const [located] = await on
      .select({ projectId: test.projectId, suiteId: test.suiteId })
      .from(test)
      .where(theTest(auth, id))
      .limit(1);
  if (located === undefined) return undefined;
  await lockRepositoryProject(on, located.projectId);
  await on
      .select({ id: testSuite.id })
      .from(testSuite)
      .where(eq(testSuite.id, located.suiteId))
      .limit(1)
      .for("update");

  const [locked] = await on
      .select({ ...COLUMNS, currentVersionId: test.currentVersionId })
      .from(test)
      .where(theTest(auth, id))
      .limit(1)
      .for("update");

  if (locked === undefined) return undefined;
  const { currentVersionId, ...current } = locked;

    // Before anything is read about the content, and inside the lock. Nothing
    // has been written yet, and returning through a throw takes the transaction
    // with it, so a refused edit leaves the test exactly as it found it.
    //
    // The identity expectation goes first because it is the cheaper loss to
    // report: somebody whose rename lost a race retypes it, and telling them
    // that instead of telling them the content moved would send them looking at
    // the wrong half of their own edit.
  expectRevision(current, changes.expectedRevision);
  if (
    changes.expectedVersionId !== undefined &&
    changes.expectedVersionId !== currentVersionId
  ) {
    throw new TestMovedOnError(current, {
      expected: changes.expectedVersionId,
      current: currentVersionId,
    });
  }

    // This select and the update below are the two `where`s in this file that
    // start from a bare `eq` rather than `within`: each names an id that just
    // came off the tenancy-checked row locked above, in this same transaction,
    // so neither predicate can reach further than that check already did.
  const [currentVersion] = await on
      .select({
        id: testVersion.id,
        version: testVersion.version,
        ...VERSION_CONTENT_COLUMNS,
      })
      .from(testVersion)
      .where(eq(testVersion.id, currentVersionId))
      .limit(1);
  if (currentVersion === undefined) {
    throw new Error("the test's current version is missing");
  }

  const storedContent = contentOf(currentVersion, currentVersion.id);
  const storedPersonas = await personasOf(on, currentVersion.id);
  const storedIds = storedPersonas.map((named) => named.id);

    // Carry forward omitted fields, then apply current authoring validation.
    // Stored reads preserve text; validation trims it, so non-normalized stored
    // content may create a corrected version on the next edit.
  const content = validContent({
    scenario: changes.scenario ?? storedContent.scenario,
    expectedBehaviors:
      changes.expectedBehaviors ?? storedContent.expectedBehaviors,
    mockTools: changes.mockTools ?? storedContent.mockTools,
    // `null` clears, so absent is the only thing that keeps: `?? stored` would
    // read a deliberate clearing as an omission and carry the old env forward.
    env: changes.env === undefined ? storedContent.env : changes.env,
  });
  const personaIds = await personaIdsFor(
    on,
    auth,
    current.projectId,
    named ?? storedIds,
  );
  const mintsVersion =
    !sameContent(storedContent, content) ||
    !sameOrderedList(storedIds, personaIds);
  const identityChanged =
    (name !== undefined && name !== current.name) ||
    (changes.description !== undefined &&
      changes.description !== current.description);

  if (!mintsVersion && !identityChanged) {
    return {
      ...current,
      version: currentVersion.version,
      versionId: currentVersion.id,
      ...storedContent,
      personas: storedPersonas,
    };
  }

  let versionId = currentVersion.id;
  let version = currentVersion.version;
  let personas = storedPersonas;
  if (mintsVersion) {
    versionId = newId("tstv");
    version = currentVersion.version + 1;
    await on.insert(testVersion).values({
      id: versionId,
      testId: current.id,
      version,
      ...storedColumns(content),
      createdBy: auth.userId,
    });
    await namePersonasOn(on, versionId, personaIds);
    personas = await personasOf(on, versionId);
  }

  const [updated] = await on
      .update(test)
      .set({
        ...(name === undefined ? {} : { name }),
        ...(changes.description === undefined
          ? {}
          : { description: changes.description }),
        ...(mintsVersion ? { currentVersionId: versionId } : {}),
        // **Only when the identity moved**, which is the whole worth of two
        // tokens. A version-only edit refuses a rename somebody is typing in
        // another tab if this moves for it — and a rename is not stale for a
        // scenario somebody else sharpened, because the name they read is
        // still the name. A repository copy is made stale by the version, so
        // nothing downstream needs this to move for content.
        ...(identityChanged ? { revision: newId("rev") } : {}),
        updatedAt: new Date(),
      })
      .where(eq(test.id, current.id))
      .returning(COLUMNS);

  if (updated === undefined) throw new Error("the test was not written");
  return {
    ...updated,
    version,
    versionId,
    ...content,
    personas,
  };
}

/** One authored test in a complete repository change set. */
export type RepositoryTest = NewTest & {
  readonly clientRef: string;
  readonly expectedVersionId?: string;
  readonly expectedRevision?: string;
};

export type AppliedRepositoryTest = {
  readonly clientRef: string;
  readonly test: Test;
};

/**
 * Reconcile all active tests in one project on the repository transaction.
 * The version and identity-revision pins together identify an existing test;
 * neither pin means a new test.
 * Any active server test not named by a pin refuses the whole push.
 */
export async function applyRepositoryTestsOn(
  on: Transaction,
  auth: AuthContext,
  wanted: readonly RepositoryTest[],
): Promise<readonly AppliedRepositoryTest[]> {
  const projectId = auth.projectId;
  if (projectId === undefined) {
    throw new Error(
      "a repository belongs to a project, and this credential is acting in none",
    );
  }

  const clientRefs = new Set<string>();
  const expectedIds: string[] = [];
  for (const entry of wanted) {
    if (entry.clientRef.trim() === "") {
      throw new UnprocessableInputError("client_ref must name one repository file");
    }
    if (clientRefs.has(entry.clientRef)) {
      throw new UnprocessableInputError(
        `the repository names client_ref ${JSON.stringify(entry.clientRef)} more than once`,
      );
    }
    clientRefs.add(entry.clientRef);
    const hasVersionPin = entry.expectedVersionId !== undefined;
    const hasRevisionPin = entry.expectedRevision !== undefined;
    if (hasVersionPin !== hasRevisionPin) {
      throw new UnprocessableInputError(
        "an existing repository test needs both expected_version_id and expected_revision; a new test needs neither",
      );
    }
    if (entry.expectedRevision !== undefined && !isId("rev", entry.expectedRevision)) {
      throw new UnprocessableInputError(
        `"${entry.expectedRevision}" is not a revision id`,
      );
    }
    if (entry.expectedVersionId !== undefined) {
      if (!isId("tstv", entry.expectedVersionId)) {
        throw new UnprocessableInputError(
          `"${entry.expectedVersionId}" is not a test version id`,
        );
      }
      expectedIds.push(entry.expectedVersionId);
    }
  }

  const activeTests = await on
    .select({
      id: test.id,
      suiteId: test.suiteId,
      currentVersionId: test.currentVersionId,
    })
    .from(test)
    .where(
      within(
        auth,
        test,
        and(eq(test.projectId, projectId), isNull(test.deletedAt)),
      ),
    )
    .for("update", { of: test });

  const pinned = expectedIds.length === 0
    ? []
    : await on
        .select({
          versionId: testVersion.id,
          testId: test.id,
          suiteId: test.suiteId,
        })
        .from(testVersion)
        .innerJoin(test, eq(testVersion.testId, test.id))
        .where(
          within(
            auth,
            test,
            and(
              eq(test.projectId, projectId),
              isNull(test.deletedAt),
              inArray(testVersion.id, expectedIds),
            ),
          ),
        );
  const byVersion = new Map(pinned.map((row) => [row.versionId, row] as const));
  const existingByRef = new Map<string, { id: string; suiteId: string }>();
  const namedTestIds = new Set<string>();
  for (const entry of wanted) {
    if (entry.expectedVersionId === undefined) continue;
    const found = byVersion.get(entry.expectedVersionId);
    if (found === undefined) {
      throw new UnprocessableInputError(
        `expected_version_id ${entry.expectedVersionId} does not name an active test in this project`,
      );
    }
    if (namedTestIds.has(found.testId)) {
      throw new UnprocessableInputError(
        `the repository names test ${found.testId} more than once`,
      );
    }
    if (found.suiteId !== entry.suiteId) {
      throw new UnprocessableInputError(
        `test ${found.testId} belongs to suite ${found.suiteId}; a test cannot move to suite ${entry.suiteId}`,
      );
    }
    namedTestIds.add(found.testId);
    existingByRef.set(entry.clientRef, { id: found.testId, suiteId: found.suiteId });
  }

  const unseen = activeTests.find((row) => !namedTestIds.has(row.id));
  if (unseen !== undefined) {
    throw new UnprocessableInputError(
      `the repository does not include active test ${unseen.id}; pull before pushing so no server test is deleted by inference`,
    );
  }

  const applied: AppliedRepositoryTest[] = [];
  for (const entry of wanted) {
    const existing = existingByRef.get(entry.clientRef);
    if (existing === undefined) {
      const created = await createTestOn(on, auth, entry);
      applied.push({ clientRef: entry.clientRef, test: created });
      continue;
    }
    const edited = await editTestOn(on, auth, existing.id, {
      name: entry.name,
      description: entry.description ?? null,
      scenario: entry.scenario,
      expectedBehaviors: entry.expectedBehaviors,
      personaIds: entry.personaIds ?? [],
      mockTools: entry.mockTools ?? [],
      env: entry.env ?? null,
      ...(entry.expectedVersionId === undefined
        ? {}
        : { expectedVersionId: entry.expectedVersionId }),
      ...(entry.expectedRevision === undefined
        ? {}
        : { expectedRevision: entry.expectedRevision }),
    });
    if (edited === undefined) {
      throw new Error(`test ${existing.id} disappeared inside the repository transaction`);
    }
    applied.push({ clientRef: entry.clientRef, test: edited });
  }
  return applied;
}

/** The revision check, written once for the writes that make it. */
function expectRevision(
  current: { readonly id: string; readonly revision: string },
  expected: string | undefined,
): void {
  if (expected === undefined || expected === current.revision) return;
  throw new IdentityConflictError("test", current.id, {
    expected,
    current: current.revision,
  });
}

/**
 * Read a pinned test version, ordered personas, and the test's current name and
 * version status, including deleted tests. Simulations pin persona versions
 * separately. Project grader scope determines grading, not this content.
 */
export async function getTestVersion(
  auth: AuthContext,
  versionId: string,
): Promise<TestVersion | undefined> {
  authorize(auth, "read", here(auth));

  const [row] = await db()
    .select({
      id: testVersion.id,
      testId: testVersion.testId,
      suiteId: test.suiteId,
      testName: test.name,
      currentVersionId: test.currentVersionId,
      version: testVersion.version,
      ...VERSION_CONTENT_COLUMNS,
      createdAt: testVersion.createdAt,
    })
    .from(testVersion)
    .innerJoin(test, eq(testVersion.testId, test.id))
    .where(
      within(
        auth,
        test,
        and(eq(testVersion.id, versionId), inActingProject(auth)),
      ),
    )
    .limit(1);

  if (row === undefined) return undefined;

  const {
    content: _content,
    mockTools: _mockTools,
    env: _env,
    currentVersionId,
    ...rest
  } = row;
  return {
    ...rest,
    current: currentVersionId === row.id,
    ...contentOf(row, row.id),
    personas: await personasOf(db(), row.id),
  };
}

/** Read only the immutable content one Simulation executes or displays. */
export async function getTestVersionExecutionContent(
  auth: AuthContext,
  versionId: string,
): Promise<TestExecutionContent | undefined> {
  authorize(auth, "read", here(auth));
  const [row] = await db()
    .select({
      id: testVersion.id,
      testId: testVersion.testId,
      suiteId: test.suiteId,
      testName: test.name,
      ...VERSION_CONTENT_COLUMNS,
    })
    .from(testVersion)
    .innerJoin(test, eq(testVersion.testId, test.id))
    .where(
      within(
        auth,
        test,
        and(eq(testVersion.id, versionId), inActingProject(auth)),
      ),
    )
    .limit(1);
  if (row === undefined) return undefined;
  const {
    content: _content,
    mockTools: _mockTools,
    env: _env,
    ...identity
  } = row;
  return { ...identity, ...contentOf(row, row.id) };
}

/**
 * Page visible tests newest first with an ID cursor. An explicit project narrows
 * the organization scope; an organization-wide credential can read across projects.
 */
export type TestPage = {
  readonly items: readonly Test[];
  /** Hand back as `cursor` to continue; absent on the last page. */
  readonly nextCursor: string | undefined;
};

export async function listTests(
  auth: AuthContext,
  suiteId: string,
  page?: PageRequest,
): Promise<TestPage | undefined> {
  authorize(auth, "read", here(auth));

  if (!isId("ste", suiteId)) {
    throw new UnprocessableInputError(`"${suiteId}" is not a test suite id`);
  }

  const { limit, cursor } = pageWindow(page, {
    singular: "test",
    plural: "tests",
    prefix: "tst",
  });
  const olderThanCursor = cursor === undefined ? undefined : lt(test.id, cursor);

  const [suite] = await db()
    .select({ id: testSuite.id })
    .from(testSuite)
    .where(
      within(
        auth,
        testSuite,
        and(
          eq(testSuite.id, suiteId),
          isNull(testSuite.deletedAt),
          auth.projectId === undefined
            ? undefined
            : eq(testSuite.projectId, auth.projectId),
        ),
      ),
    )
    .limit(1);
  if (suite === undefined) return undefined;

  const rows = await selectWithCurrentVersion()
    .where(
      within(
        auth,
        test,
        and(
          eq(test.suiteId, suite.id),
          notDeleted,
          inActingProject(auth),
          olderThanCursor,
        ),
      ),
    )
    .orderBy(desc(test.id))
    .limit(limit + 1);

  // A page's personas come back in one read, not one per row.
  const { items: wanted, nextCursor } = pageOf(rows, limit);
  const personasByVersion = await personasOfVersions(
    db(),
    wanted.map((row) => row.versionId),
  );
  return {
    items: wanted.map(({ content, mockTools, env, ...rest }) => ({
      ...rest,
      ...contentFromRow(content, mockTools, env, rest.versionId),
      personas: personasByVersion.get(rest.versionId) ?? [],
    })),
    nextCursor,
  };
}

/**
 * Permanently remove a test from authoring while retaining its evidence.
 *
 * The expected version and identity revision are compared after the Test row
 * is locked and before it is tombstoned. A caller cannot delete content or
 * identity work that arrived after the Test it reviewed, even when that edit
 * lands between the caller's read and delete.
 */
export async function deleteTest(
  auth: AuthContext,
  id: string,
  expectedVersionId: string,
  expectedRevision: string,
): Promise<boolean> {
  authorize(auth, "author_definitions", here(auth));
  if (!isId("tstv", expectedVersionId)) {
    throw new UnprocessableInputError(
      `"${expectedVersionId}" is not a test version id`,
    );
  }
  if (!isId("rev", expectedRevision)) {
    throw new UnprocessableInputError(
      `"${expectedRevision}" is not a revision id`,
    );
  }
  const projectId = auth.projectId;
  if (projectId === undefined) {
    throw new Error("deleting a test happens inside its project");
  }

  const deletedAt = new Date();
  return db().transaction(async (tx) => {
    await lockRepositoryProject(tx, projectId);
    const [located] = await tx
      .select({ suiteId: test.suiteId })
      .from(test)
      .where(theTest(auth, id))
      .limit(1);
    if (located === undefined) return false;
    await tx
      .select({ id: testSuite.id })
      .from(testSuite)
      .where(eq(testSuite.id, located.suiteId))
      .limit(1)
      .for("update");

    const [locked] = await tx
      .select({
        id: test.id,
        name: test.name,
        currentVersionId: test.currentVersionId,
        revision: test.revision,
      })
      .from(test)
      .where(theTest(auth, id))
      .limit(1)
      .for("update");
    if (locked === undefined) return false;
    expectRevision(locked, expectedRevision);
    if (locked.currentVersionId !== expectedVersionId) {
      throw new TestMovedOnError(locked, {
        expected: expectedVersionId,
        current: locked.currentVersionId,
      });
    }

    await tx
      .update(test)
      .set({
        deletedAt,
        revision: newId("rev"),
        updatedAt: deletedAt,
      })
      .where(eq(test.id, locked.id));
    return true;
  });
}

/**
 * Every version of one test, newest first — the history a detail page shows,
 * and the list an older-version read is chosen from.
 *
 * Deliberately no lifecycle filter on the test: a deleted test's history is
 * exactly as readable as an active one's, because a run that pinned one of
 * these versions is still on the record and still has to be interpretable.
 */
export async function listTestVersions(
  auth: AuthContext,
  testId: string,
  page?: PageRequest,
): Promise<TestVersionPage | undefined> {
  authorize(auth, "read", here(auth));

  const { limit, cursor } = pageWindow(page, {
    singular: "test version",
    plural: "test versions",
    prefix: "tstv",
  });

  const [found] = await db()
    .select({
      id: test.id,
      suiteId: test.suiteId,
      name: test.name,
      currentVersionId: test.currentVersionId,
    })
    .from(test)
    .where(anyTest(auth, testId))
    .limit(1);

  // Told apart from a test with no history, which cannot exist: a test always
  // has a version 1, so an empty page would only ever mean the test is not
  // there — and saying so is what lets a page show a not-found rather than an
  // empty history.
  if (found === undefined) return undefined;

  const rows = await db()
    .select({
      id: testVersion.id,
      testId: testVersion.testId,
      version: testVersion.version,
      ...VERSION_CONTENT_COLUMNS,
      createdAt: testVersion.createdAt,
    })
    .from(testVersion)
    .where(
      and(
        eq(testVersion.testId, found.id),
        cursor === undefined ? undefined : lt(testVersion.id, cursor),
      ),
    )
    .orderBy(desc(testVersion.id))
    .limit(limit + 1);

  const { items, nextCursor } = pageOf(rows, limit);
  const versionIds = items.map((row) => row.id);
  const personasByVersion = await personasOfVersions(db(), versionIds);

  return {
    items: items.map(({ content, mockTools, env, ...row }) => ({
      ...row,
      suiteId: found.suiteId,
      testName: found.name,
      current: row.id === found.currentVersionId,
      ...contentFromRow(content, mockTools, env, row.id),
      personas: personasByVersion.get(row.id) ?? [],
    })),
    nextCursor,
  };
}

export type TestVersionPage = {
  readonly items: readonly TestVersion[];
  readonly nextCursor: string | undefined;
};

/**
 * List active tests whose current version names this persona. Used for persona
 * usage display, not to block deletion. Require an authorized project even for
 * shared Egma-provided personas so the query cannot expose another
 * organization's tests.
 */
export async function liveTestsNamingPersona(
  on: Queryable,
  auth: AuthContext,
  projectId: string,
  personaId: string,
): Promise<readonly TestNamingPersona[]> {
  return on
    .select({ id: test.id, name: test.name })
    .from(testPersona)
    .innerJoin(
      test,
      eq(test.currentVersionId, testPersona.testVersionId),
    )
    .where(
      within(
        auth,
        test,
        and(
          eq(test.projectId, projectId),
          eq(testPersona.personaId, personaId),
          notDeleted,
        ),
      ),
    )
    .orderBy(asc(test.id));
}
