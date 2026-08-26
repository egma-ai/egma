/**
 * `egma monitoring enable | disable | status | record`: the wizard's
 * monitoring work, plus a record-only recovery, with nobody watching.
 *
 * It asks nothing. What it prints is one fact per line, `name: value`, in a
 * shape that does not move, and the exit code is the branch — so a coding agent
 * can run it, read the answer, and act on it without a person relaying
 * anything. Underneath it is the same two flows the wizard's screens sit on,
 * because the wizard is never a second code path.
 *
 * The Retell key comes in on standard input and **never** as a command
 * argument: arguments are readable by every process on the machine and are kept
 * in shell history. An argument named for a key is refused before this module
 * is reached at all.
 *
 * **Which agent is the repository's own.** `egma/config.yaml` names it, which
 * is what makes these verbs runnable with no arguments at all in a repository
 * that has been onboarded. Which platform runs it is inferred from the same
 * place — the agent's own binding, or, for an agent that has only ever been
 * tested, the connections that reach it — and refused in plain words when Egma
 * genuinely cannot tell.
 */

import path from "node:path";

import {
  folderPathsIn,
  readConfig,
  type FolderAgent,
} from "../folder/egma-folder.ts";
import { selectFolderAgent } from "../folder/target-selection.ts";
import { wireLiveKitMonitoring } from "../monitoring/livekit-lane.ts";
import {
  MonitoringTargetRecordError,
  recordMonitoringTarget,
  type MonitoredTarget,
} from "../monitoring/record-target.ts";
import { refusalLines } from "../monitoring/refusals.ts";
import {
  MONITORING_CUSTODY_LINE,
  MONITORING_KEY_ASK_LINE,
  watchRetellAgent,
} from "../monitoring/retell-lane.ts";
import type { RegisterOptions } from "../platform/agents.ts";
import type { PlatformAccess } from "../platform/credentials.ts";
import {
  readAgentMonitoring,
  stopMonitoring,
  type AgentMonitoring,
} from "../platform/monitoring.ts";
import { signedInAt } from "../platform/signed-in.ts";
import { RetellKey } from "../retell/key.ts";
import { fromStdin } from "./connect.ts";

/** What each ending means to whoever ran the command. */
export const MONITORING_EXIT = {
  /** The switch is where the command asked for it to be. */
  done: 0,
  /** Nothing here to act on: this repository names no agent. */
  nothingHere: 1,
  /** Retell would not take the key. */
  invalidKey: 2,
  /** The key works and Egma found no voice agents on that account. */
  noAgents: 3,
  /** Egma did not answer, or answered and would not do it. */
  unreachable: 4,
  /**
   * Something only the caller decides was not decided: which platform runs
   * this agent, or which agent on the account to watch.
   */
  unchosen: 5,
  /** No key arrived at all. */
  noKey: 6,
  /** This machine holds no Egma key, so there is nowhere to look. */
  notSignedIn: 7,
  /** Egma would not start watching, and said which rule refused it. */
  refused: 8,
  /** Remote monitoring is ready, but its repository record did not finish. */
  repositoryRecordFailed: 9,
  /** Stopped part way through. */
  interrupted: 130,
} as const;

/** The ordinary controls and the record-only recovery for a partial setup. */
export const MONITORING_ACTIONS = ["enable", "disable", "status", "record"] as const;
export type MonitoringAction = (typeof MONITORING_ACTIONS)[number];

/** What a developer is told when they named something else. */
export function unknownActionRefusal(said: string): string {
  return (
    `"${said}" is not something egma monitoring does. Run egma monitoring ` +
    `${MONITORING_ACTIONS.join(", ")}.`
  );
}

/** The two platforms this verb can be told about, spelt as a developer spells them. */
const PLATFORM_WORDS = ["retell", "livekit"] as const;
type PlatformWord = (typeof PLATFORM_WORDS)[number];

/** What a developer is told when `--platform` said something else. */
export function unknownPlatformRefusal(said: string): string {
  return (
    `"${said}" is not a platform Egma monitors. Say --platform ` +
    `${PLATFORM_WORDS.join(" or --platform ")}.`
  );
}

