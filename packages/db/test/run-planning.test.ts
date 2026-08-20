import { newId } from "@egma/ids";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createAgent,
  createPersona,
  createTest,
  deleteGrader,
  getGradingPlan,
  IdempotencyConflictError,
  listGraders,
  listSimulations,
  NotPermittedError,
  planRun,
  PREDEFINED_GRADERS,
  seedGraderLibrary,
  useLibraryEntry,
  refreshConnectionCapabilities,
  startRun,
  type AuthContext,
  type PlanItem,
  type Role,
} from "@egma/db";

import {
  createConnectedDatabase,
  type MigratedDatabase,
} from "./support/database.ts";
import {
  seedGraderCopies,
  seedOrganization,
  seedUser,
} from "./support/tenancy.ts";

/**
 * What a run decides before it exists.
 *
 * Three claims, and each of them is a state this product keeps apart from a
 * state it looks like:
 *
 * **A conversation egma cannot honestly have is skipped, never failed.** A test
 * that requires something the connection was measured not to do, or something
 * nobody has measured, produces a terminal `skipped` simulation with a
 * structured reason — no claim, no grading job, and the rest of the run
 * conducted around it. A run made entirely of those completes with nothing that
 * can be read as a pass.
 *
 * **What will judge a run is written down at the moment it starts.** One group
 * per pinned test version, holding every live running copy of the project whose
 * scope reaches simulations — the seeded expected-behaviors copy among them —
 * with one immutable grader version id as the execution pin. No copied model,
 * credential reference, or key enters the plan.
 *
 * **Starting is idempotent under a key the client chose.** The same key and the
 * same selection answers the run that already exists; the same key and a
 * different selection is refused out loud rather than quietly answered with
 * somebody else's run.
 */

let database: MigratedDatabase;

const acme = { organization: newId("org"), project: newId("prj") };
const ada = newId("usr");

function actingAsAcme(role: Role = "member"): AuthContext {
  return {
    userId: ada,
    organizationId: acme.organization,
    projectId: acme.project,
    role,
    via: "session",
  };
}

const neutralTraits = {
  personality: "Speaks plainly, stays patient, asks one question at a time.",
  language: "en-US",
} as const;

let agentId: string;
/** A chat connection, measured: it carries no audio and cannot press a digit. */
let measured: string;
/** A second connection nobody has ever measured. */
let unmeasured: string;
let rita: string;

/** A test with nothing to require of a connection: it runs anywhere. */
let plain: string;
/** A test that needs audio, which a measured chat connection does not have. */
let needsAudio: string;
/** A test that needs barge-in, which no adapter here speaks to at all. */
let needsBargeIn: string;

async function seedTestVersion(
  name: string,
  requiredCapabilities: readonly string[] = [],
): Promise<string> {
  const created = await createTest(actingAsAcme(), {
    name,
    scenario:
      "Their cleaning is booked for Thursday morning and has to move to any afternoon next week.",
    expectedBehaviors: [
      "verifies who it is speaking to before discussing the booking",
      "offers at least one afternoon slot next week",
    ],
    personaIds: [rita],
    requiredCapabilities: [...requiredCapabilities],
  });
  return created.versionId;
}

/** The plan items of one group, found by the version it judges. */
function itemsFor(
  groups: readonly { readonly items: readonly PlanItem[] }[],
  at: number,
): readonly PlanItem[] {
  return groups[at]?.items ?? [];
}

/**
 * The seeded expected-behaviors copy's item, found by the entry it points at
 * rather than by a name somebody could rename.
 *
 * It is an ordinary item now — one kind of item is all there is — and finding
 * it through `library_id` uses the same stable identity as its pinned immutable
 * definition revision, so a renamed copy is still this one.
 */
function behaviorsItem(items: readonly PlanItem[]): PlanItem | undefined {
  return items.find(
    (one) => one.libraryId === PREDEFINED_GRADERS.expectedBehaviors,
  );
}

