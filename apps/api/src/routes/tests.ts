import {
  authorize,
  createTest,
  editTest,
  getTestVersion,
  listTests,
  NotPermittedError,
  ProjectOutsideOrganizationError,
  resolvePersonaNames,
  TestMovedOnError,
  UnprocessableInputError,
  type MockOverride,
  type MockOverrideInput,
  type Test,
  type TestPersona,
  type TestVersion,
} from "@egma/db";
import { isId } from "@egma/ids";
import type { FastifyInstance } from "fastify";

import type { SessionIdentityProvider } from "../auth/seam.ts";
import { actingIn, cannotActIn, refuseActing } from "../http/acting.ts";
import { credentialed, requesterOf } from "../http/credentialed.ts";
import {
  invalid,
  notFound,
  notPermitted,
  unprocessable,
} from "../http/refusals.ts";
import type { RateLimit } from "../http/rate-limit.ts";
import { given, text, textList } from "../http/reading.ts";

/**
 * The tests on the platform, as a developer's folder syncs against them: the
 * list, one frozen version by its own id, a new test, and an edit to one.
 *
 * Two things about this group are contract rather than convenience, and both are
 * here because a folder is reviewed by people and executed by machines.
 *
 * **Personas cross the wire by name** — as text, never as a structure, so one
 * shape carries them in both directions. `resolvePersonaNames` is where that
 * rule and its refusals live.
 *
 * **A test's mock-tool overrides are content, so they travel with it.** They
 * ride in `mock_tools`, they version with the test exactly as an expected
 * behavior does, and every gate a project mock tool passes they pass — from the
 * same functions, so a rule enforced on one half of the mocked world is not a
 * rule a test could walk around on the other.
 *
 * **An edit carries the version it was written against**, and it is required.
 * The platform compares it against what is current and refuses when the two have
 * parted, naming both. Nothing is merged, because there is no merge that could
 * be right: a teammate editing a test in the dashboard and a developer editing
 * the same test in a file are two people saying different things, and a
 * heuristic that picked one would be egma deciding which of them was wrong. The
 * comparison happens inside the write itself rather than as a read before it,
 * which is what stops a second writer walking through the gap between the two.
 *
 * The addresses follow the standing rule: nothing is rooted at a project, and
 * the organization is never in a path. Both are resolved from the credential. A
 * write may name a project in its body and a read may filter by one; neither has
 * to, and in a single-project organization nothing ever does.
 */

export type TestRoutesOptions = {
  readonly provider: SessionIdentityProvider;
  readonly rateLimit: RateLimit;
};

export const TESTS_PATH = "/api/tests";
export const TEST_PATH = "/api/tests/:testId";
export const TEST_VERSION_PATH = "/api/test-versions/:versionId";

type Body = Record<string, unknown>;

type Query = {
  readonly project?: string;
  readonly cursor?: string;
};

/** A persona as a test names them. */
function describedPersona(named: TestPersona): Record<string, unknown> {
  return { id: named.id, name: named.name };
}

/**
 * What the wire says about one expected behavior: the statement, and nothing
 * else.
 *
 * The store carries a priority beside each statement — P0 blocks a release, P1
 * warns, P2 informs — and the graders judge by it. This door does not carry one
 * in either direction, and that is a stated position rather than an oversight:
 * a file is a list of statements, every statement a test file can write is a
 * P0, and there is no way through here to say otherwise. So the answer says
 * exactly what a caller could have written, and the day this door can set a
 * priority is the day it answers with one.
 */
function describedBehaviors(
  behaviors: readonly { readonly behavior: string }[],
): readonly string[] {
  return behaviors.map((one) => one.behavior);
}

/** The keys one entry of `mock_tools` holds, and no others. */
const OVERRIDE_KEYS = ["tool", "answer", "error", "delay_ms"] as const;

/**
 * One override, as the wire carries it in both directions: the tool it answers
 * for, and the branch it answers with. The two branches are two keys and never
 * one nullable field, because `null` is a perfectly good answer for a tool to
 * give and a shape that could not tell it from "no answer" would make an
 * authored `null` unreadable.
 */
function describedOverride(one: MockOverride): Record<string, unknown> {
  return {
    tool: one.toolName,
    ...(one.answer.error === undefined
      ? { answer: one.answer.answer }
      : { error: one.answer.error }),
    delay_ms: one.delayMilliseconds,
  };
}