/** What a developer is told when Egma cannot work the platform out for itself. */
export const CANNOT_TELL_PLATFORM =
  "Egma cannot tell which platform runs this agent, so it did nothing. Say " +
  "--platform retell or --platform livekit.";

/** What a developer is told when the repository names no agent. */
export const NO_AGENT_HERE =
  "This repository's egma/config.yaml names no agent, so Egma does not know " +
  "which agent this is about. Run the wizard, or egma connect, first.";

export type MonitoringCommandOptions = {
  /** Which Egma, and where this machine's key is. Resolved once, by the caller. */
  readonly access: PlatformAccess;
  readonly cwd: string;
  readonly action: MonitoringAction;
  /** Exact committed agent name or stable id. Required when several are configured. */
  readonly agent: string | null;
  /** `--platform`, when one was named. */
  readonly platform: string | null;
  /** `--platform-agent`, when the account holds more than one. */
  readonly platformAgentId: string | null;
  /** `--name`: what to call the agent row, when Egma writes one. */
  readonly name: string | null;
  readonly signal: AbortSignal;
  readonly out: (line: string) => void;
  readonly fail: (line: string) => void;
  /** Standard input, read only when it is not a terminal. */
  readonly stdin?: NodeJS.ReadableStream & { readonly isTTY?: boolean };
  readonly fetchImpl?: RegisterOptions["fetchImpl"];
};

/** The word `--platform` said, `null` when it said nothing, or the mistake. */
function platformIn(
  said: string | null,
): PlatformWord | null | { readonly said: string } {
  const word = (said ?? "").trim().toLowerCase();
  if (word === "") return null;
  return (PLATFORM_WORDS as readonly string[]).includes(word)
    ? (word as PlatformWord)
    : { said: word };
}

/**
 * Which platform runs the agent this repository names, worked out rather than
 * asked for.
 *
 * The agent's own binding answers first, because it is the fact monitoring
 * writes and reads. An agent that has only ever been tested holds none, and its
 * connections do — so they answer next, and only when they agree with each
 * other. Anything else is Egma not knowing, which it says.
 */
function inferredPlatform(agent: AgentMonitoring): PlatformWord | null {
  const platformOf = (named: string): PlatformWord | null =>
    named === "retell" ? "retell" : named === "livekit" ? "livekit" : null;

  if (agent.agentPlatform !== null) return platformOf(agent.agentPlatform);

  const reached = [
    ...new Set(agent.connectionPlatforms.flatMap((one) => platformOf(one) ?? [])),
  ];
  return reached.length === 1 ? (reached[0] as PlatformWord) : null;
}

/** What the agent's row says about itself, printed the one way. */
function sayMonitoring(
  out: (line: string) => void,
  state: {
    readonly agentId: string;
    readonly pullProductionCalls: boolean;
    readonly agentPlatform: string | null;
    readonly platformAgentId: string | null;
    readonly monitoringApiKeyHint: string | null;
    readonly lastReceivedAt: string | null;
  },
): void {
  out(`agent_id: ${state.agentId}`);
  // The switch, then the binding it needs to be true, then the key it spends,
  // then the one fact that says anything is really arriving. `none` rather than
  // an absent line, so a reader can tell an empty answer from an older Egma.
  out(`pull_production_calls: ${state.pullProductionCalls ? "on" : "off"}`);
  out(`agent_platform: ${state.agentPlatform ?? "none"}`);
  out(`platform_agent_id: ${state.platformAgentId ?? "none"}`);
  out(`monitoring_key: ${state.monitoringApiKeyHint ?? "none"}`);
  out(`last_received_at: ${state.lastReceivedAt ?? "never"}`);
}

