import { afterEach, describe, expect, it } from "vitest";

import { createApi, type TestApi } from "./support/api.ts";
import { colleagueOf, signUp, type Customer } from "./support/traces.ts";

/**
 * The grader routes, over real HTTP against real Postgres.
 *
 * What is asserted here is what a caller observes: which edits mint history and
 * which do not, that a type can never change, that the shelf describes the
 * built-in nobody attaches, and every refusal sentence word for word. Refusal
 * wording is contract — a page shows it and a client branches on the code
 * beside it — so a sentence that changed without somebody deciding to change it
 * fails here.
 */

let api: TestApi;

afterEach(async () => {
  await api?.close();
});

type Answer = {
  readonly statusCode: number;
  readonly body: Record<string, unknown>;
  readonly raw: string;
};

async function asBrowser(
  person: Customer,
  method: "GET" | "POST" | "PATCH" | "PUT",
  url: string,
  payload?: Record<string, unknown>,
): Promise<Answer> {
  const response = await api.app.inject({
    method,
    url,
    headers: { cookie: person.cookie },
    ...(payload === undefined ? {} : { payload }),
  });
  return {
    statusCode: response.statusCode,
    body: (() => {
      try {
        return response.json() as Record<string, unknown>;
      } catch {
        return {};
      }
    })(),
    raw: response.body,
  };
}

function rubric(person: Customer, overrides: Record<string, unknown> = {}) {
  return {
    name: "Verified identity first",
    type: "llm_rubric",
    config: { rubric: "The agent verified identity before any balance." },
    project: person.projectId,
    ...overrides,
  };
}

async function createGraderFor(
  person: Customer,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const created = await asBrowser(person, "POST", "/api/graders", body);
  expect(created.statusCode, created.raw).toBe(201);
  return created.body;
}

describe("the grader shelf", () => {
  /**
   * The built-in reaches the browser as a description and never as a row.
   *
   * A shelf listing only authored graders would leave somebody believing that a
   * project with none makes no judgments at all, which is the opposite of true:
   * every test is judged against its own expected behaviors from birth. And a
   * shelf that made the built-in look like a row would invite somebody to go
   * looking for it, or to try to take it off.
   */
  it("describes the built-in as implicit, always active, and neither editable nor removable", async () => {
    api = await createApi("grader_registry_built_in");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");

    const registry = await asBrowser(ada, "GET", "/api/grader-registry");

    expect(registry.statusCode, registry.raw).toBe(200);
    expect(registry.body.built_in).toEqual([
      expect.objectContaining({
        key: "expected_behaviors_v1",
        implicit: true,
        always_active: true,
        editable: false,
        removable: false,
      }),
    ]);

    // It is not among the authored types, so nothing can create one.
    const types = (registry.body.types as { type: string }[]).map(
      (one) => one.type,
    );
    expect(types).not.toContain("expected_behaviors");
    expect(types.sort()).toEqual([
      "llm_rubric",
      "metric_threshold",
      "phrase_match",
      "tool_calls",
    ]);
  });

  it("says which types fix their reads and which let an author choose", async () => {
    api = await createApi("grader_registry_reads");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");

    const registry = await asBrowser(ada, "GET", "/api/grader-registry");
    const byType = new Map(
      (registry.body.types as { type: string; reads: string[]; reads_are_fixed: boolean }[]).map(
        (one) => [one.type, one],
      ),
    );

    expect(byType.get("metric_threshold")).toMatchObject({
      reads: ["measures"],
      reads_are_fixed: true,
    });
    expect(byType.get("tool_calls")).toMatchObject({
      reads: ["tool_calls"],
      reads_are_fixed: true,
    });
    expect(byType.get("phrase_match")).toMatchObject({
      reads: ["transcript"],
      reads_are_fixed: true,
    });
    expect(byType.get("llm_rubric")).toMatchObject({
      reads: ["transcript"],
      reads_are_fixed: false,
    });
  });

  it("refuses a grader whose type does not create the shelf's built-in", async () => {
    api = await createApi("grader_built_in_is_not_a_type");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");

    const refused = await asBrowser(
      ada,
      "POST",
      "/api/graders",
      rubric(ada, { type: "expected_behaviors" }),
    );

    expect(refused.statusCode).toBe(422);
    expect(String(refused.body.message)).toContain("not a grader type");
  });
});