/**
 * The overrides a body carries, as the factory takes them.
 *
 * Almost nothing is judged here: how long a delay may be, how large an answer
 * may be, and what a tool name has to say are the factory's rules, held in one
 * place for a project's mock tools and a test's overrides alike — a second
 * opinion here could come to disagree with the one that matters. What this owns
 * is the shape of the envelope, and that a wrong shape is refused rather than
 * dropped: a dropped override is a branch somebody believes their test forces
 * and it does not.
 */
type WrittenOverrides =
  | { readonly entries: readonly MockOverrideInput[] }
  | { readonly refusal: string };

function overrideEntries(value: unknown): WrittenOverrides {
  if (!Array.isArray(value)) {
    return {
      refusal:
        "mock_tools is the list of tools this test answers for itself. Send " +
        'it as a list of objects, like [{"tool": "check_availability", ' +
        '"answer": {"slots": []}}], or leave it out and the project\'s mock ' +
        "tools are the whole world.",
    };
  }

  const entries: MockOverrideInput[] = [];
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      return {
        refusal:
          "each entry in mock_tools names one tool and what it answers with. " +
          'Send objects, like {"tool": "check_availability", "error": "the ' +
          'calendar is unreachable"}.',
      };
    }
    const written = entry as Record<string, unknown>;
    for (const key of Object.keys(written)) {
      if ((OVERRIDE_KEYS as readonly string[]).includes(key)) continue;
      return {
        refusal:
          `a mock tool a test overrides has no key "${key}"; it holds ` +
          OVERRIDE_KEYS.join(", "),
      };
    }

    const gives = "answer" in written;
    const fails = "error" in written;
    if (gives && fails) {
      return {
        refusal:
          "a mock tool answers with one thing: this one sent both answer and " +
          "error. Send whichever branch the test needs.",
      };
    }
    if (!gives && !fails) {
      return {
        refusal:
          "a mock tool answers with something: send answer with what the " +
          "tool returns, or error with the failure it raises. This one sent " +
          "neither.",
      };
    }
    if (fails && typeof written.error !== "string") {
      return {
        refusal:
          "error is the failure this mock tool raises, written as text, and " +
          `one entry in mock_tools sent ${typeof written.error}.`,
      };
    }
    if ("delay_ms" in written && typeof written.delay_ms !== "number") {
      return {
        refusal:
          "delay_ms is how long egma holds an answer back, as a whole number " +
          `of milliseconds, and one entry in mock_tools sent ${typeof written.delay_ms}.`,
      };
    }

    entries.push({
      toolName: typeof written.tool === "string" ? written.tool : "",
      answer: fails
        ? { error: written.error as string }
        : { answer: written.answer },
      ...(typeof written.delay_ms === "number"
        ? { delayMilliseconds: written.delay_ms }
        : {}),
    });
  }
  return { entries };
}

/** A test as it currently stands. One shape for the list and for both writes. */
function described(test: Test): Record<string, unknown> {
  return {
    id: test.id,
    name: test.name,
    version: test.version,
    version_id: test.versionId,
    scenario: test.scenario,
    expected_behaviors: describedBehaviors(test.expectedBehaviors),
    personas: test.personas.map(describedPersona),
    mock_tools: test.mockOverrides.map(describedOverride),
    created_at: test.createdAt.toISOString(),
    updated_at: test.updatedAt.toISOString(),
  };
}

/** One frozen version, and enough about its test to act on it. */
function describedVersion(version: TestVersion): Record<string, unknown> {
  return {
    id: version.id,
    test_id: version.testId,
    test_name: version.testName,
    version: version.version,
    current: version.current,
    scenario: version.scenario,
    expected_behaviors: describedBehaviors(version.expectedBehaviors),
    personas: version.personas.map(describedPersona),
    mock_tools: version.mockOverrides.map(describedOverride),
    created_at: version.createdAt.toISOString(),
  };
}

/**
 * The personas a body names, in the order it named them.
 *
 * **Text, and only text** — a name, or a persona identifier. A file in a
 * repository writes `personas: [impatient-caller]`, and that one shape is what
 * crosses the wire in both directions; a second form accepting the structure a
 * read answers with would be two dialects for one field, and every client would
 * then have to know which one this instance prefers. An entry that is not text
 * is refused rather than dropped, because dropping it would quietly hand the
 * test to the project's default persona instead.
 */
type NamedPersonas =
  | { readonly entries: readonly string[] }
  | { readonly refusal: string };