/** The agent this repository is about, or the refusal that there is none. */
async function theRepositoryAgent(
  options: MonitoringCommandOptions,
  platform: RegisterOptions,
): Promise<
  | { readonly kind: "agent"; readonly agent: AgentMonitoring }
  | { readonly kind: "none"; readonly name: string | null }
  | {
      readonly kind: "refused";
      readonly code: number;
      /** The word the `status:` line says, so each refusal is its own. */
      readonly status: string;
      readonly reason: string;
      readonly choices?: readonly FolderAgent[];
    }
> {
  const config = await readConfig(folderPathsIn(options.cwd).config).catch(
    () => null,
  );
  const agents = config?.agents ?? [];
  const choice = selectFolderAgent(agents, options.agent);
  let named: FolderAgent | null;
  switch (choice.kind) {
    case "selected":
      named = choice.agent;
      break;
    case "none":
      named = null;
      break;
    case "unknown":
      return {
        kind: "refused",
        code: MONITORING_EXIT.unchosen,
        status: "unknown-agent",
        reason: `No configured voice agent exactly matches ${JSON.stringify((options.agent ?? "").trim())}. Choose one with --agent <name-or-id>. Nothing was changed.`,
        choices: choice.choices,
      };
    case "ambiguous":
      return {
        kind: "refused",
        code: MONITORING_EXIT.unchosen,
        status: "ambiguous-agent",
        reason: `${JSON.stringify((options.agent ?? "").trim())} matches more than one configured voice agent. Use its stable id with --agent. Nothing was changed.`,
        choices: choice.choices,
      };
    case "unchosen":
      return {
        kind: "refused",
        code: MONITORING_EXIT.unchosen,
        status: "unchosen-agent",
        reason: `This folder names ${String(choice.choices.length)} voice agents. Choose one with --agent <name-or-id>. Nothing was changed.`,
        choices: choice.choices,
      };
  }
  const agentId = named?.id ?? null;
  if (agentId === null || agentId === "") {
    return { kind: "none", name: named?.name ?? null };
  }

  const read = await readAgentMonitoring(agentId, platform);
  switch (read.kind) {
    case "monitoring":
      return { kind: "agent", agent: read.monitoring };
    case "not-found":
      return {
        kind: "refused",
        code: MONITORING_EXIT.nothingHere,
        status: "no-agent",
        reason:
          `Egma has no agent ${agentId} in this project, and that is the agent ` +
          "this repository names. Check which project this machine is signed in to.",
      };
    case "not-authenticated":
      return {
        kind: "refused",
        code: MONITORING_EXIT.notSignedIn,
        status: "not-signed-in",
        reason: `This machine holds no Egma key for ${options.access.url}. Run egma login, then try again.`,
      };
    case "refused":
    case "unreachable":
      return {
        kind: "refused",
        code: MONITORING_EXIT.unreachable,
        status: "failed",
        reason: read.reason,
      };
  }
}

/**
 * Record a completed remote setup without hiding its receipt when this final
 * local step fails. Callers print the stable agent facts, and LiveKit's worker
 * configuration, before reaching this boundary.
 */
async function recordMonitoringReceipt(
  options: MonitoringCommandOptions,
  platform: RegisterOptions,
  target: MonitoredTarget,
): Promise<number | null> {
  try {
    await recordMonitoringTarget({
      cwd: options.cwd,
      signedIn: platform,
      target,
      fetchImpl: options.fetchImpl,
    });
    return null;
  } catch (cause) {
    const detail =
      cause instanceof MonitoringTargetRecordError
        ? cause.message
        : `could not finish the repository record: ${cause instanceof Error ? cause.message : String(cause)}`;
    const reason =
      `Egma finished remote monitoring setup for agent ${target.id}, but ${detail} The remote setup remains active. ` +
      `Keep the receipt above. After the repository or Egma connection is fixed, run egma monitoring record --agent ${target.id} --url ${platform.url}. ` +
      "That recovery command does not create an agent or mint a key.";
    options.out("status: repository-record-failed");
    options.out(`reason: ${reason}`);
    options.fail(reason);
    return MONITORING_EXIT.repositoryRecordFailed;
  }
}

