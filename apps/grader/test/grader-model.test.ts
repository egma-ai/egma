import { newId } from "@egma/ids";
import {
  claimGradingJobs,
  connectManagedAccess,
  disconnectManagedAccess,
  getGrader,
  holdManagedDeployment,
  GRADING_CAPABILITIES,
  readVerdicts,
  removeModelProviderCredential,
  setModelAccess,
  storeModelProviderCredential,
  type AuthContext,
  type RecordedVerdict,
} from "@egma/db";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  aConversation,
  aJudgedCopy,
  conductSimulation,
  eventually,
  makeWorld,
  oneServiceAtATime,
  seedGrader,
  seedJudge,
  seedTest,
  type World,
} from "./support/world.ts";
import { met, scriptedJudge } from "./support/scripted-judge.ts";
import { judgesOnce, NoJudge } from "../src/judge/index.ts";

/**
 * A grader that selects its own model, and the account it spends from.
 *
 * **The claim under test is which of two sources answers**, so every case sets
 * both at once: a project judge with one key, and an organization credential
 * with another. A test that set only one would pass against a grader that read
 * neither.
 *
 * The key itself is not a field anything outside `src/judge/` can read, so it
 * is observed where it is actually spent — at the provider seam the scripted
 * maker stands in for — and its absence is observed everywhere a person can
 * read: the rationale, the verdict rows, and the service's own log.
 */

let world: World;
const service = oneServiceAtATime();

const BEHAVIOR = "confirms the new time back before finishing";

/** Sentinels, so a leak anywhere is a string a scan can find. */
const THE_ORGANIZATIONS_KEY = "sk-sentinel-organization-openai-K7L8";
const THE_PROJECTS_JUDGE_KEY = "sk-sentinel-project-judge-M9N0";

/** What a grading claim resolves to, as the queue builds it. */
function theEngine(): AuthContext {
  return {
    userId: "engine",
    organizationId: world.organizationId,
    projectId: world.projectId,
    role: "viewer",
    via: "engine",
  };
}

async function rowsFor(
  graderId: string,
  verdicts: readonly RecordedVerdict[],
): Promise<readonly RecordedVerdict[]> {
  return verdicts.filter((verdict) => verdict.graderId === graderId);
}

beforeAll(async () => {
  world = await makeWorld("grader_model");
  // Both sources, deliberately, and with different keys. Which one reaches the
  // provider is the whole question this file asks.
  await seedJudge(world, { model: "gpt-4.1-mini", key: THE_PROJECTS_JUDGE_KEY });
  await storeModelProviderCredential(world.adminAuth, {
    provider: "openai",
    key: THE_ORGANIZATIONS_KEY,
  });
});

afterAll(async () => {
  await service.stop();
  await world.drop();
});

/**
 * A grader binary built before grader models existed, and the work it is and is
 * not offered.
 *
 * **The failure this guards against is silent and it produces verdicts.** Such
 * a binary reads no `grader_model`, so it would judge a grader that selected
 * its own model through the project's judge configuration instead — a different
 * model, on a different account nobody chose, with a green report to show for
 * it. So the queue does not offer it that work at all, exactly as the
 * simulation queue does not offer a version-1 worker a row needing a version-2
 * document.
 *
 * Both directions are asserted, because only one of them is the interesting
 * one: an old binary must be turned away, *and* must still drain everything it
 * was always able to judge. A guard that starved it would be a rollout that
 * stops grading rather than one that grades wrongly, which is better and still
 * wrong.
 *
 * **This half runs first, and the order is the arrangement.** It needs a
 * project in which nothing has selected its own model, and that is what this
 * world is until the cases below seed one — so the honest way to have one is to
 * ask before they do rather than to build a second world beside this one.
 */
