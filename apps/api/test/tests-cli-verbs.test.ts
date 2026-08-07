import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { createApiKey, type AuthContext, type Role } from "@egma/db";
import { newId } from "@egma/ids";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createEgmaFolder,
  readFolderTests,
  writeTestFile,
  type FolderPaths,
} from "../../cli/src/folder/egma-folder.ts";
import type { Fetch } from "../../cli/src/platform/device-flow.ts";
import type { SignedIn } from "../../cli/src/platform/signed-in.ts";
import { editTest as editTestOnPlatform } from "../../cli/src/platform/tests.ts";
import { pullTests } from "../../cli/src/sync/pull.ts";
import { pushTests } from "../../cli/src/sync/push.ts";
import { hashApiKeySecret } from "../src/auth/api-key.ts";
import { cookiesFrom, createApi, type TestApi } from "./support/api.ts";

/**
 * `pull` and `push` — the real sync code a developer runs — against the real
 * API and a real Postgres.
 *
 * The rest of this suite drives the API directly and asserts what a caller
 * observes. This file asks the other question: whether the client egma actually
 * ships can work against this API with nothing changed but its configuration.
 * It imports the sync module itself rather than restating what it sends, so a
 * client and a server that drift apart fail here rather than in somebody's
 * terminal.
 *
 * Two things stand in for the world outside, and neither hides anything the API
 * does. The transport is the API's own injection rather than a socket, because
 * what is under test is what the two ends say to each other. And the list
 * response is adapted below — the one client-side change this API's unified
 * list envelope still needs, applied here as an adapter so that everything else
 * about pull and push can be proven now rather than after it lands.
 */

let api: TestApi;
let folder: FolderPaths;
let repository: string;

beforeEach(async () => {
  repository = await mkdtemp(path.join(tmpdir(), "egma-sync-"));
  ({ paths: folder } = await createEgmaFolder({ repository }));
});

afterEach(async () => {
  await api?.close();
  await rm(repository, { recursive: true, force: true });
});

/**
 * The CLI's `fetch`, answered by the API in this process.
 *
 * Everything the client sends travels: the method, the path, the query, the
 * bearer header and the JSON body. Everything the API answers travels back: the
 * status and the bytes. Nothing in between is stubbed.
 */
function fetchThrough(app: FastifyInstance): Fetch {
  return (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const address = new URL(
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url,
    );

    const sent = init?.headers;
    const headers: Record<string, string> =
      sent instanceof Headers
        ? Object.fromEntries(sent.entries())
        : ((sent ?? {}) as Record<string, string>);

    const injected = await app.inject({
      method: (init?.method ?? "GET") as "GET",
      url: `${address.pathname}${address.search}`,
      headers,
      ...(init?.body === undefined
        ? {}
        : { payload: String(init.body) }),
    });

    return new Response(injected.body, {
      status: injected.statusCode,
      headers: { "content-type": "application/json" },
    });
  }) as Fetch;
}

/**
 * The client change this API's list envelope is waiting for, as an adapter.
 *
 * Every list in this API answers `{ items, next_cursor }`; the client still
 * reads the older per-resource key. Moving the client is its own piece of work,
 * so it is stood in for here — and only here, for exactly that one field, so
 * that this file proves the rest of pull and push against the API as it is.
 */
function readsTheUnifiedEnvelope(inner: Fetch): Fetch {
  return (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const response = await inner(input as never, init as never);
    const address = String(
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : (input as Request).url,
    );
    if (!new URL(address).pathname.startsWith("/api/tests") || !response.ok) {
      return response;
    }

    const body = (await response.json()) as Record<string, unknown>;
    if (!Array.isArray(body.items)) return Response.json(body, { status: response.status });
    return Response.json(
      { ...body, tests: body.items },
      { status: response.status },
    );
  }) as Fetch;
}

type Person = {
  readonly userId: string;
  readonly organizationId: string;
  readonly projectId: string;
  readonly cookie: string;
};

async function signUp(email: string, organizationName: string): Promise<Person> {
  const created = await api.app.inject({
    method: "POST",
    url: "/api/signup",
    payload: { email, password: "a-long-enough-password", organizationName },
  });
  expect(created.statusCode, created.body).toBe(201);

  const landed = created.json() as {
    userId: string;
    organization: { id: string };
    project: { id: string };
  };
  return {
    userId: landed.userId,
    organizationId: landed.organization.id,
    projectId: landed.project.id,
    cookie: cookiesFrom(created.headers["set-cookie"]),
  };
}

