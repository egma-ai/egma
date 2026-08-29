import {
  GRADER_DEFINITION_CATALOG,
  MAXIMUM_RESPONSE_TIME_PARAMETER,
  PREDEFINED_GRADERS,
  reconcileGraderCatalog,
} from "@egma/db";
import { afterEach, describe, expect, it } from "vitest";

import { createApi, type TestApi } from "./support/api.ts";
import {
  colleagueOf,
  mintKey,
  projectKeyFor,
  signUp,
  type Answer,
} from "./support/traces.ts";

let api: TestApi;

afterEach(async () => {
  await api?.close();
});

async function request(
  method: "GET" | "POST",
  url: string,
  key: string,
  body?: Record<string, unknown>,
): Promise<Answer> {
  const response = await api.app.inject({
    method,
    url,
    headers: { authorization: `Bearer ${key}` },
    ...(body === undefined ? {} : { payload: body }),
  });
  return {
    statusCode: response.statusCode,
    body: response.body === ""
      ? {}
      : response.json() as Record<string, unknown>,
  };
}

type Listed = {
  readonly id: string;
  readonly name: string;
  readonly owner: "egma" | "organization";
  readonly type: "llm_as_judge" | "code";
  readonly scopeEditable: boolean;
  readonly currentDefinitionVersion: number;
  readonly definitionVersion: number;
  readonly modalities: readonly ("chat" | "voice")[];
  readonly gradingInstructions: string | null;
  readonly requiredEvidence: readonly string[];
  readonly settingDefinitions: readonly Record<string, unknown>[];
  readonly activeProjectGraderId: string | null;
};

function itemsOf(answer: Answer): readonly Listed[] {
  return answer.body.graderLibraryEntries as readonly Listed[];
}

function policy(settings: Record<string, unknown> = {}) {
  return {
    scope: {
      simulations: [{ kind: "all" }],
      production: null,
    },
    settings,
    passThreshold: 1,
  };
}

