import { setTimeout as sleep } from "node:timers/promises";

import {
  bindingsFor,
  bindingVerdictOf,
  canonicalJson,
  isIntercepted,
  EGMA_URL_VARIABLE_DEFAULT,
  listRoutedNumbers,
  mockToolVariable,
  numbersRouting,
  readEngineConfiguration,
  resolveAgentVersion,
  toolsOf,
  versionReferenceIn,
  bindingDecisionsFor,
  type RetellCredential,
} from "@egma/retell";
import { afterAll, describe, expect, it } from "vitest";

/**
 * The real ring: one run whose two tests mock **different** tools of a live
 * Retell agent, in parallel, on one temporary version — and the proof that
 * production was untouched while it ran.
 *
 * **Nobody but the developer runs this.** Agents test against fakes only
 * (ruling, 2026-08-28); the live account is the developer's to touch. Every
 * check below is skipped — visibly, as skipped rather than passed — unless the
 * environment names a real Retell key and a real Egma deployment, and nothing
 * in this file reaches a network at module load. CI has neither, so CI never
 * touches an account.
 *
 * ## The one command
 *
 * ```sh
 * EGMA_LIVE_RETELL_API_KEY=<the Retell key for the account> \
 * EGMA_LIVE_RETELL_AGENT_ID=agent_b0e2e9cb267c47e7e7026cd8e8 \
 * EGMA_LIVE_API_URL=https://<your public tunnel or deployment> \
 * EGMA_LIVE_API_KEY=<an Egma project API key> \
 * EGMA_LIVE_AGENT_ID=agt_… \
 * EGMA_LIVE_CONNECTION_ID=con_…   # the agent's retell_web_call connection \
 * EGMA_LIVE_SUITE_ID=ste_…        # a suite with at least two tests \
 *   npx vitest run --project fast apps/api/test/live-remedy.test.ts
 * ```
 *
 * ## What it needs, and why
 *
 * - **A Retell API key** for the account that holds the agent. The suite reads
 *   the account directly with it — numbers, versions, engine configuration —
 *   so that what it asserts about production is read from Retell rather than
 *   from Egma's own record of Retell.
 * - **A public tunnel** in front of the Egma deployment, and `EGMA_BASE_URL`
 *   set to it. Retell refuses localhost and private addresses for a tool URL,
 *   so a mocked run against a real agent needs an address Retell's own
 *   infrastructure can reach. This is the effort's only new inbound
 *   requirement.
 * - **Funded model keys** on that deployment, and a simulator running against
 *   it. The simulations are real voice conversations: they spend speech
 *   synthesis, transcription and LLM tokens.
 * - **An agent with at least two custom tools**, and a suite with at least two
 *   tests. The whole point of this proof is two tests mocking different tools
 *   of one agent at the same time.
 *
 * ## What it does to the account
 *
 * On the **Retell** side it only reads. Everything written there is written by
 * Egma's own run lifecycle — one temporary agent version, created and deleted
 * — and the suite's whole job is to watch that happen and check what is left
 * afterwards. It binds no number, publishes nothing, and creates no agent.
 *
 * On the **Egma** side it edits the mock tools of the suite's first two tests,
 * and puts them back. That is where a test's world lives now: there is no
 * project list and no connection switch, so making one test mock `A` and
 * another mock `B` **is** editing those two tests. Each edit mints a new test
 * version, and so does the restore — that is what a versioned test does, and
 * the developer sees two extra versions on each of the two tests afterwards.
 *
 * The teardown (in `afterAll`, so it runs on every failure path) touches only
 * those two tests, **by id**, and **reads each back before it writes**: it
 * restores a test only while that test still holds exactly what this suite
 * left it as. If anyone changed one of them in between, the change is left in
 * place and named in a warning. The residual is a microsecond between the
 * re-read and the write; closing it entirely would need a write precondition
 * the product does not have.
 *
 * ## What is proved here, and what stays the developer's own hand step
 *
 * Proved here: one temporary version for the whole run; every custom tool on
 * it carrying its own `{{egma_url_…}}` in front of the customer's URL byte for
 * byte, with the customer's headers and query params untouched; every routing
 * default stored as exactly one space; both tests running against that one
 * version; the serving version byte-identical before, during and after; and
 * the temporary version deleted at the end.
 *
 * **The receiver is the developer's.** Which host each *unmocked* tool call
 * reached is a fact about the customer's own backend, and no API of Egma's can
 * read it. Point one of the agent's tools at a receiver you can watch
 * (webhook.site is what the 2026-09-03 proof used), run this, and check that
 * the receiver saw exactly the calls of the test that did **not** mock that
 * tool. This file prints the two tests and the tool each of them mocked, so
 * there is something to compare the receiver against.
 *
 * ## What to bank when it passes
 *
 * The run's URL, the two version readings this file prints, and the receiver's
 * log. That is the artifact: two tests of one run answered by Egma for their
 * own tools while every other call reached the customer's backend.
 */

