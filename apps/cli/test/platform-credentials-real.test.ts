/**
 * Two real platforms, two real logins, one machine.
 *
 * A developer who self-hosts and also uses hosted egma signs in to both from the
 * same laptop. The promise is that the second login does not sign them out of
 * the first, and that the key each platform minted is only ever offered back to
 * that platform. Both halves are proved here against real API processes with
 * their own databases, driving the real `egma login` as a separate process
 * through the real device flow — a fixture could agree with the reader about
 * the file format and prove neither.
 */

import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import process from "node:process";

import { expect, it, vi } from "vitest";

import { startInstance, type Instance } from "../../api/test/support/instance.ts";
import { signUp, type Customer } from "../../api/test/support/traces.ts";
import { readCredentials } from "../src/platform/credentials.ts";
import { DEVICE_CLIENT_ID } from "../src/platform/device-flow.ts";
import { CLI_ENTRY, makeWorkspace, type Workspace } from "./support/workspace.ts";

vi.setConfig({ testTimeout: 180_000, hookTimeout: 180_000 });

type Ended = { readonly code: number; readonly stdout: string; readonly stderr: string };

/**
 * Sign in for real: the CLI asks for a code, somebody approves it where they
 * are signed in, and the CLI collects the key its own polling earned.
 *
 * The approval is done through the platform's own endpoints rather than a
 * browser because what is under test here is the file the CLI writes, not the
 * page a person clicks. `browser.test.ts` owns the page.
 */
async function logInThrough(
  instance: Instance,
  customer: Customer,
  workspace: Workspace,
): Promise<Ended> {
  const child = spawn(
    process.execPath,
    [CLI_ENTRY, "login", "--url", instance.origin],
    { cwd: workspace.dir, env: workspace.env() },
  );
  child.stdin.end();

  let stdout = "";
  let stderr = "";
  let approving: Promise<void> | undefined;
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
    const code = /^code: (?<code>.+)$/mu.exec(stdout)?.groups?.code;
    if (code === undefined || approving !== undefined) return;
    approving = approve(instance, customer, code.trim());
  });

  const code = await new Promise<number>((resolve) => {
    child.on("close", (value) => resolve(value ?? 1));
  });
  await approving;
  return { code, stdout, stderr };
}

async function approve(
  instance: Instance,
  customer: Customer,
  userCode: string,
): Promise<void> {
  const looked = await instance.api.inject({
    method: "GET",
    url: `/api/device/authorization?user_code=${encodeURIComponent(userCode)}`,
    headers: { cookie: customer.cookie },
  });
  expect(looked.statusCode, looked.body).toBe(200);
  const projectId = (looked.json() as { projects: { id: string }[] }).projects[0]?.id;

  const approved = await instance.api.inject({
    method: "POST",
    url: "/api/device/approve",
    headers: { cookie: customer.cookie },
    payload: { user_code: userCode, project_id: projectId },
  });
  expect(approved.statusCode, approved.body).toBe(200);
}

/** Whether this platform accepts this key, asked the way every command asks. */
async function keyWorks(instance: Instance, key: string): Promise<boolean> {
  const asked = await instance.api.inject({
    method: "GET",
    url: "/v1/projects",
    headers: { authorization: `Bearer ${key}` },
  });
  return asked.statusCode === 200;
}

/** The real provider is still used; only its test platform's pace is zero. */
async function expectImmediatePolling(instance: Instance): Promise<void> {
  const started = await instance.api.inject({
    method: "POST",
    url: "/api/device/code",
    payload: { client_id: DEVICE_CLIENT_ID },
  });
  expect(started.statusCode, started.body).toBe(200);
  expect(started.json()).toMatchObject({ interval: 0 });
}

it("keeps one key per platform when a machine signs in to two of them", async () => {
  const workspace = await makeWorkspace();
  let first: Instance | undefined;
  let second: Instance | undefined;

  try {
    first = await startInstance("cli_two_platform_credentials_first", {
      web: false,
      deviceAuthorizationInterval: "0s",
    });
    await expectImmediatePolling(first);
    const firstOrigin = first.origin;
    const onFirst = await signUp(first.api, "two-platforms@acme.example", "Acme First");

    const firstLogin = await logInThrough(first, onFirst, workspace);
    expect(firstLogin.code, firstLogin.stderr).toBe(0);
    expect(firstLogin.stdout).toContain("status: stored");

    const heldForFirst = await readCredentials(workspace.credentialsFile, firstOrigin);
    expect(heldForFirst?.url).toBe(firstOrigin);
    expect(heldForFirst?.key).toMatch(/^egma_sk_/u);
    expect(await keyWorks(first, heldForFirst?.key ?? "")).toBe(true);

    // One at a time: each instance owns the process-wide database connection
    // while it is up, exactly as `platform-binding-real.test.ts` arranges it.
    await first.close();
    first = undefined;

    second = await startInstance("cli_two_platform_credentials_second", {
      web: false,
      deviceAuthorizationInterval: "0s",
    });
    const onSecond = await signUp(second.api, "two-platforms@beta.example", "Beta Second");

    const secondLogin = await logInThrough(second, onSecond, workspace);
    expect(secondLogin.code, secondLogin.stderr).toBe(0);
    expect(secondLogin.stdout).toContain("status: stored");

    // The second login did not sign this machine out of the first platform.
    const stillFirst = await readCredentials(workspace.credentialsFile, firstOrigin);
    expect(stillFirst).toEqual(heldForFirst);

    const heldForSecond = await readCredentials(
      workspace.credentialsFile,
      second.origin,
    );
    expect(heldForSecond?.url).toBe(second.origin);
    expect(heldForSecond?.key).toMatch(/^egma_sk_/u);
    expect(heldForSecond?.key).not.toBe(heldForFirst?.key);

    // Each key is only good where it was minted, so a file that mixed them up
    // would be caught here rather than by a 401 in front of a developer.
    expect(await keyWorks(second, heldForSecond?.key ?? "")).toBe(true);
    expect(await keyWorks(second, heldForFirst?.key ?? "")).toBe(false);

    // Two entries, each under its own normalized origin, and no leftover
    // top-level pair that a command could read as "the platform".
    const onDisk = JSON.parse(await readFile(workspace.credentialsFile, "utf8")) as {
      version: number;
      platforms: Record<string, { key: string }>;
      url?: unknown;
    };
    expect(onDisk.url).toBeUndefined();
    expect(Object.keys(onDisk.platforms).sort()).toEqual(
      [firstOrigin, second.origin].sort(),
    );
  } finally {
    await first?.close();
    await second?.close();
    await workspace.remove();
  }
});
