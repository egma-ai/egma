/** Successful collection reads fail closed when the platform omits the collection. */

import { describe, expect, it } from "vitest";

import { readConnectionOptions } from "../src/platform/connection-options.ts";
import { listProjectPersonas } from "../src/platform/personas.ts";
import { listProjects } from "../src/platform/projects.ts";
import { PlatformRefusedError } from "../src/platform/refused.ts";
import { listTestSuites } from "../src/platform/test-suites.ts";
import { listTests } from "../src/platform/tests.ts";

const URL = "https://egma.example";
const KEY = "egma_sk_collection-contract";
const PROJECT_ID = "prj_01K3XQ7M4E8YB2FVN0H9TZQWER";
const SUITE_ID = "ste_01K3XQ7M4E8YB2FVN0H9TZQWER";

function successful(body: unknown): typeof fetch {
  return async () =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
}

function refusedWith(message: string): {
  readonly name: string;
  readonly status: number;
  readonly message: string;
} {
  return {
    name: PlatformRefusedError.name,
    status: 200,
    message,
  };
}

describe("successful platform collection envelopes", () => {
  it.each([
    ["a missing response body", undefined],
    ["a missing Project list", {}],
    ["a non-list Project collection", { projects: {} }],
    ["an incomplete Project", { projects: [{}] }],
  ])("refuses Projects with %s", async (_case, body) => {
    const result = await listProjects(
      { url: URL, key: KEY },
      successful(body),
    );
    expect(result.kind).toBe("refused");
    if (result.kind !== "refused") throw new Error("expected a refused Project list");
    expect(result.reason).toMatch(
      /^Egma answered with (?:a Project collection|an incomplete Project)/u,
    );
  });

  it.each([
    ["a missing response body", undefined],
    ["a missing Persona list", {}],
    ["a non-list Persona collection", { personas: {}, nextPageToken: null }],
    ["a missing Persona page token", { personas: [] }],
    ["an incomplete Persona", { personas: [{}], nextPageToken: null }],
  ])("refuses Personas with %s", async (_case, body) => {
    await expect(
      listProjectPersonas(
        { url: URL, key: KEY },
        PROJECT_ID,
        successful(body),
      ),
    ).rejects.toMatchObject({
      name: PlatformRefusedError.name,
      status: 200,
      message: expect.stringMatching(
        /^Egma answered with (?:a Persona collection|a persona that has no stable id or name)/u,
      ),
    });
  });

  it.each([
    ["a missing response body", undefined],
    ["a missing catalog", {}],
    ["a non-list catalog", { items: {} }],
  ])("refuses Connection options with %s", async (_case, body) => {
    const answer = await readConnectionOptions({
      url: URL,
      key: KEY,
      fetchImpl: successful(body),
    });

    expect(answer).toEqual({
      kind: "refused",
      reason:
        "Egma answered with a Connection option catalog this CLI cannot read. Check that this Egma platform is up to date.",
    });
  });

  it.each([
    ["a missing response body", undefined],
    ["a missing Suite list", {}],
    ["a non-list Suite collection", { testSuites: {}, nextPageToken: null }],
    ["a missing Suite page token", { testSuites: [] }],
  ])("refuses Test Suites with %s", async (_case, body) => {
    await expect(
      listTestSuites(
        { url: URL, key: KEY },
        PROJECT_ID,
        successful(body),
      ),
    ).rejects.toMatchObject(
      refusedWith(
        "Egma answered with a Test Suite collection this CLI cannot read. Check that this Egma platform is up to date.",
      ),
    );
  });

  it.each([
    ["a missing response body", undefined],
    ["a missing Test list", {}],
    ["a non-list Test collection", { tests: {}, nextPageToken: null }],
    ["a missing Test page token", { tests: [] }],
  ])("refuses Tests with %s", async (_case, body) => {
    await expect(
      listTests(
        { url: URL, key: KEY },
        {
          projectId: PROJECT_ID,
          suiteId: SUITE_ID,
          fetchImpl: successful(body),
        },
      ),
    ).rejects.toMatchObject(
      refusedWith(
        "Egma answered with a Test collection this CLI cannot read. Check that this Egma platform is up to date.",
      ),
    );
  });
});
