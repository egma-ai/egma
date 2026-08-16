/**
 * How egma learns to start a coding agent.
 *
 * Launch conventions differ per agent and change, so the wizard never carries a
 * table of commands it wrote itself. It reads the protocol's own agent registry,
 * mirrored here as a snapshot so a first run needs no network. `registry.json`
 * in `registry-snapshot.json` is the published document, copied verbatim.
 */

import process from "node:process";

import snapshot from "./registry-snapshot.json" with { type: "json" };

/** Mirrored from https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json on 2026-08-05. */
export const REGISTRY_SNAPSHOT_MIRRORED_ON = "2026-08-05";

/** The coding agent egma drives when the developer names none. */
export const DEFAULT_DRIVEN_AGENT_ID = "claude-acp";

export type RegistryEntry = {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly distribution?: {
    readonly npx?: { readonly package: string; readonly args?: readonly string[] };
    readonly uvx?: { readonly package: string; readonly args?: readonly string[] };
    readonly binary?: Readonly<Record<string, unknown>>;
  };
};

export type DrivenAgentRegistry = {
  readonly version: string;
  readonly agents: readonly RegistryEntry[];
};

/** How to start one coding agent as a subprocess that speaks the protocol. */
export type DrivenAgentLaunch = {
  readonly id: string;
  readonly name: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
};

export function registry(): DrivenAgentRegistry {
  return snapshot as DrivenAgentRegistry;
}

export function findDrivenAgent(
  id: string,
  from: DrivenAgentRegistry = registry(),
): RegistryEntry | null {
  return from.agents.find((entry) => entry.id === id) ?? null;
}

/**
 * Environment an agent needs before it will run without asking a human
 * anything. This is not a launch table — the command still comes from the
 * registry — it is the one setting per agent that its own documentation names
 * as the way to start in its most permissive mode.
 */
const ZERO_PROMPT_ENV: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  "codex-acp": { INITIAL_AGENT_MODE: "agent-full-access" },
};

/** The runner for a package the registry says is published to npm. */
function packageRunner(kind: "npx" | "uvx"): string {
  if (kind === "uvx") return "uvx";
  return process.platform === "win32" ? "npx.cmd" : "npx";
}

export class UnlaunchableDrivenAgentError extends Error {}

/**
 * Turn a registry entry into a command egma can spawn.
 *
 * Only the package distributions are honoured. An agent published solely as a
 * downloadable binary needs egma to fetch, verify and unpack a release, which
 * it does not do yet — so it is refused by name rather than half-started.
 */
export function launchFor(entry: RegistryEntry): DrivenAgentLaunch {
  const env = ZERO_PROMPT_ENV[entry.id] ?? {};
  const npx = entry.distribution?.npx;
  if (npx) {
    return {
      id: entry.id,
      name: entry.name,
      command: packageRunner("npx"),
      args: ["--yes", npx.package, ...(npx.args ?? [])],
      env,
    };
  }

  const uvx = entry.distribution?.uvx;
  if (uvx) {
    return {
      id: entry.id,
      name: entry.name,
      command: packageRunner("uvx"),
      args: [uvx.package, ...(uvx.args ?? [])],
      env,
    };
  }

  throw new UnlaunchableDrivenAgentError(
    `Egma cannot start ${entry.name} yet: the agent registry ships it as a downloadable binary, and Egma only starts agents published as packages.`,
  );
}

/** The launch for a registry id, or a plain-words error naming what went wrong. */
export function launchForId(
  id: string,
  from: DrivenAgentRegistry = registry(),
): DrivenAgentLaunch {
  const entry = findDrivenAgent(id, from);
  if (entry === null) {
    throw new UnlaunchableDrivenAgentError(
      `Egma does not know a coding agent called "${id}". The ones it knows come from the protocol registry mirrored on ${REGISTRY_SNAPSHOT_MIRRORED_ON}.`,
    );
  }
  return launchFor(entry);
}
