import { afterAll, describe, expect, it } from "vitest";

import {
  branchAgentVersion,
  isIntercepted,
  deleteAgentVersion,
  EGMA_URL_VARIABLE_DEFAULT,
  LATEST_PUBLISHED,
  listAgentVersions,
  mockedToolsFor,
  mockToolUrl,
  mockToolVariable,
  readEngineConfiguration,
  resolveAgentVersion,
  resolveServingAgentVersion,
  RETELL_API,
  toolsOf,
  writeEngineTools,
  type RetellCredential,
} from "../src/index.ts";

/**
 * Two questions this package answers against a live account, and nowhere else.
 *
 * **Three: does the per-call routing work on a Retell LLM engine?** The
 * founder's live proof of it (2026-09-03) was on a **conversation-flow** agent,
 * and Retell documents neither engine's behaviour here — so ADR-0022 left the
 * LLM half owed. It is answered below, on the scratch agent this file already
 * creates and deletes: the transform is written onto the branched version, read
 * back, and two web calls are created against it. Retell validates a tool's
 * *rendered* URL as it creates a call — an unrendered `{{…}}` is refused with
 * `Got invalid url` — so a call it accepts is a call whose routing variables
 * rendered.
 *
 * **One: does branching an agent version fork a Retell LLM** the way it
 * provably forks a conversation flow? The flow half is observed behaviour:
 * `create-agent-version` mints a new agent version with its own freshly forked
 * flow version. The Retell-LLM half is not — there is no LLM-versioning
 * endpoint in the API at all, and `response_engine.version` is the only pointer
 * — so the question is settled here, by a test, rather than by an assumption in
 * the builder. **The builder never assumes the answer either way**: its fork
 * guard refuses a branch whose engine reference still matches the serving
 * version's, before any write. Whatever this test finds is informational.
 *
 * **Two: does the corrected version lifecycle hold on a real router?** Three
 * facts this package now depends on, each of which a fake can only agree with:
 * the delete names its version as a **query parameter** (the path form Egma
 * sent for a week is not a route at all, and Retell answers it 404 "Cannot
 * DELETE"); the **current listing** reads the versions back, so a deletion is
 * proved rather than assumed; and `latest_published` resolves the newest
 * published version rather than the newest draft. On this scratch agent
 * nothing is published, which makes it the exact shape the two-door refusal
 * exists for.
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

/**
 * One web call against a named version of the scratch agent.
 *
 * Here rather than in the client for the same reason the scaffolding above is:
 * Egma's own web-call lane lives in the simulator, and this check needs only
 * the one request. Retell validates each tool's rendered URL as it creates the
 * call, so the status code is the answer.
 */