const NEEDED = [
  "EGMA_LIVE_RETELL_API_KEY",
  "EGMA_LIVE_RETELL_AGENT_ID",
  "EGMA_LIVE_API_URL",
  "EGMA_LIVE_API_KEY",
  "EGMA_LIVE_AGENT_ID",
  "EGMA_LIVE_CONNECTION_ID",
  "EGMA_LIVE_SUITE_ID",
] as const;

const named = (variable: (typeof NEEDED)[number]): string =>
  (process.env[variable] ?? "").trim();

const missing = NEEDED.filter((variable) => named(variable) === "");
const live = missing.length === 0 ? describe : describe.skip;

const key: RetellCredential = { reveal: () => named("EGMA_LIVE_RETELL_API_KEY") };
const platformAgentId = named("EGMA_LIVE_RETELL_AGENT_ID");

/** How long the suite waits for the run to finish before giving up. */
const RUN_DEADLINE_MILLISECONDS = 20 * 60 * 1000;
const POLL_MILLISECONDS = 5_000;

/** One mock tool a test carries, in the shape the API reads and writes. */
type MockTool =
  | { readonly tool: string; readonly answer: unknown }
  | { readonly tool: string; readonly error: string };

/** The world one test carries, which is the whole of what this suite edits. */
type TestWorld = {
  readonly id: string;
  readonly name: string;
  readonly mockTools: readonly MockTool[];
  readonly env: unknown;
};

/**
 * One test this suite edited, with **what it left it as**, so the teardown can
 * read before it writes.
 *
 * `prior` goes back; `left` is what the row must still hold for the restore to
 * be safe. A test anyone changed after this suite did is left exactly as found
 * and named in a warning.
 */
type Touched = { readonly prior: TestWorld; left: TestWorld };

const made: {
  runId: string | null;
  readonly touched: Map<string, Touched>;
} = { runId: null, touched: new Map() };

async function egma(
  method: "GET" | "POST" | "PATCH" | "DELETE",
  path: string,
  body?: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const base = named("EGMA_LIVE_API_URL").replace(/\/+$/u, "");
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${named("EGMA_LIVE_API_KEY")}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  let held: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed === "object" && parsed !== null) {
      held = parsed as Record<string, unknown>;
    }
  } catch {
    held = { raw: text };
  }
  return { status: response.status, body: held };
}

/** The suite's tests, in the shape this suite compares and restores them in. */
async function testsInSuite(): Promise<readonly TestWorld[]> {
  const listed = await egma(
    "GET",
    `/v1/tests?suiteId=${encodeURIComponent(named("EGMA_LIVE_SUITE_ID"))}` +
      "&pageSize=200",
  );
  const rows = (listed.body["tests"] as Record<string, unknown>[]) ?? [];
  return rows.map((row) => ({
    id: String(row["id"]),
    name: String(row["name"]),
    mockTools: (row["mockTools"] ?? []) as readonly MockTool[],
    env: row["env"] ?? null,
  }));
}

/** Whether a test still holds the world this suite left it holding. */
function sameWorld(a: TestWorld, b: TestWorld): boolean {
  return (
    canonicalJson([a.mockTools, a.env]) === canonicalJson([b.mockTools, b.env])
  );
}