beforeAll(async () => {
  database = await createConnectedDatabase("run_planning");

  await seedOrganization(database, acme.organization, [
    { id: acme.project, slug: "default" },
  ]);
  await seedUser(database, ada, "ada@acme.example");
  // And the copy of the predefined expected-behaviors grader that a real
  // project is born with. Every claim in this file about what a run freezes is
  // a claim about that copy being in the plan, so a fixture without one would
  // prove them all against an empty list.
  await seedGraderCopies();

  const created = await createAgent(actingAsAcme(), {
    name: "Front desk",
    connection: {
      agentPlatform: "retell",
      connectionKind: "retell_chat_api",
      accessVariant: "retell_chat_api.api_key",
      modality: "chat",
      environment: "staging",
      config: { retellAgentId: "agent_in_retell_1" },
      credentials: { apiKey: "a-retell-key-for-this-test" },
    },
  });
  agentId = created.id;
  measured = created.connection?.id ?? "";

  // The shipped adapter's two facts, on a chat connection: it examines
  // `raw_audio` and `dtmf`, finds neither, and deliberately says nothing about
  // `barge_in` — which is what makes "unsupported" and "nobody looked" two
  // different answers in this file rather than one.
  await refreshConnectionCapabilities(actingAsAcme(), agentId, measured);

  const second = await createAgent(actingAsAcme(), {
    name: "Night desk",
    connection: {
      agentPlatform: "retell",
      connectionKind: "retell_chat_api",
      accessVariant: "retell_chat_api.api_key",
      modality: "chat",
      environment: "staging",
      config: { retellAgentId: "agent_in_retell_2" },
      credentials: { apiKey: "another-retell-key" },
    },
  });
  unmeasured = second.connection?.id ?? "";

  rita = (
    await createPersona(actingAsAcme(), {
      name: "Rita",
      traits: neutralTraits,
    })
  ).id;

  plain = await seedTestVersion("Moving a booking");
  needsAudio = await seedTestVersion("Hearing the hold music", ["raw_audio"]);
  needsBargeIn = await seedTestVersion("Interrupting mid-sentence", ["barge_in"]);

  // The second agent has to be able to run them too, or applicability refuses
  // before capabilities are ever consulted.
  for (const versionId of [plain, needsAudio, needsBargeIn]) {
    const { rows } = await database.sql<{ test_id: string }>(
      "select test_id from test_version where id = $1",
      [versionId],
    );
    const testId = rows[0]?.test_id ?? "";
    // `on conflict do nothing`, because a test created with no explicit
    // targets is already linked to every active agent of its project.
    await database.sql(
      "insert into test_agent (test_id, agent_id, project_id) values ($1, $2, $3) on conflict do nothing",
      [testId, second.id, acme.project],
    );
  }
});

afterAll(async () => {
  await database.drop();
});

