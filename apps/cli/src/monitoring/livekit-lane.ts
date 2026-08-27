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
 * the agent exists in Egma even though no switch says so. The agent row keeps
 * only the non-secret id of its current monitoring key. The secret lives in
 * the customer's `.env`; the full key record lives in Egma, where it can be
 * rotated or revoked.
 */

import {
  registerBoundAgent,
  type RegisteredAgent,
  type RegisterOptions,
} from "../platform/agents.ts";
import { mintProjectKey, type MintedKey } from "../platform/api-keys.ts";
import { readAgentMonitoring } from "../platform/monitoring.ts";
import { envLines, exportLines, writeEnvFile, type EnvWrite } from "./env-file.ts";

/** The platform binding a LiveKit worker's agent row carries. */
const LIVEKIT = "livekit";

/**
 * What Egma calls the key it mints, so a person reading the key list a year
 * later can tell what revoking it would break.
 */
export function monitoringKeyName(agentName: string): string {
  return `${agentName} production monitoring`;
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
      readonly keyId: string;
      readonly reason: string;
    }
  | { readonly kind: "interrupted" }
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
      readonly monitoringKeyId: string | null;
    }
  | { readonly kind: "failed"; readonly reason: string }
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
          monitoringKeyId: read.monitoring.monitoringExportApiKeyId,
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
    options.platform,
  );
  switch (written.kind) {
    case "registered":
      return {
        kind: "agent",
        agent: written.agent,
        created: written.result === "created",
        monitoringKeyId: null,
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
    case "refused":
    case "unreachable":
      return { kind: "failed", reason: written.reason };
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
    return options.signal.aborted
      ? { kind: "interrupted" }
      : { kind: "failed", reason: resolved.reason };
  }
  const { agent, created, monitoringKeyId } = resolved;
  if (created) {
    options.say(`${agent.name} is on Egma, bound to LiveKit Agents.`, "action");
  }
  if (monitoringKeyId !== null) {
    return {
      kind: "already-configured",
      agent,
      keyId: monitoringKeyId,
      reason:
        `LiveKit monitoring is already configured for ${agent.name}. ` +
        "No key was rotated and no file was changed. Revoke the current " +
        "monitoring key in Egma before running enable to replace it.",
    };
  }

  /*
   * A fresh project key, never this machine's own.
   *
   * The terminal's credential is this machine's identity. A worker in a
   * deployment holding it would be this laptop everywhere, and revoking it
   * later would sign the laptop out — so what the worker gets is minted for
   * this project, named for the job, and revocable on its own.
   */
  const minted = await mintProjectKey(
    {
      name: monitoringKeyName(agent.name),
      projectId: agent.projectId,
      monitoringAgentId: agent.id,
    },
    options.platform,
  );

  let key: MintedKey;
  switch (minted.kind) {
    case "minted":
      key = minted.key;
      break;
    case "already-bound": {
      const current = await readAgentMonitoring(agent.id, {
        ...options.platform,
        signal: undefined,
      });
      const keyId =
        current.kind === "monitoring"
          ? current.monitoring.monitoringExportApiKeyId
          : null;
      return {
        kind: "already-configured",
        agent,
        keyId: keyId ?? "unknown",
        reason:
          `LiveKit monitoring became configured for ${agent.name} while this command was running. ` +
          "No key was rotated and no file was changed.",
      };
    }
    case "not-authenticated":
      return options.signal.aborted
        ? { kind: "interrupted" }
        : { kind: "failed", reason: NOT_SIGNED_IN };
    case "refused":
    case "unreachable":
      return options.signal.aborted
        ? { kind: "interrupted" }
        : { kind: "failed", reason: minted.reason };
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
