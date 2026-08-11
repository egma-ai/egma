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
import {
  createEgmaFolder,
  folderPathsIn,
  updateConfig,
  writeTestFile,
} from "../src/folder/egma-folder.ts";
import { CLI_ENTRY, makeWorkspace } from "./support/workspace.ts";

const run = promisify(execFile);

type PublicIdentity = { readonly instance_id: string; readonly origin: string };

async function identityOf(instance: Instance): Promise<PublicIdentity> {
  const response = await fetch(`${instance.origin}/api/platform`);
  expect(response.status).toBe(200);
  return (await response.json()) as PublicIdentity;
}

type Ended = { readonly code: number; readonly stdout: string; readonly stderr: string };

/** The built CLI, run the way a developer runs it, never throwing on a refusal. */
async function egma(
  args: readonly string[],
  where: { readonly cwd: string; readonly env: NodeJS.ProcessEnv },
): Promise<Ended> {
  return run(process.execPath, [CLI_ENTRY, ...args], where).then(
    ({ stdout, stderr }) => ({ code: 0, stdout, stderr }),
    (error: { code?: number; stdout?: string; stderr?: string }) => ({
      code: error.code ?? 1,
      stdout: error.stdout ?? "",
      stderr: error.stderr ?? "",
    }),
  );
}

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

/**
 * Real-process acceptance for the safety rule.
 *
 * Both platforms use the real API application and their own real Postgres
 * database. The built CLI is a separate process. Fixture tests cover branches;
 * this proves that an identifier issued by one actual platform never reaches a
 * second actual platform.
 *
 * The repository is bound to the address the second platform answers at while
 * naming the first platform's instance, which is what a developer's committed
 * file really looks like after a colleague rebuilt the local stack: same
 * address, new database, new platform. It is also the one thing an origin alone
 * cannot catch, and therefore the reason the instance identifier is committed
 * beside it.
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

    // The committed file: the first platform's resources and instance, at the
    // address the second platform now answers at.
    await createEgmaFolder({
      repository: workspace.dir,
      config: {
        platform: {
          origin: secondIdentity.origin,
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
      mockTools: [],
    });

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

    // No flag: the committed binding chooses the address, and what answers
    // there is not the platform that issued anything in this folder.
    const env = workspace.env();
    expect(env.EGMA_URL).toBeUndefined();
    const result = await egma(["run", "--cwd", workspace.dir, "--no-follow"], {
      cwd: workspace.dir,
      env,
    });

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

    // And the cheaper refusal in front of that one: a repository bound to one
    // address, pointed at another on the command line, stops without asking
    // anybody anything at all.
    observedBySecond.length = 0;
    await updateConfig(folderPathsIn(workspace.dir).config, {
      platform: {
        origin: firstIdentity.origin,
        instance: firstIdentity.instance_id,
      },
    });
    const elsewhere = await egma(
      ["run", "--url", second.origin, "--cwd", workspace.dir, "--no-follow"],
      { cwd: workspace.dir, env },
    );

    expect(elsewhere.code).toBe(4);
    expect(elsewhere.stdout).toContain("status: refused");
    expect(elsewhere.stderr).toContain(firstIdentity.origin);
    expect(elsewhere.stderr).toContain(secondIdentity.origin);
    expect(elsewhere.stderr).toContain("No repository identifiers were sent");
    expect(observedBySecond).toEqual([]);
  } finally {
    await first?.close();
    await second?.close();
    await workspace.remove();
  }
});

/**
 * The other half of the safety rule, and the one a self-hoster meets by
 * accident: the platform this repository is bound to is simply not running.
 *
 * The tempting behaviour is to carry on with Egma Cloud, and it is the one
 * failure this ticket exists to make impossible — a repository full of
 * local-platform identifiers would start posting them at a platform that has
 * never seen them. So the command stops, names the platform it wanted, and says
 * what to do. A second real platform is left running throughout, standing in
 * for every platform this machine could have wandered to, and it must see
 * nothing at all.
 */