describe("a test this connection cannot honestly run", () => {
  it("is written terminal skipped with the reason and the capabilities that decided it", async () => {
    const started = await startRun(actingAsAcme(), {
      agentId,
      connectionId: measured,
      testVersionIds: [needsAudio],
      idempotencyKey: newId("run"),
    });

    const [only] = started.simulations;
    expect(only?.status).toBe("skipped");
    expect(only?.skipReason).toBe("required_capability_unsupported");
    expect(only?.skippedCapabilities).toEqual(["raw_audio"]);
    // Terminal from birth: it ended when it was written, and nothing ever
    // claimed it or started it.
    expect(only?.endedAt).not.toBeNull();
    expect(only?.claimedAt).toBeNull();
    expect(only?.startedAt).toBeNull();
  });

  it("tells a measured absence from an unmeasured one, because the fixes differ", async () => {
    const measuredRun = await startRun(actingAsAcme(), {
      agentId,
      connectionId: measured,
      testVersionIds: [needsBargeIn],
      idempotencyKey: newId("run"),
    });
    // The adapter examined `raw_audio` and `dtmf` and said nothing about
    // `barge_in`, so this is an unasked question rather than a settled fact.
    expect(measuredRun.simulations[0]?.skipReason).toBe(
      "required_capability_unknown",
    );

    const unmeasuredRun = await startRun(actingAsAcme(), {
      connectionId: unmeasured,
      testVersionIds: [needsAudio],
      idempotencyKey: newId("run"),
    });
    // Same requirement, a connection nobody has measured: also unknown, and
    // never "unsupported" — nothing has looked.
    expect(unmeasuredRun.simulations[0]?.skipReason).toBe(
      "required_capability_unknown",
    );
  });

  it("never becomes grading work, because there is no conversation to judge", async () => {
    const started = await startRun(actingAsAcme(), {
      agentId,
      connectionId: measured,
      testVersionIds: [needsAudio],
      idempotencyKey: newId("run"),
    });
    const { rows } = await database.sql<{ count: string }>(
      "select count(*) as count from grading_job where simulation_id = $1",
      [started.simulations[0]?.id ?? ""],
    );
    expect(Number(rows[0]?.count)).toBe(0);
  });

  it("leaves the rest of the run to be conducted", async () => {
    const started = await startRun(actingAsAcme(), {
      agentId,
      connectionId: measured,
      testVersionIds: [plain, needsAudio],
      idempotencyKey: newId("run"),
    });

    expect(started.simulations.map((one) => one.status)).toEqual([
      "queued",
      "skipped",
    ]);
    // Still pending, because something is still to be conducted — and the
    // counts stay unwritten until the queued one lands.
    expect(started.status).toBe("pending");
    expect(started.skippedCount).toBeNull();
  });

  it("completes an all-skipped run at once, with no passing headline", async () => {
    const started = await startRun(actingAsAcme(), {
      agentId,
      connectionId: measured,
      testVersionIds: [needsAudio, needsBargeIn],
      idempotencyKey: newId("run"),
    });

    expect(started.status).toBe("completed");
    expect(started.finishedAt).not.toBeNull();
    // Nothing conducted, nothing failed, nobody canceled anything — and the
    // skipped count is the whole of it. Three zeroes and a number is what makes
    // this unreadable as a pass.
    expect(started.completedCount).toBe(0);
    expect(started.failedCount).toBe(0);
    expect(started.canceledCount).toBe(0);
    expect(started.skippedCount).toBe(2);
  });

  it("is never claimable, whatever a simulator asks for", async () => {
    const started = await startRun(actingAsAcme(), {
      agentId,
      connectionId: measured,
      testVersionIds: [needsAudio],
      idempotencyKey: newId("run"),
    });
    const { rows } = await database.sql<{ count: string }>(
      "select count(*) as count from simulation where run_id = $1 and status = 'queued'",
      [started.id],
    );
    expect(Number(rows[0]?.count)).toBe(0);
  });
});

describe("the review, before anybody starts anything", () => {
  it("answers the same skip the start would write, rather than refusing", async () => {
    const plan = await planRun(actingAsAcme(), {
      agentId,
      connectionId: measured,
      testVersionIds: [plain, needsAudio],
    });

    expect(plan.runnableSimulationCount).toBe(1);
    expect(plan.skippedSimulationCount).toBe(1);
    expect(plan.groups[0]?.capability).toEqual({ runnable: true });
    expect(plan.groups[1]?.capability).toEqual({
      runnable: false,
      reason: "required_capability_unsupported",
      capabilities: ["raw_audio"],
    });
  });

  it("names the persona versions the run would pin", async () => {
    const plan = await planRun(actingAsAcme(), {
      agentId,
      connectionId: measured,
      testVersionIds: [plain],
    });
    const started = await startRun(actingAsAcme(), {
      agentId,
      connectionId: measured,
      testVersionIds: [plain],
      idempotencyKey: newId("run"),
    });

    expect(plan.groups[0]?.personas[0]?.personaVersionId).toBe(
      started.simulations[0]?.personaVersionId,
    );
  });

  it("refuses a test that does not apply to this agent, exactly as the start does", async () => {
    const strangerAgent = await createAgent(actingAsAcme(), {
      name: "Somewhere else",
      connection: {
        agentPlatform: "retell",
        connectionKind: "retell_chat_api",
        accessVariant: "retell_chat_api.api_key",
        modality: "chat",
        config: { retellAgentId: "agent_in_retell_3" },
        credentials: { apiKey: "a-third-retell-key" },
      },
    });

    await expect(
      planRun(actingAsAcme(), {
        agentId: strangerAgent.id,
        connectionId: strangerAgent.connection?.id ?? "",
        testVersionIds: [plain],
      }),
    ).rejects.toThrow(/does not apply to agent/u);
  });
});