/** What `egma login` leaves on the machine: one instance, and a key for it. */
async function signedInAs(person: Person, role: Role = "admin"): Promise<SignedIn> {
  const secret = `egma_sk_${newId("key")}`;
  const auth: AuthContext = {
    userId: person.userId,
    organizationId: person.organizationId,
    projectId: person.projectId,
    role,
    via: "session",
  };
  await createApiKey(auth, {
    hash: hashApiKeySecret(secret),
    prefix: "egma_sk_",
    displaySuffix: secret.slice(-4),
    name: "a terminal",
    projectId: person.projectId,
  });
  // Any origin does: the transport above answers from this process whatever
  // address it is given, and the client sends the path it would have sent.
  return { url: "http://egma.test", key: secret };
}

const FILE = {
  name: "Reschedules a booked appointment",
  personas: [],
  version: null,
  scenario:
    "Their cleaning is booked for Thursday morning and has to move to any afternoon next week.",
  expectedBehaviors: [
    "verifies who it is speaking to before discussing the booking",
    "confirms the new time back before finishing",
  ],
} as const;

function fileAt(name: string): string {
  return path.join(folder.tests, name);
}

describe("push, against a real instance", () => {
  it("creates the folder's test and writes the version it minted back into the file", async () => {
    api = await createApi("sync_push_create");
    const ada = await signUp("ada@acme.example", "Acme");
    const signedIn = await signedInAs(ada);
    const fetchImpl = readsTheUnifiedEnvelope(fetchThrough(api.app));

    await writeTestFile(fileAt("reschedules.md"), { ...FILE });

    const report = await pushTests({ signedIn, paths: folder, fetchImpl });

    expect(report.turnedAway).toEqual([]);
    expect(report.conflicts).toEqual([]);
    expect(report.tests.map((test) => test.state)).toEqual(["created"]);

    // The file now carries the pin, and the pin is a version this egma issued.
    const [held] = await readFolderTests(folder);
    expect(held?.test.version).toBe(report.tests[0]?.versionId);
    expect(String(held?.test.version)).toMatch(/^tstv_/u);

    // And the platform holds exactly what the file said, with the project's
    // default persona standing in for the file naming nobody.
    const listed = await api.app.inject({
      method: "GET",
      url: "/api/tests",
      headers: { authorization: `Bearer ${signedIn.key}` },
    });
    const items = (listed.json() as { items: Record<string, unknown>[] }).items;
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      name: FILE.name,
      scenario: FILE.scenario,
      expected_behaviors: [...FILE.expectedBehaviors],
    });
    expect((items[0]?.personas as unknown[]).length).toBe(1);
  });

  it("leaves a second push of unchanged files with nothing to do", async () => {
    api = await createApi("sync_push_settled");
    const ada = await signUp("ada@acme.example", "Acme");
    const signedIn = await signedInAs(ada);
    const fetchImpl = readsTheUnifiedEnvelope(fetchThrough(api.app));

    await writeTestFile(fileAt("reschedules.md"), { ...FILE });
    const first = await pushTests({ signedIn, paths: folder, fetchImpl });
    const testId = first.tests[0]?.versionId;

    const again = await pushTests({ signedIn, paths: folder, fetchImpl });

    expect(again.tests.map((test) => test.state)).toEqual(["unchanged"]);
    expect(again.tests[0]?.versionId).toBe(testId);

    const { rows } = await api.database.sql<{ count: string }>(
      "select count(*) as count from test_version",
    );
    expect(Number(rows[0]?.count)).toBe(1);
  });

  it("uploads an edited file as the next version, and the file follows it", async () => {
    api = await createApi("sync_push_edit");
    const ada = await signUp("ada@acme.example", "Acme");
    const signedIn = await signedInAs(ada);
    const fetchImpl = readsTheUnifiedEnvelope(fetchThrough(api.app));

    await writeTestFile(fileAt("reschedules.md"), { ...FILE });
    const first = await pushTests({ signedIn, paths: folder, fetchImpl });
    const [held] = await readFolderTests(folder);
    if (held === undefined) throw new Error("the push wrote no file");

    await writeTestFile(held.file, {
      ...held.test,
      scenario: "They want the Wednesday slot instead.",
    });
    const second = await pushTests({ signedIn, paths: folder, fetchImpl });

    expect(second.conflicts).toEqual([]);
    expect(second.tests.map((test) => test.state)).toEqual(["updated"]);
    expect(second.tests[0]?.versionId).not.toBe(first.tests[0]?.versionId);

    const [after] = await readFolderTests(folder);
    expect(after?.test.version).toBe(second.tests[0]?.versionId);
    expect(after?.test.scenario).toBe("They want the Wednesday slot instead.");
  });

  it("refuses the whole push, uploading nothing, when the platform has moved", async () => {
    api = await createApi("sync_push_moved");
    const ada = await signUp("ada@acme.example", "Acme");
    const signedIn = await signedInAs(ada);
    const fetchImpl = readsTheUnifiedEnvelope(fetchThrough(api.app));

    await writeTestFile(fileAt("reschedules.md"), { ...FILE });
    await pushTests({ signedIn, paths: folder, fetchImpl });
    const [held] = await readFolderTests(folder);
    if (held === undefined) throw new Error("the push wrote no file");

    // The teammate in the dashboard, editing while this developer works.
    const listed = await api.app.inject({
      method: "GET",
      url: "/api/tests",
      headers: { authorization: `Bearer ${signedIn.key}` },
    });
    const [onPlatform] = (
      listed.json() as { items: { id: string; version_id: string }[] }
    ).items;
    const moved = await api.app.inject({
      method: "PATCH",
      url: `/api/tests/${String(onPlatform?.id)}`,
      headers: { authorization: `Bearer ${signedIn.key}` },
      payload: {
        scenario: "The dashboard's own words.",
        expected_version_id: onPlatform?.version_id,
      },
    });
    expect(moved.statusCode, moved.body).toBe(200);

    // And only now does the developer edit their file and push.
    await writeTestFile(held.file, {
      ...held.test,
      scenario: "The file's own words.",
    });
    const refused = await pushTests({ signedIn, paths: folder, fetchImpl });

    expect(refused.uploadedNothing).toBe(true);
    expect(refused.tests).toEqual([]);
    expect(refused.conflicts).toEqual([
      { name: FILE.name, shown: held.shown, reason: "moved" },
    ]);

    // Nothing was merged and nothing was lost: the dashboard's version stands,
    // and the developer's file is still theirs to reconcile.
    const { rows } = await api.database.sql<{ count: string }>(
      "select count(*) as count from test_version",
    );
    expect(Number(rows[0]?.count)).toBe(2);
  });

  it("refuses a file pinned to a version this egma never issued, uploading nothing", async () => {
    api = await createApi("sync_push_unknown_pin");
    const ada = await signUp("ada@acme.example", "Acme");
    const signedIn = await signedInAs(ada);
    const fetchImpl = readsTheUnifiedEnvelope(fetchThrough(api.app));

    await writeTestFile(fileAt("reschedules.md"), {
      ...FILE,
      version: newId("tstv"),
    });

    const report = await pushTests({ signedIn, paths: folder, fetchImpl });

    expect(report.uploadedNothing).toBe(true);
    expect(report.conflicts).toEqual([
      {
        name: FILE.name,
        shown: "egma/tests/reschedules.md",
        reason: "unknown",
      },
    ]);
  });

  it("reads the version conflict the platform answers with, and names the test", async () => {
    api = await createApi("sync_push_late_conflict");
    const ada = await signUp("ada@acme.example", "Acme");
    const signedIn = await signedInAs(ada);
    const fetchImpl = readsTheUnifiedEnvelope(fetchThrough(api.app));

    await writeTestFile(fileAt("reschedules.md"), { ...FILE });
    await pushTests({ signedIn, paths: folder, fetchImpl });

    const listed = await api.app.inject({
      method: "GET",
      url: "/api/tests",
      headers: { authorization: `Bearer ${signedIn.key}` },
    });
    const [onPlatform] = (
      listed.json() as { items: { id: string; version_id: string }[] }
    ).items;
    if (onPlatform === undefined) throw new Error("the push wrote no test");

    const moved = await api.app.inject({
      method: "PATCH",
      url: `/api/tests/${onPlatform.id}`,
      headers: { authorization: `Bearer ${signedIn.key}` },
      payload: {
        scenario: "The dashboard's own words.",
        expected_version_id: onPlatform.version_id,
      },
    });
    const current = (moved.json() as { version_id: string }).version_id;

    // The write the platform's own door refuses — what a second writer arriving
    // after the push's own check looks like from the client's side.
    const answer = await editTestOnPlatform(
      signedIn,
      onPlatform.id,
      onPlatform.version_id,
      {
        name: FILE.name,
        scenario: "The file's own words.",
        expectedBehaviors: [...FILE.expectedBehaviors],
        personas: [],
      },
      fetchImpl,
    );

    expect(answer).toEqual({
      kind: "moved",
      testName: FILE.name,
      currentVersionId: current,
    });
  });

  it("names a test the platform turned away, in the platform's own words", async () => {
    api = await createApi("sync_push_turned_away");
    const ada = await signUp("ada@acme.example", "Acme");
    const signedIn = await signedInAs(ada);
    const fetchImpl = readsTheUnifiedEnvelope(fetchThrough(api.app));

    await writeTestFile(fileAt("reschedules.md"), {
      ...FILE,
      personas: ["Nobody At All"],
    });

    const report = await pushTests({ signedIn, paths: folder, fetchImpl });

    expect(report.tests).toEqual([]);
    expect(report.turnedAway).toEqual([
      {
        name: FILE.name,
        shown: "egma/tests/reschedules.md",
        reason:
          'egma has no persona called "Nobody At All" in this project. Name a persona this project already has, or name none and egma takes the project\'s default.',
      },
    ]);
  });
});

