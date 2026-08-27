/**
 * The deterministic half of monitoring a LiveKit worker.
 *
 * The other half is a code edit, and it belongs to the developer's own coding
 * agent: `monitor_livekit(ctx)` at the top of the job entrypoint, taught by the
 * shipped SDK-integration skill, applied where the developer can watch it
 * happen. Everything here is the half that must not be a model's judgement —
 * minting a live credential, deciding whether a file is safe to write it into,
 * and putting it there.
 *
 * Nothing here flips a switch on the platform. Push is observed, never declared
 * (ADR-0015): the worker exports and the evidence is the whole record. What
 * this does write is the agent's identity in the roster, bound to LiveKit, so
 * the agent exists in Egma even though no switch says so. The worker key is an
 * ordinary project key. Its stable name is the recovery receipt already held
 * by Egma's key list; no monitoring-only database relationship is required.
 */

import { randomBytes } from "node:crypto";

import {
  registerBoundAgent,
  type RegisteredAgent,
  type RegisterOptions,
} from "../platform/agents.ts";
import {
  listActiveProjectKeys,
  mintProjectKey,
  revokeProjectKey,
  type MintedKey,
} from "../platform/api-keys.ts";
import { readAgentMonitoring } from "../platform/monitoring.ts";
import { envLines, exportLines, writeEnvFile, type EnvWrite } from "./env-file.ts";
import { recordMonitoringTarget } from "./record-target.ts";

/** The LiveKit identity saved in the repository before a worker key is minted. */
const LIVEKIT = "livekit";

/** Cleanup must finish even when the developer stops the parent command. */
const CLEANUP_TIMEOUT_MS = 5_000;

/** A started mutation finishes independently of a later terminal interrupt. */
const COMMIT_TIMEOUT_MS = 30_000;

/**
 * What Egma calls the key it mints, so a person reading the key list a year
 * later can tell what revoking it would break.
 */
/** Stable across display-name changes, and readable in the project key list. */
function monitoringKeyPrefix(agentId: string): string {
  return `Egma monitoring ${agentId} — `;
}

export function monitoringKeyName(
  agentName: string,
  agentId: string,
  attempt: string,
): string {
  return `${monitoringKeyPrefix(agentId)}${agentName} [${attempt}]`;
}

/** The closing sentence, which promises nothing Egma cannot see. */
export const LIVEKIT_CLOSING_LINE =
  "Egma is not waiting: a LiveKit worker pushes its own evidence, so " +
  "conversations appear in Monitoring once real traffic starts.";

export type LiveKitWired = {
  readonly kind: "wired";
  /** The agent's row in the roster, and whether this run wrote it. */
  readonly agent: RegisteredAgent;
  readonly created: boolean;
  /** What became of the repository's `.env`. */
  readonly env: EnvWrite;
  /**
   * The two lines, for wherever this worker really runs.
   *
   * They carry the minted secret, so they are the one thing here a caller must
   * put in front of the developer and nowhere else.
   */
  readonly lines: readonly string[];
  /** The non-secret stable id used to prove this exact key during recovery. */
  readonly keyId: string;
  /** Enough to tell the minted key from another, and not enough to be one. */
  readonly keyLooksLike: string;
};

export type LiveKitOutcome =
  | LiveKitWired
  | {
      readonly kind: "already-configured";
      readonly agent: RegisteredAgent;
      /** Null when another member's key is deliberately not visible here. */
      readonly keyId: string | null;
      readonly reason: string;
    }
  | {
      readonly kind: "interrupted";
      /** A fresh remote agent that this stopped run saved for a safe retry. */
      readonly retryTarget?: { readonly agentId: string };
    }
  | { readonly kind: "failed"; readonly reason: string };

export type LiveKitOptions = {
  /** The Egma being written to, and this machine's key for it. */
  readonly platform: RegisterOptions;
  /** The repository whose `.env` the lines go in. */
  readonly cwd: string;
  readonly signal: AbortSignal;
  /**
   * The agent this repository is about, when it already has one.
   *
   * A repository that has been through connection setup already holds an agent
   * id, and a second row for one agent would split its history in half. Left
   * out, a row is written under `agentName` and bound to LiveKit.
   */
  readonly agentId?: string | null | undefined;
  /** What to call the agent row this writes, when it writes one. */
  readonly agentName: string;
  /** One line about what is happening, for whoever is watching. */
  readonly say: (line: string, kind?: "action") => void;
};

const NOT_SIGNED_IN =
  "Egma would not take this machine's key. Run egma login, then try again.";