describe("authoring a grader", () => {
  it("takes each type through its own fields, and defaults reads and modalities", async () => {
    api = await createApi("grader_types");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");

    const cases: readonly [string, Record<string, unknown>, readonly string[]][] = [
      [
        "llm_rubric",
        { rubric: "The agent verified identity before any balance." },
        ["transcript"],
      ],
      [
        "metric_threshold",
        {
          measure: "turn_response_latency",
          aggregation: "p90",
          comparator: "below",
          threshold: 2000,
        },
        ["measures"],
      ],
      ["tool_calls", { required: [{ tool: "check_availability" }] }, ["tool_calls"]],
      ["phrase_match", { required: [{ text: "recorded for quality" }] }, ["transcript"]],
    ];

    for (const [type, config, reads] of cases) {
      const created = await createGraderFor(ada, {
        name: `A ${type} grader`,
        type,
        config,
        project: ada.projectId,
      });

      expect(created.type).toBe(type);
      expect(created.reads).toEqual(reads);
      // Both, always, unless somebody narrows: a grader that named neither
      // could never fire, and one narrowed by accident is a check that
      // silently stops applying.
      expect(created.modalities).toEqual(["voice", "chat"]);
      expect(created.version).toBe(1);
    }
  });

  it("refuses reads a deterministic type does not choose, rather than correcting them", async () => {
    api = await createApi("grader_fixed_reads");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");

    const refused = await asBrowser(ada, "POST", "/api/graders", {
      name: "A confused threshold",
      type: "metric_threshold",
      config: {
        measure: "turn_response_latency",
        aggregation: "p90",
        comparator: "below",
        threshold: 2000,
      },
      reads: ["transcript"],
      project: ada.projectId,
    });

    expect(refused.statusCode).toBe(422);
    expect(String(refused.body.message)).toContain("fixed by the type");
  });

  it("lets an llm_rubric author choose what its criteria are written about", async () => {
    api = await createApi("grader_rubric_reads");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");

    const created = await createGraderFor(
      ada,
      rubric(ada, { reads: ["tool_calls", "outcome"] }),
    );

    // Answered in the settled order rather than the order it was written in, so
    // that saving the same set twice is one set and not two versions.
    expect(created.reads).toEqual(["outcome", "tool_calls"]);
  });

  it("refuses an empty modality set, because a grader that scores nothing can never fire", async () => {
    api = await createApi("grader_empty_modalities");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");

    const refused = await asBrowser(
      ada,
      "POST",
      "/api/graders",
      rubric(ada, { modalities: [] }),
    );

    expect(refused.statusCode).toBe(422);
    expect(String(refused.body.message)).toContain("at least one modality");
  });

  it("refuses a key it has no place for, by name", async () => {
    api = await createApi("grader_unknown_key");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");

    const refused = await asBrowser(
      ada,
      "POST",
      "/api/graders",
      rubric(ada, { gates: true }),
    );

    expect(refused.statusCode).toBe(400);
    expect(String(refused.body.message)).toContain('a grader has no key "gates"');
  });
});

