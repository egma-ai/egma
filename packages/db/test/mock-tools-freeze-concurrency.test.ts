import { newId } from "@egma/ids";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createAgent, createMockTool, editMockTool, type AuthContext } from "@egma/db";

import { db, type Queryable } from "../src/client.ts";
import { mockToolsApplyingTo } from "../src/access/mock-tools.ts";
import {
  createConnectedDatabase,
  type MigratedDatabase,
} from "./support/database.ts";
import { seedOrganization, seedUser } from "./support/tenancy.ts";

/**
 * The world a run freezes, against an edit landing while it is being read.
 *
 * A mock tool's answer and the agents it applies to are **one fact**, written
 * together in one transaction. Postgres reads at READ COMMITTED, where every
 * *statement* takes its own snapshot — so a freeze that read the answers in one
 * statement and the scopes in another could take the answer from before an edit
 * and the scope from after it. That pairing never existed on any row at any
 * instant, and a run's snapshot is immutable, so it would stay on the record for
 * as long as the run is kept: a mock tool re-scoped from one agent to another
 * mid-freeze would be frozen serving the new agent the old answer.
 *
 * The guarantee under test is Postgres's, not egma's arithmetic: one statement
 * sees one snapshot. So these tests reach past the package to the freeze's own
 * seam — it takes its `Queryable` as an argument — and hand it a connection that
 * counts statements and can commit an edit between them. The freeze is given
 * the pool here rather than a transaction; it makes no difference to what is
 * being proved, because a READ COMMITTED transaction takes a fresh snapshot per
 * statement exactly as autocommit does.
 *
 * Deterministic throughout: the edit is committed by a hook the read itself
 * triggers, never by a timer.
 */

let database: MigratedDatabase;

const organizationId = newId("org");
const projectId = newId("prj");
const ada = newId("usr");

const auth: AuthContext = {
  userId: ada,
  organizationId,
  projectId,
  role: "member",
  via: "session",
};

/** The agent the mock tool is scoped to before the edit… */
let frontDesk: string;
/** …and the one it is scoped to after it. */
let nightDesk: string;

const BEFORE_ANSWER = { slots: ["Tuesday 14:00"] };
const AFTER_ANSWER = { slots: [] };

/** One mock tool as this file compares them: the three fields the edit moves. */
type Readable = {
  tool: string;
  answer: unknown;
  agents: readonly string[];
};

function readable(
  world: readonly Awaited<ReturnType<typeof mockToolsApplyingTo>>[number][],
  /**
   * The one tool a test is about. Every test here shares the project, so the
   * mock tools of the others are in the world too — naming the one under test
   * is what keeps these independent of the order they run in.
   */
  only?: string,
): Readable[] {
  return world
    .filter((one) => only === undefined || one.toolName === only)
    .map((one) => ({
      tool: one.toolName,
      answer: one.answer,
      agents: one.agents.map((named) => named.id),
    }));
}

/**
 * A `Queryable` that counts the statements a read issues, and may commit
 * something of its own between them.
 *
 * `select()` is where a statement begins, so counting there counts statements —
 * each chain this module builds becomes exactly one. The hook is awaited before
 * the statement it precedes actually runs, which is what makes the interleaving
 * a fact rather than a race: the builder is thenable, so the wrapper stands in
 * front of `then` and lets the hook finish first.
 */
function watching(
  inner: Queryable,
  beforeStatement?: (nth: number) => Promise<void>,
): { on: Queryable; statements: () => number } {
  let statements = 0;

  const deferring = <T extends object>(built: T, hook: () => Promise<void>): T =>
    new Proxy(built, {
      get(target, property, receiver) {
        if (property === "then") {
          return (
            resolve: (value: unknown) => unknown,
            reject: (reason: unknown) => unknown,
          ) =>
            hook()
              .then(() => (target as PromiseLike<unknown>).then((value) => value))
              .then(resolve, reject);
        }
        const held = Reflect.get(target, property, receiver) as unknown;
        if (typeof held !== "function") return held;
        // Every chained call returns the next builder, so the wrapper has to
        // travel with it or `then` would arrive on an unwrapped object.
        return (...args: unknown[]) => {
          const next = Reflect.apply(held as (...a: unknown[]) => unknown, target, args);
          return typeof next === "object" && next !== null
            ? deferring(next as object, hook)
            : next;
        };
      },
    }) as T;

  const on = new Proxy(inner as object, {
    get(target, property, receiver) {
      const held = Reflect.get(target, property, receiver) as unknown;
      if (property !== "select" || typeof held !== "function") return held;
      return (...args: unknown[]) => {
        statements += 1;
        const nth = statements;
        const built = Reflect.apply(
          held as (...a: unknown[]) => unknown,
          target,
          args,
        ) as object;
        if (beforeStatement === undefined) return built;
        return deferring(built, () => beforeStatement(nth));
      };
    },
  }) as Queryable;

  return { on, statements: () => statements };
}

/** The whole edit, as one transaction: a new answer and a new scope together. */
async function reScopeAndReAnswer(mockToolId: string): Promise<void> {
  await editMockTool(auth, mockToolId, {
    answer: { answer: AFTER_ANSWER },
    agentIds: [nightDesk],
  });
}

