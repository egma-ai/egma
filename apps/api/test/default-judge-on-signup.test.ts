import {
  resolveJudgeKey,
  seedDefaultJudge,
  setJudgeConfiguration,
  type AuthContext,
} from "@egma/db";
import { afterEach, describe, expect, it } from "vitest";

import { createApi, type TestApi } from "./support/api.ts";

/**
 * A project created while the platform is running is born gradable.
 *
 * **This file exists because the gap it closes is the ordinary first run.** The
 * platform's default judge — the model key a self-hoster puts in
 * `EGMA_JUDGE_API_KEY` — used to be applied only by a backfill at API
 * startup. That is fine for a project that already exists and useless for the
 * sequence the product actually documents:
 *
 * 1. a clean platform workspace, `egma self-host up` — **no project exists**,
 *    so the backfill runs against nothing;
 * 2. `egma self-host setup`;
 * 3. in a separate agent repository, the wizard signs in — and *that* is what
 *    creates the organization and its first project, with the API already up.
 *
 * The project created at step 3 had no judge until somebody restarted the API,
 * and until then every model-based verdict came back `errored`. That would not
 * even have read as a bad test result: a grading failure is an operational
 * failure, so it would have surfaced as a broken run after real phone calls had
 * been paid for.
 *
 * So the check below starts a platform **with no projects at all** and creates
 * one the way a person does — through the signup route, over HTTP, against a
 * real Postgres — and then asks the grading engine for the key without
 * restarting anything. A test that seeded a project first would pass against
 * the old code and prove nothing.
 */

const THE_PLATFORMS_JUDGE = {
  provider: "openai",
  model: "gpt-4o",
  key: "sk-the-self-hoster-supplied-this-WXYZ",
} as const;

/** A judge a project picked for itself, on its own account. */
const A_PROJECTS_OWN_JUDGE = {
  provider: "openai",
  model: "gpt-4.1-mini",
  key: "sk-this-project-chose-this-one-QRST",
} as const;

let api: TestApi;

afterEach(async () => {
  await api?.close();
});

/** What a grading claim resolves to: no person, and `engine` on its face. */
function theEngineIn(organizationId: string, projectId: string): AuthContext {
  return { userId: "engine", organizationId, projectId, role: "viewer", via: "engine" };
}

/** The person who signed up, in the organization signup gave them. */
function theAdminOf(
  userId: string,
  organizationId: string,
  projectId: string,
): AuthContext {
  return { userId, organizationId, projectId, role: "admin", via: "session" };
}

async function signUpFor(label: string): Promise<{
  userId: string;
  organizationId: string;
  projectId: string;
}> {
  const response = await api.app.inject({
    method: "POST",
    url: "/api/signup",
    payload: {
      email: `${label}@acme.example`,
      password: "a-long-enough-password",
      organizationName: `Acme ${label}`,
      projectName: "Default",
    },
  });
  expect(response.statusCode).toBe(201);
  const landed = response.json<{
    userId: string;
    organization: { id: string };
    project: { id: string };
  }>();
  return {
    userId: landed.userId,
    organizationId: landed.organization.id,
    projectId: landed.project.id,
  };
}

describe("a platform with a default judge and no projects yet", () => {
  it("gives the judge to a project created while it is running, with no restart", async () => {
    // Nothing to back-fill: this is a platform nobody has signed up on.
    api = await createApi("default_judge_on_signup", {
      defaultJudge: THE_PLATFORMS_JUDGE,
    });

    const { organizationId, projectId } = await signUpFor("ada");

    // The one door to a judge key, asked exactly as the grading engine asks.
    // No restart between the signup above and this line — that is the whole
    // point, and the reason this is an HTTP test rather than a data-access one.
    await expect(
      resolveJudgeKey(theEngineIn(organizationId, projectId), projectId),
    ).resolves.toBe(THE_PLATFORMS_JUDGE.key);
  });

  it("does the same for the second organization, and for the tenth", async () => {
    // The fix is in the transaction that creates a project rather than in
    // anything that runs once, so it cannot be right only for the first.
    //
    // `singleOrganization: false` is named here rather than inherited from the
    // helper, because it *is* the claim: this deployment serves several
    // organizations, open signup stays open, and each person below lands in an
    // organization of their own. The deployment's judge is its offer to every
    // project on it, so which organization a project landed in decides nothing
    // about whether its first simulation can be graded.
    api = await createApi("default_judge_every_signup", {
      singleOrganization: false,
      defaultJudge: THE_PLATFORMS_JUDGE,
    });

    const organizations = new Set<string>();
    for (const who of ["ada", "grace", "alan"]) {
      const { organizationId, projectId } = await signUpFor(who);
      organizations.add(organizationId);
      await expect(
        resolveJudgeKey(theEngineIn(organizationId, projectId), projectId),
      ).resolves.toBe(THE_PLATFORMS_JUDGE.key);
    }

    // Three organizations rather than three signups into one. Without this the
    // loop above would say nothing about the second organization or the tenth,
    // which is the only thing this test is named for.
    expect(organizations.size).toBe(3);
  });

  it("never takes back a judge a project chose for itself", async () => {
    // The property that makes handing the judge out safe, on the deployment
    // shape that makes it matter. Seeding writes only where there is nothing —
    // `onConflictDoNothing` in the transaction that creates a project, and
    // again in the backfill every boot runs — so a project that picked its own
    // model and its own account keeps both, and a restart is never an occasion
    // to start spending the operator's key on its behalf.
    api = await createApi("default_judge_never_overwrites", {
      singleOrganization: false,
      defaultJudge: THE_PLATFORMS_JUDGE,
    });

    // The second organization on this deployment, so the claim is about a
    // project the operator does not own.
    await signUpFor("ada");
    const { userId, organizationId, projectId } = await signUpFor("grace");

    await setJudgeConfiguration(
      theAdminOf(userId, organizationId, projectId),
      A_PROJECTS_OWN_JUDGE,
    );

    // Exactly what the next restart does, and it must find nothing to give.
    await expect(seedDefaultJudge(THE_PLATFORMS_JUDGE)).resolves.toEqual([]);

    await expect(
      resolveJudgeKey(theEngineIn(organizationId, projectId), projectId),
    ).resolves.toBe(A_PROJECTS_OWN_JUDGE.key);
  });

  it("leaves a project unjudged when the platform has no judge of its own", async () => {
    // A deployment that configured none is unchanged: its projects have no
    // judge, model-based grading says so, and nothing is invented.
    api = await createApi("default_judge_absent", { defaultJudge: null });

    const { organizationId, projectId } = await signUpFor("ada");

    await expect(
      resolveJudgeKey(theEngineIn(organizationId, projectId), projectId),
    ).resolves.toBeUndefined();
  });
});