describe("editing a grader", () => {
  it("keeps live settings out of history and versioned content in it", async () => {
    api = await createApi("grader_live_versus_versioned");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");
    const created = await createGraderFor(ada, rubric(ada));

    // Live: priority, scope, sampling, name, description. None of them changes
    // what any verdict already meant, so none mints a version.
    const live = await asBrowser(ada, "PATCH", `/api/graders/${created.id}`, {
      name: "Identity before balance",
      priority: "P1",
      scope: "both",
      production_sample_rate: 25,
      project: ada.projectId,
      expected_revision: created.revision,
      expected_version_id: created.version_id,
    });

    expect(live.statusCode, live.raw).toBe(200);
    expect(live.body).toMatchObject({
      name: "Identity before balance",
      priority: "P1",
      scope: "both",
      production_sample_rate: 25,
      version: 1,
      version_id: created.version_id,
    });
    // The revision moved, because something on the row did.
    expect(live.body.revision).not.toBe(created.revision);

    // Versioned: the rubric itself.
    const versioned = await asBrowser(
      ada,
      "PATCH",
      `/api/graders/${created.id}`,
      {
        config: { rubric: "The agent verified two facts before any balance." },
        project: ada.projectId,
        expected_revision: live.body.revision,
        expected_version_id: created.version_id,
      },
    );

    expect(versioned.statusCode, versioned.raw).toBe(200);
    expect(versioned.body.version).toBe(2);
    expect(versioned.body.version_id).not.toBe(created.version_id);

    const history = await asBrowser(
      ada,
      "GET",
      `/api/graders/${created.id}/versions?project=${ada.projectId}`,
    );
    expect((history.body.items as { version: number }[]).map((one) => one.version)).toEqual(
      [2, 1],
    );
  });

  it("treats reads and modalities as versioned content", async () => {
    api = await createApi("grader_reads_are_versioned");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");
    const created = await createGraderFor(ada, rubric(ada));

    const narrowed = await asBrowser(ada, "PATCH", `/api/graders/${created.id}`, {
      modalities: ["voice"],
      project: ada.projectId,
    });

    expect(narrowed.body.version).toBe(2);
    expect(narrowed.body.modalities).toEqual(["voice"]);

    const widened = await asBrowser(ada, "PATCH", `/api/graders/${created.id}`, {
      reads: ["transcript", "outcome"],
      project: ada.projectId,
    });

    expect(widened.body.version).toBe(3);
    expect(widened.body.reads).toEqual(["transcript", "outcome"]);
  });

  it("writes no version at all for content that has not changed", async () => {
    api = await createApi("grader_no_op_save");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");
    const created = await createGraderFor(ada, rubric(ada));

    const again = await asBrowser(ada, "PATCH", `/api/graders/${created.id}`, {
      config: { rubric: "The agent verified identity before any balance." },
      // The same sets, written the other way round. Two orders are one set.
      modalities: ["chat", "voice"],
      reads: ["transcript"],
      project: ada.projectId,
    });

    expect(again.statusCode, again.raw).toBe(200);
    expect(again.body.version).toBe(1);
    expect(again.body.version_id).toBe(created.version_id);
    // Nothing was written, so nothing about the row moved either.
    expect(again.body.revision).toBe(created.revision);
  });

  it("refuses to change the type, and says what to do instead", async () => {
    api = await createApi("grader_type_immutable");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");
    const created = await createGraderFor(ada, rubric(ada));

    const refused = await asBrowser(ada, "PATCH", `/api/graders/${created.id}`, {
      type: "phrase_match",
      project: ada.projectId,
    });

    expect(refused.statusCode).toBe(422);
    expect(String(refused.body.message)).toContain("cannot be changed");
    expect(String(refused.body.message)).toContain("Clone");
  });

  it("refuses a live edit written against a revision the grader has left behind", async () => {
    api = await createApi("grader_identity_conflict");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");
    const created = await createGraderFor(ada, rubric(ada));

    await asBrowser(ada, "PATCH", `/api/graders/${created.id}`, {
      priority: "P2",
      project: ada.projectId,
      expected_revision: created.revision,
    });

    const stale = await asBrowser(ada, "PATCH", `/api/graders/${created.id}`, {
      name: "Written in the other tab",
      project: ada.projectId,
      expected_revision: created.revision,
    });

    expect(stale.statusCode).toBe(409);
    expect(stale.body).toEqual({
      error: "identity_conflict",
      message:
        `Grader ${created.id} changed after you opened it. Read it again, ` +
        "keep or reapply your edits, and send the update with " +
        "expected_revision set to its new revision.",
    });

    const after = await asBrowser(
      ada,
      "GET",
      `/api/graders/${created.id}?project=${ada.projectId}`,
    );
    expect(after.body.name).toBe(created.name);
  });

  it("refuses a versioned edit written against a version the grader has minted past", async () => {
    api = await createApi("grader_version_conflict");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");
    const created = await createGraderFor(ada, rubric(ada));

    const moved = await asBrowser(ada, "PATCH", `/api/graders/${created.id}`, {
      config: { rubric: "Something else entirely." },
      project: ada.projectId,
    });

    const stale = await asBrowser(ada, "PATCH", `/api/graders/${created.id}`, {
      config: { rubric: "A third thing." },
      project: ada.projectId,
      expected_version_id: created.version_id,
    });

    expect(stale.statusCode).toBe(409);
    expect(stale.body).toEqual({
      error: "version_conflict",
      message:
        `this grader edit was written against version ${String(created.version_id)}, ` +
        `and it has moved on to ${String(moved.body.version_id)}. Read the ` +
        "grader again, keep or reapply your edits, and send them with " +
        `expected_version_id set to ${String(moved.body.version_id)}.`,
    });
  });
});

