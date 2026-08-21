/**
 * The bare command's last resort, against a real platform.
 *
 * `hosted-default-process.test.ts` drives the built CLI against the fixture
 * platform, and that is where the branches of this behaviour are covered.
 * Fixture tests cover branches; this proves the one thing they cannot — that a
 * repository naming no platform, in a shell naming none either, reaches an
 * actual egma platform with its own database and leaves real rows in it.
 *
 * That rule belongs to the platform-binding effort and applies here for the
 * same reason: the step being added is the one nobody typed, so the only honest
 * proof is the whole real thing, run the way a developer runs it.
 *
 * The address it reaches is a local instance, put in the built-in address's
 * place through `EGMA_TEST_DEFAULT_URL`. Nothing here dials hosted egma.
 */

import { spawn } from "node:child_process";
import path from "node:path";
import process from "node:process";

import { expect, it, vi } from "vitest";

import { startInstance, type Instance } from "../../api/test/support/instance.ts";
import { signUp } from "../../api/test/support/traces.ts";
import { folderPathsIn, readConfig, writeTestFile } from "../src/folder/egma-folder.ts";
import { CLI_ENTRY, makeWorkspace } from "./support/workspace.ts";
import { aTestFile, blocking } from "./support/test-file.ts";

type Ended = { readonly code: number; readonly stdout: string; readonly stderr: string };

/** The built CLI, as its own process, ended rather than thrown. */
async function egma(
  args: readonly string[],
  where: { readonly cwd: string; readonly env: NodeJS.ProcessEnv },
): Promise<Ended> {
  const child = spawn(process.execPath, [CLI_ENTRY, ...args], where);
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  child.stdin.end();
  const code = await new Promise<number>((resolve) => {
    child.on("close", (value) => resolve(value ?? 1));
  });
  return { stdout, stderr, code };
}

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

it("reaches a real local platform with nothing configured anywhere", async () => {
  const workspace = await makeWorkspace();
  let platform: Instance | undefined;

  try {
    platform = await startInstance("cli_hosted_default", { web: false });
    const customer = await signUp(platform.api, "unbound@acme.example", "Acme Unbound");
    // A key this machine holds. It is not what selects a platform — the
    // built-in address is — and it is only what lets the command do its work
    // once it has got there.
    await workspace.signIn(platform.origin, customer.secret);

    // Nothing names a platform: no `--url` in any command below, which is the
    // one way to name one, and no egma folder in the repository yet.
    const env = workspace.env({ EGMA_TEST_DEFAULT_URL: platform.origin });
    const paths = folderPathsIn(workspace.dir);

    // A test always applies to at least one active agent, so the project needs
    // one before a folder can push anything into it. This folder names no
    // platform, so it may hold no platform identifier either — which is the
    // rule this whole test is about — and a push from it therefore names no
    // agent and is given the project's active ones, exactly as the upgrade gave
    // installed tests theirs. Registering one here is what makes that set
    // non-empty; `egma connect` is what does it for a person.
    const registered = await platform.api.inject({
      method: "POST",
      url: "/v1/agents",
      headers: { authorization: `Bearer ${customer.secret}` },
      payload: { name: "Receptionist" },
    });
    expect(registered.statusCode, registered.body).toBe(201);

    const started = await egma(
      ["init", "--agent", "Receptionist", "--connection", "retell-1", "--cwd", workspace.dir],
      { cwd: workspace.dir, env },
    );
    expect(started.code, started.stderr).toBe(0);
    // What `egma init` writes: names, and no platform of any kind.
    expect((await readConfig(paths.config)).platform).toBeNull();

    await writeTestFile(path.join(paths.tests, "moves-appointment.md"), aTestFile({
      name: "moves-appointment",
      personas: [],
      version: null,
      scenario: "The persona needs a different appointment time.",
      expectedBehaviors: blocking("The agent confirms the new time."),
      mockTools: [],
    }));

    const pushed = await egma(["push", "--cwd", workspace.dir], {
      cwd: workspace.dir,
      env,
    });

    expect(pushed.code, pushed.stderr).toBe(0);
    expect(pushed.stdout).toContain("status: pushed");
    // The address it went to, said back to the developer, and it is the one
    // nobody typed.
    expect(pushed.stdout).toContain(`url: ${platform.origin}`);

    // And it really arrived: the row is in that platform's own database. A
    // fixture and a test can agree with each other about a request and prove
    // neither, which is why this half is here.
    const stored = await platform.database.sql<{ name: string }>("select name from test");
    expect(stored.rows.map((row) => row.name)).toEqual(["moves-appointment"]);

    // `push` writes no binding; committing one is `connect`'s job.
    expect((await readConfig(paths.config)).platform).toBeNull();
  } finally {
    await platform?.close();
    await workspace.remove();
  }
});
