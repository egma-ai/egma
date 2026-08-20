import { newId } from "@egma/ids";
import {
  appendSpans,
  appendVerdicts,
  claimSimulations,
  completeSimulation,
  createPersona,
  listGraders,
  PREDEFINED_GRADERS,
  startSimulation,
  useLibraryEntry,
  type AuthContext,
  type NewSpan,
} from "@egma/db";
import { traceIdOfSimulation } from "@egma/simulation-contract";
import { afterEach, describe, expect, it } from "vitest";

import { createApi, type TestApi } from "./support/api.ts";
import {
  contextFor,
  NEUTRAL_TRAITS,
  projectKeyFor,
  request as ask,
  signUp,
  type Answer,
} from "./support/traces.ts";

/**
 * What a run's results say about the two lanes and about what a judgment is
 * *about* — the two halves of this surface a reader cannot get anywhere else.
 *
 * **The lanes.** A running copy carrying `required: false` is a diagnostic:
 * judged and written exactly like a blocking one, reported with its own
 * fraction, and never able to fail a conversation or a run. Every number this
 * page calls the outcome is folded over the required copies alone, and the
 * diagnostic lane sits beside it under a name of its own — because folding them
 * together would make a diagnostic a blocker, and leaving the second lane out
 * would make it judge in silence.
 *
 * **The words.** A verdict row files its assertion by **key** — a behavior's
 * position in the pinned test version — so that editing a sentence cannot make
 * a second assertion counted beside the first forever. What a person reads is
 * therefore fetched at display time from that pinned version, and it arrives
 * here beside the key rather than instead of it: the key is what a client
 * filters by, the words are what it shows.
 *
 * No simulator exists in this suite and no grading service runs, so the verdict
 * rows are written through the same exported call the engine writes them
 * through. What is under test is the read.
 */

let api: TestApi;

afterEach(async () => {
  await api?.close();
});

function request(
  method: "GET" | "POST",
  url: string,
  key: string,
  payload?: Record<string, unknown>,
): Promise<Answer> {
  return ask(api.app, method, url, key, payload);
}

const THE_BEHAVIORS = [
  "confirms the new time back before finishing",
  "offers at least one afternoon slot next week",
] as const;

