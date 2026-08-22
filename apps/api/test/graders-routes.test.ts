import { PREDEFINED_GRADERS } from "@egma/db";
import { afterEach, describe, expect, it } from "vitest";

import { createApi, type TestApi } from "./support/api.ts";
import {
  colleagueOf,
  projectKeyFor,
  request as ask,
  signUp,
  type Answer,
} from "./support/traces.ts";

let api: TestApi;

afterEach(async () => {
  await api?.close();
});

function request(
  method: "GET" | "POST" | "PATCH" | "DELETE",
  url: string,
  key: string,
  body?: Record<string, unknown>,
): Promise<Answer> {
  return ask(api.app, method, url, key, body);
}

type Listed = {
  readonly id: string;
  readonly projectId: string;
  readonly graderDefinitionId: string;
  readonly name: string;
  readonly description: string | null;
  readonly scopeEditable: boolean;
  readonly scope: {
    readonly simulations: readonly { readonly kind: string }[];
    readonly production: { readonly samplePercent: number } | null;
  };
  readonly passThreshold: number;
};

function itemsOf(answer: Answer): readonly Listed[] {
  return answer.body.graders as readonly Listed[];
}

describe("project graders", () => {
  it("starts every project with the protected Expected behaviors grader", async () => {
    api = await createApi("graders_expected_behaviors");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");
    const key = await projectKeyFor(api.app, ada);

    const answer = await request("GET", "/v1/graders", key);

    expect(answer.statusCode, JSON.stringify(answer.body)).toBe(200);
    expect(itemsOf(answer)).toHaveLength(1);
    expect(itemsOf(answer)[0]).toMatchObject({
      projectId: ada.projectId,
      graderDefinitionId: PREDEFINED_GRADERS.expectedBehaviors,
      name: "expected_behaviors",
      scopeEditable: false,
      scope: {
        simulations: [{ kind: "all" }],
        production: null,
      },
      passThreshold: 1,
    });
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

  it("lets an administrator change only the pass threshold", async () => {
    api = await createApi("graders_threshold");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");
    const key = await projectKeyFor(api.app, ada);
    const [grader] = itemsOf(await request("GET", "/v1/graders", key));
    expect(grader).toBeDefined();

    const changed = await request(
      "PATCH",
      `/v1/graders/${grader!.id}`,
      key,
      { passThreshold: 0.75 },
    );

    expect(changed.statusCode, JSON.stringify(changed.body)).toBe(200);
    expect(changed.body).toMatchObject({
      id: grader!.id,
      passThreshold: 0.75,
      scope: grader!.scope,
    });

    const scopeEdit = await request(
      "PATCH",
      `/v1/graders/${grader!.id}`,
      key,
      {
        passThreshold: 0.75,
        scope: { simulations: [], production: null },
      },
    );
    expect(scopeEdit.statusCode).toBe(400);
  });

  it("keeps the threshold write unavailable to viewers", async () => {
    api = await createApi("graders_roles");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");
    const viewer = await colleagueOf(
      api.app,
      ada,
      "grace@acme.example",
      "viewer",
    );
    const key = await projectKeyFor(api.app, ada);
    const [grader] = itemsOf(await request("GET", "/v1/graders", key));

    const changed = await request(
      "PATCH",
      `/v1/graders/${grader!.id}`,
      viewer.secret,
      { passThreshold: 0.5 },
    );

    expect(changed.statusCode).toBe(403);
  });

  it("does not expose Use or Remove routes", async () => {
    api = await createApi("graders_no_use_remove");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");
    const key = await projectKeyFor(api.app, ada);
    const [grader] = itemsOf(await request("GET", "/v1/graders", key));

    expect((await request("POST", "/v1/graders", key, {})).statusCode).toBe(
      404,
    );
    expect(
      (await request("DELETE", `/v1/graders/${grader!.id}`, key)).statusCode,
    ).toBe(404);
  });

  it("gives each project its own policy row over the shared definition", async () => {
    api = await createApi("graders_tenants");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");
    const grace = await signUp(api.app, "grace@globex.example", "Globex");

    const [acme] = itemsOf(
      await request("GET", "/v1/graders", await projectKeyFor(api.app, ada)),
    );
    const [globex] = itemsOf(
      await request(
        "GET",
        "/v1/graders",
        await projectKeyFor(api.app, grace),
      ),
    );

    expect(acme!.id).not.toBe(globex!.id);
    expect(acme!.graderDefinitionId).toBe(globex!.graderDefinitionId);
  });
});
