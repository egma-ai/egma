import { isId, newId } from "@egma/ids";
import { and, asc, desc, eq, inArray, isNull, lt, or, type SQL } from "drizzle-orm";

import { db, type Queryable } from "../client.ts";
import { agent } from "../schema/agents.ts";
import {
  LARGEST_MOCK_TOOL_ANSWER_BYTES,
  LONGEST_MOCK_TOOL_DELAY_MILLISECONDS,
  mockTool,
  mockToolAgent,
} from "../schema/mock-tools.ts";
import type { MockToolAnswer } from "../mock-tools/resolve.ts";
import type { AuthContext } from "./context.ts";
import {
  MockToolTakenError,
  ProjectOutsideOrganizationError,
  UnprocessableInputError,
} from "./errors.ts";
import { lostToConstraint } from "./agents.ts";
import { pageOf, pageWindow, type PageRequest } from "./pages.ts";
import { authorize, here } from "./permissions.ts";
import { isProjectOfOrganization } from "./projects.ts";
import { within } from "./within.ts";

/**
 * Reading and writing mock tools — what they are is the schema file's story
 * (`schema/mock-tools.ts`); this file is how they are reached.
 *
 * Project scoping works as the persona and test factories' does, verb for verb.
 * A context acting in a project writes and reads there; a context acting in
 * none — an organization-scoped credential — reads the whole customer and
 * creates nothing, because a mock tool belongs to a project and a credential
 * for the whole customer is acting in none.
 *
 * **The one factory here with no version table behind it.** `editMockTool`
 * overwrites the row and mints nothing, which is the decision the schema file
 * writes out in full. Every gate an edit passes is the gate a create passes,
 * from the same functions, so a mocked world can never be edited into a shape a
 * create would have refused.
 */

/** What an answer's own validation is about, so a refusal can name the key. */
type AnswerKey = "answer" | "error";

/**
 * What a write says this tool answers with, before anything has judged it.
 *
 * Wider than `MockToolAnswer` on purpose, and this is where the rule about the
 * two keys lives: a caller sends whichever of them it was given and never
 * decides whether that was one, both or neither — `validAnswer` decides, in one
 * place, in one set of words. A door that judged it first would be a second
 * copy of the rule, free to disagree with this one the day either moved.
 */
export type MockToolAnswerInput = {
  readonly answer?: unknown;
  readonly error?: unknown;
};

export type NewMockTool = {
  /** The agent's own name for the tool this answers for. */
  readonly toolName: unknown;
  readonly answer: MockToolAnswerInput;
  /** How long egma holds the answer back. Absent is no delay at all. */
  readonly delayMilliseconds?: number | undefined;
  /**
   * The agents this applies to, by identity. Absent or empty is every agent in
   * the project, which is the ordinary case and the one that keeps two prompt
   * variants comparable.
   */
  readonly agentIds?: readonly string[] | undefined;
};

/** An agent as a mock tool's scope names it: by identity, with its name. */
export type MockToolAgent = {
  readonly id: string;
  readonly name: string;
};

export type MockTool = {
  readonly id: string;
  readonly projectId: string;
  readonly toolName: string;
  readonly answer: MockToolAnswer;
  readonly delayMilliseconds: number;
  /** In the order they were authored; empty means every agent. */
  readonly agents: readonly MockToolAgent[];
  readonly createdAt: Date;
  readonly updatedAt: Date;
};

/**
 * What an edit may touch. Absent means keep — and there is no version to mint,
 * so every one of these overwrites what the row said.
 */
export type MockToolChanges = {
  readonly toolName?: unknown;
  readonly answer?: MockToolAnswerInput;
  readonly delayMilliseconds?: number;
  /**
   * The agents the mock tool should apply to after this edit. An empty list
   * means what it means on a create — every agent in the project — because a
   * mock tool that applied to nobody would be one that answers nothing, and
   * leaving the field out is how a scope is kept as it was.
   */
  readonly agentIds?: readonly string[];
};

export type DeletedMockTool = {
  readonly id: string;
  readonly projectId: string;
  readonly toolName: string;
  readonly deletedAt: Date;
};

const notDeleted: SQL = isNull(mockTool.deletedAt);

