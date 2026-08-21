import { createAgent, createPersona, type AuthContext } from "@egma/db";
import { afterEach, describe, expect, it } from "vitest";

import { createApi, type TestApi } from "./support/api.ts";
import {
  contextFor,
  NEUTRAL_TRAITS,
  signUp,
  type Answer,
  type Customer,
} from "./support/traces.ts";

/**
 * The half of the test surface a repository writes through, over real HTTP.
 *
 * A repository client is not a browser. It holds one folder bound to one agent,
 * it edits by file rather than by form, and the words it is answered with are
 * read off a terminal by a person or by a coding agent — so each of them is a
 * fixed sentence and asserted whole rather than by substring.
 *
 * Three things are new at this door and all three are here:
 *
 * - **`repository_agent` is a question, never a change.** It asks whether the
 *   test still applies to the agent this folder is bound to, and the platform
 *   refuses when it does not. `agents` on the same request is refused outright,
 *   because that would be an instruction and one file must never become the
 *   source of truth for a set of links it cannot see.
 * - **A write names both tokens.** The content it was written against and the
 *   live half beside it, each refused on its own terms.
 * - **A name two living personas answer to has no right answer**, so it is
 *   refused with a code of its own rather than resolved by list order.
 */

let api: TestApi;

afterEach(async () => {
  await api?.close();
});

const RESCHEDULING = {
  name: "Reschedules a booked appointment",
  scenario:
    "Their cleaning is booked for Thursday morning and has to move to any afternoon next week.",
  expectedBehaviors: [
    "verifies who it is speaking to before discussing the booking",
    "confirms the new time back before finishing",
  ],
} as const;

async function browse(
  method: "GET" | "POST" | "PATCH",
  url: string,
  who: Customer,
  payload?: Record<string, unknown>,
): Promise<Answer> {
  const response = await api.app.inject({
    method,
    url,
    headers: { cookie: who.cookie },
    ...(payload === undefined ? {} : { payload }),
  });
  return {
    statusCode: response.statusCode,
    body: response.json() as Record<string, unknown>,
  };
}

function author(person: Customer): AuthContext {
  return contextFor(person, "member");
}

type WireTest = {
  id: string;
  versionId: string;
  revision: string;
  applicabilityRevision: string;
  agents: { id: string }[];
};

/** One project, two agents, and one test applying to the first of them. */
async function aBoundRepository(label: string): Promise<{
  readonly ada: Customer;
  readonly boundAgent: string;
  readonly otherAgent: string;
  readonly test: WireTest;
}> {
  api = await createApi(label);
  const ada = await signUp(api.app, "ada@acme.example", "Acme");
  const boundAgent = (await createAgent(author(ada), { name: "Front desk" })).id;
  const otherAgent = (await createAgent(author(ada), { name: "Night line" })).id;

  const created = await browse("POST", "/v1/tests", ada, {
    ...RESCHEDULING,
    projectId: ada.projectId,
    agents: [boundAgent, otherAgent],
  });
  expect(created.statusCode, JSON.stringify(created.body)).toBe(201);

  return {
    ada,
    boundAgent,
    otherAgent,
    test: created.body as unknown as WireTest,
  };
}