async function aMockToolScopedToFrontDesk(toolName: string): Promise<string> {
  return (
    await createMockTool(auth, {
      toolName,
      answer: { answer: BEFORE_ANSWER },
      agentIds: [frontDesk],
    })
  ).id;
}

beforeAll(async () => {
  database = await createConnectedDatabase("mock_tools_freeze");

  await seedOrganization(database, organizationId, [
    { id: projectId, slug: "default" },
  ]);
  await seedUser(database, ada, "ada@acme.example");

  frontDesk = (
    await createAgent(auth, {
      agentPlatform: "retell",
      name: "Front desk",
      connection: {
        agentPlatform: "retell",
        connectionType: "retell_chat_api",
        accessVariant: "retell_chat_api.api_key",
        modality: "chat",
        config: { retellAgentId: "agent_in_retell_front" },
        credentials: { apiKey: "retell-secret-A1B2C3D4WXYZ" },
      },
    })
  ).id;

  nightDesk = (
    await createAgent(auth, {
      agentPlatform: "retell",
      name: "Night desk",
      connection: {
        agentPlatform: "retell",
        connectionType: "retell_chat_api",
        accessVariant: "retell_chat_api.api_key",
        modality: "chat",
        config: { retellAgentId: "agent_in_retell_night" },
        credentials: { apiKey: "retell-secret-E5F6G7H8WXYZ" },
      },
    })
  ).id;
});

afterAll(async () => {
  await database.drop();
});

describe("the world a run freezes", () => {
  /**
   * The mechanism, said plainly: one statement is one snapshot. Everything
   * below rests on it, and it is the thing a later edit could quietly undo by
   * splitting the read in two again for a reason that looked good at the time.
   */
  it("is read in a single statement, whatever it holds", async () => {
    await aMockToolScopedToFrontDesk("count_one_statement");
    await createMockTool(auth, {
      toolName: "applies_to_everybody",
      answer: { answer: { ok: true } },
    });

    const watched = watching(db());
    const frozen = await mockToolsApplyingTo(
      watched.on,
      auth,
      projectId,
      nightDesk,
    );

    expect(watched.statements()).toBe(1);
    // And it really did read something, so the count above is not the count of
    // a read that did nothing.
    expect(readable(frozen).map((one) => one.tool)).toContain(
      "applies_to_everybody",
    );
  });

  /**
   * The property the single statement buys, against the edit that used to tear
   * it: a mock tool moved from one agent to another *and* re-answered, in one
   * transaction, committing while the freeze is reading.
   *
   * Two worlds are truthful — the one before the edit and the one after it —
   * and the mix of them is not. Read in two statements this returned the mix:
   * the night desk covered, carrying the answer only the front desk was ever
   * served. Read in one, there is no moment between statements for the edit to
   * land in.
   */
  it("never pairs an answer with a scope that never applied to it", async () => {
    const mockToolId = await aMockToolScopedToFrontDesk("check_calendar");

    let edits = 0;
    const watched = watching(db(), async (nth) => {
      // Every statement after the first: exactly the window the two-statement
      // read left open. The edit is committed whole before that statement runs.
      if (nth === 1) return;
      edits += 1;
      await reScopeAndReAnswer(mockToolId);
    });

    const frozen = readable(
      await mockToolsApplyingTo(watched.on, auth, projectId, nightDesk),
      "check_calendar",
    );

    const beforeTheEdit: Readable[] = [];
    const afterTheEdit: Readable[] = [
      {
        tool: "check_calendar",
        answer: { answer: AFTER_ANSWER },
        agents: [nightDesk],
      },
    ];

    // The two truthful answers. The torn one — the night desk covered, carrying
    // the answer from before the edit — is neither of them.
    expect([beforeTheEdit, afterTheEdit]).toContainEqual(frozen);
    // And it is the earlier of the two, because the one statement ran to
    // completion before anything else could commit.
    expect(frozen).toEqual(beforeTheEdit);
    // The window closed rather than the edit being skipped: there was no
    // second statement for it to land between.
    expect(edits).toBe(0);
  });

  /**
   * The other half of the same claim: the read is consistent because it takes
   * one snapshot, not because it stopped seeing edits. An edit committed before
   * the freeze is whole in it.
   */
  it("sees an edit that committed before it, whole", async () => {
    const mockToolId = await aMockToolScopedToFrontDesk("send_confirmation");
    await editMockTool(auth, mockToolId, {
      answer: { answer: AFTER_ANSWER },
      agentIds: [nightDesk],
    });

    const frozen = readable(
      await mockToolsApplyingTo(db(), auth, projectId, nightDesk),
    );

    expect(frozen).toContainEqual({
      tool: "send_confirmation",
      answer: { answer: AFTER_ANSWER },
      agents: [nightDesk],
    });
    // And the front desk, which the edit took it away from, no longer has it.
    expect(
      readable(
        await mockToolsApplyingTo(db(), auth, projectId, frontDesk),
      ).map((one) => one.tool),
    ).not.toContain("send_confirmation");
  });
});