/** An answer's columns, and no more — the tenant-free view. */
const COLUMNS = {
  id: mockTool.id,
  projectId: mockTool.projectId,
  toolName: mockTool.toolName,
  answer: mockTool.answer,
  delayMilliseconds: mockTool.delayMilliseconds,
  createdAt: mockTool.createdAt,
  updatedAt: mockTool.updatedAt,
} as const;

/**
 * The tool name as it will be stored: trimmed, because matching is by this
 * string exactly and a name with an invisible character on the end would never
 * match the tool the agent registered.
 */
export function validToolName(name: unknown): string {
  if (typeof name !== "string") {
    throw new UnprocessableInputError(
      "tool is the name of the agent's tool this mock tool answers for, " +
        `written as text, and this request sent ${typeof name}.`,
    );
  }
  const trimmed = name.trim();
  if (trimmed === "") {
    throw new UnprocessableInputError(
      "tool is the name of the agent's tool this mock tool answers for, and " +
        "this one is blank. Send the tool's name exactly as the agent " +
        "registers it.",
    );
  }
  return trimmed;
}

/**
 * The delay as it will be stored.
 *
 * The cap is refused with the number that was sent and the number that is
 * allowed, because the fix is arithmetic the author has to do — and refused at
 * authoring time rather than at call time, where a simulation would already be
 * halfway through a conversation before anybody learned the answer could never
 * arrive.
 */
export function validDelay(milliseconds: number | undefined): number {
  if (milliseconds === undefined) return 0;
  if (!Number.isInteger(milliseconds) || milliseconds < 0) {
    throw new UnprocessableInputError(
      `delay_ms is a whole number of milliseconds, zero or more, and this ` +
        `request sent ${JSON.stringify(milliseconds)}.`,
    );
  }
  if (milliseconds > LONGEST_MOCK_TOOL_DELAY_MILLISECONDS) {
    throw new UnprocessableInputError(
      `delay_ms is ${milliseconds}, and a mock tool may delay its answer by ` +
        `at most ${LONGEST_MOCK_TOOL_DELAY_MILLISECONDS} milliseconds — the ` +
        `budget the exchange carrying it is given. Send a smaller delay_ms.`,
    );
  }
  return milliseconds;
}

/** How many bytes something takes once serialized, as the exchange counts it. */
function serializedBytes(value: unknown, key: AnswerKey): number {
  let written: string | undefined;
  try {
    written = JSON.stringify(value);
  } catch {
    written = undefined;
  }
  if (written === undefined) {
    throw new UnprocessableInputError(
      `${key} has to be something egma can serialize and hand to the agent, ` +
        `and this one is not.`,
    );
  }
  return Buffer.byteLength(written, "utf8");
}

/**
 * The answer as it will be stored: exactly one branch, within the size the
 * exchange can carry.
 *
 * The size is checked here rather than at the transport, because an answer too
 * large is a fact about what somebody wrote and the person who can fix it is
 * reading this refusal — not the simulation that would otherwise have
 * discovered it mid-conversation.
 */
export function validAnswer(answer: MockToolAnswerInput): MockToolAnswer {
  // A key that is there *and* says something. `answer: null` is an answer a
  // tool can perfectly well give and counts; `answer: undefined` is a key
  // carrying nothing and does not, which is what lets the union's own
  // `error: string; answer?: undefined` shape reach the failure branch instead
  // of being refused for saying two things.
  const gives = "answer" in answer && answer.answer !== undefined;
  const fails = "error" in answer && answer.error !== undefined;

  if (gives && fails) {
    throw new UnprocessableInputError(
      "a mock tool answers with one thing: this one sent both answer and " +
        "error. Send whichever branch the test needs.",
    );
  }
  if (!gives && !fails) {
    throw new UnprocessableInputError(
      "a mock tool answers with something: send answer with what the tool " +
        "returns, or error with the failure it raises. This one sent neither.",
    );
  }

  if (fails) {
    const message = answer.error;
    if (typeof message !== "string") {
      throw new UnprocessableInputError(
        "error is the failure this mock tool raises, written as text, and " +
          `this request sent ${typeof message}.`,
      );
    }
    if (message.trim() === "") {
      throw new UnprocessableInputError(
        "error is the failure this mock tool raises, and this one is blank. " +
          "Say what the agent's backend would have said.",
      );
    }
    // Counted the way the value branch is counted — serialized, because that
    // is what the exchange carries and a cap measured two ways is two caps.
    const bytes = serializedBytes(message, "error");
    if (bytes > LARGEST_MOCK_TOOL_ANSWER_BYTES) {
      throw new UnprocessableInputError(tooLarge("error", bytes));
    }
    return { error: message };
  }

  const value = answer.answer;
  const bytes = serializedBytes(value, "answer");
  if (bytes > LARGEST_MOCK_TOOL_ANSWER_BYTES) {
    throw new UnprocessableInputError(tooLarge("answer", bytes));
  }
  return { answer: value };
}