it("refuses when the bound real platform is down, and reaches no other platform", async () => {
  const workspace = await makeWorkspace();
  let bound: Instance | undefined;
  let stillRunning: Instance | undefined;

  try {
    bound = await startInstance("cli_bound_platform_down", { web: false });
    const boundIdentity = await identityOf(bound);
    const boundOrigin = bound.origin;
    const customer = await signUp(bound.api, "down@acme.example", "Acme Down");

    const registered = await bound.api.inject({
      method: "POST",
      url: "/api/agents",
      headers: { authorization: `Bearer ${customer.secret}` },
      payload: {
        name: "Real receptionist",
        connection: {
          name: "real-retell-down",
          type: "retell",
          modality: "chat",
          config: { retellAgentId: "synthetic-agent-on-the-bound-platform" },
          credentials: { apiKey: "synthetic-key-used-only-by-this-test" },
        },
      },
    });
    expect(registered.statusCode, registered.body).toBe(201);
    const resources = registered.json() as {
      agent: { id: string; name: string };
      connection: { id: string; name: string };
    };

    const createdTest = await bound.api.inject({
      method: "POST",
      url: "/api/tests",
      headers: { authorization: `Bearer ${customer.secret}` },
      payload: {
        name: "Real unavailable-platform test",
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
        platform: { origin: boundOrigin, instance: boundIdentity.instance_id },
        agent: { name: resources.agent.name, id: resources.agent.id },
        connection: {
          name: resources.connection.name,
          id: resources.connection.id,
        },
        suite: { name: "down-suite", id: null },
      },
    });
    await writeTestFile(path.join(workspace.dir, "egma", "tests", "unavailable.md"), {
      name: "Real unavailable-platform test",
      personas: [],
      version: testResource.version_id,
      scenario: "The persona asks to move an appointment.",
      expectedBehaviors: ["The agent confirms the new time."],
      mockTools: [],
    });
    const repositoryIds = [
      resources.agent.id,
      resources.connection.id,
      testResource.id,
      testResource.version_id,
    ];

    await bound.close();
    bound = undefined;

    const observed: ObservedInstanceRequest[] = [];
    stillRunning = await startInstance("cli_bound_platform_down_other", {
      web: false,
      observeRequest: (request) => observed.push(request),
    });
    // A freed port can be handed out again. If that happened the bound origin
    // would be answering after all, so say so here rather than let the run
    // prove a different thing than it claims to.
    expect(stillRunning.origin).not.toBe(boundOrigin);

    // The machine holds a key for the platform that is up. It is still not this
    // repository's platform, and a held key is not a target.
    const otherCustomer = await signUp(
      stillRunning.api,
      "elsewhere@beta.example",
      "Beta Elsewhere",
    );
    await workspace.signIn(stillRunning.origin, otherCustomer.secret);
    observed.length = 0;

    // No flag and no environment URL: this is the repository binding alone.
    const env = workspace.env();
    expect(env.EGMA_URL).toBeUndefined();
    const result = await egma(["run", "--cwd", workspace.dir, "--no-follow"], {
      cwd: workspace.dir,
      env,
    });

    expect(result.code).toBe(4);
    expect(result.stdout).toContain("status: unreachable");
    expect(result.stderr).toContain(boundIdentity.instance_id);
    expect(result.stderr).toContain(boundOrigin);
    expect(result.stderr).toContain("Egma Cloud was not used");
    expect(result.stderr).toContain("no repository identifiers were sent");

    // The platform that is up saw nothing: not a request carrying an
    // identifier, and not a request at all.
    expect(observed).toEqual([]);
    const shown = result.stdout + result.stderr;
    for (const identifier of repositoryIds) expect(shown).not.toContain(identifier);
    const stored = await stillRunning.database.sql<{ count: string }>(
      "select count(*) from run",
    );
    expect(stored.rows).toEqual([{ count: "0" }]);
  } finally {
    await bound?.close();
    await stillRunning?.close();
    await workspace.remove();
  }
});