/** A conversation judged by two copies, one of each lane. */
async function aJudgedRun(label: string): Promise<{
  key: string;
  auth: AuthContext;
  runId: string;
  simulationId: string;
  behaviors: string;
  diagnostic: string;
}> {
  api = await createApi(label, { traceStore: true });
  const ada = await signUp(api.app, "ada@acme.example", "Acme");
  const key = await projectKeyFor(api.app, ada);
  const auth = contextFor(ada, "member");

  const registered = await request("POST", "/api/agents", key, {
    name: "Front desk",
    connection: {
      type: "retell",
      modality: "chat",
      config: { retellAgentId: "agent_in_retell_1" },
      credentials: { apiKey: "retell-secret-A1B2C3D4WXYZ" },
    },
  });
  expect(registered.statusCode, JSON.stringify(registered.body)).toBe(201);
  const connectionId = (registered.body.connection as { id: string }).id;

  await createPersona(auth, {
    name: "Impatient Rita",
    traits: NEUTRAL_TRAITS,
  });

  const created = await request("POST", "/api/tests", key, {
    name: "Reschedules a booked appointment",
    scenario:
      "Their cleaning is booked for Thursday morning and has to move to any afternoon next week.",
    expected_behaviors: [...THE_BEHAVIORS],
    personas: ["Impatient Rita"],
  });
  expect(created.statusCode, JSON.stringify(created.body)).toBe(201);

  const started = await request("POST", "/api/runs", key, {
    connection: connectionId,
    test_versions: [String(created.body.version_id)],
    // A start dials a real agent and spends a real judge, so the door takes the
    // caller's own key for the attempt: an answer lost on the way back must
    // never become a second conversation.
    idempotency_key: newId("run"),
  });
  expect(started.statusCode, JSON.stringify(started.body)).toBe(201);

  const runId = String(started.body.id);
  const simulations = started.body.simulations as Record<string, unknown>[];
  const simulationId = String(simulations[0]?.id);

  // The conversation is conducted before anything judges it. A `queued` one is
  // still moving, and every read here says so by answering a null verdict — so
  // rows written against one would be judgments of a conversation that has not
  // happened, and the surfaces would agree only by agreeing on nothing.
  const claimant = "simulator-lanes-1";
  const claimed = (
    await claimSimulations({ claimant, capacity: 50 })
  ).filter((one) => one.runId === runId);
  for (const one of claimed) {
    await startSimulation(auth, one.id, claimant);
    await completeSimulation(auth, one.id, claimant, {
      endingReason: "agent_ended",
      turnCount: 6,
    });
  }

  // The copy every project is born with — what judges a test against its own
  // sentences — found by the entry it points at rather than remembered.
  const copies = await listGraders(auth);
  const behaviors = copies.items.find(
    (one) => one.libraryId === PREDEFINED_GRADERS.expectedBehaviors,
  );
  if (behaviors === undefined) throw new Error("the project has no seeded copy");

  const diagnostic = await useLibraryEntry(auth, {
    libraryId: PREDEFINED_GRADERS.latency,
    name: "Reports and never blocks",
    required: false,
    params: { metric: "turn_response_latency", bound: 2_000 },
  });

  const judged = (
    graderId: string,
    versionId: string,
    assertion: string,
    verdict: "passed" | "failed",
  ) => ({
    traceId: simulationId,
    graderId,
    graderVersionId: versionId,
    assertion,
    source: "simulation" as const,
    verdict,
    score: verdict === "passed" ? 1 : 0,
    rationale: `${assertion} was judged ${verdict}.`,
    citedSpanIds: ["turn:3"],
    runId,
    agentId: String(started.body.agent_id),
    agentVersionId: "",
    judgedAtMicroseconds: BigInt(Date.now()) * 1000n,
  });

  await appendVerdicts(auth, [
    // Both required assertions pass, so the conversation passes.
    judged(behaviors.id, behaviors.versionId, "behavior_1", "passed"),
    judged(behaviors.id, behaviors.versionId, "behavior_2", "passed"),
    // And the diagnostic fails as loudly as it can.
    judged(
      diagnostic.id,
      diagnostic.versionId,
      PREDEFINED_GRADERS.latency,
      "failed",
    ),
  ]);

  return {
    key,
    auth,
    runId,
    simulationId,
    behaviors: behaviors.id,
    diagnostic: diagnostic.id,
  };
}