describe("the grading plan a run freezes", () => {
  it("holds one group per pinned version, each carrying the seeded grader", async () => {
    const started = await startRun(actingAsAcme(), {
      agentId,
      connectionId: measured,
      testVersionIds: [plain, needsAudio],
      idempotencyKey: newId("run"),
    });

    const plan = await getGradingPlan(actingAsAcme(), started.id);
    expect(plan?.state).toBe("run_start");
    expect(plan?.capturedAt).not.toBeNull();
    expect(plan?.groups).toHaveLength(2);
    expect(plan?.groups.map((group) => group.tag)).toEqual([
      "version",
      "version",
    ]);

    for (const group of plan?.groups ?? []) {
      // The seeded copy every project is born with, in every group: a first run
      // is judged with no setup at all because this row exists.
      const item = behaviorsItem(group.items);
      expect(item?.libraryId).toBe(PREDEFINED_GRADERS.expectedBehaviors);
      // It is an ordinary running copy and it has an identity, which is the
      // whole of the redesign at this level: a rowless sentinel could not be
      // switched off, renamed, or made a diagnostic.
      expect(item?.graderId).toMatch(/^grd_/u);
      expect(item?.graderVersionId).toMatch(/^grv_/u);
      expect(item?.required).toBe(true);
      // The immutable version owns its model. Copying it into the plan would
      // leave two durable answers that could disagree.
      expect("judge" in (item ?? {})).toBe(false);
    }
  });

  it("is frozen even for a conversation it will never conduct", async () => {
    const started = await startRun(actingAsAcme(), {
      agentId,
      connectionId: measured,
      testVersionIds: [needsAudio],
      idempotencyKey: newId("run"),
    });
    // A run with nothing to conduct still records what would have judged it,
    // because the plan is what makes the run interpretable afterwards.
    const plan = await getGradingPlan(actingAsAcme(), started.id);
    expect(plan?.state).toBe("run_start");
    expect(plan?.groups).toHaveLength(1);
  });

  it("carries the project's running copies, at the versions they stand at", async () => {
    const copy = await useLibraryEntry(actingAsAcme(), {
      libraryId: PREDEFINED_GRADERS.latency,
      name: "Answers inside two seconds",
      params: { metric: "turn_response_latency", bound: 2_000 },
    });

    const started = await startRun(actingAsAcme(), {
      agentId,
      connectionId: measured,
      testVersionIds: [plain],
      idempotencyKey: newId("run"),
    });
    const plan = await getGradingPlan(actingAsAcme(), started.id);
    const item = itemsFor(plan?.groups ?? [], 0).find(
      (one) => one.graderId === copy.id,
    );

    expect(item?.graderVersionId).toBe(copy.versionId);
    expect(item?.libraryId).toBe(PREDEFINED_GRADERS.latency);
    expect(item?.required).toBe(true);
    expect("judge" in (item ?? {})).toBe(false);
  });

  /**
   * A diagnostic copy is planned exactly like a blocking one, and the plan says
   * which it is.
   *
   * The flag has to ride the item because a page draws the plan before a single
   * verdict exists — so "this one reports and cannot fail the run" has to be
   * readable from what was frozen, not worked out from rows nobody has written.
   */
  it("marks a diagnostic copy as one, and plans it like any other", async () => {
    const copy = await useLibraryEntry(actingAsAcme(), {
      libraryId: PREDEFINED_GRADERS.latency,
      name: "Reports how fast it answered",
      required: false,
      params: { metric: "turn_response_latency", bound: 1_000 },
    });

    const started = await startRun(actingAsAcme(), {
      agentId,
      connectionId: measured,
      testVersionIds: [plain],
      idempotencyKey: newId("run"),
    });
    const plan = await getGradingPlan(actingAsAcme(), started.id);
    const item = itemsFor(plan?.groups ?? [], 0).find(
      (one) => one.graderId === copy.id,
    );

    expect(item).toBeDefined();
    expect(item?.required).toBe(false);
    // And where it applies, frozen beside the flag. A page drawing the plan
    // reads both off the item; nothing recomputes them from the copy, which
    // may have been deleted by the time somebody opens the run.
    expect(item?.scope).toBe("simulations");
  });

  /**
   * A copy whose scope reaches live traffic is planned for the simulations too,
   * and the item says `both` rather than the half this run is.
   *
   * The scope on a frozen item is what the copy was set to, not a note about
   * which side of it produced this run — a plan that narrowed it would describe
   * a grader the project never configured.
   */
  it("freezes a both-scoped copy with its own scope, not the run's half", async () => {
    const copy = await useLibraryEntry(actingAsAcme(), {
      libraryId: PREDEFINED_GRADERS.latency,
      name: "Watches both sides",
      scope: "both",
      productionSampleRate: 10,
      params: { metric: "turn_response_latency", bound: 1_500 },
    });

    const started = await startRun(actingAsAcme(), {
      agentId,
      connectionId: measured,
      testVersionIds: [plain],
      idempotencyKey: newId("run"),
    });
    const plan = await getGradingPlan(actingAsAcme(), started.id);
    const item = itemsFor(plan?.groups ?? [], 0).find(
      (one) => one.graderId === copy.id,
    );

    expect(item?.scope).toBe("both");
  });

  it("keeps two items for one grader across two selected versions", async () => {
    const started = await startRun(actingAsAcme(), {
      agentId,
      connectionId: measured,
      testVersionIds: [plain, needsBargeIn],
      idempotencyKey: newId("run"),
    });
    const plan = await getGradingPlan(actingAsAcme(), started.id);

    const first = itemsFor(plan?.groups ?? [], 0);
    const second = itemsFor(plan?.groups ?? [], 1);
    expect(first.length).toBeGreaterThan(0);
    expect(second.map((one) => one.graderId).sort()).toEqual(
      first.map((one) => one.graderId).sort(),
    );
  });

  it("leaves a switched-off copy out of a new plan, and starts the run anyway", async () => {
    const grader = await useLibraryEntry(actingAsAcme(), {
      libraryId: PREDEFINED_GRADERS.latency,
      name: "Taken out of use",
      params: { metric: "turn_response_latency", bound: 3_000 },
    });
    await deleteGrader(actingAsAcme(), grader.id);

    const started = await startRun(actingAsAcme(), {
      agentId,
      connectionId: measured,
      testVersionIds: [plain],
      idempotencyKey: newId("run"),
    });
    const plan = await getGradingPlan(actingAsAcme(), started.id);

    expect(
      itemsFor(plan?.groups ?? [], 0).map((one) => one.graderId),
    ).not.toContain(grader.id);
    expect(started.status).toBe("pending");
  });

  it("pins the grader version without copying its model or a credential", async () => {
    const started = await startRun(actingAsAcme(), {
      agentId,
      connectionId: measured,
      testVersionIds: [plain],
      idempotencyKey: newId("run"),
    });
    const plan = await getGradingPlan(actingAsAcme(), started.id);
    const item = behaviorsItem(itemsFor(plan?.groups ?? [], 0));

    expect(item?.graderVersionId).toMatch(/^grv_/u);
    expect("judge" in (item ?? {})).toBe(false);

    const { rows } = await database.sql<{ groups: string }>(
      "select groups::text as groups from grading_plan where run_id = $1",
      [started.id],
    );
    expect(rows[0]?.groups).not.toContain("provider");
    expect(rows[0]?.groups).not.toContain("model");
    expect(rows[0]?.groups).not.toContain("source");
    expect(rows[0]?.groups).not.toContain("credential");
  });
});