describe("pull, against a real instance", () => {
  it("writes the platform's tests into an empty folder", async () => {
    api = await createApi("sync_pull_writes");
    const ada = await signUp("ada@acme.example", "Acme");
    const signedIn = await signedInAs(ada);
    const fetchImpl = readsTheUnifiedEnvelope(fetchThrough(api.app));

    const authored = await api.app.inject({
      method: "POST",
      url: "/api/tests",
      headers: { authorization: `Bearer ${signedIn.key}` },
      payload: {
        name: FILE.name,
        scenario: FILE.scenario,
        expected_behaviors: [...FILE.expectedBehaviors],
      },
    });
    expect(authored.statusCode, authored.body).toBe(201);
    const onPlatform = authored.json() as {
      version_id: string;
      personas: { name: string }[];
    };

    const report = await pullTests({ signedIn, paths: folder, fetchImpl });

    expect(report.kept).toEqual([]);
    expect(report.tests.map((test) => test.state)).toEqual(["written"]);

    const [written] = await readFolderTests(folder);
    expect(written?.test.name).toBe(FILE.name);
    expect(written?.test.scenario).toBe(FILE.scenario);
    expect(written?.test.version).toBe(onPlatform.version_id);
    // Personas cross the wire by name, so the file a team reads holds names.
    expect(written?.test.personas).toEqual(
      onPlatform.personas.map((persona) => persona.name),
    );
  });

  it("finds nothing to do straight after a push", async () => {
    api = await createApi("sync_pull_settled");
    const ada = await signUp("ada@acme.example", "Acme");
    const signedIn = await signedInAs(ada);
    const fetchImpl = readsTheUnifiedEnvelope(fetchThrough(api.app));

    await writeTestFile(fileAt("reschedules.md"), { ...FILE });
    await pushTests({ signedIn, paths: folder, fetchImpl });

    const report = await pullTests({ signedIn, paths: folder, fetchImpl });

    expect(report.tests.map((test) => test.state)).toEqual(["unchanged"]);
  });

  it("follows a stale pin to the test it belongs to and updates that file", async () => {
    api = await createApi("sync_pull_stale_pin");
    const ada = await signUp("ada@acme.example", "Acme");
    const signedIn = await signedInAs(ada);
    const fetchImpl = readsTheUnifiedEnvelope(fetchThrough(api.app));

    await writeTestFile(fileAt("reschedules.md"), { ...FILE });
    await pushTests({ signedIn, paths: folder, fetchImpl });
    const [held] = await readFolderTests(folder);

    const listed = await api.app.inject({
      method: "GET",
      url: "/api/tests",
      headers: { authorization: `Bearer ${signedIn.key}` },
    });
    const [onPlatform] = (
      listed.json() as { items: { id: string; version_id: string }[] }
    ).items;
    await api.app.inject({
      method: "PATCH",
      url: `/api/tests/${String(onPlatform?.id)}`,
      headers: { authorization: `Bearer ${signedIn.key}` },
      payload: {
        scenario: "The dashboard's own words.",
        expected_version_id: onPlatform?.version_id,
      },
    });

    const report = await pullTests({ signedIn, paths: folder, fetchImpl });

    expect(report.tests.map((test) => test.shown)).toEqual([held?.shown]);
    const [after] = await readFolderTests(folder);
    expect(after?.file).toBe(held?.file);
    expect(after?.test.scenario).toBe("The dashboard's own words.");
    expect(after?.test.version).not.toBe(held?.test.version);
  });
});
