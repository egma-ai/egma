import { newId } from "@egma/ids";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  archiveJudgeCredential,
  createAgent,
  createGrader,
  createJudgeCredential,
  createPersona,
  createTest,
  deleteGrader,
  getGradingPlan,
  IdempotencyConflictError,
  JudgeCredentialInUseError,
  JudgeNotConfiguredError,
  listSimulations,
  NotPermittedError,
  planRun,
  refreshConnectionCapabilities,
  setProjectJudge,
  startRun,
  type AuthContext,
  type AuthoredPlanItem,
  type BuiltInPlanItem,
  type PlanItem,
  type Role,
} from "@egma/db";

import {
  createConnectedDatabase,
  type MigratedDatabase,
} from "./support/database.ts";
import { seedJudge, seedOrganization, seedUser } from "./support/tenancy.ts";

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
 * per pinned test version, the expected-behaviors built-in in every one of
 * them, the project's default graders, and the graders each version names
 * directly — with a judge choice on each that carries a credential *reference*
 * and never a key.
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
  voice: { provider: "elevenlabs", voiceId: "EXAVITQu4vr4xnSDxMaL", speed: 1 },
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
      { behavior: "offers at least one afternoon slot next week", priority: "P1" },
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

function authored(items: readonly PlanItem[]): readonly AuthoredPlanItem[] {
  return items.filter((one): one is AuthoredPlanItem => one.kind === "authored");
}

function builtIn(items: readonly PlanItem[]): BuiltInPlanItem | undefined {
  return items.find((one): one is BuiltInPlanItem => one.kind === "built_in");
}