/** Revoke only the key created by this invocation. */
async function rollbackUncommittedKey(
  keyId: string,
  platform: RegisterOptions,
): Promise<boolean> {
  return (
    await revokeProjectKey(keyId, {
      ...platform,
      signal: AbortSignal.timeout(CLEANUP_TIMEOUT_MS),
    })
  ).kind === "revoked";
}

function cleanupResult(
  keyRevoked: boolean,
  keyId: string,
): string {
  if (keyRevoked) {
    return "The unused key was revoked and no environment file was changed.";
  }
  return (
    `Egma could not confirm that key ${keyId} was revoked, so it may still be active. ` +
    "Revoke that key in Egma before retrying. No environment file was changed."
  );
}

/** Finish a Ctrl-C after mint without leaving this invocation's key behind. */
async function interruptedAfterMint(
  options: LiveKitOptions,
  agent: RegisteredAgent,
  created: boolean,
  keyId: string,
): Promise<LiveKitOutcome> {
  const keyRevoked = await rollbackUncommittedKey(keyId, options.platform);
  return keyRevoked
    ? interruptedAfterRecord(agent, created)
    : {
        kind: "failed",
        reason:
          "The monitoring command was stopped after Egma minted a key. " +
          cleanupResult(keyRevoked, keyId),
      };
}

/**
 * Commit the stable agent before any key can exist.
 *
 * This is the retry boundary. If the local write fails, the command stops
 * before minting. A later run can recover the exact remote row by its printed
 * id without any monitoring-only state on that row.
 */
async function recordTargetBeforeKey(
  options: LiveKitOptions,
  agent: RegisteredAgent,
  created: boolean,
): Promise<
  | { readonly kind: "recorded" }
  | { readonly kind: "failed"; readonly reason: string }
> {
  try {
    await recordMonitoringTarget({
      cwd: options.cwd,
      signedIn: { url: options.platform.url, key: options.platform.key },
      target: agent,
      ...(options.platform.fetchImpl === undefined
        ? {}
        : { fetchImpl: options.platform.fetchImpl }),
      signal: AbortSignal.timeout(CLEANUP_TIMEOUT_MS),
    });
    if (created) {
      options.say(
        `Saved agent ${agent.id} in egma/config.yaml before creating its worker key.`,
        "action",
      );
    }
    return { kind: "recorded" };
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    return {
      kind: "failed",
      reason:
        `Agent ${agent.id} remains in Egma, but Egma could not save it in egma/config.yaml: ${detail} ` +
        `No worker key was created. After the repository is writable, run egma monitoring record --agent ${agent.id} --url ${options.platform.url}.`,
    };
  }
}

/** Preserve the stable fresh-agent receipt after the alternate screen closes. */
function interruptedAfterRecord(
  agent: RegisteredAgent,
  created: boolean,
): Extract<LiveKitOutcome, { readonly kind: "interrupted" }> {
  return created
    ? { kind: "interrupted", retryTarget: { agentId: agent.id } }
    : { kind: "interrupted" };
}

/**
 * The agent this repository's monitoring is about: the one it already has, or
 * a new platform-bound row.
 *
 * A taken name is refused. Inventing a suffixed name here would turn a retry
 * after a partial local write into another agent, another key, and a rewritten
 * environment for the same worker.
 */
async function theAgent(
  options: LiveKitOptions,
): Promise<
  | {
      readonly kind: "agent";
      readonly agent: RegisteredAgent;
      readonly created: boolean;
    }
  | {
      readonly kind: "failed";
      readonly reason: string;
      readonly uncertainMutation?: boolean;
    }