describe("a run's results", () => {
  it("folds the required copies into the outcome and reports the diagnostics apart", async () => {
    const { key, runId, behaviors, diagnostic } = await aJudgedRun("run_lanes");

    const read = await request("GET", `/api/runs/${runId}`, key);
    expect(read.statusCode, JSON.stringify(read.body)).toBe(200);

    // The headline is the required lane, and the diagnostic's failure is
    // nowhere in it — not in the word, not in the counts.
    expect(read.body).toMatchObject({
      verdict: "passed",
      score: 1,
      counts: { passed: 2, failed: 0, skipped: 0, errored: 0, total: 2 },
    });

    // And it is reported, whole, in a lane of its own.
    expect(read.body.diagnostics).toMatchObject({
      verdict: "failed",
      score: 0,
      counts: { passed: 0, failed: 1, skipped: 0, errored: 0, total: 1 },
    });

    // Every grader that judged is listed, each saying which lane it is in.
    const byGrader = read.body.by_grader as Record<string, unknown>[];
    expect(
      byGrader.map((one) => [one.grader_id, one.required, one.verdict]),
    ).toEqual(
      [
        [behaviors, true, "passed"],
        [diagnostic, false, "failed"],
      ].sort((left, right) => (String(left[0]) < String(right[0]) ? -1 : 1)),
    );
  });

  it("says the same thing about the one conversation underneath it", async () => {
    const { key, runId, diagnostic } = await aJudgedRun("run_lanes_one");

    const read = await request("GET", `/api/runs/${runId}`, key);
    const one = (read.body.simulations as Record<string, unknown>[])[0];

    expect(one).toMatchObject({
      grading: "graded",
      verdict: "passed",
      score: 1,
      counts: { passed: 2, failed: 0, skipped: 0, errored: 0, total: 2 },
      diagnostics: {
        verdict: "failed",
        counts: { passed: 0, failed: 1, skipped: 0, errored: 0, total: 1 },
      },
    });

    // And each row says which lane it is in, so a card can be marked without
    // going and matching grader ids.
    const rows = one?.verdicts as Record<string, unknown>[];
    expect(
      rows.map((its) => [its.assertion, its.required]),
    ).toEqual([
      ["behavior_1", true],
      ["behavior_2", true],
      [PREDEFINED_GRADERS.latency, false],
    ]);
  });

  /**
   * The key stays the key. The words beside it are read from the version this
   * conversation was executed against, which is why editing the test afterwards
   * cannot rewrite what a judgment was about — the case for that lives with the
   * read itself; what this one holds is that the read is actually made here.
   */
  it("resolves each assertion key into the sentence somebody wrote", async () => {
    const { key, runId } = await aJudgedRun("run_lanes_words");

    const read = await request("GET", `/api/runs/${runId}`, key);
    const one = (read.body.simulations as Record<string, unknown>[])[0];
    const rows = one?.verdicts as Record<string, unknown>[];

    expect(rows.map((its) => its.assertion_text)).toEqual([
      THE_BEHAVIORS[0],
      THE_BEHAVIORS[1],
      // A copy that makes exactly one assertion names it by its entry's
      // identifier, and what a person reads for that is the entry's name.
      "latency",
    ]);
    // Beside the key, never instead of it: one is what a client filters by and
    // the other is what it shows.
    expect(rows.map((its) => its.assertion)).toEqual([
      "behavior_1",
      "behavior_2",
      PREDEFINED_GRADERS.latency,
    ]);
  });
});

/**
 * The same judgment, drawn on the other surface.
 *
 * One conversation is read at two addresses — a run's results and its own
 * transcript — and one component draws the judgment on both. So the two answers
 * have to carry the same fields, or the shared card reads two ways depending on
 * where somebody opened it. The field that matters most is `required`: the
 * outcome above it is folded over the required copies alone, so a diagnostic's
 * failure sent without its lane would be an unmarked red card under a header
 * that says `passed` — the headline disagreeing with the evidence beneath it,
 * which is the one thing read-time folding exists to prevent.
 */
describe("the same conversation read as a transcript", () => {
  it("marks the diagnostic and reports its lane, exactly as the run does", async () => {
    const { key, auth, runId, simulationId, diagnostic } =
      await aJudgedRun("run_lanes_transcript");

    // The conversation's own spans, so there is a transcript to read at all.
    // The verdict rows file under the simulation id and the spans under the 128
    // bits that id carries — the same number written two ways, which is what
    // lets one page show both with nothing having stored a mapping.
    const traceId = traceIdOfSimulation(simulationId);
    if (traceId === undefined) throw new Error("no trace id for this simulation");
    const startedAt = BigInt(Date.now()) * 1000n - 60_000_000n;
    await appendSpans(auth, [
      aSpan(traceId, {
        spanId: "1111111111111111",
        name: "agent_session",
        kind: "root",
        startedAtMicroseconds: startedAt,
        runId,
      }),
      aSpan(traceId, {
        spanId: "2222222222222222",
        parentSpanId: "1111111111111111",
        name: "agent_turn",
        kind: "turn:agent",
        text: "Thursday at four works. Shall I move it?",
        startedAtMicroseconds: startedAt + 1_000_000n,
        runId,
      }),
    ]);

    const window = {
      from: new Date(Number(startedAt / 1000n) - 60_000).toISOString(),
      to: new Date(Date.now() + 60_000).toISOString(),
    };
    const read = await ask(
      api.app,
      "GET",
      `/v1/traces/${traceId}?from=${window.from}&to=${window.to}`,
      key,
    );
    expect(read.statusCode, JSON.stringify(read.body)).toBe(200);

    // The outcome is the required lane, as everywhere.
    expect(read.body.outcome).toMatchObject({
      verdict: "passed",
      counts: { passed: 2, failed: 0, total: 2 },
    });
    // And the lane that only reports is beside it rather than missing.
    expect(read.body.diagnostics).toMatchObject({
      verdict: "failed",
      counts: { failed: 1, total: 1 },
    });

    const rows = read.body.verdicts as Record<string, unknown>[];
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(row).toHaveProperty("required");
      expect(row.required).toBe(row.grader_id !== diagnostic);
    }
    // The failed row is the diagnostic's, and it says so — which is the whole
    // difference between a red card that means something and one that does not.
    const failed = rows.find((row) => row.verdict === "failed");
    expect(failed?.grader_id).toBe(diagnostic);
    expect(failed?.required).toBe(false);
  });
});