/** The one sentence both branches are refused with, written once. */
function tooLarge(key: AnswerKey, bytes: number): string {
  return (
    `${key} is ${bytes} bytes once serialized, and the exchange that carries ` +
    `it holds at most ${LARGEST_MOCK_TOOL_ANSWER_BYTES}. An answer that ` +
    `needs more than that is a document rather than a tool answer.`
  );
}

/**
 * Everything about the named ids that is answerable without the database: every
 * one is an agent's identifier, and each one is named once. Naming the same
 * agent twice says nothing the first naming did not, so it is refused rather
 * than silently collapsed.
 */
function validateAgentIds(ids: readonly string[]): void {
  const seen = new Set<string>();
  for (const id of ids) {
    if (!isId("agt", id)) {
      throw new UnprocessableInputError(
        `agents names "${id}", which is not an agent id`,
      );
    }
    if (seen.has(id)) throw new UnprocessableInputError(namedTwice(id));
    seen.add(id);
  }
}

/**
 * The sentence a scope naming one agent twice is refused with. Both the ids a
 * caller handed over and the names the resolver turned into ids come through
 * it, so the two paths cannot come to say it differently.
 */
function namedTwice(agentId: string): string {
  return `agents names agent ${agentId} twice; name each agent once`;
}

/**
 * The shape guard on every read. Stored jsonb comes back `unknown`, and a row
 * somebody hand-edited must fail here, loudly and naming itself, rather than
 * leak into a caller as a `MockToolAnswer` that isn't one.
 *
 * Shape only, deliberately, and the size cap is not re-applied: an answer
 * written when the cap was larger has to stay readable exactly as it was
 * written, exactly as an old persona's voice provider is taken on trust once it
 * is a string.
 */
export function answerFromRow(value: unknown, id: string): MockToolAnswer {
  const malformed = () =>
    new Error(
      `mock tool ${id} holds an answer in a shape egma never writes; the row needs repairing before anybody can read it`,
    );

  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw malformed();
  }
  const held = value as Record<string, unknown>;
  if ("error" in held) {
    if (typeof held.error !== "string" || held.error === "") throw malformed();
    return { error: held.error };
  }
  if (!("answer" in held)) throw malformed();
  return { answer: held.answer };
}

/** Acting in a project narrows to it; acting in none reaches the customer. */
function inActingProject(auth: AuthContext): SQL | undefined {
  return auth.projectId === undefined
    ? undefined
    : eq(mockTool.projectId, auth.projectId);
}

/** The named mock tool, alive, within the caller's tenancy and scope. */
function theMockTool(auth: AuthContext, id: string): SQL {
  return within(
    auth,
    mockTool,
    and(eq(mockTool.id, id), notDeleted, inActingProject(auth)),
  );
}

/**
 * The agents of several mock tools at once, keyed by mock tool and each list in
 * the order it was authored — one read for a whole page rather than one read
 * per row.
 *
 * The `where` starts from a bare `inArray` rather than `within`: every caller
 * hands it ids that have already come off tenancy-checked rows, so the
 * predicate cannot reach further than that check already did.
 */