/**
 * A project and the three grader plans it can ask for.
 *
 * The expected-behaviors grader used to be an implicit built-in. ADR-0009 made
 * it an ordinary seeded copy, and deleting a copy is how a grader is switched
 * off. A run now pins only the grader versions selected by its plan. A model-
 * judged version carries its own model selection; a computed version carries
 * no model at all.
 *
 * The three cases below are that rule, and the second and third are the ones
 * the old rule got wrong — it refused runs for a key they would never have
 * spent.
 */
describe("a run pins only the grader versions its plan selects", () => {
  /** A judge-less project with an agent, a persona and a test, and nothing else. */
  async function judgelessProject(slug: string): Promise<{
    readonly auth: AuthContext;
    readonly projectId: string;
    readonly agentId: string;
    readonly connectionId: string;
    readonly versionId: string;
  }> {
    const made = { organization: newId("org"), project: newId("prj") };
    const grace = newId("usr");
    await seedOrganization(database, made.organization, [
      { id: made.project, slug },
    ]);
    await seedUser(database, grace, `grace-${slug}@globex.example`);

    const auth: AuthContext = {
      userId: grace,
      organizationId: made.organization,
      projectId: made.project,
      role: "member",
      via: "session",
    };

    const agent = await createAgent(auth, {
      name: "Unjudged",
      connection: {
        agentPlatform: "retell",
        connectionKind: "retell_chat_api",
        accessVariant: "retell_chat_api.api_key",
        modality: "chat",
        config: { retellAgentId: `agent_in_retell_${slug}` },
        credentials: { apiKey: `a-key-for-${slug}` },
      },
    });
    const persona = await createPersona(auth, {
      name: "Sam",
      traits: neutralTraits,
    });
    const test = await createTest(auth, {
      name: "Anything at all",
      scenario: "Their cleaning has to move.",
      expectedBehaviors: ["confirms the new time"],
      personaIds: [persona.id],
    });

    return {
      auth,
      projectId: made.project,
      agentId: agent.id,
      connectionId: agent.connection?.id ?? "",
      versionId: test.versionId,
    };
  }

  it("starts with the immutable version of its seeded grader", async () => {
    const made = await judgelessProject("asks-a-model");
    // The copy a real project is created with. These fixtures build tenants by
    // raw SQL and skip the transaction that writes it, so the claim below —
    // that the expected-behaviors copy is what needs the judge — has to be
    // proved against a project that actually holds one.
    await seedGraderCopies();

    const started = await startRun(made.auth, {
      agentId: made.agentId,
      connectionId: made.connectionId,
      testVersionIds: [made.versionId],
      idempotencyKey: newId("run"),
    });
    expect(started.status).toBe("pending");

    const plan = await planRun(made.auth, {
      agentId: made.agentId,
      connectionId: made.connectionId,
      testVersionIds: [made.versionId],
    });
    const item = behaviorsItem(itemsFor(plan.groups, 0));
    expect(item?.graderVersionId).toMatch(/^grv_/u);
    expect("judge" in (item ?? {})).toBe(false);
  });

  /**
   * A project judging only by computation never asks a model. Removing the
   * seeded model grader therefore leaves one complete, executable plan.
   */
  it("starts a run whose graders are all computed rather than judged", async () => {
    const made = await judgelessProject("computed-only");
    await seedGraderCopies();
    const [seeded] = (await listGraders(made.auth, {})).items;
    if (seeded === undefined) throw new Error("the project has no graders");
    await deleteGrader(made.auth, seeded.id);

    const latency = await useLibraryEntry(made.auth, {
      libraryId: PREDEFINED_GRADERS.latency,
      params: { metric: "turn_response_latency", bound: 2_000 },
    });

    const started = await startRun(made.auth, {
      agentId: made.agentId,
      connectionId: made.connectionId,
      testVersionIds: [made.versionId],
      idempotencyKey: newId("run"),
    });

    expect(started.status).toBe("pending");
    const plan = await getGradingPlan(made.auth, started.id);
    const items = itemsFor(plan?.groups ?? [], 0);
    expect(items.map((one) => one.graderId)).toEqual([latency.id]);
    expect("judge" in (items[0] ?? {})).toBe(false);
  });

  /**
   * And a project judged by nothing at all runs too, and comes back with no
   * verdicts. That is a decision somebody took on the Graders screen — deleting
   * a copy is how a grader is switched off, and there is no other switch — so
   * it is warned about where it is taken, and never refused here.
   */
  it("starts a run for a project judged by nothing, and freezes an empty plan", async () => {
    const made = await judgelessProject("judged-by-nothing");
    await seedGraderCopies();
    for (const copy of (await listGraders(made.auth, {})).items) {
      await deleteGrader(made.auth, copy.id);
    }

    const started = await startRun(made.auth, {
      agentId: made.agentId,
      connectionId: made.connectionId,
      testVersionIds: [made.versionId],
      idempotencyKey: newId("run"),
    });

    expect(started.status).toBe("pending");
    // A group for the version, holding nothing: the run happens, and judges
    // nothing. An empty plan and a missing plan are different facts.
    const plan = await getGradingPlan(made.auth, started.id);
    expect(plan?.groups).toHaveLength(1);
    expect(itemsFor(plan?.groups ?? [], 0)).toEqual([]);
  });
});