/**
 * The three surfaces that show one run's verdict, asked in one test.
 *
 * **The crossing is the point, and the crossing is where the fault was.** Each
 * surface has its own read: run detail folds `readRunVerdicts`, run history
 * folds `readVerdictsAcrossRuns` over a whole page of runs at once, and a
 * conversation's own page folds `readVerdicts`. Three reads, one algebra, and
 * nothing anywhere asked all three the same question — so a lane split that one
 * of them forgot would show a run passing on the page somebody opened and
 * failing on the list they opened it from, with no test on either side failing.
 *
 * That is exactly what happened: `verdictLanes` took a defaulted `diagnostics`
 * argument, an empty set of diagnostics means *everything gates*, and the read
 * behind run history never passed one. Every existing test still passed,
 * because they predate `required` and none of them builds a diagnostic copy.
 *
 * So this is deliberately one test over three addresses rather than three tests.
 * Three would each be green against a tree where the surfaces disagree.
 */
describe("one run, read on every surface it appears on", () => {
  it("passes on run detail, in the run list and on the conversation, with the diagnostic failing on all three", async () => {
    const { key, runId, simulationId, diagnostic } =
      await aJudgedRun("run_lanes_every_surface");

    const detail = await request("GET", `/api/runs/${runId}`, key);
    expect(detail.statusCode, JSON.stringify(detail.body)).toBe(200);

    const history = await request("GET", "/api/runs", key);
    expect(history.statusCode, JSON.stringify(history.body)).toBe(200);
    const listed = (history.body.items as Record<string, unknown>[]).find(
      (one) => one.id === runId,
    );

    const conversation = await request(
      "GET",
      `/api/simulations/${simulationId}`,
      key,
    );
    expect(conversation.statusCode, JSON.stringify(conversation.body)).toBe(200);

    // One sentence, three answers: the run passed. The diagnostic's failure is
    // in none of them, because a copy that only reports can fail nothing.
    expect([
      detail.body.verdict,
      listed?.verdict,
      conversation.body.verdict,
    ]).toEqual(["passed", "passed", "passed"]);

    // And it is not silence either — the failure is reported, apart, on the two
    // surfaces that carry a lane of their own.
    expect(detail.body.diagnostics).toMatchObject({ verdict: "failed" });
    expect(conversation.body.diagnostics).toMatchObject({ verdict: "failed" });

    // The row that failed is the diagnostic's, and the conversation says so.
    const rows = conversation.body.verdicts as Record<string, unknown>[];
    const failed = rows.find((row) => row.verdict === "failed");
    expect(failed?.grader_id).toBe(diagnostic);
    expect(failed?.required).toBe(false);
  });
});

/** A span with every field stated, which is what the type requires. */
function aSpan(traceId: string, over: Partial<NewSpan>): NewSpan {
  return {
    traceId,
    spanId: "",
    parentSpanId: "",
    source: "simulation",
    emitter: "egma-runtime",
    environment: "default",
    startedAtMicroseconds: 0n,
    durationNanoseconds: 1_000_000_000n,
    name: "agent_turn",
    kind: "turn:agent",
    status: "unset",
    text: "",
    audioUrl: "",
    toolName: "",
    toolArguments: "",
    toolResult: "",
    providerCallId: "",
    connectionType: "retell",
    runId: "",
    agentId: "",
    agentVersionId: "",
    testVersionId: "",
    personaVersionId: "",
    payload: "{}",
    ...over,
  };
}
