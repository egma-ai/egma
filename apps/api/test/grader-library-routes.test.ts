import { GRADER_LIBRARY_CATALOG } from "@egma/db";
import { afterEach, describe, expect, it } from "vitest";

import { createApi, type TestApi } from "./support/api.ts";
import {
  colleagueOf,
  projectKeyFor,
  request as ask,
  signUp,
  type Answer,
} from "./support/traces.ts";

/**
 * The grader library route, over real HTTP against real Postgres.
 *
 * One verb, and the shape of the answer is the whole contract: what a developer
 * sees on the Library screen is what a customer's own integration sees, because
 * the screen is drawn from this endpoint rather than from a private one built
 * for it.
 *
 * The fact worth defending here is **owner**. It is the only field on the
 * answer that nothing stores — it is derived from who the entry belongs to, and
 * an entry belonging to nobody is egma's. A door that computed it any other way
 * could show a team's own grader as egma's, or egma's as theirs, and neither
 * would fail anything else.
 */

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
  readonly type: string;
  readonly owner: string;
  readonly projectId: string | null;
  readonly prompt: string | null;
  readonly params: readonly { readonly name: string }[];
};

function itemsOf(answer: Answer): readonly Listed[] {
  return answer.body.graderLibraryEntries as readonly Listed[];
}

describe("reading the grader library", () => {
  it("answers egma's own graders, owned by egma", async () => {
    api = await createApi("grader_library_list");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");
    const key = await projectKeyFor(api.app, ada);

    const listed = await request("/v1/grader-library", key);

    expect(listed.statusCode, JSON.stringify(listed.body)).toBe(200);
    expect(itemsOf(listed).map((entry) => entry.name).sort()).toEqual(
      GRADER_LIBRARY_CATALOG.map((entry) => entry.name).sort(),
    );
    for (const entry of itemsOf(listed)) {
      // Derived from tenancy, and the tenancy of egma's own entries is nothing
      // at all — which is why there is no project on them either.
      expect(entry.owner, entry.name).toBe("egma");
      expect(entry.projectId, entry.name).toBeNull();
    }
    expect(listed.body.nextPageToken).toBeNull();
  });

  it("hands the judge prompt and the Use form's parameters over with them", async () => {
    api = await createApi("grader_library_shape");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");
    const key = await projectKeyFor(api.app, ada);

    const items = itemsOf(await request("/v1/grader-library", key));
    const behaviors = items.find((entry) => entry.name === "expected_behaviors");
    const latency = items.find((entry) => entry.name === "latency");

    // The prompt is on the answer because the whole point of the entry
    // carrying it is that a developer can read the words their conversations
    // are judged by.
    expect(behaviors?.type).toBe("llm_as_judge");
    expect(behaviors?.prompt ?? "").toContain("Decide only the criterion");
    // And nothing is asked at Use time: its assertions are the test's own
    // sentences.
    expect(behaviors?.params).toEqual([]);

    // Latency is computed rather than judged, and its form has two controls.
    expect(latency?.type).toBe("code");
    expect(latency?.prompt).toBeNull();
    expect(latency?.params.map((one) => one.name)).toEqual(["metric", "bound"]);
  });

  it("is a read every role holds, viewers included", async () => {
    api = await createApi("grader_library_roles");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");
    const grace = await colleagueOf(api.app, ada, "grace@acme.example", "viewer");

    const listed = await request("/v1/grader-library", grace.secret);

    // The shelf is what a project is judged by. Somebody who may read a run's
    // results and not change anything still has to be able to see it.
    expect(listed.statusCode, JSON.stringify(listed.body)).toBe(200);
    expect(itemsOf(listed)).toHaveLength(GRADER_LIBRARY_CATALOG.length);
  });

  it("refuses a cursor it never issued, and says what to send instead", async () => {
    api = await createApi("grader_library_cursor");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");
    const key = await projectKeyFor(api.app, ada);

    const listed = await request("/v1/grader-library?pageToken=nonsense", key);

    expect(listed.statusCode).toBe(400);
    expect(String(listed.body.message)).toContain("nextPageToken");
  });

  it("shows each customer the same shelf, because it is egma's", async () => {
    api = await createApi("grader_library_tenants");
    const ada = await signUp(api.app, "ada@acme.example", "Acme");
    const grace = await signUp(api.app, "grace@globex.example", "Globex");

    const theirs = itemsOf(
      await request("/v1/grader-library", await projectKeyFor(api.app, ada)),
    );
    const others = itemsOf(
      await request("/v1/grader-library", await projectKeyFor(api.app, grace)),
    );

    // The same identifiers on both, which is what "egma ships this" means: one
    // row, on every customer's shelf, upgraded by one release.
    expect(theirs.map((entry) => entry.id).sort()).toEqual(
      others.map((entry) => entry.id).sort(),
    );
  });
});