async function agentsOfMockTools(
  on: Queryable,
  ids: readonly string[],
): Promise<Map<string, MockToolAgent[]>> {
  const byMockTool = new Map<string, MockToolAgent[]>();
  if (ids.length === 0) return byMockTool;

  const rows = await on
    .select({
      mockToolId: mockToolAgent.mockToolId,
      id: agent.id,
      name: agent.name,
    })
    .from(mockToolAgent)
    .innerJoin(agent, eq(mockToolAgent.agentId, agent.id))
    .where(inArray(mockToolAgent.mockToolId, [...ids]))
    .orderBy(asc(mockToolAgent.mockToolId), asc(mockToolAgent.position));

  for (const { mockToolId, ...named } of rows) {
    const already = byMockTool.get(mockToolId);
    if (already === undefined) byMockTool.set(mockToolId, [named]);
    else already.push(named);
  }
  return byMockTool;
}

/** The one mock tool's agents, in the order they were authored. */
async function agentsOf(
  on: Queryable,
  id: string,
): Promise<readonly MockToolAgent[]> {
  return (await agentsOfMockTools(on, [id])).get(id) ?? [];
}

/**
 * Whether the ids a write names are agents this project holds: each one exists,
 * is alive, and is this project's.
 *
 * One read for the whole set, and one refusal per id that did not come back
 * whole. An agent of another customer or another project is not found and is
 * refused in the same words as one that never existed, because confirming that
 * somebody else's row exists is itself a leak.
 *
 * **No shared lock, unlike the same check for a test's personas**, and the
 * difference is the invariant rather than the care taken. A live test may never
 * name a deleted persona, so a persona's delete is refused while one does and
 * the two writes have to be made to wait for each other. Nothing refuses an
 * agent's delete, because a mock tool scoped to a deleted agent loses nothing:
 * it simply never applies, since no run is conducted against a deleted agent.
 * A lock here would hold an invariant that does not exist.
 */
async function validateNamedAgents(
  on: Queryable,
  auth: AuthContext,
  projectId: string,
  ids: readonly string[],
): Promise<void> {
  if (ids.length === 0) return;

  const found = new Map(
    (
      await on
        .select({ id: agent.id, deletedAt: agent.deletedAt })
        .from(agent)
        .where(
          within(
            auth,
            agent,
            and(inArray(agent.id, [...ids]), eq(agent.projectId, projectId)),
          ),
        )
    ).map((row) => [row.id, row.deletedAt] as const),
  );

  for (const id of ids) {
    if (!found.has(id) || found.get(id) !== null) {
      throw new UnprocessableInputError(noSuchAgent(id));
    }
  }
}

/** The sentence a scope naming an unreachable agent is refused with. */
function noSuchAgent(named: string): string {
  return (
    `agents names ${named}, and there is no agent ${named} in this project. ` +
    `Name an agent this project already holds, or leave agents out and the ` +
    `mock tool applies to every agent in the project.`
  );
}

/**
 * The agent ids a write names, from the names or ids a reviewed file carries.
 *
 * A mock tool in somebody's repository says `agents: [front-desk]`, because a
 * folder a team reads in pull requests cannot be a folder of identifiers.
 * Turning those names into identity is the platform's job, and this is where it
 * happens. An identifier resolves too, so a caller already holding one does not
 * have to find a name for it first.
 *
 * A living agent's name is unique inside its project — the agent factory
 * refuses a second one — so unlike a persona there is never a name two rows
 * answer to, and this needs no rule for picking between them.
 */
export async function resolveMockToolAgents(
  auth: AuthContext,
  named: readonly string[],
): Promise<readonly string[]> {
  authorize(auth, "read", here(auth));

  const { projectId } = auth;
  if (projectId === undefined) {
    throw new Error(
      "a mock tool belongs to a project, and this credential is for the whole organization and acting in none",
    );
  }

  const wanted = named.map((entry) => entry.trim());
  if (wanted.length === 0) return [];

  const rows = await db()
    .select({ id: agent.id, name: agent.name, deletedAt: agent.deletedAt })
    .from(agent)
    .where(
      within(
        auth,
        agent,
        and(
          eq(agent.projectId, projectId),
          isNull(agent.deletedAt),
          or(inArray(agent.id, wanted), inArray(agent.name, wanted)),
        ),
      ),
    );

  const resolved: string[] = [];
  for (const entry of wanted) {
    // The identifier first, so a project holding an agent whose *name* is
    // another agent's identifier still resolves the identifier to the row it
    // names. Nothing stops somebody authoring such a name.
    const byId = rows.filter((row) => row.id === entry);
    const [found] = byId.length > 0 ? byId : rows.filter((row) => row.name === entry);

    if (found === undefined) throw new UnprocessableInputError(noSuchAgent(entry));
    if (resolved.includes(found.id)) {
      throw new UnprocessableInputError(namedTwice(found.id));
    }
    resolved.push(found.id);
  }

  return resolved;
}

