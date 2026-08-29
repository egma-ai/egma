import { afterAll, describe, expect, it } from "vitest";

import {
  branchAgentVersion,
  deleteAgentVersion,
  readEngineConfiguration,
  resolveAgentVersion,
  RETELL_API,
  type RetellCredential,
} from "../src/index.ts";

/**
 * Does branching an agent version fork a **Retell LLM** the way it provably
 * forks a conversation flow?
 *
 * The flow half is observed behaviour: `create-agent-version` mints a new
 * agent version with its own freshly forked flow version. The Retell-LLM half
 * is not — there is no LLM-versioning endpoint in the API at all, and
 * `response_engine.version` is the only pointer — so the question is settled
 * here, by a test, rather than by an assumption in the builder. **The builder
 * never assumes the answer either way**: its fork guard refuses a branch whose
 * engine reference still matches the serving version's, before any write.
 * Whatever this test finds is informational.
 *
 * ## The one command
 *
 * ```sh
 * EGMA_LIVE_RETELL_API_KEY=<a Retell key> \
 *   npx vitest run --root packages/retell --config /dev/null test/live-fork.test.ts
 * ```
 *
 * Without that variable every check here is **skipped, visibly** — Vitest
 * prints them as skipped rather than passing them in silence. CI has no key, so
 * CI never touches an account.
 *
 * ## What it does to the account
 *
 * It creates everything it touches and deletes everything it created, in a
 * `finally` that runs even when a check fails: one scratch Retell LLM, one
 * scratch agent pointing at it, and one branched version of that agent. It
 * **binds no telephone number**, publishes nothing, and never reads or writes
 * any agent that was already on the account. A crash between the create and the
 * delete leaves two objects named `egma-fork-check-…` and nothing else.
 *
 * ## Who runs it
 *
 * The developer, by hand. Agents never execute against a live account. When it
 * is run, its finding goes — dated — into the research file this effort was
 * built from: `.scratch/mock-tools/research/retell-mocking-surface.md`.
 */

const LIVE_KEY_VARIABLE = "EGMA_LIVE_RETELL_API_KEY";
const liveKey = (process.env[LIVE_KEY_VARIABLE] ?? "").trim();
const live = liveKey === "" ? describe.skip : describe;

const key: RetellCredential = { reveal: () => liveKey };

/** A name nobody would mistake for a real agent, unique per run. */
const SCRATCH_NAME = `egma-fork-check-${Date.now()}`;

/** What this test made, so the teardown can unmake exactly that. */
const made: {
  llmId: string | null;
  agentId: string | null;
  branchedVersion: number | null;
} = { llmId: null, agentId: null, branchedVersion: null };

/**
 * The three scaffolding calls this check needs and the product does not.
 *
 * Deliberately here rather than in the client: egma never creates or deletes a
 * customer's agent, so those verbs have no place in the shared surface. A test
 * that needs a scratch agent of its own writes its own request.
 */
async function scratch(
  method: "POST" | "DELETE",
  path: string,
  body?: unknown,
): Promise<{ status: number; document: Record<string, unknown> }> {
  const response = await fetch(`${RETELL_API}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${liveKey}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  let document: Record<string, unknown> = {};
  try {
    const held: unknown = JSON.parse(text);
    if (typeof held === "object" && held !== null) {
      document = held as Record<string, unknown>;
    }
  } catch {
    document = {};
  }
  return { status: response.status, document };
}

afterAll(async () => {
  if (liveKey === "") return;
  // Deletes before anything else, and each one on its own, so one failure
  // cannot stop the next: the account is left as it was found even when a
  // check above threw.
  if (made.agentId !== null && made.branchedVersion !== null) {
    await deleteAgentVersion(key, made.agentId, made.branchedVersion).catch(
      () => undefined,
    );
  }
  if (made.agentId !== null) {
    await scratch("DELETE", `/delete-agent/${made.agentId}`).catch(
      () => undefined,
    );
  }
  if (made.llmId !== null) {
    await scratch("DELETE", `/delete-retell-llm/${made.llmId}`).catch(
      () => undefined,
    );
  }
});

live("branching a live Retell-LLM agent", () => {
  it("forks its response engine, or says plainly that it does not", async () => {
    const llm = await scratch("POST", "/create-retell-llm", {
      general_prompt: "You are a scratch agent for an egma fork check.",
      general_tools: [
        {
          type: "custom",
          name: "egma_fork_check_tool",
          description: "Never called. It exists so the fork has something to fork.",
          url: "https://example.com/egma-fork-check",
          method: "POST",
          headers: {},
          parameters: { type: "object", properties: {} },
        },
      ],
    });
    expect(llm.status, JSON.stringify(llm.document)).toBeLessThan(300);
    made.llmId = String(llm.document["llm_id"] ?? "");
    expect(made.llmId).not.toBe("");

    const agent = await scratch("POST", "/create-agent", {
      agent_name: SCRATCH_NAME,
      voice_id: "11labs-Adrian",
      response_engine: { type: "retell-llm", llm_id: made.llmId },
    });
    expect(agent.status, JSON.stringify(agent.document)).toBeLessThan(300);
    made.agentId = String(agent.document["agent_id"] ?? "");
    expect(made.agentId).not.toBe("");

    const serving = await resolveAgentVersion(key, made.agentId, "latest");
    expect(serving.kind).toBe("version");
    if (serving.kind !== "version") return;

    const branched = await branchAgentVersion(
      key,
      made.agentId,
      serving.agentVersion.version,
    );
    expect(branched.kind).toBe("branched");
    if (branched.kind !== "branched") return;
    made.branchedVersion = branched.agentVersion.version;

    // The finding, recorded verbatim so the research file gets the exact
    // shapes rather than a paraphrase of them.
    const before = serving.agentVersion.engine;
    const after = branched.agentVersion.engine;
    const forked =
      after.engineId !== before.engineId || after.version !== before.version;

    // Printed rather than only asserted: the finding is what the developer
    // came for, and it goes into the research file from this line.
    console.log(
      `[retell fork check] serving=${JSON.stringify(before)} ` +
        `branched=${JSON.stringify(after)} forked=${forked}`,
    );

    // The branch itself is what must work; whether Retell forked the engine is
    // the finding, and the builder's fork guard is what acts on it.
    expect(branched.agentVersion.version).toBeGreaterThan(
      serving.agentVersion.version,
    );

    // Both versions' engines are readable, whichever way the finding went.
    const draftEngine = await readEngineConfiguration(key, after);
    expect(draftEngine.kind).toBe("engine");
  });
});

describe("the live fork check's own gate", () => {
  it("names the variable that turns it on", () => {
    // Runs with or without a key, so a reader of a green CI log can see that
    // the live check exists and why it did not run.
    expect(LIVE_KEY_VARIABLE).toBe("EGMA_LIVE_RETELL_API_KEY");
  });
});