describe("the agent a repository is bound to", () => {
  it("lets an edit through while the test still applies to it", async () => {
    const { ada, boundAgent, test } = await aBoundRepository("repo_applies");

    const edited = await browse("PATCH", `/v1/tests/${test.id}`, ada, {
      projectId: ada.projectId,
      scenario: "The file's own words.",
      expectedVersionId: test.versionId,
      expectedRevision: test.revision,
      repositoryAgentId: boundAgent,
    });

    expect(edited.statusCode, JSON.stringify(edited.body)).toBe(200);
    // It asked a question and changed nothing about the links: the set it came
    // in with is the set it goes out with, and on the same revision.
    expect((edited.body as unknown as WireTest).agents.map((one) => one.id).sort()).toEqual(
      test.agents.map((one) => one.id).sort(),
    );
    expect((edited.body as unknown as WireTest).applicabilityRevision).toBe(
      test.applicabilityRevision,
    );
  });

  it("refuses the edit once the browser has unlinked it, and writes nothing", async () => {
    const { ada, boundAgent, otherAgent, test } = await aBoundRepository(
      "repo_unlinked",
    );

    // What somebody does in the browser's link editor: the repository's agent
    // comes off, and the test still applies to another one.
    const relinked = await browse("POST", `/v1/tests/${test.id}/agents`, ada, {
      projectId: ada.projectId,
      agents: [otherAgent],
      expectedApplicabilityRevision: test.applicabilityRevision,
    });
    expect(relinked.statusCode, JSON.stringify(relinked.body)).toBe(200);

    const refused = await browse("PATCH", `/v1/tests/${test.id}`, ada, {
      projectId: ada.projectId,
      scenario: "The file's own words.",
      expectedVersionId: test.versionId,
      expectedRevision: test.revision,
      repositoryAgentId: boundAgent,
    });

    expect(refused.statusCode).toBe(409);
    expect(refused.body.error).toBe("repository_agent_not_applicable");
    expect(refused.body.message).toBe(
      `Test ${test.id} no longer applies to the agent bound to this ` +
        `repository. Link it to agent ${boundAgent} in Egma, or remove this ` +
        `local file; egma push changed neither side.`,
    );

    // Neither side moved. The refusal says so, and this is what makes that
    // sentence true rather than reassuring.
    const read = await browse("GET", `/v1/tests/${test.id}?projectId=${ada.projectId}`, ada);
    expect((read.body as unknown as WireTest).versionId).toBe(test.versionId);
    expect(read.body.scenario).toBe(RESCHEDULING.scenario);
  });

  /**
   * The refusal is about the links and not about the content, so it is answered
   * before either token is looked at.
   *
   * A repository whose agent has been unlinked would otherwise be told to pull
   * a test it is no longer entitled to push — and the same refusal would meet
   * it afterwards, having cost somebody a round trip and their afternoon's
   * draft.
   */
  it("is answered ahead of a stale version, because a pull would not fix it", async () => {
    const { ada, boundAgent, otherAgent, test } = await aBoundRepository(
      "repo_unlinked_first",
    );

    await browse("POST", `/v1/tests/${test.id}/agents`, ada, {
      projectId: ada.projectId,
      agents: [otherAgent],
      expectedApplicabilityRevision: test.applicabilityRevision,
    });
    const moved = await browse("PATCH", `/v1/tests/${test.id}`, ada, {
      projectId: ada.projectId,
      scenario: "Somebody else's words.",
      expectedVersionId: test.versionId,
    });
    expect(moved.statusCode, JSON.stringify(moved.body)).toBe(200);

    const refused = await browse("PATCH", `/v1/tests/${test.id}`, ada, {
      projectId: ada.projectId,
      scenario: "The file's own words.",
      expectedVersionId: test.versionId,
      repositoryAgentId: boundAgent,
    });

    expect(refused.body.error).toBe("repository_agent_not_applicable");
  });

  it("refuses anything that is not an agent id, before it reads a thing", async () => {
    const { ada, test } = await aBoundRepository("repo_agent_shape");

    const refused = await browse("PATCH", `/v1/tests/${test.id}`, ada, {
      projectId: ada.projectId,
      scenario: "x",
      expectedVersionId: test.versionId,
      repositoryAgentId: "front-desk",
    });

    expect(refused.statusCode).toBe(422);
    expect(refused.body.message).toContain('"front-desk" is not an agent id');
  });
});