/** The junction rows of one mock tool, in the order the ids were authored. */
async function scopeTo(
  on: Queryable,
  id: string,
  projectId: string,
  agentIds: readonly string[],
): Promise<void> {
  if (agentIds.length === 0) return;

  await on.insert(mockToolAgent).values(
    agentIds.map((agentId, index) => ({
      mockToolId: id,
      agentId,
      projectId,
      position: index + 1,
    })),
  );
}

/** The unique index's own name, so the loser of a race is recognised by it. */
const ONE_ANSWER_PER_TOOL = "mock_tool_project_id_tool_name_unique";

/**
 * The refusal both writes share, for the moment the database says this project
 * already answers for the tool.
 *
 * **Two writes arriving at the same instant both pass the check below**, and
 * the unique index is what stops the second — so the loser is answered here, in
 * the same words rather than as a driver error. Which row won is read fresh, on
 * a connection outside the transaction the violation just rolled back; if the
 * winner has since been deleted there is nothing honest to name, and the
 * refusal says the same thing without naming one.
 */
async function refusingATakenTool(
  auth: AuthContext,
  projectId: string,
  toolName: string,
  error: unknown,
): Promise<never> {
  if (!lostToConstraint(error, ONE_ANSWER_PER_TOOL)) throw error;
  throw new MockToolTakenError(
    toolName,
    await answeredAlreadyBy(db(), auth, projectId, toolName),
  );
}

/**
 * Whether this project already answers for the tool, and which row does.
 *
 * The unique index refuses the second row anyway, and that second line is what
 * covers migration scripts, manual fixes and the two writes that arrived at the
 * same instant. A write that comes through this module is refused before it
 * reaches the database, so the refusal can name the row standing in the way and
 * say what to do instead.
 */
async function answeredAlreadyBy(
  on: Queryable,
  auth: AuthContext,
  projectId: string,
  toolName: string,
  exceptId?: string,
): Promise<string | undefined> {
  const [row] = await on
    .select({ id: mockTool.id })
    .from(mockTool)
    .where(
      within(
        auth,
        mockTool,
        and(
          eq(mockTool.projectId, projectId),
          eq(mockTool.toolName, toolName),
          notDeleted,
        ),
      ),
    )
    .limit(1);

  return row === undefined || row.id === exceptId ? undefined : row.id;
}

export async function createMockTool(
  auth: AuthContext,
  input: NewMockTool,
): Promise<MockTool> {
  authorize(auth, "author_definitions", here(auth));

  const { projectId } = auth;
  if (projectId === undefined) {
    throw new Error(
      "a mock tool belongs to a project, and this credential is for the whole organization and acting in none",
    );
  }

  // Everything answerable without the database is answered first; only an
  // input worth writing costs the reads below.
  const toolName = validToolName(input.toolName);
  const answer = validAnswer(input.answer);
  const delayMilliseconds = validDelay(input.delayMilliseconds);
  const agentIds = input.agentIds ?? [];
  validateAgentIds(agentIds);

  if (!(await isProjectOfOrganization(auth, projectId))) {
    throw new ProjectOutsideOrganizationError(auth.organizationId, projectId);
  }

  const id = newId("mck");

  const written = await db()
    .transaction(async (tx) => {
      const taken = await answeredAlreadyBy(tx, auth, projectId, toolName);
      if (taken !== undefined) throw new MockToolTakenError(toolName, taken);
      await validateNamedAgents(tx, auth, projectId, agentIds);

      const [row] = await tx
        .insert(mockTool)
        .values({
          id,
          organizationId: auth.organizationId,
          projectId,
          toolName,
          answer,
          delayMilliseconds,
          createdBy: auth.userId,
        })
        .returning(COLUMNS);

      if (row === undefined) throw new Error("the mock tool was not written");

      await scopeTo(tx, id, projectId, agentIds);
      // Read back inside the transaction, so what the create answers with is
      // what the transaction wrote and checked.
      return { ...row, agents: await agentsOf(tx, id) };
    })
    .catch((error: unknown) =>
      refusingATakenTool(auth, projectId, toolName, error),
    );

  return { ...written, answer: answerFromRow(written.answer, written.id) };
}