/** Recover only the local catalog entry for an already-created Egma agent. */
async function recordExistingMonitoringTarget(
  options: MonitoringCommandOptions,
  platform: RegisterOptions,
): Promise<number> {
  const agentId = (options.agent ?? "").trim();
  if (agentId === "") {
    options.out("status: unchosen-agent");
    options.fail(
      "Name the stable Egma agent id from the earlier receipt with --agent. Nothing was changed.",
    );
    return MONITORING_EXIT.unchosen;
  }

  const read = await readAgentMonitoring(agentId, platform);
  switch (read.kind) {
    case "monitoring": {
      options.out(`agent_id: ${read.monitoring.agentId}`);
      options.out(`agent_name: ${read.monitoring.agentName}`);
      options.out(`project_id: ${read.monitoring.projectId}`);
      try {
        await recordMonitoringTarget({
          cwd: options.cwd,
          signedIn: platform,
          target: {
            id: read.monitoring.agentId,
            name: read.monitoring.agentName,
            projectId: read.monitoring.projectId,
          },
          fetchImpl: options.fetchImpl,
        });
      } catch (cause) {
        const detail =
          cause instanceof MonitoringTargetRecordError
            ? cause.message
            : cause instanceof Error
              ? cause.message
              : String(cause);
        options.out("status: repository-record-failed");
        options.out(`reason: ${detail}`);
        options.fail(
          `Egma changed no remote monitoring setup, but the repository record still failed: ${detail}`,
        );
        return MONITORING_EXIT.repositoryRecordFailed;
      }
      options.out("status: recorded");
      return MONITORING_EXIT.done;
    }
    case "not-found":
      options.out("status: no-agent");
      options.fail(
        `Egma has no agent ${agentId} in this project. Copy the stable agent id from the earlier receipt and try again.`,
      );
      return MONITORING_EXIT.nothingHere;
    case "not-authenticated":
      options.out("status: not-signed-in");
      options.fail(
        `This machine holds no Egma key for ${options.access.url}. Run egma login, then try again.`,
      );
      return MONITORING_EXIT.notSignedIn;
    case "refused":
    case "unreachable":
      options.out("status: failed");
      options.out(`reason: ${read.reason}`);
      options.fail(read.reason);
      return MONITORING_EXIT.unreachable;
  }
}

export async function runMonitoringCommand(
  options: MonitoringCommandOptions,
): Promise<number> {
  const named = platformIn(options.platform);
  if (named !== null && typeof named === "object") {
    options.out("status: unchosen");
    options.fail(unknownPlatformRefusal(named.said));
    return MONITORING_EXIT.unchosen;
  }

  options.out(`url: ${options.access.url}`);

  const signedIn = await signedInAt(options.access);
  if (signedIn === null) {
    options.out("status: not-signed-in");
    options.fail(
      `This machine holds no Egma key for ${options.access.url}. Run egma login, then try again.`,
    );
    return MONITORING_EXIT.notSignedIn;
  }

  const platform: RegisterOptions = {
    url: signedIn.url,
    key: signedIn.key,
    signal: options.signal,
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
  };

  if (options.action === "record") {
    return recordExistingMonitoringTarget(options, platform);
  }

  const held = await theRepositoryAgent(options, platform);
  if (held.kind === "refused") {
    for (const agent of held.choices ?? []) {
      options.out(`agent-option: ${agent.id} ${agent.name}`);
    }
    options.out(`status: ${held.status}`);
    options.out(`reason: ${held.reason}`);
    options.fail(held.reason);
    return held.code;
  }

  const agent = held.kind === "agent" ? held.agent : null;
  if (agent !== null) options.out(`agent_name: ${agent.agentName}`);

  // Reading and stopping both need an agent to act on. Starting does not: it
  // can write the row it is about, which is what onboarding a repository that
  // only ever pushes looks like.
  const nothingHere = (): number => {
    options.out("status: no-agent");
    options.fail(NO_AGENT_HERE);
    return MONITORING_EXIT.nothingHere;
  };

  if (options.action === "status") {
    if (agent === null) return nothingHere();
    sayMonitoring(options.out, agent);
    options.out("status: read");
    return MONITORING_EXIT.done;
  }

  if (options.action === "disable") {
    if (agent === null) return nothingHere();
    const stopped = await stopMonitoring(agent.agentId, platform);
    switch (stopped.kind) {
      case "stopped":
        // Everything stored stays stored: the transcripts, the binding and the
        // sealed key are all still there, and the lines below say so.
        sayMonitoring(options.out, stopped.monitoring);
        options.out("status: disabled");
        return MONITORING_EXIT.done;
      case "not-found":
        return nothingHere();
      case "not-authenticated":
        options.out("status: not-signed-in");
        options.fail(
          `This machine holds no Egma key for ${options.access.url}. Run egma login, then try again.`,
        );
        return MONITORING_EXIT.notSignedIn;
      case "refused":
      case "unreachable":
        options.out("status: failed");
        options.out(`reason: ${stopped.reason}`);
        options.fail(stopped.reason);
        return MONITORING_EXIT.unreachable;
    }
  }

  const runs =
    named ?? (agent === null ? null : inferredPlatform(agent));
  if (runs === null) {
    options.out("status: unchosen");
    options.fail(CANNOT_TELL_PLATFORM);
    return MONITORING_EXIT.unchosen;
  }
  options.out(`platform: ${runs}`);

  return runs === "retell"
    ? enableRetell(options, platform, agent)
    : enableLiveKit(options, platform, agent, held.kind === "none" ? held.name : null);
}