async function webCall(
  agentId: string,
  agentVersion: number,
  variables: Record<string, string>,
): Promise<{ status: number; document: Record<string, unknown> }> {
  const answer = await scratch("POST", "/v2/create-web-call", {
    agent_id: agentId,
    agent_version: agentVersion,
    retell_llm_dynamic_variables: variables,
  });
  return answer;
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

  it("refuses the scratch agent, which has published nothing", async () => {
    const agentId = made.agentId;
    expect(agentId, "the fork check above must have made the agent").not.toBe(
      null,
    );
    if (agentId === null) return;

    // A freshly created agent has one version and it is a draft. `latest`
    // reaches it — which is exactly what a run must never do — and the
    // published pointer reaches nothing.
    const serving = await resolveServingAgentVersion(
      key,
      agentId,
      LATEST_PUBLISHED,
    );
    console.log(
      `[retell lifecycle check] latest_published on an unpublished agent: ` +
        `${serving.kind}`,
    );
    expect(serving.kind).toBe("none-published");
    if (serving.kind !== "none-published") return;
    expect(serving.reason).toContain("no published version");
    expect(serving.reason).toContain("Publish in Retell the version you want tested");
    expect(serving.reason).toContain("pin a Retell phone number that routes to this agent");
  });

  it("routes its tools per call, exactly as a conversation flow does", async () => {
    const agentId = made.agentId;
    const branched = made.branchedVersion;
    expect(agentId, "the fork check above must have made the agent").not.toBe(
      null,
    );
    if (agentId === null || branched === null) return;

    const draft = await resolveAgentVersion(key, agentId, branched);
    expect(draft.kind).toBe("version");
    if (draft.kind !== "version") return;
    const engine = draft.agentVersion.engine;
    const engineVersion = engine.version;
    expect(engineVersion, "the branch names no engine version").not.toBeNull();
    if (engineVersion === null) return;

    const captured = await readEngineConfiguration(key, engine);
    expect(captured.kind, JSON.stringify(captured)).toBe("engine");
    if (captured.kind !== "engine") return;

    const transform = mockedToolsFor(captured.engine);
    expect(
      transform.kind,
      transform.kind === "refused" ? transform.reason : "",
    ).toBe("mocked");
    if (transform.kind !== "mocked") return;
    expect(transform.variables.length).toBeGreaterThan(0);

    const written = await writeEngineTools(key, {
      reference: engine,
      version: engineVersion,
      tools: transform.tools,
      defaults: transform.defaults,
    });
    expect(written, JSON.stringify(written)).toEqual({
      kind: "written",
      version: engineVersion,
    });

    // Read back off Retell's own answer: the prefix in front of the URL that
    // was there, and the single-space default Retell must have kept as a space.
    const after = await readEngineConfiguration(key, engine);
    expect(after.kind).toBe("engine");
    if (after.kind !== "engine") return;
    const before = new Map(
      toolsOf(captured.engine).map((tool) => [tool.name, tool.verbatim]),
    );
    for (const tool of toolsOf(after.engine)) {
      if (!isIntercepted(tool)) continue;
      expect(String(tool.verbatim["url"]), `${tool.name}'s URL`).toBe(
        `{{${mockToolVariable(tool.name)}}}` +
          String(before.get(tool.name)?.["url"] ?? ""),
      );
    }
    const defaults = (after.engine.document["default_dynamic_variables"] ??
      {}) as Record<string, unknown>;
    for (const { variable } of transform.variables) {
      expect(
        defaults[variable],
        `Retell did not keep ${variable}'s default as a single space`,
      ).toBe(EGMA_URL_VARIABLE_DEFAULT);
    }

    // **The owed check.** Both shapes a run really sends, on this engine type.
    // Nothing joins either call: a web call nobody joins carries no media and
    // expires on its own.
    const empty = Object.fromEntries(
      transform.variables.map(({ variable }) => [variable, ""]),
    );
    const allReal = await webCall(agentId, branched, empty);
    expect(
      allReal.status,
      `Retell refused a Retell-LLM call whose routing variables were all "": ` +
        JSON.stringify(allReal.document),
    ).toBeLessThan(300);

    const one = transform.variables[0];
    if (one === undefined) return;
    const routed = await webCall(agentId, branched, {
      ...empty,
      [one.variable]: mockToolUrl(
        {
          base: "https://live-fork-check.egma.invalid/mock-tools",
          simulationId: `sim_live_fork_${Date.now()}`,
        },
        one.tool,
      ),
    });
    expect(
      routed.status,
      "Retell refused a Retell-LLM call routing one tool at Egma: " +
        JSON.stringify(routed.document),
    ).toBeLessThan(300);

    console.log(
      `[retell llm routing check] create-web-call accepted version ` +
        `${branched} on a retell-llm agent with every routing variable "" ` +
        `(call ${String(allReal.document["call_id"])}) and with ` +
        `${one.variable} = the mock address (call ` +
        `${String(routed.document["call_id"])}). Retell validates a rendered ` +
        "tool URL at call creation, so both rendered — the same answer the " +
        "conversation-flow agent gave on 2026-09-03.",
    );
  });

  it("deletes a version by the query parameter, and proves it with the listing", async () => {
    const agentId = made.agentId;
    const branched = made.branchedVersion;
    expect(agentId, "the fork check above must have made the agent").not.toBe(
      null,
    );
    expect(branched, "the fork check above must have branched a version").not.toBe(
      null,
    );
    if (agentId === null || branched === null) return;

    const before = await listAgentVersions(key, agentId);
    expect(before.kind, JSON.stringify(before)).toBe("versions");
    if (before.kind !== "versions") return;
    expect(before.versions.map((one) => one.version)).toContain(branched);

    const removed = await deleteAgentVersion(key, agentId, branched);
    // The query form. The path form is not a route on Retell's router and
    // answers 404 "Cannot DELETE", which Egma read as "already deleted".
    expect(removed, JSON.stringify(removed)).toEqual({ kind: "deleted" });

    const after = await listAgentVersions(key, agentId);
    expect(after.kind, JSON.stringify(after)).toBe("versions");
    if (after.kind !== "versions") return;
    // The proof, and the whole point: absence read rather than inferred from a
    // status code.
    expect(after.versions.map((one) => one.version)).not.toContain(branched);

    console.log(
      `[retell lifecycle check] versions before=${JSON.stringify(
        before.versions,
      )} after=${JSON.stringify(after.versions)}`,
    );

    // The teardown has nothing left to delete.
    made.branchedVersion = null;
  });
});

describe("the live fork check's own gate", () => {
  it("names the variable that turns it on", () => {
    // Runs with or without a key, so a reader of a green CI log can see that
    // the live check exists and why it did not run.
    expect(LIVE_KEY_VARIABLE).toBe("EGMA_LIVE_RETELL_API_KEY");
    if (liveKey === "") {
      console.log(
        `[retell lifecycle check] skipped — set ${LIVE_KEY_VARIABLE} to run ` +
          "it. It creates one scratch agent and deletes it again, and never " +
          "reads or writes an agent that was already on the account.",
      );
    }
  });
});