describe("a grader binary that cannot read a grader's own model", () => {
  /** A claim as an old binary makes one: it declares nothing, because it had nothing to declare. */
  function anOldBinary(claimant: string) {
    return claimGradingJobs({ claimant, capacity: 5 });
  }

  /** A claim as this release's binary makes one. */
  function thisRelease(claimant: string) {
    return claimGradingJobs({
      claimant,
      capacity: 5,
      capabilities: [...GRADING_CAPABILITIES],
    });
  }

  it("still drains the work it was always able to judge", async () => {
    // Every copy in this project is on the compatibility path so far, which is
    // exactly what an old binary understands.
    const testId = await seedTest(world, [BEHAVIOR]);
    await conductSimulation(world, { testId, spans: aConversation() });

    const taken = await anOldBinary("grader-before-models");
    expect(taken.length).toBeGreaterThan(0);
    expect(taken.every((job) => job.projectId === world.projectId)).toBe(true);
  });

  it("is offered no conversation whose project holds one, and one that can takes it", async () => {
    await seedGrader(
      world,
      aJudgedCopy({
        name: "Judged by a model this grader chose",
        graderModel: { provider: "openai", model: "gpt-4o" },
      }),
    );

    const testId = await seedTest(world, [BEHAVIOR]);
    await conductSimulation(world, { testId, spans: aConversation() });

    // The old binary sees an empty queue rather than work it would judge on an
    // account nobody chose.
    expect(await anOldBinary("grader-before-models-2")).toEqual([]);

    // And the upgraded binary standing beside it takes exactly that work.
    const taken = await thisRelease("grader-this-release");
    expect(taken.length).toBeGreaterThan(0);
  });
});

describe("a grader that selected its own model", () => {
  it("judges with it, and spends the organization's credential rather than the project's", async () => {
    const graderId = await seedGrader(
      world,
      aJudgedCopy({
        name: "Judged by a model this grader chose",
        graderModel: { provider: "openai", model: "gpt-4o" },
      }),
    );

    const grader = await getGrader(world.auth, graderId);
    const judge = scriptedJudge({ answers: {} });
    const resolved = await judgesOnce(theEngine()).judgeFor(
      {
        graderModel: grader?.graderModel ?? null,
        judgeModel: grader?.judgeModel ?? null,
      },
      judge.makers,
    );

    expect(resolved).not.toBeInstanceOf(NoJudge);
    expect(judge.configured.at(-1)).toEqual({
      provider: "openai",
      model: "gpt-4o",
      // Asserted present on purpose: "it spends the organization's account"
      // means nothing if no key was resolved at all.
      key: THE_ORGANIZATIONS_KEY,
    });
  });

  it("never consults the project's judge, so a project with none still judges", async () => {
    const graderId = await seedGrader(
      world,
      aJudgedCopy({
        name: "Judged without any project judge behind it",
        graderModel: { provider: "openai", model: "gpt-4o-mini" },
      }),
    );
    const grader = await getGrader(world.auth, graderId);

    // The project's judge row is taken away underneath it. A grader that chose
    // for itself has no business caring, and this is what says so. Raw SQL
    // because no product verb removes a judge — which is exactly why this
    // state is reached by an upgrade or an operator rather than by a form.
    await world.database.sql(
      "delete from judge_configuration where project_id = $1",
      [world.projectId],
    );

    try {
      const judge = scriptedJudge({ answers: {} });
      const resolved = await judgesOnce(theEngine()).judgeFor(
        {
          graderModel: grader?.graderModel ?? null,
          judgeModel: grader?.judgeModel ?? null,
        },
        judge.makers,
      );

      expect(resolved).not.toBeInstanceOf(NoJudge);
      expect(judge.configured.at(-1)?.key).toBe(THE_ORGANIZATIONS_KEY);
    } finally {
      // Put it back through the product's own door, so the rest of this file
      // and anything added after it start from the world they expect.
      await seedJudge(world, {
        model: "gpt-4.1-mini",
        key: THE_PROJECTS_JUDGE_KEY,
      });
    }
  });
});

describe("a grader still on the compatibility path", () => {
  it("is judged by the project's setting, with the project's key, exactly as before", async () => {
    const graderId = await seedGrader(
      world,
      aJudgedCopy({ name: "Judged the way it always was" }),
    );

    const grader = await getGrader(world.auth, graderId);
    expect(grader?.graderModel).toBeNull();

    const judge = scriptedJudge({ answers: {} });
    await judgesOnce(theEngine()).judgeFor(
      {
        graderModel: grader?.graderModel ?? null,
        judgeModel: grader?.judgeModel ?? null,
      },
      judge.makers,
    );

    expect(judge.configured.at(-1)).toEqual({
      provider: "openai",
      model: "gpt-4.1-mini",
      key: THE_PROJECTS_JUDGE_KEY,
    });
  });

  it("keeps its own judge-model override, which names no key", async () => {
    const graderId = await seedGrader(
      world,
      aJudgedCopy({
        name: "A second opinion, on a stronger model",
        judgeModel: { provider: "openai", model: "gpt-4.1" },
      }),
    );

    const grader = await getGrader(world.auth, graderId);
    const judge = scriptedJudge({ answers: {} });
    await judgesOnce(theEngine()).judgeFor(
      {
        graderModel: grader?.graderModel ?? null,
        judgeModel: grader?.judgeModel ?? null,
      },
      judge.makers,
    );

    // The model is the grader's and the key is still the project's, which is
    // the whole of what an override does and does not do.
    expect(judge.configured.at(-1)).toEqual({
      provider: "openai",
      model: "gpt-4.1",
      key: THE_PROJECTS_JUDGE_KEY,
    });
  });
});