afterAll(async () => {
  if (missing.length > 0) return;
  // A run still moving is stopped, so nothing is left conducting against
  // somebody's real agent after the suite has gone. Its own teardown then
  // deletes the temporary version.
  if (made.runId !== null) {
    const header = await egma("GET", `/v1/runs/${made.runId}`).catch(() => null);
    if (header !== null && header.body["finishedAt"] === null) {
      await egma("POST", `/v1/runs/${made.runId}/cancel`, {}).catch(
        () => undefined,
      );
    }
  }

  // The Egma side, scoped to exactly the two tests this suite edited, by id,
  // and read before it writes. A test anyone changed since is left as found.
  const current = new Map(
    (await testsInSuite().catch(() => [])).map((one) => [one.id, one]),
  );
  for (const [id, touched] of made.touched) {
    const now = current.get(id);
    if (now === undefined) continue; // already gone — nothing to undo.
    if (!sameWorld(now, touched.left)) {
      console.warn(
        `[live remedy] test ${id} was changed after the suite left it; left ` +
          "exactly as found, not reverted.",
      );
      continue;
    }
    await egma("PATCH", `/v1/tests/${id}`, {
      mockTools: touched.prior.mockTools,
      env: touched.prior.env,
    }).catch(() => undefined);
  }
});

/**
 * Every tool the serving version declares, in the one spelling a diff uses.
 *
 * `canonicalJson`, the same key-order-insensitive spelling the builder compares
 * in — a plain `JSON.stringify` would cry "the serving version changed" the
 * first time Retell happened to serialize a tool's keys in a different order.
 */
function toolPrint(document: Record<string, unknown>, type: string, id: string): string {
  return canonicalJson(
    toolsOf({
      reference: { type: type as never, engineId: id, version: null },
      document,
    }).map((tool) => tool.verbatim),
  );
}