describe("the grader library", () => {
  it("shows predefined graders, their form contract, and current-project use state", async () => {
    api = await createApi("grader_library_list");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");
    const key = await projectKeyFor(api.app, ada);

    const answer = await request("GET", "/v1/grader-library", key);

    expect(answer.statusCode, JSON.stringify(answer.body)).toBe(200);
    const expected = itemsOf(answer).find(
      (entry) => entry.id === PREDEFINED_GRADERS.expectedBehaviors,
    );
    expect(expected).toMatchObject({
      name: "expected_behaviors",
      owner: "egma",
      type: "llm_as_judge",
      scopeEditable: false,
      modalities: ["chat", "voice"],
      gradingInstructions: null,
      requiredEvidence: ["transcript", "test_expected_behaviors"],
      settingDefinitions: [],
    });
    expect(expected?.activeProjectGraderId).toMatch(/^grd_/u);

    const latency = itemsOf(answer).find(
      (entry) => entry.id === PREDEFINED_GRADERS.responseLatency,
    );
    expect(latency).toMatchObject({
      name: "Response latency",
      owner: "egma",
      type: "code",
      scopeEditable: true,
      modalities: ["chat", "voice"],
      gradingInstructions: null,
      requiredEvidence: ["turn_response_latency"],
      activeProjectGraderId: null,
      settingDefinitions: [
        {
          key: MAXIMUM_RESPONSE_TIME_PARAMETER,
          label: "Maximum response time (p90)",
          valueType: "integer",
          defaultValue: 3_000,
          unit: "milliseconds",
          minimum: 1,
          maximum: null,
        },
      ],
    });
    expect(answer.body.nextPageToken).toBeNull();

    const serialized = JSON.stringify(itemsOf(answer));
    for (const executable of [
      "prompt",
      "params",
      "outputDefinition",
      "judgeModel",
      "sourceCode",
    ]) {
      expect(serialized).not.toContain(executable);
    }
  });

  it("lets viewers read details but refuses Use in project", async () => {
    api = await createApi("grader_library_roles");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");
    const viewer = await colleagueOf(
      api.app,
      ada,
      "grace@acme.example",
      "viewer",
    );

    const detail = await request(
      "GET",
      `/v1/grader-library/${PREDEFINED_GRADERS.responseLatency}`,
      viewer.secret,
    );
    expect(detail.statusCode, JSON.stringify(detail.body)).toBe(200);
    expect(detail.body).toMatchObject({
      id: PREDEFINED_GRADERS.responseLatency,
      activeProjectGraderId: null,
    });

    const refused = await request(
      "POST",
      `/v1/grader-library/${PREDEFINED_GRADERS.responseLatency}/use`,
      viewer.secret,
      policy({ [MAXIMUM_RESPONSE_TIME_PARAMETER]: 2_500 }),
    );
    expect(refused.statusCode).toBe(403);

    const createRefused = await request(
      "POST",
      "/v1/grader-library/custom",
      viewer.secret,
      {
        name: "Viewer grader",
        gradingInstructions: "the agent offered a refund",
        passesWhen: "the agent offers a refund",
        failsWhen: "the agent never offers a refund",
        scope: { simulations: [{ kind: "all" }], production: null },
        passThreshold: 1,
      },
    );
    expect(createRefused.statusCode).toBe(403);
  });

  it("reads one exact immutable definition version after the current version moves", async () => {
    api = await createApi("grader_library_version_read");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");
    const key = await projectKeyFor(api.app, ada);
    const expected = GRADER_DEFINITION_CATALOG.find(
      (entry) => entry.id === PREDEFINED_GRADERS.expectedBehaviors,
    );
    if (expected === undefined) {
      throw new Error("the Expected behaviors catalog fixture is missing");
    }
    await reconcileGraderCatalog([{ ...expected, modalities: ["chat"] }]);

    const current = await request(
      "GET",
      `/v1/grader-library/${expected.id}`,
      key,
    );
    expect(current.statusCode, JSON.stringify(current.body)).toBe(200);
    expect(current.body).toMatchObject({
      currentDefinitionVersion: 2,
      definitionVersion: 2,
      modalities: ["chat"],
    });

    const frozen = await request(
      "GET",
      `/v1/grader-library/${expected.id}?definitionVersion=1`,
      key,
    );
    expect(frozen.statusCode, JSON.stringify(frozen.body)).toBe(200);
    expect(frozen.body).toMatchObject({
      currentDefinitionVersion: 2,
      definitionVersion: 1,
      modalities: ["chat", "voice"],
    });
  });

  it("uses one predefined grader once in the current project", async () => {
    api = await createApi("grader_library_use");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");
    const key = await projectKeyFor(api.app, ada);
    const input = policy({
      [MAXIMUM_RESPONSE_TIME_PARAMETER]: 2_500,
    });

    const used = await request(
      "POST",
      `/v1/grader-library/${PREDEFINED_GRADERS.responseLatency}/use`,
      key,
      input,
    );
    expect(used.statusCode, JSON.stringify(used.body)).toBe(201);
    expect(used.body).toMatchObject({
      graderDefinitionId: PREDEFINED_GRADERS.responseLatency,
      type: "code",
      owner: "egma",
      settings: input.settings,
      scope: input.scope,
      passThreshold: 1,
      removable: true,
    });

    const library = await request("GET", "/v1/grader-library", key);
    expect(
      itemsOf(library).find(
        (entry) => entry.id === PREDEFINED_GRADERS.responseLatency,
      )?.activeProjectGraderId,
    ).toBe(used.body.id);

    const duplicate = await request(
      "POST",
      `/v1/grader-library/${PREDEFINED_GRADERS.responseLatency}/use`,
      key,
      input,
    );
    expect(duplicate.statusCode).toBe(422);
  });

  it("creates an organization-owned LLM grader and activates it atomically", async () => {
    api = await createApi("grader_library_custom");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");
    const key = await projectKeyFor(api.app, ada);

    const boundary = {
      name: "Polite close",
      description: "Checks that the agent closes politely.",
      gradingInstructions: "the agent closed the conversation politely",
      passesWhen: "the last agent turn thanks the caller",
      failsWhen: "the last agent turn ends with no closing courtesy",
      scope: { simulations: [{ kind: "all" }], production: null },
      passThreshold: 0.8,
    };
    const created = await request(
      "POST",
      "/v1/grader-library/custom",
      key,
      boundary,
    );

    expect(created.statusCode, JSON.stringify(created.body)).toBe(201);
    /*
     * The three authored parts arrive as three fields and leave as one
     * compiled prompt, so every client produces the same judged behavior.
     */
    expect(created.body.definition).toMatchObject({
      name: "Polite close",
      owner: "organization",
      type: "llm_as_judge",
      modalities: ["chat", "voice"],
      gradingInstructions:
        "Decide whether: the agent closed the conversation politely. " +
        "Answer met when: the last agent turn thanks the caller. " +
        "Answer not_met when: the last agent turn ends with no closing courtesy.",
      settingDefinitions: [],
    });
    expect(JSON.stringify(created.body)).not.toContain("outputContract");
    expect(created.body.grader).toMatchObject({
      owner: "organization",
      type: "llm_as_judge",
      modalities: ["chat", "voice"],
      settings: {},
      scope: { simulations: [{ kind: "all" }], production: null },
      passThreshold: 0.8,
      removable: true,
    });
    expect(
      (created.body.definition as Listed).activeProjectGraderId,
    ).toBe((created.body.grader as { id: string }).id);

    const typeChoice = await request(
      "POST",
      "/v1/grader-library/custom",
      key,
      { ...boundary, name: "Customer code", type: "code" },
    );
    expect(typeChoice.statusCode).toBe(400);
    /* A stale client that still sends modalities is told, not ignored. */
    const staleClient = await request(
      "POST",
      "/v1/grader-library/custom",
      key,
      { ...boundary, name: "Stale client", modalities: ["voice"] },
    );
    expect(staleClient.statusCode).toBe(400);
    expect(JSON.stringify(staleClient.body)).toContain("modalities");
    expect(
      (await request("POST", "/v1/grader-library", key, {})).statusCode,
    ).toBe(404);
  });

  it("refuses a boundary that leaves any of its three parts blank", async () => {
    api = await createApi("grader_library_boundary");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");
    const key = await projectKeyFor(api.app, ada);
    const boundary = {
      name: "Blank part",
      gradingInstructions: "the agent confirmed the address",
      passesWhen: "the agent reads the address back",
      failsWhen: "the agent never reads the address back",
      scope: { simulations: [{ kind: "all" }], production: null },
      passThreshold: 1,
    };

    for (const blank of [
      "gradingInstructions",
      "passesWhen",
      "failsWhen",
    ] as const) {
      const refused = await request("POST", "/v1/grader-library/custom", key, {
        ...boundary,
        [blank]: "   ",
      });
      expect(refused.statusCode, blank).toBe(400);
      expect(JSON.stringify(refused.body), blank).toContain(blank);

      const missing = { ...boundary } as Record<string, unknown>;
      delete missing[blank];
      expect(
        (await request("POST", "/v1/grader-library/custom", key, missing))
          .statusCode,
        blank,
      ).toBe(400);
    }
  });

  it("keeps custom definitions inside their organization and activation inside one project", async () => {
    api = await createApi("grader_library_tenants");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");
    const globex = await signUp(api.app, "grace@globex.example", "Globex");
    const acmeKey = await projectKeyFor(api.app, ada);
    const created = await request(
      "POST",
      "/v1/grader-library/custom",
      acmeKey,
      {
        name: "Acme policy",
        gradingInstructions: "the agent followed Acme policy",
        passesWhen: "the agent states the policy before closing",
        failsWhen: "the agent closes without stating the policy",
        scope: { simulations: [{ kind: "all" }], production: null },
        passThreshold: 1,
      },
    );
    expect(created.statusCode, JSON.stringify(created.body)).toBe(201);
    const definitionId = (created.body.definition as { id: string }).id;

    const foreignKey = await projectKeyFor(api.app, globex);
    expect(
      (await request("GET", `/v1/grader-library/${definitionId}`, foreignKey))
        .statusCode,
    ).toBe(404);
    expect(
      (await request(
        "POST",
        `/v1/grader-library/${definitionId}/use`,
        foreignKey,
        policy(),
      )).statusCode,
    ).toBe(404);

    const made = await api.app.inject({
      method: "POST",
      url: "/v1/projects",
      headers: { cookie: ada.cookie },
      payload: { name: "Second" },
    });
    expect(made.statusCode, made.body).toBe(201);
    const secondProjectId = (made.json() as { id: string }).id;
    const secondKey = await mintKey(
      api.app,
      ada.cookie,
      "second project",
      secondProjectId,
    );
    const secondLibrary = await request("GET", "/v1/grader-library", secondKey);
    expect(
      itemsOf(secondLibrary).find((entry) => entry.id === definitionId)
        ?.activeProjectGraderId,
    ).toBeNull();
    const secondActive = await request("GET", "/v1/graders", secondKey);
    expect(
      (secondActive.body.graders as { graderDefinitionId: string }[]).map(
        (grader) => grader.graderDefinitionId,
      ),
    ).toEqual([PREDEFINED_GRADERS.expectedBehaviors]);
  });
});