describe("starting a run twice under one key", () => {
  it("answers the original run rather than starting a second", async () => {
    const key = newId("run");
    const first = await startRun(actingAsAcme(), {
      agentId,
      connectionId: measured,
      testVersionIds: [plain],
      idempotencyKey: key,
    });
    const again = await startRun(actingAsAcme(), {
      agentId,
      connectionId: measured,
      testVersionIds: [plain],
      idempotencyKey: key,
    });

    expect(again.id).toBe(first.id);
    expect(again.simulations.map((one) => one.id)).toEqual(
      first.simulations.map((one) => one.id),
    );
  });

  it("refuses a different selection under the same key, and writes nothing", async () => {
    const key = newId("run");
    const first = await startRun(actingAsAcme(), {
      agentId,
      connectionId: measured,
      testVersionIds: [plain],
      idempotencyKey: key,
    });

    await expect(
      startRun(actingAsAcme(), {
        agentId,
        connectionId: measured,
        testVersionIds: [plain, needsBargeIn],
        idempotencyKey: key,
      }),
    ).rejects.toBeInstanceOf(IdempotencyConflictError);

    const { rows } = await database.sql<{ count: string }>(
      "select count(*) as count from idempotent_operation where idempotency_key = $1",
      [key],
    );
    expect(Number(rows[0]?.count)).toBe(1);
    expect((await listSimulations(actingAsAcme(), first.id))?.length).toBe(1);
  });

  it("keeps one person's key out of another's, because a key is a word somebody chose", async () => {
    const key = "the-same-word-we-both-chose";
    const grace = newId("usr");
    await seedUser(database, grace, "grace@acme.example");

    const mine = await startRun(actingAsAcme(), {
      agentId,
      connectionId: measured,
      testVersionIds: [plain],
      idempotencyKey: key,
    });
    const theirs = await startRun(
      { ...actingAsAcme(), userId: grace },
      {
        agentId,
        connectionId: measured,
        testVersionIds: [plain],
        idempotencyKey: key,
      },
    );

    expect(theirs.id).not.toBe(mine.id);
  });

  it("starts a run at all without one, because egma's own fixtures have no retry to guard", async () => {
    const started = await startRun(actingAsAcme(), {
      agentId,
      connectionId: measured,
      testVersionIds: [plain],
    });
    expect(started.status).toBe("pending");
  });
});

describe("who may plan and start", () => {
  it("lets a viewer read the builder's inputs and refuses their start", async () => {
    const plan = await planRun(actingAsAcme("viewer"), {
      agentId,
      connectionId: measured,
      testVersionIds: [plain],
    });
    expect(plan.groups).toHaveLength(1);

    await expect(
      startRun(actingAsAcme("viewer"), {
        agentId,
        connectionId: measured,
        testVersionIds: [plain],
        idempotencyKey: newId("run"),
      }),
    ).rejects.toBeInstanceOf(NotPermittedError);
  });
});
