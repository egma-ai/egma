import { chmod, mkdir, realpath, symlink, writeFile } from "node:fs/promises";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  discoverCodingAgents,
  installedCodingAgent,
  supportedCodingAgentId,
} from "../src/acp/coding-agents.ts";
import { sessionMetaFor } from "../src/acp/hardening.ts";
import { makeWorkspace, type Workspace } from "./support/workspace.ts";

let scratch: Workspace | null = null;

afterEach(async () => {
  await scratch?.remove();
  scratch = null;
});

async function executable(
  directory: string,
  name: string,
  answers: { readonly version: string; readonly acpHelp?: string },
): Promise<string> {
  const target = path.join(directory, name);
  await writeFile(
    target,
    [
      "#!/bin/sh",
      `if [ \"$1\" = \"--version\" ]; then printf '%s\\n' '${answers.version}'; exit 0; fi`,
      `if [ \"$1\" = \"acp\" ] && [ \"$2\" = \"--help\" ]; then printf '%s\\n' '${answers.acpHelp ?? ""}'; exit 0; fi`,
      "exit 97",
      "",
    ].join("\n"),
    "utf8",
  );
  await chmod(target, 0o755);
  return target;
}

describe("installed coding agents", () => {
  it("finds only Egma's four supported agents without starting ACP", async () => {
    scratch = await makeWorkspace({});
    const bin = path.join(scratch.dir, "bin");
    await mkdir(bin);
    await executable(bin, "claude", {
      version: "2.1.233 (Claude Code)",
    });
    await executable(bin, "codex", {
      version: "codex-cli 0.148.0",
    });
    await executable(bin, "agent", {
      version: "2026.08.15",
      acpHelp: "Cursor Agent as an ACP Agent Client Protocol server",
    });
    await executable(bin, "opencode", {
      version: "1.18.16",
      acpHelp: "opencode acp start ACP Agent Client Protocol server",
    });
    await executable(bin, "augie", {
      version: "Augie 1.0",
    });

    const found = await discoverCodingAgents({
      env: { PATH: bin },
      home: path.join(scratch.dir, "empty-home"),
      platform: "linux",
    });

    expect(found.map(({ id, name, version }) => ({ id, name, version }))).toEqual([
      { id: "claude", name: "Claude Code", version: "2.1.233" },
      { id: "codex", name: "Codex", version: "0.148.0" },
      { id: "cursor", name: "Cursor", version: "2026.08.15" },
      { id: "opencode", name: "OpenCode", version: "1.18.16" },
    ]);
    expect(found.map((agent) => agent.launch.args.at(-1))).not.toContain("acp --version");
    expect(found.map((agent) => agent.id)).not.toContain("augie");
  });

  it("deduplicates Cursor's two aliases and launches the installed binary", async () => {
    scratch = await makeWorkspace({});
    const bin = path.join(scratch.dir, "bin");
    await mkdir(bin);
    const primary = await executable(bin, "agent", {
      version: "2026.08.15",
      acpHelp: "Cursor Agent as an ACP Agent Client Protocol server",
    });
    await symlink(primary, path.join(bin, "cursor-agent"));

    const found = await discoverCodingAgents({
      env: { PATH: bin },
      home: path.join(scratch.dir, "empty-home"),
      platform: "linux",
    });

    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ id: "cursor" });
    expect(found[0]?.launch).toMatchObject({ command: await realpath(primary), args: ["acp"] });
  });

  it("does not claim a command whose identity probe fails", async () => {
    scratch = await makeWorkspace({});
    const bin = path.join(scratch.dir, "bin");
    await mkdir(bin);
    await executable(bin, "claude", {
      version: "some other claude 1.0",
    });

    await expect(
      discoverCodingAgents({
        env: { PATH: bin },
        home: path.join(scratch.dir, "empty-home"),
        platform: "linux",
      }),
    ).resolves.toEqual([]);
  });

  it("builds each supported ACP launch from the selected local install", async () => {
    scratch = await makeWorkspace({});
    const bin = path.join(scratch.dir, "bin");
    await mkdir(bin);
    const claude = await executable(bin, "claude", {
      version: "2.1.233 (Claude Code)",
    });
    const codex = await executable(bin, "codex", {
      version: "codex-cli 0.148.0",
    });
    const cursor = await executable(bin, "agent", {
      version: "2026.08.15",
      acpHelp: "Cursor Agent as an ACP Agent Client Protocol server",
    });
    const opencode = await executable(bin, "opencode", {
      version: "1.18.16",
      acpHelp: "opencode acp start ACP Agent Client Protocol server",
    });

    const options = {
      env: { PATH: bin },
      home: path.join(scratch.dir, "empty-home"),
      platform: "linux" as const,
    };
    const found = await discoverCodingAgents(options);

    expect(installedCodingAgent(found, "claude")?.launch).toMatchObject({
      id: "claude",
      command: expect.stringMatching(/^npx/),
      args: ["--yes", "@agentclientprotocol/claude-agent-acp@0.64.2"],
      env: { CLAUDE_CODE_EXECUTABLE: await realpath(claude) },
    });
    expect(installedCodingAgent(found, "codex")?.launch).toMatchObject({
      id: "codex",
      command: expect.stringMatching(/^npx/),
      args: ["--yes", "@agentclientprotocol/codex-acp@1.1.9"],
      env: { CODEX_PATH: await realpath(codex), INITIAL_AGENT_MODE: "agent-full-access" },
    });
    expect(installedCodingAgent(found, "cursor")?.launch).toEqual({
      id: "cursor",
      name: "Cursor",
      command: await realpath(cursor),
      args: ["acp"],
      env: {},
    });
    expect(installedCodingAgent(found, "opencode")?.launch).toEqual({
      id: "opencode",
      name: "OpenCode",
      command: await realpath(opencode),
      args: ["acp"],
      env: {},
    });
  });

  it("accepts only canonical public ids", async () => {
    scratch = await makeWorkspace({});
    const bin = path.join(scratch.dir, "bin");
    await mkdir(bin);
    await executable(bin, "claude", {
      version: "2.1.233 (Claude Code)",
    });
    const found = await discoverCodingAgents({
      env: { PATH: bin },
      home: path.join(scratch.dir, "empty-home"),
      platform: "linux",
    });

    expect(installedCodingAgent(found, "claude")?.id).toBe("claude");
    expect(supportedCodingAgentId("claude-acp")).toBeNull();
    expect(supportedCodingAgentId("codex-acp")).toBeNull();
    expect(installedCodingAgent(found, "claude-acp")).toBeNull();
    expect(installedCodingAgent(found, "codex-acp")).toBeNull();
    expect(installedCodingAgent(found, "augie")).toBeNull();
    expect(sessionMetaFor("claude")).not.toBeNull();
    expect(sessionMetaFor("claude-acp")).toBeNull();
  });
});