/**
 * One door for every change, and it overwrites.
 *
 * There is no version to mint and no pointer to move: an edit writes over what
 * the row said, which is the exemption the schema file argues out in full. The
 * scope is rewritten wholesale rather than diffed, because a scope is a set and
 * a partial rewrite would leave a mock tool applying to an agent nobody named.
 *
 * Editing what the caller cannot see returns what reading it would have:
 * `undefined`, with nothing disturbed.
 */
export async function editMockTool(
  auth: AuthContext,
  id: string,
  changes: MockToolChanges,
): Promise<MockTool | undefined> {
  authorize(auth, "author_definitions", here(auth));

  // Everything answerable without the database is answered first, exactly as
  // create answers it, so an edit is refused on the same grounds a create is.
  const toolName =
    changes.toolName === undefined ? undefined : validToolName(changes.toolName);
  const answer =
    changes.answer === undefined ? undefined : validAnswer(changes.answer);
  const delayMilliseconds =
    changes.delayMilliseconds === undefined
      ? undefined
      : validDelay(changes.delayMilliseconds);
  const agentIds = changes.agentIds;
  if (agentIds !== undefined) validateAgentIds(agentIds);

  /**
   * Which project the row turned out to be in, kept for the refusal outside.
   * A rename can lose the same race a create can, and the loser is answered in
   * the same words — which needs the project the winner is in, and only the
   * locked row knows it: the credential may be for the whole customer and name
   * none. Set before anything can violate the index, so the refusal path can
   * never read it unset.
   */
  let home: string | undefined;

  const written = await db().transaction(async (tx) => {
    const [locked] = await tx
      .select({ ...COLUMNS, currentToolName: mockTool.toolName })
      .from(mockTool)
      .where(theMockTool(auth, id))
      .limit(1)
      .for("update");

    if (locked === undefined) return undefined;
    home = locked.projectId;

    if (toolName !== undefined && toolName !== locked.currentToolName) {
      const taken = await answeredAlreadyBy(
        tx,
        auth,
        locked.projectId,
        toolName,
        locked.id,
      );
      if (taken !== undefined) throw new MockToolTakenError(toolName, taken);
    }
    if (agentIds !== undefined) {
      await validateNamedAgents(tx, auth, locked.projectId, agentIds);
    }

    // A bare `eq` on an id that just came off the tenancy-checked row locked
    // above, in this same transaction, so it reaches no further than that check
    // already did — the move every other factory makes, for the same reason.
    const [row] = await tx
      .update(mockTool)
      .set({
        ...(toolName === undefined ? {} : { toolName }),
        ...(answer === undefined ? {} : { answer }),
        ...(delayMilliseconds === undefined ? {} : { delayMilliseconds }),
        updatedAt: new Date(),
      })
      .where(eq(mockTool.id, locked.id))
      .returning(COLUMNS);

    if (row === undefined) throw new Error("the mock tool was not written");

    if (agentIds !== undefined) {
      await tx
        .delete(mockToolAgent)
        .where(eq(mockToolAgent.mockToolId, locked.id));
      await scopeTo(tx, locked.id, locked.projectId, agentIds);
    }

    return { ...row, agents: await agentsOf(tx, locked.id) };
  }).catch((error: unknown) => {
    // A rename that lost the same race a create can lose. Nothing before the
    // row is locked can violate the index, so `home` is always set by the time
    // this can be reached — and if it somehow is not, the original error goes
    // on rather than a refusal built from a project nobody read.
    if (home === undefined) throw error;
    return refusingATakenTool(auth, home, toolName ?? "", error);
  });

  if (written === undefined) return undefined;
  return { ...written, answer: answerFromRow(written.answer, written.id) };
}

