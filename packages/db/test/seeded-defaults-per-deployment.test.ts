import { newId } from "@egma/ids";
import {
  getGrader,
  getPersona,
  holdManagedDeployment,
  listGraders,
  listPersonas,
  provisionOrganization,
  readModelAccess,
  RECOMMENDED_GRADER_MODEL,
  RECOMMENDED_PERSONA_MODELS,
  type AuthContext,
} from "@egma/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createConnectedDatabase,
  type MigratedDatabase,
} from "./support/database.ts";
import { seedUser } from "./support/tenancy.ts";

/**
 * What a new project is born holding, and why the answer is different on the
 * two kinds of deployment.
 *
 * **This is the last step of the zero-setup first run.** A hosted organization
 * is on Managed by Egma from the moment it exists, so its seeded persona and
 * its seeded grader can be given the release's proved model selections and
 * executed at once, on Egma's provider accounts, with nothing pasted and
 * nothing edited. A seeded persona *without* selections would break that at the
 * last step: it would resolve through deployment-wide model settings, and
 * hosted Egma has none.
 *
 * A self-hosted deployment gets the opposite answer for the opposite reason,
 * and it is asserted here just as hard: those deployments hold deployment-wide
 * settings and a platform judge and usually no organization credential, so
 * seeded selections would fail the first claim naming a provider nobody was
 * asked for. Giving *their* existing personas and graders explicit successors
 * belongs to the migration.
 *
 * Everything goes through the front door signup itself uses — one call to
 * `provisionOrganization` — and is read back through the ordinary factory
 * reads.
 */

let database: MigratedDatabase;

const HOSTED = {
  hosted: true,
  gatewayAddress: "https://gateway.egma.example",
  internalGatewayKey: "sentinel-seeded-defaults-signing-A1B2",
} as const;

const SELF_HOSTED = {
  hosted: false,
  gatewayAddress: undefined,
  internalGatewayKey: undefined,
} as const;

type Provisioned = {
  readonly auth: AuthContext;
  readonly organizationId: string;
  readonly projectId: string;
};

async function aNewCustomer(label: string): Promise<Provisioned> {
  const userId = newId("usr");
  await seedUser(database, userId, `${label}-${userId.slice(-6)}@acme.example`);

  const provisioned = await provisionOrganization({
    ownerUserId: userId,
    organizationName: label,
    organizationSlug: `${label}-${userId.slice(-6)}`,
    projectName: "Default",
    projectSlug: "default",
  });

  return {
    organizationId: provisioned.organizationId,
    projectId: provisioned.projectId,
    auth: {
      userId,
      organizationId: provisioned.organizationId,
      projectId: provisioned.projectId,
      role: "admin",
      via: "session",
    },
  };
}

/** The project's default persona, as anybody in it reads one. */
async function theSeededPersona(where: Provisioned) {
  const [starter] = (await listPersonas(where.auth)).items;
  expect(starter, "a new project has no persona at all").toBeDefined();
  return getPersona(where.auth, starter?.id ?? "");
}

/** The project's mandatory grading copy, as anybody in it reads one. */
async function theSeededGrader(where: Provisioned) {
  const [seeded] = (await listGraders(where.auth)).items;
  expect(seeded, "a new project has no grader at all").toBeDefined();
  return getGrader(where.auth, seeded?.id ?? "");
}

beforeAll(async () => {
  database = await createConnectedDatabase("seeded-defaults-per-deployment");
});

afterAll(async () => {
  holdManagedDeployment(SELF_HOSTED);
  await database.drop();
});

describe("a new project on hosted Egma", () => {
  it("is born on Managed by Egma, with a persona that has already chosen its models", async () => {
    holdManagedDeployment(HOSTED);
    const acme = await aNewCustomer("hosted");

    expect((await readModelAccess(acme.auth)).mode).toBe("managed");

    const starter = await theSeededPersona(acme);
    // The release's proved defaults, whole — the same values the Models form
    // fills in, so the seeded persona and an authored one start from one
    // choice rather than two that can drift.
    expect(starter?.models).toEqual(RECOMMENDED_PERSONA_MODELS);
  });

  it("is born with a grader that has already chosen the model it judges with", async () => {
    holdManagedDeployment(HOSTED);
    const acme = await aNewCustomer("hosted-grader");

    const seeded = await theSeededGrader(acme);
    expect(seeded?.graderModel).toEqual(RECOMMENDED_GRADER_MODEL);
    // The selection lands beside the config on the version, and the copy still
    // reads its judge prompt through the library pointer rather than holding
    // one — so nothing about the pointer rules moved to make room for it.
    expect(seeded?.libraryId).toBeDefined();
    expect(seeded).not.toHaveProperty("prompt");
    // And it is still the mandatory copy it always was.
    expect(seeded?.required).toBe(true);
    expect(seeded?.scope).toBe("simulations");
  });

  it("needs nothing configured to get there, which is the whole point", async () => {
    holdManagedDeployment(HOSTED);
    const acme = await aNewCustomer("hosted-nothing-configured");

    const starter = await theSeededPersona(acme);
    const seeded = await theSeededGrader(acme);

    // No credential was stored, no key was pasted, no form was opened. What
    // the two objects hold is a provider and a model each, and nothing that
    // could authorize one.
    expect(JSON.stringify(starter?.models)).not.toMatch(/key|secret|credential/i);
    expect(JSON.stringify(seeded?.graderModel)).not.toMatch(
      /key|secret|credential/i,
    );
  });
});

describe("a new project on a self-hosted deployment", () => {
  it("keeps its seeded persona on the compatibility path, with no selections at all", async () => {
    holdManagedDeployment(SELF_HOSTED);
    const lakeside = await aNewCustomer("self-hosted");

    // Customer-owned, because nothing has been connected to Egma's provider
    // accounts and nothing may spend from them.
    expect((await readModelAccess(lakeside.auth)).mode).toBe("customer-owned");

    const starter = await theSeededPersona(lakeside);
    // `null` rather than defaults: this deployment resolves models through its
    // own settings, and a seeded selection would fail the first claim naming a
    // provider nobody was asked for.
    expect(starter?.models).toBeNull();
  });

  it("keeps its seeded grader judging through the project's own judge", async () => {
    holdManagedDeployment(SELF_HOSTED);
    const lakeside = await aNewCustomer("self-hosted-grader");

    const seeded = await theSeededGrader(lakeside);
    expect(seeded?.graderModel).toBeNull();
    expect(seeded?.judgeModel).toBeNull();
  });
});
