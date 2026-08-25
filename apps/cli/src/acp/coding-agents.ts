/**
 * The coding agents Egma can find and drive on this machine.
 *
 * The public product surface is deliberately four agents. Egma pins the
 * Claude and Codex ACP adapters here, but an adapter is not proof that its
 * coding agent is installed. Discovery proves the local command first and
 * returns the complete launch only then.
 */

import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";

/** How to start one installed coding agent as an ACP subprocess. */
export type DrivenAgentLaunch = {
  readonly id: string;
  readonly name: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
};

export const SUPPORTED_CODING_AGENT_IDS = [
  "claude",
  "codex",
  "cursor",
  "opencode",
] as const;

export type SupportedCodingAgentId = (typeof SUPPORTED_CODING_AGENT_IDS)[number];

export type InstalledCodingAgent = {
  readonly id: SupportedCodingAgentId;
  readonly name: string;
  readonly version: string;
  readonly executable: string;
  readonly launch: DrivenAgentLaunch;
};

type Probe = {
  readonly args: readonly string[];
  readonly accepts: (output: string) => boolean;
};

type Profile = {
  readonly id: SupportedCodingAgentId;
  readonly name: string;
  readonly commands: readonly string[];
  readonly known: (home: string, platform: NodeJS.Platform) => readonly string[];
  readonly probes: readonly Probe[];
  readonly launch: (executable: string) => DrivenAgentLaunch;
};

export type DiscoverCodingAgentsOptions = {
  readonly env?: NodeJS.ProcessEnv;
  readonly home?: string;
  readonly platform?: NodeJS.Platform;
  readonly probeTimeoutMs?: number;
};

const PROBE_TIMEOUT_MS = 2_000;

function adapterLaunch(
  id: "claude" | "codex",
  name: string,
  executable: string,
): DrivenAgentLaunch {
  const packageName =
    id === "claude"
      ? "@agentclientprotocol/claude-agent-acp@0.64.2"
      : "@agentclientprotocol/codex-acp@1.1.9";
  return {
    id,
    name,
    command: process.platform === "win32" ? "npx.cmd" : "npx",
    args: ["--yes", packageName],
    env: {
      ...(id === "codex" ? { INITIAL_AGENT_MODE: "agent-full-access" } : {}),
      ...(id === "claude"
        ? { CLAUDE_CODE_EXECUTABLE: executable }
        : { CODEX_PATH: executable }),
    },
  };
}

const PROFILES: readonly Profile[] = [
  {
    id: "claude",
    name: "Claude Code",
    commands: ["claude"],
    known: (home) => [path.join(home, ".local", "bin", "claude")],
    probes: [{ args: ["--version"], accepts: (output) => /Claude Code/i.test(output) }],
    launch: (executable) => adapterLaunch("claude", "Claude Code", executable),
  },
  {
    id: "codex",
    name: "Codex",
    commands: ["codex"],
    known: (home, platform) => [
      path.join(home, ".local", "bin", "codex"),
      ...(platform === "darwin"
        ? [
            "/Applications/Codex.app/Contents/Resources/codex",
            "/Applications/ChatGPT.app/Contents/Resources/codex",
          ]
        : []),
    ],
    probes: [{ args: ["--version"], accepts: (output) => /\bcodex-cli\b/i.test(output) }],
    launch: (executable) => adapterLaunch("codex", "Codex", executable),
  },
  {
    id: "cursor",
    name: "Cursor",
    commands: ["agent", "cursor-agent"],
    known: (home) => [
      path.join(home, ".local", "bin", "agent"),
      path.join(home, ".local", "bin", "cursor-agent"),
    ],
    probes: [
      { args: ["--version"], accepts: (output) => output.trim() !== "" },
      {
        args: ["acp", "--help"],
        accepts: (output) => /Cursor Agent[\s\S]*Agent Client Protocol/i.test(output),
      },
    ],
    launch: (executable) => ({
      id: "cursor",
      name: "Cursor",
      command: executable,
      args: ["acp"],
      env: {},
    }),
  },
  {
    id: "opencode",
    name: "OpenCode",
    commands: ["opencode"],
    known: (home) => [path.join(home, ".opencode", "bin", "opencode")],
    probes: [
      { args: ["--version"], accepts: (output) => output.trim() !== "" },
      {
        args: ["acp", "--help"],
        accepts: (output) => /\bopencode acp\b[\s\S]*Agent Client Protocol/i.test(output),
      },
    ],
    launch: (executable) => ({
      id: "opencode",
      name: "OpenCode",
      command: executable,
      args: ["acp"],
      env: {},
    }),
  },
];

