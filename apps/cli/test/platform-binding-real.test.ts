import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { expect, it, vi } from "vitest";

import { startInstance, type Instance } from "../../api/test/support/instance.ts";
import { createEgmaFolder } from "../src/folder/egma-folder.ts";
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

    await createEgmaFolder({
      repository: workspace.dir,
      config: {
        platform: {
          origin: firstIdentity.origin,
          instance: firstIdentity.instance_id,
        },
        agent: { name: "receptionist", id: "agt_01K3XQ7M4E8YB2FVN0H9TZQWER" },
        connection: { name: "phone-1", id: "con_01K3XQ7M4E8YB2FVN0H9TZQWES" },
        suite: { name: "first-suite", id: null },
      },
    });

    await first.close();
    first = undefined;

    second = await startInstance("cli_platform_binding_second", { web: false });
    const secondIdentity = await identityOf(second);
    expect(secondIdentity.instance_id).not.toBe(firstIdentity.instance_id);

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

    const stored = await second.database.sql<{ count: string }>("select count(*) from run");
    expect(stored.rows).toEqual([{ count: "0" }]);
  } finally {
    await first?.close();
    await second?.close();
    await workspace.remove();
  }
});