live("two tests mocking different tools, on one temporary version", () => {
  it("answers each test's own tools, leaves production as it found it", async () => {
    // ── 1. Capture. What the account looks like before Egma touches it. ──
    const listed = await listRoutedNumbers(key);
    expect(listed.kind, JSON.stringify(listed)).toBe("numbers");
    if (listed.kind !== "numbers") return;
    const routed = numbersRouting(listed.numbers, platformAgentId);
    const decisions = bindingDecisionsFor(listed.numbers, platformAgentId);
    const bindingsBefore = routed.map((number) => ({
      number: number.number,
      verdicts: bindingsFor(number, platformAgentId).map(bindingVerdictOf),
      bindings: JSON.stringify(number.bindings.map((one) => one.verbatim)),
    }));

    const serving = await resolveAgentVersion(
      key,
      platformAgentId,
      versionReferenceIn(decisions),
    );
    expect(serving.kind, JSON.stringify(serving)).toBe("version");
    if (serving.kind !== "version") return;
    const servingVersion = serving.agentVersion.version;
    const engine = serving.agentVersion.engine;

    const before = await readEngineConfiguration(key, engine);
    expect(before.kind, JSON.stringify(before)).toBe("engine");
    if (before.kind !== "engine") return;
    const toolsBefore = toolPrint(
      before.engine.document,
      engine.type,
      engine.engineId,
    );
    const declared = toolsOf(before.engine);
    const interceptable = declared.filter((tool) => isIntercepted(tool));
    expect(
      interceptable.length,
      "this proof needs a live agent with at least two custom tools, so two " +
        "tests can mock different ones",
    ).toBeGreaterThanOrEqual(2);
    const answered = interceptable[0]?.name ?? "";
    const failing = interceptable[1]?.name ?? "";
    console.log(
      `[live remedy] serving version ${servingVersion}, engine ${engine.type} ` +
        `${engine.engineId} v${String(engine.version)}, ` +
        `${declared.length} tools, ${interceptable.length} of them custom`,
    );

    // ── 2. Give two tests two different worlds. ──
    //
    // This is the whole shape the design turns on: one run, two tests, two
    // different sets of mocked tools, and one temporary version serving both.
    const tests = await testsInSuite();
    expect(
      tests.length,
      "this proof needs a suite with at least two tests, so two of them can " +
        "mock different tools",
    ).toBeGreaterThanOrEqual(2);
    const first = tests[0];
    const second = tests[1];
    if (first === undefined || second === undefined) return;

    const worlds: readonly (readonly [TestWorld, readonly MockTool[]])[] = [
      [first, [{ tool: answered, answer: { egma_live_remedy: "answered" } }]],
      [second, [{ tool: failing, error: "the live proof's authored failure" }]],
    ];
    for (const [test, mockTools] of worlds) {
      const patched = await egma("PATCH", `/v1/tests/${test.id}`, { mockTools });
      expect(patched.status, JSON.stringify(patched.body)).toBe(200);
      made.touched.set(test.id, { prior: test, left: test });
    }
    // What the suite left them as, read back, so the teardown never writes
    // blind over somebody else's later edit.
    const afterEdits = new Map(
      (await testsInSuite()).map((one) => [one.id, one]),
    );
    for (const [id, touched] of made.touched) {
      const left = afterEdits.get(id);
      if (left !== undefined) touched.left = left;
    }
    console.log(
      `[live remedy] test "${first.name}" mocks ${answered}; test ` +
        `"${second.name}" mocks ${failing}. Every other tool of this agent ` +
        "reaches your own backend on both — that is what your receiver should " +
        "show.",
    );

    // ── 3. The run. ──
    const started = await egma("POST", "/v1/runs", {
      suiteId: named("EGMA_LIVE_SUITE_ID"),
      agentId: named("EGMA_LIVE_AGENT_ID"),
      connectionId: named("EGMA_LIVE_CONNECTION_ID"),
      idempotencyKey: `live-remedy-${Date.now()}`,
    });
    expect(started.status, JSON.stringify(started.body)).toBe(201);
    const runId = String(started.body["id"]);
    made.runId = runId;
    console.log(`[live remedy] run ${runId} — ${String(started.body["resultsUrl"])}`);

    // A mocked web call is its own unit: never a phone simulation, and never
    // compared with one.
    expect(started.body["connectionType"]).toBe("retell_web_call");
    expect(started.body["modality"]).toBe("voice");

    // ── 4. Mid-run: one temporary version, and production does not know. ──
    const header = await egma("GET", `/v1/runs/${runId}`);
    expect(header.body["agentVersion"]).toBe(servingVersion);
    expect(header.body["tempMockAgentVersionCleanup"]).toBe(false);
    const draftVersion = header.body["tempMockAgentVersion"] as number;
    expect(
      draftVersion,
      "the run branched no temporary version, so its tests carried no mock tools",
    ).not.toBeNull();
    // Branched from the exact version the agent serves.
    expect(draftVersion).toBeGreaterThan(servingVersion);

    const draft = await resolveAgentVersion(key, platformAgentId, draftVersion);
    expect(draft.kind).toBe("version");
    if (draft.kind !== "version") return;
    // Retell forked the engine: the draft is not the serving version's engine.
    expect(
      draft.agentVersion.engine.engineId !== engine.engineId ||
        draft.agentVersion.engine.version !== engine.version,
    ).toBe(true);
    // And it is never published — a `latest_published` binding must not reach it.
    expect(draft.agentVersion.published).toBe(false);

    const draftEngine = await readEngineConfiguration(
      key,
      draft.agentVersion.engine,
    );
    expect(draftEngine.kind).toBe("engine");
    if (draftEngine.kind !== "engine") return;

    const capturedByName = new Map(
      declared.map((tool) => [tool.name, tool.verbatim]),
    );
    for (const tool of toolsOf(draftEngine.engine)) {
      if (!isIntercepted(tool)) continue;
      const captured = capturedByName.get(tool.name);
      // The one field that moved: the tool's own routing variable, in front of
      // the customer's own URL, byte for byte.
      expect(String(tool.verbatim["url"])).toBe(
        `{{${mockToolVariable(tool.name)}}}${String(captured?.["url"] ?? "")}`,
      );
      // And the two fields that did **not** move. They are what a call this
      // run does not mock authenticates with, and this version serves those
      // calls too.
      expect(
        canonicalJson(tool.verbatim["headers"]),
        `${tool.name}'s headers were changed`,
      ).toBe(canonicalJson(captured?.["headers"]));
      expect(
        canonicalJson(tool.verbatim["query_params"]),
        `${tool.name}'s query params were changed`,
      ).toBe(canonicalJson(captured?.["query_params"]));
    }

    // Every routing variable is declared on the copy, defaulted to exactly one
    // space — the value the run's own read-back guard refuses anything else
    // for, checked here against Retell's own answer.
    const defaults = (draftEngine.engine.document["default_dynamic_variables"] ??
      {}) as Record<string, unknown>;
    for (const tool of interceptable) {
      expect(
        defaults[mockToolVariable(tool.name)],
        `${tool.name}'s routing default is not a single space`,
      ).toBe(EGMA_URL_VARIABLE_DEFAULT);
    }

    // The serving version, mid-run: byte-identical to the capture.
    const during = await readEngineConfiguration(key, engine);
    expect(during.kind).toBe("engine");
    if (during.kind !== "engine") return;
    expect(toolPrint(during.engine.document, engine.type, engine.engineId)).toBe(
      toolsBefore,
    );

    // The tag binding, untouched — Egma writes to no number of the customer's.
    const midRun = await listRoutedNumbers(key);
    expect(midRun.kind).toBe("numbers");
    if (midRun.kind !== "numbers") return;
    for (const captured of bindingsBefore) {
      const now = numbersRouting(midRun.numbers, platformAgentId).find(
        (one) => one.number === captured.number,
      );
      expect(
        JSON.stringify(now?.bindings.map((one) => one.verbatim)),
        `${captured.number}'s routing must not be touched`,
      ).toBe(captured.bindings);
    }

    // ── 5. Wait for it to finish. ──
    const deadline = Date.now() + RUN_DEADLINE_MILLISECONDS;
    let finished = await egma("GET", `/v1/runs/${runId}`);
    while (finished.body["finishedAt"] === null && Date.now() < deadline) {
      await sleep(POLL_MILLISECONDS);
      finished = await egma("GET", `/v1/runs/${runId}`);
    }
    expect(
      finished.body["finishedAt"],
      "the run did not finish inside the deadline",
    ).not.toBeNull();

    // ── 6. After: the account exactly as it was found. ──
    const gone = await resolveAgentVersion(key, platformAgentId, draftVersion);
    expect(gone.kind, "the temporary version was not deleted").toBe("gone");

    const after = await readEngineConfiguration(key, engine);
    expect(after.kind).toBe("engine");
    if (after.kind !== "engine") return;
    expect(
      toolPrint(after.engine.document, engine.type, engine.engineId),
      "the serving version's tools changed",
    ).toBe(toolsBefore);

    const afterNumbers = await listRoutedNumbers(key);
    expect(afterNumbers.kind).toBe("numbers");
    if (afterNumbers.kind !== "numbers") return;
    for (const captured of bindingsBefore) {
      const now = numbersRouting(afterNumbers.numbers, platformAgentId).find(
        (one) => one.number === captured.number,
      );
      expect(
        JSON.stringify(now?.bindings.map((one) => one.verbatim)),
        `${captured.number}'s routing changed`,
      ).toBe(captured.bindings);
    }

    // ── 7. Both tests really ran, on the one temporary version. ──
    const simulations = await egma(
      "GET",
      `/v1/runs/${runId}/simulations?pageSize=200`,
    );
    const rows = (simulations.body["simulations"] ?? []) as {
      id: string;
      modality: string;
      testId: string;
      testName: string;
    }[];
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      // Its own unit: a web call, never the phone band.
      expect(row.modality).toBe("voice");
    }
    const ran = new Set(rows.map((row) => row.testId));
    expect(ran.has(first.id), `test "${first.name}" conducted nothing`).toBe(
      true,
    );
    expect(ran.has(second.id), `test "${second.name}" conducted nothing`).toBe(
      true,
    );

    console.log(
      `[live remedy] finished. ${rows.length} mocked web-call simulations ` +
        `across ${ran.size} tests, one temporary version (${draftVersion}) ` +
        `deleted, serving version ${servingVersion} byte-identical before and ` +
        "after. Now check your receiver: it should show the calls of the test " +
        "that did not mock its tool, and none of the other's.",
    );
  }, RUN_DEADLINE_MILLISECONDS + 60_000);
});

describe("the live suite's own gate", () => {
  it("names everything it needs, and reaches nothing without it", () => {
    // Runs with or without the environment, so a reader of a green CI log can
    // see that the live proof exists and exactly why it did not run.
    expect(NEEDED).toContain("EGMA_LIVE_RETELL_API_KEY");
    expect(NEEDED).toContain("EGMA_LIVE_API_URL");
    expect(NEEDED).toContain("EGMA_LIVE_SUITE_ID");
    if (missing.length > 0) {
      console.log(
        `[live remedy] skipped — set ${missing.join(", ")} to run it, and put ` +
          "a public tunnel in front of the deployment so Retell can reach the " +
          "mock endpoint. It edits the mock tools of the suite's first two " +
          "tests and puts them back.",
      );
    }
  });
});