function personaEntries(value: unknown): NamedPersonas {
  if (!Array.isArray(value)) {
    return {
      refusal:
        "personas is the list of people who call about this test, by name. " +
        'Send it as a list of text, like ["impatient-caller"], or leave it ' +
        "out and egma takes the project's default persona.",
    };
  }

  const entries: string[] = [];
  for (const entry of value) {
    const named = text(entry);
    if (typeof entry !== "string" || named === "") {
      return {
        refusal:
          "a test names each persona as text — their name, or their prs_ " +
          "identifier — and one entry in personas is neither. Send it as a " +
          'list of text, like ["impatient-caller"].',
      };
    }
    entries.push(named);
  }
  return { entries };
}

export async function testRoutes(
  app: FastifyInstance,
  options: TestRoutesOptions,
): Promise<void> {
  credentialed(app, {
    provider: options.provider,
    rateLimit: options.rateLimit,
  });

  /**
   * The project's tests, newest first, one page at a time.
   *
   * `{ items, next_cursor }` is the envelope every list in this API answers
   * with, and the cursor is the last id of the page rather than a count of rows
   * to skip: the ids sort by mint time, so a list changing under a reader never
   * shows them a row twice and never skips one.
   */
  app.get(TESTS_PATH, async (request, reply) => {
    const { auth } = requesterOf(request);
    const query = (request.query ?? {}) as Query;

    const acting = await actingIn(auth, given(query.project));
    if ("refusal" in acting) return refuseActing(reply, acting);

    const cursor = given(query.cursor);
    if (cursor !== undefined && !isId("tst", cursor)) {
      return invalid(
        reply,
        `"${cursor}" is not a cursor this list issued. Send the next_cursor ` +
          `an earlier page answered with, or leave it out to start at the ` +
          `newest test.`,
      );
    }

    const page = await listTests(acting.auth, { cursor });

    return reply.send({
      items: page.items.map(described),
      // Null rather than absent, so a client can tell "there is no next page"
      // from "this response is an older shape that never had one".
      next_cursor: page.nextCursor ?? null,
    });
  });

  /**
   * One frozen version by its own id.
   *
   * This is what a pinned file resolves through, so it says which test the
   * version belongs to and whether the test has moved past it. Both are answers
   * a caller holding only a version id cannot get any other way, and a version
   * outlives its test's deletion, so both stay answerable afterwards.
   */
  app.get(TEST_VERSION_PATH, async (request, reply) => {
    const { auth } = requesterOf(request);
    const { versionId } = request.params as { versionId: string };
    const query = (request.query ?? {}) as Query;

    const acting = await actingIn(auth, given(query.project));
    if ("refusal" in acting) return refuseActing(reply, acting);

    const version = await getTestVersion(acting.auth, versionId);
    if (version === undefined) {
      return notFound(
        reply,
        `there is no test version ${versionId} on this egma. List the tests ` +
          `to see the version each of them stands on now.`,
      );
    }

    return reply.send(describedVersion(version));
  });

  /**
   * A new test.
   *
   * The role is checked before anything is read, which is the stance the factory
   * takes for the same reason: a viewer is refused for being a viewer, rather
   * than after a read that tells them what is there.
   */
  app.post(TESTS_PATH, async (request, reply) => {
    const { auth } = requesterOf(request);
    const body = (request.body ?? {}) as Body;

    authorize(auth, "author_definitions", {
      organizationId: auth.organizationId,
      projectId: auth.projectId,
    });

    const personas =
      "personas" in body ? personaEntries(body.personas) : { entries: [] };
    if ("refusal" in personas) return unprocessable(reply, personas.refusal);

    const overrides =
      "mock_tools" in body ? overrideEntries(body.mock_tools) : { entries: [] };
    if ("refusal" in overrides) return unprocessable(reply, overrides.refusal);

    const acting = await actingIn(auth, given(text(body.project)));
    if ("refusal" in acting) return refuseActing(reply, acting);

    const personaIds = await resolvePersonaNames(acting.auth, personas.entries);

    const created = await createTest(acting.auth, {
      name: text(body.name),
      scenario: text(body.scenario),
      expectedBehaviors: textList(body.expected_behaviors),
      personaIds,
      mockOverrides: overrides.entries,
    });

    return reply.code(201).send(described(created));
  });

  /**
   * An edit, carrying the version it was written against.
   *
   * `expected_version_id` is required, and it is required because it is the
   * whole of the refusal rule: an edit that named no version would be accepted
   * over a test somebody else moved in the meantime, and the later write would
   * quietly become what the test says. It is never a cost to the writer — a
   * create and every read answer the version id.
   *
   * What the body leaves out, the test keeps — the factory's rule, and this
   * relays it rather than restating it. An empty persona list is not the same as
   * leaving the field out: it means what it means on a create, which is that the
   * project's default persona is who calls.
   *
   * Content byte-identical to the current version mints nothing and answers the
   * current version, so a nervous re-push leaves no noise behind. A name is
   * identity: it writes in place and versions nothing.
   */
  app.patch(TEST_PATH, async (request, reply) => {
    const { auth } = requesterOf(request);
    const { testId } = request.params as { testId: string };
    const body = (request.body ?? {}) as Body;

    authorize(auth, "author_definitions", {
      organizationId: auth.organizationId,
      projectId: auth.projectId,
    });

    // Everything answerable without reading anything is answered first, so a
    // body that could never be written is refused before it can learn whether
    // the test it names is there.
    const expectedVersionId = given(text(body.expected_version_id));
    if (expectedVersionId === undefined) {
      return unprocessable(
        reply,
        "an edit says which version it was written against, and this one " +
          "named no expected_version_id. Send the version_id you last read " +
          "for this test, or read the test again and send the version it " +
          "names now.",
      );
    }

    const personas = "personas" in body ? personaEntries(body.personas) : undefined;
    if (personas !== undefined && "refusal" in personas) {
      return unprocessable(reply, personas.refusal);
    }

    const overrides =
      "mock_tools" in body ? overrideEntries(body.mock_tools) : undefined;
    if (overrides !== undefined && "refusal" in overrides) {
      return unprocessable(reply, overrides.refusal);
    }

    const acting = await actingIn(auth, given(text(body.project)));
    if ("refusal" in acting) return refuseActing(reply, acting);

    const personaIds =
      personas === undefined
        ? undefined
        : await resolvePersonaNames(acting.auth, personas.entries);

    const edited = await editTest(acting.auth, testId, {
      expectedVersionId,
      ...("name" in body ? { name: text(body.name) } : {}),
      ...("scenario" in body ? { scenario: text(body.scenario) } : {}),
      ...("expected_behaviors" in body
        ? { expectedBehaviors: textList(body.expected_behaviors) }
        : {}),
      ...(personaIds === undefined ? {} : { personaIds }),
      ...(overrides === undefined ? {} : { mockOverrides: overrides.entries }),
    });

    // A test this credential cannot see reads exactly as a test that is not
    // there, because to this caller those are the same thing.
    if (edited === undefined) {
      return notFound(
        reply,
        `there is no test ${testId} on this egma. List the tests to see what ` +
          `this project holds, or create this one instead of editing it.`,
      );
    }

    return reply.send(described(edited));
  });

  app.setErrorHandler(async (error, _request, reply) => {
    /**
     * The version conflict. The sentence keeps the factory's own words for what
     * happened and adds what to do about it in the vocabulary of this wire,
     * which is the half the factory has no business knowing.
     */
    if (error instanceof TestMovedOnError) {
      // The one refusal in this API that carries more than `{ error, message }`
      // — the caller's next move is to go and read a specific test — so it
      // writes its own body rather than going through the shared answer.
      return reply.code(409).send({
        error: "conflict",
        message:
          `this edit was written against version ${error.expectedVersionId}, ` +
          `and the test has moved on to ${error.currentVersionId}. Read the ` +
          `test again and send the edit with expected_version_id set to the ` +
          `version it names now.`,
        test: { id: error.testId, name: error.testName },
        expected_version_id: error.expectedVersionId,
        current_version_id: error.currentVersionId,
      });
    }

    // The factory turned the write away at its door, in its own words. Relayed
    // rather than rewritten: the sentence is written for whoever has to fix the
    // body, and rewriting it here would put it in two places.
    if (error instanceof UnprocessableInputError) {
      return unprocessable(reply, error.message);
    }

    // Reachable only in a race — the project was checked before the write, and
    // this is what a delete landing in between looks like from inside it.
    if (error instanceof ProjectOutsideOrganizationError) {
      return notPermitted(reply, cannotActIn(error.projectId));
    }

    if (error instanceof NotPermittedError) {
      return notPermitted(reply, error.message);
    }

    throw error;
  });
}