describe("a credential the organization does not hold", () => {
  it("errors the behaviors, names the provider, and says where to add it", async () => {
    await service.judgingWith({ [BEHAVIOR]: met("confirmed") });

    const graderId = await seedGrader(
      world,
      aJudgedCopy({
        name: "Judged after the key went away",
        graderModel: { provider: "openai", model: "gpt-4o" },
      }),
    );

    // The key is taken away between the grader being authored and the
    // conversation being judged, which is the state a removal actually leaves.
    // The project's own judge is still configured and still holds a different
    // key, so anything that silently fell back to it would go green here.
    await removeModelProviderCredential(world.adminAuth, "openai");

    const testId = await seedTest(world, [BEHAVIOR]);
    const { simulationId } = await conductSimulation(world, {
      testId,
      spans: aConversation(),
    });

    const rows = await eventually("the behaviors to be errored", async () => {
      const read = await readVerdicts(world.auth, simulationId);
      const mine = await rowsFor(graderId, read.verdicts);
      return mine.length > 0 ? mine : undefined;
    });

    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      // `errored`, deliberately not `failed`: a check egma could not make did
      // not fail, and a red row on a report for a key nobody pasted is the
      // exact false trust this product exists to kill.
      expect(row.verdict).toBe("errored");
      expect(row.rationale).toContain("openai");
      expect(row.rationale).toContain("Model providers");
      // And nothing a key could be read out of, in a sentence a person reads.
      expect(row.rationale).not.toContain(THE_ORGANIZATIONS_KEY);
      expect(row.rationale).not.toContain(THE_PROJECTS_JUDGE_KEY);
    }

    // No silent fallback: this grader judged nothing at all rather than being
    // decided by the project's account, which the errored rows above would
    // have been `passed` under.
    expect(rows.every((row) => row.verdict === "errored")).toBe(true);

    await service.stop();

    // Put it back, so the ordering of this file is not a trap for the next
    // case somebody adds.
    await storeModelProviderCredential(world.adminAuth, {
      provider: "openai",
      key: THE_ORGANIZATIONS_KEY,
    });
  });

  it("is a refusal the resolver gives before anything is asked", async () => {
    await removeModelProviderCredential(world.adminAuth, "openai");

    try {
      const judge = scriptedJudge({ answers: {} });
      const resolved = await judgesOnce(theEngine()).judgeFor(
        {
          graderModel: { provider: "openai", model: "gpt-4o" },
          judgeModel: null,
        },
        judge.makers,
      );

      expect(resolved).toBeInstanceOf(NoJudge);
      expect(String((resolved as NoJudge).message)).toContain(
        "Model providers",
      );
      // Nothing was configured at the provider seam, which is what "before
      // anything is asked" means: resolving a key is beginning to act with it.
      expect(judge.configured).toEqual([]);
    } finally {
      await storeModelProviderCredential(world.adminAuth, {
        provider: "openai",
        key: THE_ORGANIZATIONS_KEY,
      });
    }
  });
});