export type MockToolPage = {
  readonly items: readonly MockTool[];
  /** Hand back as `cursor` to continue; absent on the last page. */
  readonly nextCursor: string | undefined;
};

/**
 * One page of the mock tools the caller can reach — the acting project's, or
 * the whole customer's for a credential acting in none — and where the next
 * page starts.
 *
 * Newest first, on the id, exactly as every other list in this module: the ids
 * are Crockford base32 of UUIDv7 under `COLLATE "C"`, so ordering by id *is*
 * ordering by mint time and the last id of a page is the whole cursor.
 */
export async function listMockTools(
  auth: AuthContext,
  page?: PageRequest,
): Promise<MockToolPage> {
  authorize(auth, "read", here(auth));

  const { limit, cursor } = pageWindow(page, {
    singular: "mock tool",
    plural: "mock tools",
    prefix: "mck",
  });
  const olderThanCursor =
    cursor === undefined ? undefined : lt(mockTool.id, cursor);

  const rows = await db()
    .select(COLUMNS)
    .from(mockTool)
    .where(
      within(
        auth,
        mockTool,
        and(notDeleted, inActingProject(auth), olderThanCursor),
      ),
    )
    .orderBy(desc(mockTool.id))
    .limit(limit + 1);

  // A page's agents come back in one read, not one per row.
  const { items, nextCursor } = pageOf(rows, limit);
  const byMockTool = await agentsOfMockTools(
    db(),
    items.map((row) => row.id),
  );

  return {
    items: items.map((row) => ({
      ...row,
      answer: answerFromRow(row.answer, row.id),
      agents: byMockTool.get(row.id) ?? [],
    })),
    nextCursor,
  };
}

/**
 * The soft-delete marker, and only the marker.
 *
 * The mock tool vanishes from lists and from every run started afterwards; the
 * runs already started keep answering exactly what they resolved, because their
 * snapshot is a copy rather than a pointer. That is the same property that lets
 * an edit overwrite in place, applied to the last edit there is.
 *
 * Like create, this refuses a credential acting in no project: an edit lands on
 * a row that already names its own project, and taking a mock tool out of a
 * project is an act taken inside one.
 */
export async function deleteMockTool(
  auth: AuthContext,
  id: string,
): Promise<DeletedMockTool | undefined> {
  authorize(auth, "author_definitions", here(auth));

  if (auth.projectId === undefined) {
    throw new Error(
      "deleting a mock tool happens inside its project, and this credential is for the whole organization and acting in none",
    );
  }

  const deletedAt = new Date();
  const [row] = await db()
    .update(mockTool)
    .set({ deletedAt, updatedAt: deletedAt })
    .where(theMockTool(auth, id))
    .returning({
      id: mockTool.id,
      projectId: mockTool.projectId,
      toolName: mockTool.toolName,
    });

  if (row === undefined) return undefined;
  return { ...row, deletedAt };
}

/**
 * The project's mock tools that apply to one agent, as a run freezes them.
 *
 * A mock tool with no scope applies to every agent, so it is here whatever the
 * run is conducted against; one naming agents is here only when it names this
 * one. Ordered by identity so a run's frozen world reads in the order the mock
 * tools were authored, which is stable across every run of the project.
 *
 * Exported to the module, not from the package: it answers a question the run
 * factory has to ask before it writes a header, and the mock-tool tables have
 * one owner, which is this file.
 */
export async function mockToolsApplyingTo(
  on: Queryable,
  auth: AuthContext,
  projectId: string,
  agentId: string,
): Promise<readonly MockTool[]> {
  const rows = await on
    .select(COLUMNS)
    .from(mockTool)
    .where(
      within(
        auth,
        mockTool,
        and(eq(mockTool.projectId, projectId), notDeleted),
      ),
    )
    .orderBy(asc(mockTool.id));

  const byMockTool = await agentsOfMockTools(
    on,
    rows.map((row) => row.id),
  );

  return rows
    .map((row) => ({
      ...row,
      answer: answerFromRow(row.answer, row.id),
      agents: byMockTool.get(row.id) ?? [],
    }))
    .filter(
      (one) =>
        one.agents.length === 0 ||
        one.agents.some((named) => named.id === agentId),
    );
}