> {
  const held = options.agentId?.trim() ?? "";
  if (held !== "") {
    const read = await readAgentMonitoring(held, options.platform);
    switch (read.kind) {
      case "monitoring":
        return {
          kind: "agent",
          agent: {
            id: read.monitoring.agentId,
            name: read.monitoring.agentName,
            projectId: read.monitoring.projectId,
          },
          created: false,
        };
      case "not-found":
        return {
          kind: "failed",
          reason:
            `Egma has no agent ${held} in this project, and that is the agent ` +
            "this repository names. Check which project you are signed in to.",
        };
      case "not-authenticated":
        return { kind: "failed", reason: NOT_SIGNED_IN };
      case "refused":
      case "unreachable":
        return { kind: "failed", reason: read.reason };
    }
  }

  if (options.signal.aborted) return { kind: "failed", reason: "stopped" };
  const wanted = options.agentName.trim() || "voice-agent";
  const written = await registerBoundAgent(
    { name: wanted, agentPlatform: LIVEKIT },
    {
      ...options.platform,
      signal: AbortSignal.timeout(COMMIT_TIMEOUT_MS),
    },
  );
  switch (written.kind) {
    case "registered":
      return {
        kind: "agent",
        agent: written.agent,
        created: written.result === "created",
      };
    case "name-taken":
      return {
        kind: "failed",
        reason:
          `An Egma agent already uses the name ${JSON.stringify(wanted)}. ` +
          "Egma did not create a second agent, mint a key, or change the environment. " +
          "If this follows a repository-record failure, use the printed egma monitoring record command.",
      };
    case "not-authenticated":
      return { kind: "failed", reason: NOT_SIGNED_IN };
    case "uncertain":
      return {
        kind: "failed",
        uncertainMutation: true,
        reason:
          `${written.reason} Egma may have created an agent named ${JSON.stringify(wanted)} ` +
          "before the response was lost. Check for that exact agent before retrying.",
      };
    case "refused":
      return { kind: "failed", reason: written.reason };
    case "unreachable":
      return {
        kind: "failed",
        uncertainMutation: true,
        reason:
          `${written.reason} Egma may have created an agent named ${JSON.stringify(wanted)} ` +
          "before the response was lost. Check for that exact agent before retrying.",
      };
  }
}

/**
 * Mint the key, write the two lines, and answer with them either way.
 *
 * The order is the point: the agent exists first, because the key is minted for
 * the project that agent lands in; then the key; then the file. A `.env` Egma
 * will not write is not a failure — the lines it would have held come back and
 * a caller prints them, which is the answer a deployment needs anyway.
 */
