/**
 * `egma monitoring enable | disable | status`: the wizard's monitoring work,
 * with nobody watching.
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

import { folderPathsIn, readConfig } from "../folder/egma-folder.ts";
import { wireLiveKitMonitoring } from "../monitoring/livekit-lane.ts";
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
  /** Stopped part way through. */
  interrupted: 130,
} as const;

/** The three things this verb does, and no fourth. */
export const MONITORING_ACTIONS = ["enable", "disable", "status"] as const;
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
    named === "retell" ? "retell" : named === "livekit_agents" ? "livekit" : null;

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
  | { readonly kind: "refused"; readonly code: number; readonly reason: string }
> {
  const config = await readConfig(folderPathsIn(options.cwd).config).catch(
    () => null,
  );
  const named = config?.agent ?? null;
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
        reason:
          `Egma has no agent ${agentId} in this project, and that is the agent ` +
          "this repository names. Check which project this machine is signed in to.",
      };
    case "not-authenticated":
      return {
        kind: "refused",
        code: MONITORING_EXIT.notSignedIn,
        reason: `This machine holds no Egma key for ${options.access.url}. Run egma login, then try again.`,
      };
    case "refused":
    case "unreachable":
      return {
        kind: "refused",
        code: MONITORING_EXIT.unreachable,
        reason: read.reason,
      };
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

  const held = await theRepositoryAgent(options, platform);
  if (held.kind === "refused") {
    options.out("status: refused");
    options.out(`reason: ${held.reason}`);
    options.fail(held.reason);
    return held.code;
  }

  // Reading and stopping both need an agent to act on. Starting does not: it
  // can write the row it is about, which is what onboarding a repository that
  // only ever pushes looks like.
  if (held.kind === "none" && options.action !== "enable") {
    options.out("status: no-agent");
    options.fail(NO_AGENT_HERE);
    return MONITORING_EXIT.nothingHere;
  }

  const agent = held.kind === "agent" ? held.agent : null;
  if (agent !== null) options.out(`agent_name: ${agent.agentName}`);

  if (options.action === "status") {
    sayMonitoring(options.out, agent as AgentMonitoring);
    options.out("status: read");
    return MONITORING_EXIT.done;
  }

  if (options.action === "disable") {
    const stopped = await stopMonitoring((agent as AgentMonitoring).agentId, platform);
    switch (stopped.kind) {
      case "stopped":
        // Everything stored stays stored: the transcripts, the binding and the
        // sealed key are all still there, and the lines below say so.
        sayMonitoring(options.out, stopped.monitoring);
        options.out("status: disabled");
        return MONITORING_EXIT.done;
      case "not-found":
        options.out("status: no-agent");
        options.fail(NO_AGENT_HERE);
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
    case "watching":
      options.out(`agent_id: ${outcome.agentId}`);
      options.out(`agent_name: ${outcome.agentName}`);
      options.out(`platform_agent_id: ${outcome.platformAgentId}`);
      options.out(`agent_registration: ${outcome.created ? "created" : "reused"}`);
      options.out("pull_production_calls: on");
      // Proof rather than a promise, and an empty account is not a failure.
      options.out(`first_conversation: ${outcome.arrived ? "arrived" : "none-yet"}`);
      options.out("status: watching");
      return MONITORING_EXIT.done;
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
    case "wired":
      options.out(`agent_id: ${wired.agent.id}`);
      options.out(`agent_name: ${wired.agent.name}`);
      options.out(`agent_registration: ${wired.created ? "created" : "reused"}`);
      options.out(`api_key: ${wired.keyLooksLike}`);
      options.out(`env_file: ${wired.env.kind === "written" ? wired.env.file : "none"}`);
      if (wired.env.kind === "refused") options.out(`reason: ${wired.env.reason}`);
      // The deliverable, whether the file was written or not: wherever this
      // worker really runs, these two lines are what it needs.
      for (const line of wired.lines) options.out(`env: ${line}`);
      options.out("status: wired");
      return MONITORING_EXIT.done;
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
