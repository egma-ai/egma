/** The removed setup workflow points operators to the one `.env` surface. */

import { existsSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  makePlatformWorkspace,
  runSelfHost,
} from "./support/platform-workspace.ts";

describe("the removed egma self-host setup command", () => {
  it("refuses with the complete .env route and the normal start command", async () => {
    const workspace = await makePlatformWorkspace("egma-platform-setup-removed-");

    const run = await runSelfHost(workspace, ["setup"]);

    expect(run.code).toBe(4);
    expect(run.stdout).toContain("status: refused");
    expect(run.stdout).toContain("egma self-host setup has been removed");
    expect(run.stdout).toContain("workspace .env file");
    expect(run.stdout).toContain("EGMA_PHONE_TRUNK_ADDRESS");
    expect(run.stdout).toContain("EGMA_PHONE_SOURCE_NUMBER");
    expect(run.stdout).toContain("EGMA_PHONE_TRUNK_USERNAME");
    expect(run.stdout).toContain("EGMA_PHONE_TRUNK_PASSWORD");
    expect(run.stdout).toContain("egma self-host up");
    expect(run.stderr).toContain("egma self-host setup has been removed");

    expect(await workspace.dockerCalls()).toBe("");
    expect(existsSync(workspace.configFile)).toBe(false);
  });

  it("never repeats the value of an option from the removed workflow", async () => {
    const workspace = await makePlatformWorkspace("egma-platform-setup-removed-");
    const privateValue = "must-not-appear-in-output";

    const run = await runSelfHost(workspace, [
      "setup",
      `--auth-token=${privateValue}`,
    ]);

    expect(run.code).not.toBe(0);
    expect(run.stderr).toContain("does not know the option --auth-token");
    expect(`${run.stdout}\n${run.stderr}`).not.toContain(privateValue);
    expect(await workspace.dockerCalls()).toBe("");
    expect(existsSync(workspace.configFile)).toBe(false);
  });
});