describe("cloning a grader", () => {
  it("copies the settings and the content, and starts its history again", async () => {
    api = await createApi("grader_clone");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");
    const created = await createGraderFor(ada, rubric(ada, { priority: "P1" }));

    await asBrowser(ada, "PATCH", `/api/graders/${created.id}`, {
      config: { rubric: "The agent verified two facts before any balance." },
      project: ada.projectId,
    });

    const cloned = await asBrowser(
      ada,
      "POST",
      `/api/graders/${created.id}/clone`,
      { name: "Identity, stricter", project: ada.projectId },
    );

    expect(cloned.statusCode, cloned.raw).toBe(201);
    expect(cloned.body.id).not.toBe(created.id);
    expect(cloned.body.name).toBe("Identity, stricter");
    expect(cloned.body.type).toBe("llm_rubric");
    expect(cloned.body.priority).toBe("P1");
    expect(cloned.body.config).toEqual({
      rubric: "The agent verified two facts before any balance.",
    });
    // No shared past: the copy starts at one, whatever the source had reached.
    expect(cloned.body.version).toBe(1);

    const history = await asBrowser(
      ada,
      "GET",
      `/api/graders/${String(cloned.body.id)}/versions?project=${ada.projectId}`,
    );
    expect(history.body.items).toHaveLength(1);
  });
});

describe("archiving a grader", () => {
  it("archives and restores, and the archived one is off the default list but still readable", async () => {
    api = await createApi("grader_archive_restore");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");
    const created = await createGraderFor(ada, rubric(ada));

    const archived = await asBrowser(
      ada,
      "POST",
      `/api/graders/${created.id}/archive`,
      { project: ada.projectId, expected_revision: created.revision },
    );
    expect(archived.statusCode, archived.raw).toBe(200);
    expect(archived.body.archived_at).not.toBeNull();

    const active = await asBrowser(
      ada,
      "GET",
      `/api/graders?project=${ada.projectId}`,
    );
    expect(active.body.items).toEqual([]);

    const filtered = await asBrowser(
      ada,
      "GET",
      `/api/graders?project=${ada.projectId}&archived=true`,
    );
    expect((filtered.body.items as { id: string }[]).map((one) => one.id)).toEqual(
      [created.id],
    );

    // The detail page and the history stay readable: a run pinned this, and a
    // verdict names it.
    const read = await asBrowser(
      ada,
      "GET",
      `/api/graders/${created.id}?project=${ada.projectId}`,
    );
    expect(read.statusCode).toBe(200);
    const history = await asBrowser(
      ada,
      "GET",
      `/api/graders/${created.id}/versions?project=${ada.projectId}`,
    );
    expect(history.body.items).toHaveLength(1);

    const restored = await asBrowser(
      ada,
      "POST",
      `/api/graders/${created.id}/restore`,
      { project: ada.projectId, expected_revision: archived.body.revision },
    );
    expect(restored.statusCode, restored.raw).toBe(200);
    expect(restored.body.archived_at).toBeNull();
  });

  /**
   * The distinction the whole Archive rule turns on: applying to every test by
   * default is not a usage that blocks anything, and being named by one test is.
   */
  it("says the project-wide default is not a blocking use", async () => {
    api = await createApi("grader_usage");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");
    const created = await createGraderFor(ada, rubric(ada));

    const usage = await asBrowser(
      ada,
      "GET",
      `/api/graders/${created.id}/usage?project=${ada.projectId}`,
    );

    expect(usage.statusCode, usage.raw).toBe(200);
    expect(usage.body).toEqual({
      direct_tests: [],
      applies_to_every_test_by_default: true,
    });
  });
});