/** Start pulling one Retell agent's production calls, promptless. */
async function enableRetell(
  options: MonitoringCommandOptions,
  platform: RegisterOptions,
  agent: AgentMonitoring | null,
): Promise<number> {
  // Read once, before anything else could consume it, and held in one local for
  // the length of the command.
  const typed = await fromStdin(options.stdin);
  let asked = false;

  const outcome = await watchRetellAgent({
    platform,
    signal: options.signal,
    say: (line) => options.out(`note: ${line}`),
    /*
     * The wizard waits briefly for the first conversation because a person is
     * sitting in front of it and proof beats a promise. Nobody is sitting in
     * front of this, and a verb that held a script for twenty seconds to
     * report a fact the script can ask for whenever it likes would be paying
     * that cost on every call. So it asks once and says what it found;
     * `egma monitoring status` is where arrivals are read afterwards.
     */
    waitMs: 0,
    ...(agent === null ? {} : { agentId: agent.agentId }),
    agentName: options.name ?? agent?.agentName ?? null,
    askForKey: () => {
      // The same two lines the wizard's screen draws, so a coding agent reading
      // this is told exactly what a person is told. There is nobody to ask
      // twice, so a second ask answers with nothing and the flow ends.
      if (asked) return Promise.resolve(null);
      asked = true;
      options.out(`note: ${MONITORING_KEY_ASK_LINE}`);
      options.out(`note: ${MONITORING_CUSTODY_LINE}`);
      return Promise.resolve(RetellKey.from(typed));
    },
    chooseAgent: (agents) => {
      for (const one of agents) {
        options.out(
          `monitoring_agent: ${one.platformAgentId} ${one.name} ` +
            `${one.registeredAgentName ?? "unregistered"} ` +
            `${one.pullProductionCalls ? "watched" : "unwatched"}`,
        );
      }
      const wanted =
        options.platformAgentId?.trim() ??
        agent?.platformAgentId ??
        agent?.connectionPlatformAgentIds[0] ??
        "";
      return Promise.resolve(wanted === "" ? null : wanted);
    },
  });

  switch (outcome.kind) {
    case "watching": {
      options.out(`agent_id: ${outcome.agentId}`);
      options.out(`agent_name: ${outcome.agentName}`);
      options.out(`project_id: ${outcome.projectId}`);
      options.out(`platform_agent_id: ${outcome.platformAgentId}`);
      options.out(`agent_registration: ${outcome.created ? "created" : "reused"}`);
      options.out("pull_production_calls: on");
      // Proof rather than a promise, and an empty account is not a failure.
      options.out(`first_conversation: ${outcome.arrived ? "arrived" : "none-yet"}`);
      const localFailure = await recordMonitoringReceipt(options, platform, {
        id: outcome.agentId,
        name: outcome.agentName,
        projectId: outcome.projectId,
      });
      if (localFailure !== null) return localFailure;
      options.out("status: watching");
      return MONITORING_EXIT.done;
    }
    case "no-key":
      options.out("status: no-key");
      options.fail(
        "No Retell key was given, or what arrived was too short to be one. Send it on standard input.",
      );
      return MONITORING_EXIT.noKey;
    case "invalid-key":
      options.out("status: invalid-key");
      options.out(`reason: ${outcome.reason}`);
      options.fail(outcome.reason);
      return MONITORING_EXIT.invalidKey;
    case "no-agents":
      options.out("status: no-agents");
      options.fail(
        "That key works, and Egma found no voice agents on the Retell account it belongs to.",
      );
      return MONITORING_EXIT.noAgents;
    case "unchosen":
      options.out("status: unchosen");
      options.fail(
        `That key reaches ${outcome.agents.length} voice agents. Name the one Egma ` +
          "should watch with --platform-agent. Nothing was changed.",
      );
      return MONITORING_EXIT.unchosen;
    case "refused-start": {
      const lines = refusalLines(outcome.refusal);
      options.out(`refusal: ${outcome.refusal.reason}`);
      options.out("status: refused");
      // Egma's own sentence for whoever has to act, then the platform's own
      // relayed word for word for whatever is reading rather than looking.
      for (const line of lines) options.out(`reason: ${line}`);
      for (const line of lines) options.fail(line);
      return MONITORING_EXIT.refused;
    }
    case "interrupted":
      options.out("status: interrupted");
      options.fail("The egma monitoring command was stopped before it finished.");
      return MONITORING_EXIT.interrupted;
    case "failed":
      options.out("status: failed");
      options.out(`reason: ${outcome.reason}`);
      options.fail(outcome.reason);
      return MONITORING_EXIT.unreachable;
  }
}

