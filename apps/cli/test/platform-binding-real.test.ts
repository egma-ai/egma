import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

import { expect, it, vi } from "vitest";

import {
  startInstance,
  type Instance,
  type ObservedInstanceRequest,
} from "../../api/test/support/instance.ts";
import { signUp } from "../../api/test/support/traces.ts";
import { createEgmaFolder, writeTestFile } from "../src/folder/egma-folder.ts";
import { CLI_ENTRY, makeWorkspace } from "./support/workspace.ts";

const run = promisify(execFile);

type PublicIdentity = { readonly instance_id: string; readonly origin: string };

async function identityOf(instance: Instance): Promise<PublicIdentity> {
  const response = await fetch(`${instance.origin}/api/platform`);
  expect(response.status).toBe(200);
  return (await response.json()) as PublicIdentity;
}

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

/**
 * Real-process acceptance for the safety rule.
 *
 * Both platforms use the real API application and their own real Postgres
 * database. The built CLI is a separate process. Fixture tests cover branches;
 * this proves that an identifier bound to one actual platform never reaches a
 * second actual platform.
 */
it("refuses a repository bound to another real local platform before sending its identifiers", async () => {
  const workspace = await makeWorkspace();
  let first: Instance | undefined;
  let second: Instance | undefined;

  try {
    first = await startInstance("cli_platform_binding_first", { web: false });
    const firstIdentity = await identityOf(first);
    const customer = await signUp(first.api, "binding@acme.example", "Acme Binding");
    const registered = await first.api.inject({
      method: "POST",
      url: "/api/agents",
      headers: { authorization: `Bearer ${customer.secret}` },
      payload: {
        name: "Real receptionist",
        connection: {
          name: "real-retell-1",
          type: "retell",
          modality: "chat",
          config: { retellAgentId: "synthetic-agent-on-platform-a" },
          credentials: { apiKey: "synthetic-key-used-only-by-this-test" },
        },
      },
    });
    expect(registered.statusCode, registered.body).toBe(201);
    const resources = registered.json() as {
      agent: { id: string; name: string };
      connection: { id: string; name: string };
    };

    const createdTest = await first.api.inject({
      method: "POST",
      url: "/api/tests",
      headers: { authorization: `Bearer ${customer.secret}` },
      payload: {
        name: "Real boundary test",
        scenario: "The persona asks to move an appointment.",
        expected_behaviors: ["The agent confirms the new time."],
        personas: [],
      },
    });
    expect(createdTest.statusCode, createdTest.body).toBe(201);
    const testResource = createdTest.json() as { id: string; version_id: string };

    await createEgmaFolder({
      repository: workspace.dir,
      config: {
        platform: {
          origin: firstIdentity.origin,
          instance: firstIdentity.instance_id,
        },
        agent: { name: resources.agent.name, id: resources.agent.id },
        connection: {
          name: resources.connection.name,
          id: resources.connection.id,
        },
        suite: { name: "first-suite", id: null },
      },
    });
    await writeTestFile(path.join(workspace.dir, "egma", "tests", "boundary.md"), {
      name: "Real boundary test",
      personas: [],
      version: testResource.version_id,
      scenario: "The persona asks to move an appointment.",
      expectedBehaviors: ["The agent confirms the new time."],
    });
    const repositoryIds = [
      resources.agent.id,
      resources.connection.id,
      testResource.id,
      testResource.version_id,
    ];

    await first.close();
    first = undefined;

    const observedBySecond: ObservedInstanceRequest[] = [];
    second = await startInstance("cli_platform_binding_second", {
      web: false,
      observeRequest: (request) => observedBySecond.push(request),
    });
    const secondIdentity = await identityOf(second);
    expect(secondIdentity.instance_id).not.toBe(firstIdentity.instance_id);

    // Prove the observer is in front of authentication. Platform A's key is
    // unknown on B, so the old preHandler observer missed this request when B
    // answered 401. The raw observer must see it, body included.
    const observerProbe = await fetch(`${second.origin}/api/runs`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${customer.secret}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ probe: "visible-before-authentication" }),
    });
    expect(observerProbe.status).toBe(401);
    expect(
      observedBySecond.some(
        (request) =>
          request.method === "POST" &&
          request.url === "/api/runs" &&
          request.rawBody.includes("visible-before-authentication"),
      ),
    ).toBe(true);
    observedBySecond.length = 0;

    // Put A's key in the exact credential slot a broken command would read for
    // B. Correct code refuses on identity before it reads this slot. If that
    // fence regresses, the run reaches B with A's key and repository ids, and
    // the raw request assertions below fail even though B answers 401.
    await workspace.signIn(second.origin, customer.secret);

    // One public read belongs to the test. The other public read below belongs
    // to the CLI process. Any command request at all would make this list fail,
    // including one B rejects before parsing A's identifiers.
    await identityOf(second);

    const result = await run(
      process.execPath,
      [CLI_ENTRY, "run", "--url", second.origin, "--cwd", workspace.dir, "--no-follow"],
      { cwd: workspace.dir, env: workspace.env() },
    ).then(
      ({ stdout, stderr }) => ({ code: 0, stdout, stderr }),
      (error: { code?: number; stdout?: string; stderr?: string }) => ({
        code: error.code ?? 1,
        stdout: error.stdout ?? "",
        stderr: error.stderr ?? "",
      }),
    );

    expect(result.code).toBe(4);
    expect(result.stdout).toContain("status: refused");
    expect(result.stdout).toContain("No repository identifiers were sent");
    expect(result.stderr).toContain(firstIdentity.instance_id);
    expect(result.stderr).toContain(secondIdentity.instance_id);
    expect(result.stderr).toContain("No repository identifiers were sent");

    const identifierBearing = observedBySecond.filter((request) => {
      const shown = JSON.stringify(request);
      return repositoryIds.some((identifier) => shown.includes(identifier));
    });
    expect(identifierBearing).toEqual([]);
    expect(
      observedBySecond
        .filter((request) => request.url.startsWith("/api/"))
        .map((request) => `${request.method} ${request.url}`),
    ).toEqual(["GET /api/platform", "GET /api/platform"]);

    const stored = await second.database.sql<{ count: string }>("select count(*) from run");
    expect(stored.rows).toEqual([{ count: "0" }]);
  } finally {
    await first?.close();
    await second?.close();
    await workspace.remove();
  }
});
