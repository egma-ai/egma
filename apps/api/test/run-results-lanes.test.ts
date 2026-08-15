import {
  appendVerdicts,
  createPersona,
  listGraders,
  PREDEFINED_GRADERS,
  useLibraryEntry,
  type AuthContext,
} from "@egma/db";
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

  await createPersona(auth, { name: "Impatient Rita", traits: NEUTRAL_TRAITS });

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
  });
  expect(started.statusCode, JSON.stringify(started.body)).toBe(201);

  const runId = String(started.body.id);
  const simulations = started.body.simulations as Record<string, unknown>[];
  const simulationId = String(simulations[0]?.id);

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
