import {
  MAXIMUM_AVERAGE_RESPONSE_TIME_PARAMETER,
  PREDEFINED_GRADERS,
} from "@egma/db";
import { afterEach, describe, expect, it } from "vitest";

import { createApi, type TestApi } from "./support/api.ts";
import {
  colleagueOf,
  projectKeyFor,
  signUp,
  type Answer,
} from "./support/traces.ts";

let api: TestApi;

afterEach(async () => {
  await api?.close();
});

async function request(
  method: "GET" | "POST" | "PATCH" | "DELETE",
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
  readonly projectId: string;
  readonly graderDefinitionId: string;
  readonly name: string;
  readonly owner: "egma" | "organization";
  readonly type: "llm_as_judge" | "code";
  readonly modalities: readonly ("chat" | "voice")[];
  readonly scopeEditable: boolean;
  readonly removable: boolean;
  readonly scope: {
    readonly simulations: readonly Record<string, unknown>[];
    readonly production: { readonly samplePercent: number } | null;
  };
  readonly settings: Record<string, unknown>;
  readonly passThreshold: number;
};

function itemsOf(answer: Answer): readonly Listed[] {
  return answer.body.graders as readonly Listed[];
}

async function useResponseLatency(key: string): Promise<Listed> {
  const used = await request(
    "POST",
    `/v1/grader-library/${PREDEFINED_GRADERS.responseLatency}/use`,
    key,
    {
      scope: { simulations: [{ kind: "all" }], production: null },
      settings: { [MAXIMUM_AVERAGE_RESPONSE_TIME_PARAMETER]: 3_000 },
      passThreshold: 1,
    },
  );
  expect(used.statusCode, JSON.stringify(used.body)).toBe(201);
  return used.body as Listed;
}

describe("active project graders", () => {
  it("starts every project with only the protected Expected behaviors grader", async () => {
    api = await createApi("graders_expected_behaviors");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");
    const key = await projectKeyFor(api.app, ada);

    const answer = await request("GET", "/v1/graders", key);

    expect(answer.statusCode, JSON.stringify(answer.body)).toBe(200);
    expect(itemsOf(answer)).toEqual([
      expect.objectContaining({
        projectId: ada.projectId,
        graderDefinitionId: PREDEFINED_GRADERS.expectedBehaviors,
        name: "expected_behaviors",
        owner: "egma",
        type: "llm_as_judge",
        modalities: ["chat", "voice"],
        scopeEditable: false,
        removable: false,
        scope: {
          simulations: [{ kind: "all" }],
          production: null,
        },
        settings: {},
        passThreshold: 1,
      }),
    ]);
    expect(answer.body.nextPageToken).toBeNull();

    const serialized = JSON.stringify(itemsOf(answer)[0]);
    for (const retired of [
      "required",
      "gate",
      "judgeModel",
      "params",
      "config",
      "versionId",
      "productionSampleRate",
    ]) {
      expect(serialized).not.toContain(retired);
    }
  });

  it("updates an optional grader's scope, settings, and pass threshold", async () => {
    api = await createApi("graders_edit_policy");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");
    const key = await projectKeyFor(api.app, ada);
    const grader = await useResponseLatency(key);

    const changed = await request(
      "PATCH",
      `/v1/graders/${grader.id}`,
      key,
      {
        scope: {
          simulations: [],
          production: { samplePercent: 25 },
        },
        settings: { [MAXIMUM_AVERAGE_RESPONSE_TIME_PARAMETER]: 2_000 },
        passThreshold: 0.75,
      },
    );

    expect(changed.statusCode, JSON.stringify(changed.body)).toBe(200);
    expect(changed.body).toMatchObject({
      id: grader.id,
      scope: {
        simulations: [],
        production: { samplePercent: 25 },
      },
      settings: { [MAXIMUM_AVERAGE_RESPONSE_TIME_PARAMETER]: 2_000 },
      passThreshold: 0.75,
    });

    const cleared = await request(
      "PATCH",
      `/v1/graders/${grader.id}`,
      key,
      { scope: { simulations: [], production: null } },
    );
    expect(cleared.statusCode, JSON.stringify(cleared.body)).toBe(200);
    expect(cleared.body.scope).toEqual({ simulations: [], production: null });
    expect(
      itemsOf(await request("GET", "/v1/graders", key)).some(
        (entry) => entry.id === grader.id,
      ),
    ).toBe(true);
  });

  it("removes an optional grader but never the protected default", async () => {
    api = await createApi("graders_remove");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");
    const key = await projectKeyFor(api.app, ada);
    const optional = await useResponseLatency(key);
    const expected = itemsOf(await request("GET", "/v1/graders", key)).find(
      (entry) => entry.graderDefinitionId === PREDEFINED_GRADERS.expectedBehaviors,
    );
    expect(expected).toBeDefined();

    const removed = await request(
      "DELETE",
      `/v1/graders/${optional.id}`,
      key,
    );
    expect(removed.statusCode).toBe(204);
    expect(
      itemsOf(await request("GET", "/v1/graders", key)).some(
        (entry) => entry.id === optional.id,
      ),
    ).toBe(false);

    const library = await request("GET", "/v1/grader-library", key);
    const entries = library.body.graderLibraryEntries as {
      id: string;
      activeProjectGraderId: string | null;
    }[];
    expect(
      entries.find(
        (entry) => entry.id === PREDEFINED_GRADERS.responseLatency,
      )?.activeProjectGraderId,
    ).toBeNull();

    const usedAgain = await useResponseLatency(key);
    expect(usedAgain.id).not.toBe(optional.id);

    const protectedRemoval = await request(
      "DELETE",
      `/v1/graders/${expected!.id}`,
      key,
    );
    expect(protectedRemoval.statusCode).toBe(422);
  });

  it("refuses viewer writes and hides another organization's rows", async () => {
    api = await createApi("graders_permissions");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");
    const viewer = await colleagueOf(
      api.app,
      ada,
      "val@acme.example",
      "viewer",
    );
    const key = await projectKeyFor(api.app, ada);
    const optional = await useResponseLatency(key);

    expect(
      (await request(
        "PATCH",
        `/v1/graders/${optional.id}`,
        viewer.secret,
        { passThreshold: 0.5 },
      )).statusCode,
    ).toBe(403);
    expect(
      (await request(
        "DELETE",
        `/v1/graders/${optional.id}`,
        viewer.secret,
      )).statusCode,
    ).toBe(403);

    const globex = await signUp(api.app, "grace@globex.example", "Globex");
    const foreignKey = await projectKeyFor(api.app, globex);
    expect(
      (await request(
        "PATCH",
        `/v1/graders/${optional.id}`,
        foreignKey,
        { passThreshold: 0.5 },
      )).statusCode,
    ).toBe(404);
    expect(
      (await request(
        "DELETE",
        `/v1/graders/${optional.id}`,
        foreignKey,
      )).statusCode,
    ).toBe(404);
  });
});