describe("who may author a grader", () => {
  it("refuses a viewer every write, in the words a page shows", async () => {
    api = await createApi("grader_viewer_refused");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");
    const eve = await colleagueOf(api.app, ada, "eve@acme.example", "viewer");
    const created = await createGraderFor(ada, rubric(ada));

    const writes: readonly [string, string, Record<string, unknown>][] = [
      ["POST", "/api/graders", rubric(eve)],
      ["PATCH", `/api/graders/${created.id}`, { name: "Mine", project: eve.projectId }],
      [
        "POST",
        `/api/graders/${created.id}/clone`,
        { project: eve.projectId },
      ],
      [
        "POST",
        `/api/graders/${created.id}/archive`,
        { project: eve.projectId },
      ],
      [
        "POST",
        `/api/graders/${created.id}/restore`,
        { project: eve.projectId },
      ],
    ];

    for (const [method, url, payload] of writes) {
      const refused = await asBrowser(
        eve,
        method as "POST" | "PATCH",
        url,
        payload,
      );
      expect(refused.statusCode, `${method} ${url}`).toBe(403);
      expect(refused.body.error).toBe("not_permitted");
      expect(String(refused.body.message)).toMatch(
        /^Your viewer role cannot .+\. Ask an organization admin to change your role, then try again\.$/,
      );
    }

    // And they read everything, which is the other half of the rule.
    const read = await asBrowser(
      eve,
      "GET",
      `/api/graders?project=${ada.projectId}`,
    );
    expect(read.statusCode).toBe(200);
    expect(read.body.items).toHaveLength(1);
  });

  it("lets a member author, because a grader is authoring rather than administration", async () => {
    api = await createApi("grader_member_authors");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");
    const bob = await colleagueOf(api.app, ada, "bob@acme.example", "member");

    const created = await asBrowser(bob, "POST", "/api/graders", rubric(bob));
    expect(created.statusCode, created.raw).toBe(201);
  });
});

describe("a grader in another organization", () => {
  it("reads as one that never existed, and cannot be edited", async () => {
    api = await createApi("grader_isolation");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");
    const grace = await signUp(api.app, "grace@globex.example", "Globex");
    const created = await createGraderFor(ada, rubric(ada));

    const read = await asBrowser(
      grace,
      "GET",
      `/api/graders/${created.id}?project=${grace.projectId}`,
    );
    expect(read.statusCode).toBe(404);
    expect(read.body).toEqual({
      error: "not_found",
      message:
        `There is no grader ${created.id} available in this project. Check ` +
        "the link, or choose it from the current project.",
    });

    const edit = await asBrowser(grace, "PATCH", `/api/graders/${created.id}`, {
      name: "Taken",
      project: grace.projectId,
    });
    expect(edit.statusCode).toBe(404);
  });

  it("refuses a browser request that named no project", async () => {
    api = await createApi("grader_project_required");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");

    const refused = await asBrowser(ada, "GET", "/api/graders");

    expect(refused.statusCode).toBe(422);
    expect(refused.body).toEqual({
      error: "project_required",
      message:
        "This request did not name a project. Choose a project from the " +
        "selector and try again.",
    });
  });
});
