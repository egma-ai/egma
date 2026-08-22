import { GRADER_DEFINITION_CATALOG, PREDEFINED_GRADERS } from "@egma/db";
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

function request(url: string, key: string): Promise<Answer> {
  return ask(api.app, "GET", url, key);
}

type Listed = {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  readonly type: string;
  readonly owner: string;
  readonly projectId: string | null;
  readonly scopeEditable: boolean;
  readonly currentDefinitionVersion: number;
};

function itemsOf(answer: Answer): readonly Listed[] {
  return answer.body.graderLibraryEntries as readonly Listed[];
}

describe("the grader definition library", () => {
  it("shows the one Egma-owned Expected behaviors definition", async () => {
    api = await createApi("grader_library_list");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");
    const key = await projectKeyFor(api.app, ada);

    const answer = await request("/v1/grader-library", key);

    expect(answer.statusCode, JSON.stringify(answer.body)).toBe(200);
    expect(itemsOf(answer)).toEqual([
      expect.objectContaining({
        id: PREDEFINED_GRADERS.expectedBehaviors,
        name: "expected_behaviors",
        type: "llm_as_judge",
        owner: "egma",
        projectId: null,
        scopeEditable: false,
        currentDefinitionVersion: 1,
      }),
    ]);
    expect(itemsOf(answer)).toHaveLength(GRADER_DEFINITION_CATALOG.length);
    expect(answer.body.nextPageToken).toBeNull();

    const serialized = JSON.stringify(itemsOf(answer)[0]);
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

  it("is readable by viewers", async () => {
    api = await createApi("grader_library_roles");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");
    const viewer = await colleagueOf(
      api.app,
      ada,
      "grace@acme.example",
      "viewer",
    );

    const answer = await request("/v1/grader-library", viewer.secret);

    expect(answer.statusCode, JSON.stringify(answer.body)).toBe(200);
    expect(itemsOf(answer)).toHaveLength(1);
  });

  it("shows every customer the same shared definition identity", async () => {
    api = await createApi("grader_library_tenants");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");
    const grace = await signUp(api.app, "grace@globex.example", "Globex");

    const acme = itemsOf(
      await request(
        "/v1/grader-library",
        await projectKeyFor(api.app, ada),
      ),
    );
    const globex = itemsOf(
      await request(
        "/v1/grader-library",
        await projectKeyFor(api.app, grace),
      ),
    );

    expect(acme.map((entry) => entry.id)).toEqual(
      globex.map((entry) => entry.id),
    );
  });
});