describe("a grader on managed model access", () => {
  /**
   * The grader's half of the two model-access modes, at the seam a judge is
   * actually resolved at.
   *
   * **What changes is a base address and one credential, and nothing else.**
   * The maker is handed the Egma model gateway's route for the provider and the
   * credential that authorizes the gateway rather than the provider — the same
   * request, the same body, the same protocol. That is the whole reason the
   * grader needed no second provider adapter for managed access, and the
   * assertion below is what says the claim is true rather than intended.
   */
  const THE_GATEWAY = "https://gateway.egma.test";
  const THE_PASTED_KEY = "egma_ik_sentinel-grader-managed-P1Q2";

  async function judgeUnderManagedAccess(name: string): Promise<{
    readonly configured: readonly Record<string, unknown>[];
    readonly resolved: unknown;
  }> {
    const graderId = await seedGrader(
      world,
      aJudgedCopy({ name, graderModel: { provider: "openai", model: "gpt-4o" } }),
    );
    const grader = await getGrader(world.auth, graderId);
    const judge = scriptedJudge({ answers: {} });
    const resolved = await judgesOnce(theEngine()).judgeFor(
      {
        graderModel: grader?.graderModel ?? null,
        judgeModel: grader?.judgeModel ?? null,
      },
      judge.makers,
    );
    return { configured: judge.configured, resolved };
  }

  afterEach(async () => {
    // Back to the deployment every other case in this file stands in.
    holdManagedDeployment({
      hosted: false,
      gatewayAddress: undefined,
      internalGatewayKey: undefined,
    });
    await setModelAccess(world.adminAuth, "customer-owned").catch(() => undefined);
  });

  it("judges through the gateway with the key its deployment connected", async () => {
    holdManagedDeployment({
      hosted: false,
      gatewayAddress: THE_GATEWAY,
      internalGatewayKey: undefined,
    });
    await connectManagedAccess(world.adminAuth, {
      key: THE_PASTED_KEY,
      cloudOrganizationId: newId("org"),
    });
    await setModelAccess(world.adminAuth, "managed");

    const { configured, resolved } = await judgeUnderManagedAccess(
      "Judged through the Egma model gateway",
    );

    expect(resolved).not.toBeInstanceOf(NoJudge);
    expect(configured.at(-1)).toEqual({
      provider: "openai",
      // The pinned selection is untouched by who supplies the credential.
      model: "gpt-4o",
      key: THE_PASTED_KEY,
      endpoint: `${THE_GATEWAY}/openai/v1`,
    });
    // And never the organization's own provider account, which is stored and
    // deliberately not what a managed grader spends.
    expect(configured.at(-1)).not.toHaveProperty("key", THE_ORGANIZATIONS_KEY);
  });

  it("judges through the gateway on hosted Egma with nothing connected at all", async () => {
    holdManagedDeployment({
      hosted: true,
      gatewayAddress: THE_GATEWAY,
      internalGatewayKey: "sentinel-grader-internal-signing-R3S4",
    });
    await setModelAccess(world.adminAuth, "managed");

    const { configured, resolved } = await judgeUnderManagedAccess(
      "Judged on hosted Egma's own credential",
    );

    expect(resolved).not.toBeInstanceOf(NoJudge);
    const asked = configured.at(-1) as { key: string; endpoint: string };
    expect(asked.endpoint).toBe(`${THE_GATEWAY}/openai/v1`);
    expect(asked.key.startsWith("egma_ig_")).toBe(true);
    // The signing key is never any part of what goes out.
    expect(asked.key).not.toContain("sentinel-grader-internal-signing-R3S4");
  });

  it("errors rather than judging, when managed access has nothing behind it", async () => {
    holdManagedDeployment({
      hosted: false,
      gatewayAddress: THE_GATEWAY,
      internalGatewayKey: undefined,
    });
    // Reconnected under the binding this world already carries — rotation, not
    // a move — then disconnected deliberately. The mode is left exactly as it
    // was, which is what makes the next grading say so instead of quietly
    // spending somebody's own account.
    await setModelAccess(world.adminAuth, "managed");
    await disconnectManagedAccess(world.adminAuth);

    const { resolved } = await judgeUnderManagedAccess(
      "Judged with nothing connected",
    );

    // An infrastructure error a person can act on, never a failed verdict: a
    // check that could not be made did not fail.
    expect(resolved).toBeInstanceOf(NoJudge);
    expect(String((resolved as Error).message)).toContain("inference key");
  });

  it("spends the organization's own account again the moment the mode changes back", async () => {
    holdManagedDeployment({
      hosted: true,
      gatewayAddress: THE_GATEWAY,
      internalGatewayKey: "sentinel-grader-internal-signing-R3S4",
    });
    await setModelAccess(world.adminAuth, "customer-owned");

    const { configured } = await judgeUnderManagedAccess(
      "Judged back on the organization's account",
    );

    expect(configured.at(-1)).toEqual({
      provider: "openai",
      model: "gpt-4o",
      key: THE_ORGANIZATIONS_KEY,
    });
  });
});