/** Mint the key and write the two lines a LiveKit worker exports with. */
async function enableLiveKit(
  options: MonitoringCommandOptions,
  platform: RegisterOptions,
  agent: AgentMonitoring | null,
  configuredName: string | null,
): Promise<number> {
  const wired = await wireLiveKitMonitoring({
    platform,
    cwd: options.cwd,
    signal: options.signal,
    ...(agent === null ? {} : { agentId: agent.agentId }),
    agentName:
      options.name ??
      agent?.agentName ??
      configuredName ??
      path.basename(options.cwd),
    say: (line) => options.out(`note: ${line}`),
  });

  switch (wired.kind) {
    case "wired": {
      options.out(`agent_id: ${wired.agent.id}`);
      options.out(`agent_name: ${wired.agent.name}`);
      options.out(`project_id: ${wired.agent.projectId}`);
      options.out(`agent_registration: ${wired.created ? "created" : "reused"}`);
      options.out(`api_key: ${wired.keyLooksLike}`);
      options.out(`env_file: ${wired.env.kind === "written" ? wired.env.file : "none"}`);
      if (wired.env.kind === "refused") options.out(`reason: ${wired.env.reason}`);
      // The deliverable, whether the file was written or not: wherever this
      // worker really runs, these two lines are what it needs.
      for (const line of wired.lines) options.out(`env: ${line}`);
      const localFailure = await recordMonitoringReceipt(options, platform, {
        id: wired.agent.id,
        name: wired.agent.name,
        projectId: wired.agent.projectId,
      });
      if (localFailure !== null) return localFailure;
      options.out("status: wired");
      return MONITORING_EXIT.done;
    }
    case "interrupted":
      options.out("status: interrupted");
      options.fail("The egma monitoring command was stopped before it finished.");
      return MONITORING_EXIT.interrupted;
    case "failed":
      options.out("status: failed");
      options.out(`reason: ${wired.reason}`);
      options.fail(wired.reason);
      return MONITORING_EXIT.unreachable;
  }
}