export async function wireLiveKitMonitoring(
  options: LiveKitOptions,
): Promise<LiveKitOutcome> {
  if (options.signal.aborted) return { kind: "interrupted" };

  const resolved = await theAgent(options);
  if (resolved.kind === "failed") {
    return options.signal.aborted && resolved.uncertainMutation !== true
      ? { kind: "interrupted" }
      : { kind: "failed", reason: resolved.reason };
  }
  const { agent, created } = resolved;
  if (created) {
    options.say(`${agent.name} is on Egma, bound to LiveKit Agents.`, "action");
  }

  const recorded = await recordTargetBeforeKey(options, agent, created);
  if (recorded.kind === "failed") {
    return { kind: "failed", reason: recorded.reason };
  }
  if (options.signal.aborted) return interruptedAfterRecord(agent, created);

  const namePrefix = monitoringKeyPrefix(agent.id);
  const before = await listActiveProjectKeys(
    { projectId: agent.projectId, namePrefix },
    {
      ...options.platform,
      signal: AbortSignal.any([
        options.signal,
        AbortSignal.timeout(COMMIT_TIMEOUT_MS),
      ]),
    },
  );
  if (options.signal.aborted) return interruptedAfterRecord(agent, created);
  if (before.kind !== "listed") {
    return {
      kind: "failed",
      reason:
        before.kind === "not-authenticated"
          ? NOT_SIGNED_IN
          : `${before.reason} No key was created and no environment file was changed.`,
    };
  }
  if (before.keys.length > 0) {
    if (before.keys.length > 1) {
      return {
        kind: "failed",
        reason:
          `Egma found ${String(before.keys.length)} active project keys for ${agent.name}. ` +
          "It cannot safely choose one. Revoke the duplicate worker keys in Egma, then run enable again. " +
          "No key was created and no file was changed.",
      };
    }
    const current = before.keys[0]!;
    return {
      kind: "already-configured",
      agent,
      keyId: current.id,
      reason:
        `LiveKit monitoring already has an active project key for ${agent.name} ` +
        `(${current.looksLike || current.id}). No key was rotated and no file was changed. ` +
        "Revoke that key in Egma before running enable to replace it.",
    };
  }

  /*
   * A fresh project key, never this machine's own.
   *
   * The terminal's credential is this machine's identity. A worker in a
   * deployment holding it would be this laptop everywhere, and revoking it
   * later would sign the laptop out. The worker gets a normal project key with
   * a stable agent-id name, so the existing key list can make retries safe.
   */
  const keyName = monitoringKeyName(
    agent.name,
    agent.id,
    randomBytes(8).toString("hex"),
  );
  const minted = await mintProjectKey(
    {
      name: keyName,
      projectId: agent.projectId,
      monitoringAgentId: agent.id,
    },
    {
      ...options.platform,
      signal: AbortSignal.timeout(COMMIT_TIMEOUT_MS),
    },
  );

  let key: MintedKey;
  switch (minted.kind) {
    case "minted":
      key = minted.key;
      break;
    case "minted-without-secret": {
      const keyRevoked = await rollbackUncommittedKey(
        minted.keyId,
        options.platform,
      );
      return {
        kind: "failed",
        reason: `${minted.reason} ${cleanupResult(keyRevoked, minted.keyId)}`,
      };
    }
    case "uncertain":
    case "unreachable": {
      const found = await listActiveProjectKeys(
        { projectId: agent.projectId, namePrefix },
        {
          ...options.platform,
          signal: AbortSignal.timeout(CLEANUP_TIMEOUT_MS),
        },
      );
      if (found.kind !== "listed") {
        const detail =
          found.kind === "not-authenticated" ? NOT_SIGNED_IN : found.reason;
        return {
          kind: "failed",
          reason:
            `${minted.reason} Egma could not reconcile the request by its exact key name: ${detail} ` +
            `Check for an active key named ${JSON.stringify(keyName)} before retrying. ` +
            "No environment file was changed.",
        };
      }
      const exact = found.keys.filter((candidate) => candidate.name === keyName);
      if (exact.length === 0) {
        return {
          kind: "failed",
          reason:
            `${minted.reason} Egma found no active key from this attempt. ` +
            "No environment file was changed.",
        };
      }
      if (exact.length > 1) {
        return {
          kind: "failed",
          reason:
            `${minted.reason} Egma found ${String(exact.length)} active keys named ` +
            `${JSON.stringify(keyName)} and cannot tell which concurrent request created each one. ` +
            "Check those keys before retrying. No environment file was changed.",
        };
      }
      const uncertainKey = exact[0]!;
      const keyRevoked = await rollbackUncommittedKey(
        uncertainKey.id,
        options.platform,
      );
      return {
        kind: "failed",
        reason:
          `${minted.reason} Reconciled ${JSON.stringify(keyName)} for agent ${agent.id}. ` +
          cleanupResult(keyRevoked, uncertainKey.id),
      };
    }
    case "not-authenticated":
      return {
        kind: "failed",
        reason: `${NOT_SIGNED_IN} No environment file was changed.`,
      };
    case "active-name-conflict":
      return {
        kind: "already-configured",
        agent,
        keyId: null,
        reason:
          `LiveKit monitoring already has an active project key for ${agent.name}. ` +
          "It may belong to another project member, so Egma does not show its details here. " +
          "No key was minted and no file was changed. Revoke that worker key in Egma before running enable to replace it.",
      };
    case "refused":
      return {
        kind: "failed",
        reason: `${minted.reason} No environment file was changed.`,
      };
  }

  if (options.signal.aborted) {
    return interruptedAfterMint(options, agent, created, key.id);
  }

  /*
   * The list is also the concurrency check. If another enable passed the empty
   * preflight at the same time, this invocation revokes only its own returned
   * key and asks the developer to retry after the competing setup settles.
   */
  const after = await listActiveProjectKeys(
    { projectId: agent.projectId, namePrefix },
    {
      ...options.platform,
      signal: AbortSignal.timeout(COMMIT_TIMEOUT_MS),
    },
  );
  if (after.kind !== "listed") {
    const keyRevoked = await rollbackUncommittedKey(key.id, options.platform);
    const detail =
      after.kind === "not-authenticated" ? NOT_SIGNED_IN : after.reason;
    return {
      kind: "failed",
      reason:
        `Egma could not verify the new key in the project key list: ${detail} ` +
        cleanupResult(keyRevoked, key.id),
    };
  }
  const ownIsActive = after.keys.some((candidate) => candidate.id === key.id);
  const competing = after.keys.filter((candidate) => candidate.id !== key.id);
  if (!ownIsActive || competing.length > 0) {
    const keyRevoked = await rollbackUncommittedKey(key.id, options.platform);
    const why = ownIsActive
      ? "Another LiveKit monitoring setup ran for this agent at the same time."
      : `Egma did not find key ${key.id} in the active project key list.`;
    return {
      kind: "failed",
      reason:
        `${why} ${cleanupResult(keyRevoked, key.id)} ` +
        "Check the agent's project keys, then run enable again.",
    };
  }

  if (options.signal.aborted) {
    return interruptedAfterMint(options, agent, created, key.id);
  }

  const values = { url: options.platform.url, key: key.secret };
  const env = await writeEnvFile(options.cwd, values);
  if (env.kind === "written") {
    options.say(
      `Wrote ${envLines(values).length} lines into ${env.file}${env.replaced ? ", replacing what was there" : ""}.`,
      "action",
    );
  } else {
    options.say(env.reason);
  }

  return {
    kind: "wired",
    agent,
    created,
    env,
    lines: exportLines(values),
    keyId: key.id,
    keyLooksLike: key.looksLike,
  };
}