beforeAll(async () => {
  database = await createConnectedDatabase("run_planning");

  await seedOrganization(database, acme.organization, [
    { id: acme.project, slug: "default" },
  ]);
  await seedUser(database, ada, "ada@acme.example");
  await seedJudge(actingAsAcme("admin"));

  const created = await createAgent(actingAsAcme(), {
    name: "Front desk",
    connection: {
      type: "retell",
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
      type: "retell",
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
        type: "retell",
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
  it("holds one group per pinned version, each carrying the built-in", async () => {
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
      const item = builtIn(group.items);
      expect(item?.graderKey).toBe("expected_behaviors_v1");
      // No grader identity, no version, no scope, no item-wide priority: each
      // verdict takes its priority from the behavior it judged.
      expect(item).not.toHaveProperty("graderId");
      expect(item).not.toHaveProperty("priority");
      expect(item?.reads).toEqual([
        "transcript",
        "outcome",
        "tool_calls",
        "measures",
      ]);
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

  it("carries the project's default graders, at the versions they stand at", async () => {
    const grader = await createGrader(actingAsAcme(), {
      name: "Never quotes a price",
      type: "phrase_match",
      priority: "P1",
      config: {
        required: [],
        banned: [{ text: "guaranteed", match: "contains" }],
        speaker: "agent",
      },
    });

    const started = await startRun(actingAsAcme(), {
      agentId,
      connectionId: measured,
      testVersionIds: [plain],
      idempotencyKey: newId("run"),
    });
    const plan = await getGradingPlan(actingAsAcme(), started.id);
    const item = authored(itemsFor(plan?.groups ?? [], 0)).find(
      (one) => one.graderId === grader.id,
    );

    expect(item?.origin).toBe("project_default");
    expect(item?.graderVersionId).toBe(grader.versionId);
    expect(item?.priority).toBe("P1");
    // A deterministic grader asks no model, so naming one would be a bill
    // nobody incurs.
    expect(item?.judge).toEqual({ tag: "not_required" });
  });

  it("keeps one item where a grader is both a default and named by the test, and it is the direct one", async () => {
    const grader = await createGrader(actingAsAcme(), {
      name: "Says the disclosure",
      type: "phrase_match",
      config: {
        required: [{ text: "recorded", match: "contains" }],
        banned: [],
        speaker: "agent",
      },
    });

    const created = await createTest(actingAsAcme(), {
      name: "A test that names it directly",
      scenario: "Their cleaning has to move to any afternoon next week.",
      expectedBehaviors: ["confirms the new time back before finishing"],
      personaIds: [rita],
      graderIds: [grader.id],
    });
    await database.sql(
      "insert into test_agent (test_id, agent_id, project_id) values ($1, $2, $3) on conflict do nothing",
      [created.id, agentId, acme.project],
    );

    const started = await startRun(actingAsAcme(), {
      agentId,
      connectionId: measured,
      testVersionIds: [created.versionId],
      idempotencyKey: newId("run"),
    });
    const plan = await getGradingPlan(actingAsAcme(), started.id);
    const named = authored(itemsFor(plan?.groups ?? [], 0)).filter(
      (one) => one.graderId === grader.id,
    );

    expect(named).toHaveLength(1);
    // The direct link is the scoping decision, so it is the origin that
    // survives — a page has to be able to say why this grader is here.
    expect(named[0]?.origin).toBe("scenario_specific");
  });

  it("keeps two items for one grader across two selected versions", async () => {
    const started = await startRun(actingAsAcme(), {
      agentId,
      connectionId: measured,
      testVersionIds: [plain, needsBargeIn],
      idempotencyKey: newId("run"),
    });
    const plan = await getGradingPlan(actingAsAcme(), started.id);

    const first = authored(itemsFor(plan?.groups ?? [], 0));
    const second = authored(itemsFor(plan?.groups ?? [], 1));
    expect(first.length).toBeGreaterThan(0);
    expect(second.map((one) => one.graderId).sort()).toEqual(
      first.map((one) => one.graderId).sort(),
    );
  });

  it("leaves an archived grader out of a new plan, and starts the run anyway", async () => {
    const grader = await createGrader(actingAsAcme(), {
      name: "Taken out of use",
      type: "phrase_match",
      config: {
        required: [{ text: "goodbye", match: "contains" }],
        banned: [],
        speaker: "agent",
      },
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
      authored(itemsFor(plan?.groups ?? [], 0)).map((one) => one.graderId),
    ).not.toContain(grader.id);
    expect(started.status).toBe("pending");
  });

  it("names the credential a judged grader spends from, and never a key", async () => {
    const credential = await createJudgeCredential(actingAsAcme("admin"), {
      label: "The team's key",
      provider: "openai",
      key: "sk-a-real-looking-openai-key-0001",
    });
    await setProjectJudge(actingAsAcme("admin"), {
      provider: "openai",
      model: "gpt-4.1-mini",
      source: credential.id,
    });

    const started = await startRun(actingAsAcme(), {
      agentId,
      connectionId: measured,
      testVersionIds: [plain],
      idempotencyKey: newId("run"),
    });
    const plan = await getGradingPlan(actingAsAcme(), started.id);
    const item = builtIn(itemsFor(plan?.groups ?? [], 0));

    expect(item?.judge).toEqual({
      tag: "configured",
      provider: "openai",
      model: "gpt-4.1-mini",
      source: credential.id,
    });

    // The whole plan, as bytes, with the key it was written under nowhere in it.
    const { rows } = await database.sql<{ groups: string }>(
      "select groups::text as groups from grading_plan where run_id = $1",
      [started.id],
    );
    expect(rows[0]?.groups).not.toContain("sk-a-real-looking-openai-key-0001");
  });
});

describe("a project with no judge", () => {
  it("cannot start a run at all, because every run judges its behaviors", async () => {
    const other = { organization: newId("org"), project: newId("prj") };
    const grace = newId("usr");
    await seedOrganization(database, other.organization, [
      { id: other.project, slug: "default" },
    ]);
    await seedUser(database, grace, "grace@globex.example");

    const auth: AuthContext = {
      userId: grace,
      organizationId: other.organization,
      projectId: other.project,
      role: "member",
      via: "session",
    };

    const agent = await createAgent(auth, {
      name: "Unjudged",
      connection: {
        type: "retell",
        modality: "chat",
        config: { retellAgentId: "agent_in_retell_9" },
        credentials: { apiKey: "a-key-for-the-unjudged-project" },
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

    await expect(
      startRun(auth, {
        agentId: agent.id,
        connectionId: agent.connection?.id ?? "",
        testVersionIds: [test.versionId],
        idempotencyKey: newId("run"),
      }),
    ).rejects.toBeInstanceOf(JudgeNotConfiguredError);

    // Nothing was written: not the run, and not a simulation to explain.
    const { rows } = await database.sql<{ count: string }>(
      "select count(*) as count from run where project_id = $1",
      [other.project],
    );
    expect(Number(rows[0]?.count)).toBe(0);

    // And the review answers it as a state, so a page can draw it rather than
    // meeting a refusal it cannot render.
    const plan = await planRun(auth, {
      agentId: agent.id,
      connectionId: agent.connection?.id ?? "",
      testVersionIds: [test.versionId],
    });
    expect(plan.judge).toEqual({ state: "needs_setup" });
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

describe("archiving a judge credential", () => {
  it("is refused while a project points at it, and names the project", async () => {
    const credential = await createJudgeCredential(actingAsAcme("admin"), {
      label: "Pointed at",
      provider: "openai",
      key: "sk-a-real-looking-openai-key-0002",
    });
    await setProjectJudge(actingAsAcme("admin"), {
      provider: "openai",
      model: "gpt-4.1-mini",
      source: credential.id,
    });

    const refused = await archiveJudgeCredential(
      actingAsAcme("admin"),
      credential.id,
    ).catch((cause: unknown) => cause);

    expect(refused).toBeInstanceOf(JudgeCredentialInUseError);
    expect((refused as JudgeCredentialInUseError).uses).toContainEqual({
      kind: "project",
      id: acme.project,
    });
  });

  it("is refused while a run's frozen plan still names it, and names the run", async () => {
    const credential = await createJudgeCredential(actingAsAcme("admin"), {
      label: "Frozen into a plan",
      provider: "openai",
      key: "sk-a-real-looking-openai-key-0003",
    });
    await setProjectJudge(actingAsAcme("admin"), {
      provider: "openai",
      model: "gpt-4.1-mini",
      source: credential.id,
    });

    const started = await startRun(actingAsAcme(), {
      agentId,
      connectionId: measured,
      testVersionIds: [plain],
      idempotencyKey: newId("run"),
    });

    // Point the project somewhere else, so the only thing left holding this
    // credential is the frozen plan of a run still conducting.
    await setProjectJudge(actingAsAcme("admin"), {
      provider: "openai",
      model: "gpt-4.1-mini",
      source: (
        await createJudgeCredential(actingAsAcme("admin"), {
          label: "Somewhere else",
          provider: "openai",
          key: "sk-a-real-looking-openai-key-0004",
        })
      ).id,
    });

    const refused = await archiveJudgeCredential(
      actingAsAcme("admin"),
      credential.id,
    ).catch((cause: unknown) => cause);

    expect(refused).toBeInstanceOf(JudgeCredentialInUseError);
    expect((refused as JudgeCredentialInUseError).uses).toContainEqual({
      kind: "run",
      id: started.id,
    });
  });

  it("succeeds once nothing needs it, and the plans that named it stay readable", async () => {
    const credential = await createJudgeCredential(actingAsAcme("admin"), {
      label: "Nothing needs it",
      provider: "openai",
      key: "sk-a-real-looking-openai-key-0005",
    });

    const archived = await archiveJudgeCredential(
      actingAsAcme("admin"),
      credential.id,
    );
    expect(archived?.id).toBe(credential.id);
    // The row stays: a plan frozen under it has to keep naming something
    // readable, which is the difference between archiving and deleting.
    const { rows } = await database.sql<{ count: string }>(
      "select count(*) as count from judge_credential where id = $1",
      [credential.id],
    );
    expect(Number(rows[0]?.count)).toBe(1);
  });

  it("is refused to anybody but an admin", async () => {
    const credential = await createJudgeCredential(actingAsAcme("admin"), {
      label: "Not a member's to remove",
      provider: "openai",
      key: "sk-a-real-looking-openai-key-0006",
    });

    await expect(
      archiveJudgeCredential(actingAsAcme("member"), credential.id),
    ).rejects.toBeInstanceOf(NotPermittedError);
  });
});
