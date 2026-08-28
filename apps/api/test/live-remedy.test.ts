import { setTimeout as sleep } from "node:timers/promises";

import {
  bindingsFor,
  bindingVerdictOf,
  canonicalJson,
  coverageClassOf,
  listRoutedNumbers,
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
 * The real ring: one mocked suite against a live Retell agent, and the proof
 * that production was untouched while it ran.
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
 * EGMA_LIVE_SUITE_ID=ste_…        # a suite with at least one test \
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
 * - **A ticked agent** — `mockToolsDuringSimulations` on, with pin consent
 *   given — and a `retell_web_call` connection on it. The suite refuses to
 *   turn the tick on for you: consent is the developer's to give.
 *
 * ## What it does to the account
 *
 * On the **Retell** side it reads. Everything written there is written by Egma's
 * own run lifecycle — one temporary agent version, created and deleted — and the
 * suite's whole job is to watch that happen and check what is left afterwards.
 * It binds no number, publishes nothing, and creates no agent.
 *
 * On the **Egma** side it must leave the account exactly as found too, and it
 * does so **per row, by id — never a project-wide snapshot**. It seeds answers
 * for the interceptable tools and edits two of them — one into an error, one
 * into a delay — and starts one run. A real `finally` (in `afterAll`, so it
 * runs on every failure path) touches only what this suite itself created or
 * changed: it **deletes exactly the rows its own seed created** (identified by
 * the seed's own report of what it added) and **restores exactly the rows it
 * edited, by their id**, to the value each held before the edit — captured at
 * edit time so a rename cannot move the target. Any other row — one a teammate
 * or another process creates or edits while the suite runs — is left completely
 * untouched. So a developer's own authored answers survive the proof, and a
 * concurrent write to an unrelated row is never clobbered.
 *
 * ## The script it follows
 *
 * The developer's own hand-run of 2026-08-27, step for step:
 * number read → tag resolved → tools read → branch auto-forking the flow →
 * targeted swap → web call against the draft hitting the mock while production
 * stayed on the customer's backend → clean delete. Each step below names which
 * part of that trail it is checking.
 *
 * ## What to bank when it passes
 *
 * The run's URL, its record — tool facts with `mocked` provenance and the
 * three-class stamp — and the before/after readings of the serving version this
 * file prints. That is the artifact: Egma answered while production served the
 * customer's own backend.
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

/** The delay the suite authors, long enough to be unmistakable on the record. */
const AUTHORED_DELAY_MILLISECONDS = 3_000;

/** One mock-tool row, in the shape a restore writes it back. */
type MockToolRow = {
  readonly id: string;
  readonly tool: string;
  readonly answer?: unknown;
  readonly error?: unknown;
  readonly delayMs: number;
};

/**
 * What this suite touched on the Egma side, by id — and only that.
 *
 * `seededIds` are the rows this suite's own seed created (named by the seed's
 * own report of what it added), which the teardown deletes. `editedPrior` holds
 * the value each **pre-existing** row this suite edited had before the edit,
 * keyed by its id, which the teardown writes back. Both are scoped to this
 * suite's own actions: a row it neither created nor edited is never in either,
 * so a concurrent write to an unrelated row is left completely alone.
 */
const made: {
  runId: string | null;
  readonly seededIds: Set<string>;
  readonly editedPrior: Map<string, MockToolRow>;
} = { runId: null, seededIds: new Set(), editedPrior: new Map() };

/** Every mock-tool row the project holds right now, whole. */
async function listMockTools(): Promise<MockToolRow[]> {
  const listed = await egma("GET", "/v1/mock-tools?pageSize=200");
  return (listed.body["mockTools"] as MockToolRow[]) ?? [];
}

/** The body that writes one row back to exactly what it held. */
function restoreBody(row: MockToolRow): Record<string, unknown> {
  return {
    ...("error" in row && row.error !== undefined
      ? { error: row.error }
      : { answer: row.answer }),
    delayMs: row.delayMs,
  };
}

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

afterAll(async () => {
  if (missing.length > 0) return;
  // A run still moving is stopped, so nothing is left conducting against
  // somebody's real agent after the suite has gone. Its own teardown then
  // deletes the temporary version and puts any pin back, in that order.
  if (made.runId !== null) {
    const header = await egma("GET", `/v1/runs/${made.runId}`).catch(() => null);
    if (header !== null && header.body["finishedAt"] === null) {
      await egma("POST", `/v1/runs/${made.runId}/cancel`, {}).catch(
        () => undefined,
      );
    }
  }

  // The Egma side, scoped to exactly the rows this suite created or edited, by
  // id — never the whole project's table. Each on its own, so one failure
  // cannot stop the next. A row this suite never touched — including one a
  // teammate or another process created or edited while it ran — is left
  // completely alone.
  //
  // The rows this suite's own seed created: deleted.
  for (const id of made.seededIds) {
    await egma("DELETE", `/v1/mock-tools/${id}`).catch(() => undefined);
  }
  // The pre-existing rows this suite edited: written back to exactly what they
  // held before the edit, by their captured id.
  for (const [id, prior] of made.editedPrior) {
    await egma("PATCH", `/v1/mock-tools/${id}`, restoreBody(prior)).catch(
      () => undefined,
    );
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

live("a mocked suite against the live agent", () => {
  it("leaves production exactly as it found it, and proves Egma answered", async () => {
    // The Egma-side teardown is scoped per row, by id — see `made` and
    // `afterAll`. Nothing is snapshotted project-wide, so a concurrent write to
    // an unrelated mock-tool row is never touched. What this suite created is
    // tracked at seed time (step 2) and what it edits is captured at edit time.

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
    console.log(
      `[live remedy] serving version ${servingVersion}, engine ${engine.type} ` +
        `${engine.engineId} v${String(engine.version)}, ` +
        `${declared.length} tools`,
    );

    // ── 2. Author the two answers the hand-run exercised. ──
    const found = await egma(
      "POST",
      `/v1/agents/${named("EGMA_LIVE_AGENT_ID")}/mock-tools:discover`,
      { seed: true },
    );
    expect(found.status, JSON.stringify(found.body)).toBe(200);
    expect(found.body["mockable"], JSON.stringify(found.body["refusal"])).toBe(
      true,
    );
    const interceptable = (
      found.body["tools"] as { name: string; coverage: string }[]
    ).filter((tool) => tool.coverage === "mocked");
    expect(
      interceptable.length,
      "the live agent must declare at least two interceptable tools for this suite",
    ).toBeGreaterThanOrEqual(2);

    // Exactly the rows this suite's own seed created, by id, so the teardown
    // deletes those and nothing else. The seed reports the names it added —
    // and it never overwrites an authored answer — so a name it reports is a
    // row it made.
    const authored = await listMockTools();
    const seededNames = new Set((found.body["seeded"] as string[]) ?? []);
    for (const row of authored) {
      if (seededNames.has(row.tool)) made.seededIds.add(row.id);
    }

    // The seed above has left one row per interceptable tool. Two of them are
    // edited into the two answers the hand-run exercised: one that fails, so
    // the agent's apology is exercised rather than assumed, and one that is
    // slow, so the market gap — nobody else can make a mock slow — is exercised
    // on a real call and the latency on the record stays honest.
    const failing = interceptable[0]?.name ?? "";
    const slow = interceptable[1]?.name ?? "";
    // Resolve the row's id **and** capture what it held, at edit time. A row
    // this suite did not seed is one that pre-existed, so its prior value is
    // remembered for a restore; a row the seed just created is left for the
    // delete above. Capturing the id here means a later rename cannot move the
    // target out from under the restore.
    const editTarget = (tool: string): string => {
      const row = authored.find((one) => one.tool === tool);
      expect(row, `no mock tool answers for ${tool}`).toBeDefined();
      const id = String(row?.id);
      if (row !== undefined && !made.seededIds.has(id)) {
        made.editedPrior.set(id, row);
      }
      return id;
    };

    const errored = await egma("PATCH", `/v1/mock-tools/${editTarget(failing)}`, {
      error: "the live proof's authored failure",
    });
    expect(errored.status, JSON.stringify(errored.body)).toBe(200);

    const delayed = await egma("PATCH", `/v1/mock-tools/${editTarget(slow)}`, {
      delayMs: AUTHORED_DELAY_MILLISECONDS,
    });
    expect(delayed.status, JSON.stringify(delayed.body)).toBe(200);

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

    // ── 4. Mid-run: the draft exists, and production does not know about it. ──
    const header = await egma("GET", `/v1/runs/${runId}`);
    const world = header.body["mockedWorld"] as {
      servingVersion: number;
      draftVersion: number | null;
      coverage: Record<string, string[]>;
    };
    expect(world.servingVersion).toBe(servingVersion);
    expect(world.draftVersion).not.toBeNull();
    const draftVersion = world.draftVersion ?? 0;
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
    for (const tool of toolsOf(draftEngine.engine)) {
      if (coverageClassOf(tool) !== "mocked") continue;
      // Pointed at Egma, with the customer's own credentials stripped.
      expect(String(tool.verbatim["url"])).toContain(
        `${named("EGMA_LIVE_API_URL").replace(/\/+$/u, "")}/mock-tools/${runId}/`,
      );
      expect(tool.verbatim["headers"]).toEqual({});
    }

    // The three-class stamp, checked against Retell's own answer rather than
    // against Egma's record of it.
    const truth = { mocked: [] as string[], notInterceptable: [] as string[], notInThisVersion: [] as string[] };
    for (const tool of declared) truth[coverageClassOf(tool)].push(tool.name);
    expect(world.coverage).toEqual(truth);

    // The serving version, mid-run: byte-identical to the capture.
    const during = await readEngineConfiguration(key, engine);
    expect(during.kind).toBe("engine");
    if (during.kind !== "engine") return;
    expect(toolPrint(during.engine.document, engine.type, engine.engineId)).toBe(
      toolsBefore,
    );

    // The tag binding, untouched — a tagged number was never pinned.
    const midRun = await listRoutedNumbers(key);
    expect(midRun.kind).toBe("numbers");
    if (midRun.kind !== "numbers") return;
    for (const captured of bindingsBefore) {
      if (!captured.verdicts.includes("environment-tag")) continue;
      const now = numbersRouting(midRun.numbers, platformAgentId).find(
        (one) => one.number === captured.number,
      );
      expect(
        JSON.stringify(now?.bindings.map((one) => one.verbatim)),
        `${captured.number} rides an environment tag and must not be touched`,
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
        `${captured.number}'s routing was not restored`,
      ).toBe(captured.bindings);
    }

    // ── 7. The record: Egma answered, and says so. ──
    const simulations = await egma("GET", `/v1/runs/${runId}/simulations?pageSize=200`);
    const rows = simulations.body["simulations"] as {
      id: string;
      modality: string;
      mockToolCoverage: Record<string, string[]> | null;
    }[];
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      // Its own unit: a web call, never the phone band.
      expect(row.modality).toBe("voice");
      const stamp = row.mockToolCoverage;
      expect(stamp, `simulation ${row.id} carries no coverage stamp`).not.toBeNull();
      expect(stamp?.notInterceptable).toEqual(truth.notInterceptable);
      expect(stamp?.notInThisVersion).toEqual(truth.notInThisVersion);
      expect(stamp?.covered).toContain(failing);
      expect(stamp?.covered).toContain(slow);
    }

    console.log(
      `[live remedy] finished. ${rows.length} mocked web-call simulations, ` +
        `temporary version ${draftVersion} deleted, serving version ` +
        `${servingVersion} byte-identical before and after.`,
    );
  }, RUN_DEADLINE_MILLISECONDS + 60_000);
});

describe("the live suite's own gate", () => {
  it("names everything it needs, and reaches nothing without it", () => {
    // Runs with or without the environment, so a reader of a green CI log can
    // see that the live proof exists and exactly why it did not run.
    expect(NEEDED).toContain("EGMA_LIVE_RETELL_API_KEY");
    expect(NEEDED).toContain("EGMA_LIVE_API_URL");
    if (missing.length > 0) {
      console.log(
        `[live remedy] skipped — set ${missing.join(", ")} to run it, and put ` +
          "a public tunnel in front of the deployment so Retell can reach the " +
          "mock endpoint.",
      );
    }
  });
});