describe("a repository write names both tokens", () => {
  it("refuses on a revision the browser has moved, without touching the content", async () => {
    const { ada, boundAgent, test } = await aBoundRepository("repo_identity_stale");

    const renamed = await browse("PATCH", `/v1/tests/${test.id}`, ada, {
      projectId: ada.projectId,
      name: "Reschedules a booked clean",
      expectedRevision: test.revision,
    });
    expect(renamed.statusCode, JSON.stringify(renamed.body)).toBe(200);
    // A rename mints no version — that is the whole reason the two tokens are
    // separate — so the file's content pin is still current and only the
    // revision has moved.
    expect((renamed.body as unknown as WireTest).versionId).toBe(test.versionId);

    const refused = await browse("PATCH", `/v1/tests/${test.id}`, ada, {
      projectId: ada.projectId,
      scenario: "The file's own words.",
      expectedVersionId: test.versionId,
      expectedRevision: test.revision,
      repositoryAgentId: boundAgent,
    });

    expect(refused.statusCode).toBe(409);
    expect(refused.body.error).toBe("identity_conflict");
    expect(refused.body.message).toBe(
      `Test ${test.id} changed after you opened it. Read it again, keep or ` +
        `reapply your edits, and send the update with expectedRevision set ` +
        `to its new revision.`,
    );

    const read = await browse("GET", `/v1/tests/${test.id}?projectId=${ada.projectId}`, ada);
    expect(read.body.scenario).toBe(RESCHEDULING.scenario);
  });

  /**
   * The whole reason a link edit carries its own revision: a repository copy
   * written before it is still a current copy afterwards.
   */
  it("is unaffected by a link edit, which moves neither token", async () => {
    const { ada, boundAgent, otherAgent, test } = await aBoundRepository(
      "repo_applicability_only",
    );

    const relinked = await browse("POST", `/v1/tests/${test.id}/agents`, ada, {
      projectId: ada.projectId,
      agents: [boundAgent],
      expectedApplicabilityRevision: test.applicabilityRevision,
    });
    expect(relinked.statusCode).toBe(200);
    const after = relinked.body as unknown as WireTest;
    expect(after.agents.map((one) => one.id)).toEqual([boundAgent]);
    expect(after.applicabilityRevision).not.toBe(test.applicabilityRevision);

    // Neither of the two a file pins moved.
    expect(after.versionId).toBe(test.versionId);
    expect(after.revision).toBe(test.revision);
    expect(otherAgent).not.toBe(boundAgent);

    const written = await browse("PATCH", `/v1/tests/${test.id}`, ada, {
      projectId: ada.projectId,
      scenario: "The file's own words.",
      expectedVersionId: test.versionId,
      expectedRevision: test.revision,
      repositoryAgentId: boundAgent,
    });
    expect(written.statusCode, JSON.stringify(written.body)).toBe(200);
  });
});

describe("a persona name two living personas answer to", () => {
  it("is refused with the sentence that says where the identifier goes", async () => {
    api = await createApi("repo_persona_ambiguous");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");
    const agentId = (await createAgent(author(ada), { name: "Front desk" })).id;

    // Nothing stops this: a persona's name is not unique, which is the whole
    // reason a name cannot resolve one on its own.
    await createPersona(author(ada), {
      name: "Impatient Rita",
      traits: NEUTRAL_TRAITS,
    });
    await createPersona(author(ada), {
      name: "Impatient Rita",
      traits: NEUTRAL_TRAITS,
    });

    const refused = await browse("POST", "/v1/tests", ada, {
      ...RESCHEDULING,
      projectId: ada.projectId,
      agents: [agentId],
      personas: ["Impatient Rita"],
    });

    expect(refused.statusCode).toBe(422);
    expect(refused.body.error).toBe("persona_name_ambiguous");
    expect(refused.body.message).toBe(
      "Persona name Impatient Rita matches more than one active persona in " +
        "this project. Put the intended persona's stable ID in the file and " +
        "try again; for a pinned file, egma pull can write the IDs after the " +
        "file is safe to migrate.",
    );
  });

  it("resolves when the file names the identifier instead", async () => {
    api = await createApi("repo_persona_by_id");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");
    const agentId = (await createAgent(author(ada), { name: "Front desk" })).id;

    const first = await createPersona(author(ada), {
      name: "Impatient Rita",
      traits: NEUTRAL_TRAITS,
    });
    await createPersona(author(ada), {
      name: "Impatient Rita",
      traits: NEUTRAL_TRAITS,
    });

    const created = await browse("POST", "/v1/tests", ada, {
      ...RESCHEDULING,
      projectId: ada.projectId,
      agents: [agentId],
      personas: [first.id],
    });

    expect(created.statusCode, JSON.stringify(created.body)).toBe(201);
    expect((created.body.personas as { id: string }[]).map((one) => one.id)).toEqual([
      first.id,
    ]);
  });
});
