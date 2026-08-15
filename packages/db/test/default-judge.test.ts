import { newId } from "@egma/ids";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  getJudgeConfiguration,
  resolveJudgeKey,
  seedDefaultJudge,
  setJudgeConfiguration,
  type AuthContext,
} from "@egma/db";

import { createConnectedDatabase, type MigratedDatabase } from "./support/database.ts";
import { seedOrganization, seedUser } from "./support/tenancy.ts";

/**
 * The platform's default judge: the self-hoster's one key, given to the
 * projects that have configured none.
 *
 * **Why this is worth having at all.** A self-hoster supplies one OpenAI key
 * when they set their platform up, meant to cover the persona's brain, its
 * voice, its ears and the judge. Without this they would run a suite, watch
 * every verdict come back `errored` saying no judge was configured, and have to
 * find a second place to put the same key.
 *
 * **Why it is not a key on the grader.** A judge configured per container is a
 * judge no project chose, spent on conversations belonging to customers who
 * agreed to neither. So the platform writes the *ordinary* row — sealed, per
 * project, opened by the grading engine through the one door that opens it —
 * and what differs from a judge a project set for itself is only who filled the
 * form in.
 *
 * The two properties that make it safe are here: it writes only where there is
 * nothing, and it never touches a project that has chosen.
 */

let database: MigratedDatabase;

const acme = { organization: newId("org"), project: newId("prj"), second: newId("prj") };
const globex = { organization: newId("org"), project: newId("prj") };
const ada = newId("usr");

const THEIR_OWN_KEY = "sk-a-project-chose-this-one-QRST";
const THE_PLATFORMS_KEY = "sk-the-self-hoster-supplied-this-WXYZ";

function actingAsAcme(projectId: string): AuthContext {
  return {
    userId: ada,
    organizationId: acme.organization,
    projectId,
    role: "admin",
    via: "session",
  };
}

function theEngineIn(organizationId: string, projectId: string): AuthContext {
  return { userId: "engine", organizationId, projectId, role: "viewer", via: "engine" };
}

beforeAll(async () => {
  database = await createConnectedDatabase("default_judge");
  await seedOrganization(database, acme.organization, [
    { id: acme.project, slug: "default" },
    { id: acme.second, slug: "second" },
  ]);
  await seedOrganization(database, globex.organization, [
    { id: globex.project, slug: "default" },
  ]);
  await seedUser(database, ada, "ada@acme.example");
});

afterAll(async () => {
  await database.drop();
});

describe("the platform's default judge", () => {
  it("gives its judge to every project that has none, across organizations", async () => {
    const given = await seedDefaultJudge({
      provider: "openai",
      model: "gpt-4o",
      key: THE_PLATFORMS_KEY,
    });

    expect([...given].sort()).toEqual(
      [acme.project, acme.second, globex.project].sort(),
    );

    // The deployment's own judge, named as such — and readable by the grading
    // engine through the one door that opens a judge key.
    //
    // **It offers no hint, and that is the point of naming the source.** The
    // key belongs to whoever runs the deployment: a project holding it cannot
    // rotate it, cannot choose which one it is, and has nothing to tell apart,
    // so four characters of an operator's secret would be handed over to no
    // purpose. A customer who wants a key of their own adds an organization
    // credential and points the project at it, and the hint they then see is
    // their own.
    const configured = await getJudgeConfiguration(actingAsAcme(acme.project));
    expect(configured).toMatchObject({
      projectId: acme.project,
      provider: "openai",
      model: "gpt-4o",
      source: "platform",
      credentialId: null,
      keyHint: null,
    });
    expect(
      await resolveJudgeKey(theEngineIn(acme.organization, acme.project), acme.project),
    ).toBe(THE_PLATFORMS_KEY);
  });

  it("changes nothing on a second run, so every boot is safe", async () => {
    const again = await seedDefaultJudge({
      provider: "openai",
      model: "gpt-4o",
      key: THE_PLATFORMS_KEY,
    });

    expect(again).toEqual([]);
  });

  it("never overwrites a judge a project chose for itself", async () => {
    // A project that has chosen has chosen. A platform restart is not an
    // occasion to change somebody's model or spend from a different account.
    await setJudgeConfiguration(actingAsAcme(acme.second), {
      provider: "openai",
      model: "gpt-4.1-mini",
      key: THEIR_OWN_KEY,
    });

    const given = await seedDefaultJudge({
      provider: "openai",
      model: "gpt-4o",
      key: THE_PLATFORMS_KEY,
    });
    expect(given).toEqual([]);

    expect(await getJudgeConfiguration(actingAsAcme(acme.second))).toMatchObject({
      model: "gpt-4.1-mini",
      keyHint: "QRST",
    });
    expect(
      await resolveJudgeKey(theEngineIn(acme.organization, acme.second), acme.second),
    ).toBe(THEIR_OWN_KEY);
  });

  it("gives its judge to a project created after the platform started", async () => {
    // What makes running it on every boot the whole mechanism rather than half
    // of one: a project made later gets a judge at the next start.
    const later = newId("prj");
    await database.sql(
      "insert into project (id, organization_id, name, slug) values ($1, $2, $3, $3)",
      [later, acme.organization, "made-later"],
    );

    const given = await seedDefaultJudge({
      provider: "openai",
      model: "gpt-4o",
      key: THE_PLATFORMS_KEY,
    });

    expect(given).toEqual([later]);
  });

  it("seals the key rather than storing it, exactly as a project's own is", async () => {
    // The one read in this file that bypasses the module, on purpose: the claim
    // is that what is stored is ciphertext, and only a read the module cannot
    // dress up can say so.
    const stored = await database.sql<{ credentials: string }>(
      "select credentials from judge_configuration where project_id = $1",
      [acme.project],
    );
    const envelope = stored.rows[0]?.credentials ?? "";
    expect(envelope).not.toContain(THE_PLATFORMS_KEY);
    expect(envelope.startsWith("v1.")).toBe(true);
  });
});