function pathValue(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string {
  if (platform !== "win32") return env.PATH ?? "";
  const held = Object.entries(env).find(([name]) => name.toLowerCase() === "path");
  return held?.[1] ?? "";
}

function pathExtensions(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): readonly string[] {
  if (platform !== "win32") return [""];
  const held = Object.entries(env).find(([name]) => name.toLowerCase() === "pathext")?.[1];
  return (held ?? ".EXE;.CMD;.BAT;.COM").split(";").filter(Boolean);
}

async function executableAt(candidate: string): Promise<string | null> {
  try {
    await access(candidate, constants.X_OK);
    return await realpath(candidate);
  } catch {
    return null;
  }
}

async function candidatesFor(
  profile: Profile,
  options: Required<Pick<DiscoverCodingAgentsOptions, "env" | "home" | "platform">>,
): Promise<readonly string[]> {
  const candidates: string[] = [];
  const directories = pathValue(options.env, options.platform)
    .split(path.delimiter)
    .filter((part) => part !== "");
  const extensions = pathExtensions(options.env, options.platform);

  for (const command of profile.commands) {
    for (const directory of directories) {
      for (const extension of extensions) {
        candidates.push(path.resolve(directory, `${command}${extension}`));
      }
    }
  }
  candidates.push(...profile.known(options.home, options.platform));

  const found: string[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    const executable = await executableAt(candidate);
    if (executable === null || seen.has(executable)) continue;
    seen.add(executable);
    found.push(executable);
  }
  return found;
}

function runProbe(
  executable: string,
  probe: Probe,
  env: NodeJS.ProcessEnv,
  timeout: number,
): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      executable,
      [...probe.args],
      { env, encoding: "utf8", timeout, windowsHide: true },
      (error, stdout, stderr) => {
        if (error !== null) {
          resolve(null);
          return;
        }
        const output = `${stdout}${stderr}`.trim();
        resolve(probe.accepts(output) ? output : null);
      },
    );
  });
}

function versionIn(output: string): string {
  return output.match(/\d+(?:\.\d+)+(?:[-+][0-9A-Za-z.-]+)?/)?.[0] ?? output.split("\n")[0]!.trim();
}

async function inspect(
  profile: Profile,
  executable: string,
  env: NodeJS.ProcessEnv,
  timeout: number,
): Promise<InstalledCodingAgent | null> {
  let versionOutput: string | null = null;
  for (const probe of profile.probes) {
    const output = await runProbe(executable, probe, env, timeout);
    if (output === null) return null;
    versionOutput ??= output;
  }
  if (versionOutput === null) return null;
  return {
    id: profile.id,
    name: profile.name,
    version: versionIn(versionOutput),
    executable,
    launch: profile.launch(executable),
  };
}

/**
 * Find Egma's supported coding agents without starting ACP or authenticating.
 *
 * Each result is fully launchable and evidence-backed by its local command.
 * Unsupported commands are never returned.
 */
export async function discoverCodingAgents(
  options: DiscoverCodingAgentsOptions = {},
): Promise<readonly InstalledCodingAgent[]> {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const home = options.home ?? os.homedir();
  const timeout = options.probeTimeoutMs ?? PROBE_TIMEOUT_MS;
  const found: InstalledCodingAgent[] = [];

  for (const profile of PROFILES) {
    for (const executable of await candidatesFor(profile, { env, home, platform })) {
      const installed = await inspect(profile, executable, env, timeout);
      if (installed === null) continue;
      found.push(installed);
      break;
    }
  }
  return found;
}

/** A supported public id. */
export function supportedCodingAgentId(id: string): SupportedCodingAgentId | null {
  return (SUPPORTED_CODING_AGENT_IDS as readonly string[]).includes(id)
    ? (id as SupportedCodingAgentId)
    : null;
}

/** Select an installed agent by public id. */
export function installedCodingAgent(
  installed: readonly InstalledCodingAgent[],
  id: string,
): InstalledCodingAgent | null {
  const canonical = supportedCodingAgentId(id);
  if (canonical === null) return null;
  return installed.find((agent) => agent.id === canonical) ?? null;
}
