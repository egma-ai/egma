/**
 * `egma connect`: the same flow the wizard runs, with nobody watching.
 *
 * It asks nothing. What it prints is one fact per line, `name: value`, in a
 * shape that does not move, and the exit code is the branch — so a coding agent
 * can run it, read the answer, and act on it without a person relaying
 * anything.
 *
 * The key comes in on standard input or out of the environment, and **never**
 * as a command argument. Arguments are readable by every process on the machine
 * through the process table and are kept by shell history; an argument named
 * for a key is therefore refused outright rather than accepted with a warning
 * nobody reads.
 */

import {
  bindRepositoryPlatform,
  folderPathsIn,
  updateConfig,
} from "../folder/egma-folder.ts";
import { readCredentials, type PlatformAccess } from "../platform/credentials.ts";
import { readProject } from "../platform/projects.ts";
import { RetellKey } from "../retell/key.ts";
import {
  connect,
  CUSTODY_LINE,
  KEY_ASK_LINE,
  keyAskLines,
  NO_NUMBERS_LINE,
  NUMBER_ASK_LINE,
  REACH_ASK_LINE,
  REACH_LINES,
  registrationLine,
  type ConnectOptions,
  type ConnectOutcome,
  type Reach,
} from "../retell/connect.ts";
import { DRIFT_LINE } from "../retell/prompt-drift.ts";

/** What each ending means to whoever ran the command. */
export const CONNECT_EXIT = {
  /** The agent and a connection are on egma. */
  connected: 0,
  /** Retell would not take the key, twice. */
  invalidKey: 2,
  /** The key works and the account has no agents on it, twice. */
  noAgents: 3,
  /**
   * Retell or egma did not answer, or answered and would not do it.
   *
   * One number for both, because both mean the same thing to whoever ran the
   * command: asking again the same way will not help, and a person has to
   * look. The `reason:` line tells them apart for anything that reads.
   */
  unreachable: 4,
  /**
   * Something the developer alone decides was not decided.
   *
   * One number for four questions — which agent, text or phone, which number,
   * and a number that is not one of the ones offered — because they mean one
   * thing to whoever ran the command: egma will not choose on their behalf, and
   * the answer goes in the command. The `status:` line says which question it
   * was, and the lines above it list what there was to choose from.
   */
  unchosen: 5,
  /** No key was given at all. */
  noKey: 6,
  /** This machine holds no egma key, so there is nowhere to register. */
  notSignedIn: 7,
  /** Retell routes no number to the chosen agent, so the phone reaches nothing. */
  noNumbers: 8,
  /** Stopped part way through. */
  interrupted: 130,
} as const;

/** The environment variables the key may arrive in, in the order they are read. */
export const KEY_VARIABLES = ["EGMA_RETELL_API_KEY", "RETELL_API_KEY"] as const;

/** The environment variable that names which agent, when the account has several. */
export const AGENT_VARIABLE = "EGMA_RETELL_AGENT_ID";

/** The environment variable that says whether egma reaches the agent by text or phone. */
export const REACH_VARIABLE = "EGMA_REACH";

/** The environment variable that names the number to dial, when several reach the agent. */
export const NUMBER_VARIABLE = "EGMA_PHONE_NUMBER";

/** What a developer is told when what they said is not one of the two ways. */
export function unknownReachRefusal(said: string): string {
  return (
    `"${said}" is not a way Egma reaches an agent. Say --reach text or ` +
    `--reach phone, or set ${REACH_VARIABLE}.`
  );
}

/** The way that was named, `null` when none was, or the word that was not one. */
export function reachIn(
  named: string | null | undefined,
): { readonly kind: "reach"; readonly reach: Reach } | { readonly kind: "unknown"; readonly said: string } | null {
  const said = (named ?? "").trim().toLowerCase();
  if (said === "") return null;
  if (said === "text" || said === "phone") return { kind: "reach", reach: said };
  return { kind: "unknown", said };
}

/** Argument names that would put a secret in the process table. */
const REFUSED_ARGUMENTS = ["--key", "--api-key", "--retell-key", "--retell-api-key"];

/** What a developer is told when they tried to pass the key as an argument. */
export function argumentRefusal(argument: string): string {
  return [
    `Egma will not take a key in ${argument}. Command arguments are readable by every process on this machine and are kept in shell history.`,
    "",
    "Send it on standard input instead:",
    "",
    "  cat retell-key.txt | egma connect",
    "",
    `or set ${KEY_VARIABLES[0]} in the environment of this one command.`,
  ].join("\n");
}

export type ConnectCommandOptions = {
  /** Which egma, and where this machine's key is. Resolved once, by the caller. */
  readonly access: PlatformAccess;
  /** The folder a repository prompt path is resolved against. */
  readonly cwd: string;
  /** `--retell-agent`, when one was named. */
  readonly agentId: string | null;
  /** `--reach`: text or phone. Nothing is created when neither was said. */
  readonly reach: string | null;
  /** `--phone-number`: which number to dial, when several reach the agent. */
  readonly phoneNumber: string | null;
  /** `--repo-prompt`: the file to compare what the provider runs against. */
  readonly repoPrompt: string | null;
  readonly env: NodeJS.ProcessEnv;
  readonly signal: AbortSignal;
  readonly out: (line: string) => void;
  readonly fail: (line: string) => void;
  /** Everything typed after the verb, checked for a key nobody should have typed. */
  readonly argv?: readonly string[];
  /** Standard input, read only when it is not a terminal. */
  readonly stdin?: NodeJS.ReadableStream & { readonly isTTY?: boolean };
  readonly retell?: ConnectOptions["retell"];
  readonly fetchImpl?: ConnectOptions["fetchImpl"];
};

/** The argument that would have leaked a key, or `null` when there is none. */
export function refusedArgumentIn(argv: readonly string[]): string | null {
  for (const argument of argv) {
    const name = argument.split("=")[0] ?? argument;
    if (REFUSED_ARGUMENTS.includes(name)) return name;
  }
  return null;
}

/**
 * Everything on standard input, or nothing at all when it is a terminal.
 *
 * Exported because every verb that takes a secret takes it here and nowhere
 * else. Arguments are readable by every process on the machine and are kept in
 * shell history, so a second verb reading a key its own way would be a second
 * chance to get that wrong.
 */
export async function fromStdin(
  stdin: (NodeJS.ReadableStream & { readonly isTTY?: boolean }) | undefined,
): Promise<string> {
  if (stdin === undefined || stdin.isTTY === true) return "";
  const chunks: Buffer[] = [];
  for await (const chunk of stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

function fromEnv(env: NodeJS.ProcessEnv): string {
  for (const variable of KEY_VARIABLES) {
    const held = env[variable];
    if (typeof held === "string" && held.trim() !== "") return held;
  }
  return "";
}

function exitCodeFor(outcome: ConnectOutcome): number {
  switch (outcome.kind) {
    case "connected":
      return CONNECT_EXIT.connected;
    case "invalid-key":
      return CONNECT_EXIT.invalidKey;
    case "no-agents":
      return CONNECT_EXIT.noAgents;
    case "unchosen":
    case "unchosen-reach":
    case "incompatible-reach":
    case "unchosen-number":
      return CONNECT_EXIT.unchosen;
    case "no-numbers":
      return CONNECT_EXIT.noNumbers;
    case "no-key":
      return CONNECT_EXIT.noKey;
    case "interrupted":
      return CONNECT_EXIT.interrupted;
    case "failed":
      return CONNECT_EXIT.unreachable;
  }
}

/** What the drift comparison is worth to something reading rather than looking. */
function driftLine(outcome: Extract<ConnectOutcome, { kind: "connected" }>): string {
  switch (outcome.drift) {
    case "differs":
      return "drift: yes";
    case "same":
      return "drift: no";
    case "not-compared":
      return "drift: not-compared";
  }
}

export async function runConnectCommand(options: ConnectCommandOptions): Promise<number> {
  const refused = refusedArgumentIn(options.argv ?? []);
  if (refused !== null) {
    options.fail(argumentRefusal(refused));
    return CONNECT_EXIT.noKey;
  }

  // Said before anything is read, because a word egma does not know is the
  // developer's own typo and finding out after a key has been sent to Retell
  // would cost them the round trip.
  const named = reachIn(options.reach ?? options.env[REACH_VARIABLE]);
  if (named !== null && named.kind === "unknown") {
    options.out("status: unchosen");
    options.fail(unknownReachRefusal(named.said));
    return CONNECT_EXIT.unchosen;
  }

  options.out(`url: ${options.access.url}`);

  const held = await readCredentials(options.access.credentialsFile, options.access.url);
  if (held === null) {
    options.out("status: not-signed-in");
    options.fail(
      `This machine holds no Egma key for ${options.access.url}. Run egma login, then try again.`,
    );
    return CONNECT_EXIT.notSignedIn;
  }

  // Read once, before anything else could consume it, and held in one local
  // for the length of the command.
  const typed = (await fromStdin(options.stdin)) || fromEnv(options.env);
  let asked = false;

  // A binding written before the key was even read would leave an egma folder
  // behind every time this command ends at "no key given" — which is the same
  // wart the wizard used to have, and it belongs here for the same reason it
  // belonged there. So the binding is written from inside the flow, at the one
  // moment after which this repository owns something only this platform can
  // resolve.
  const binding: { refused: Error | null } = { refused: null };

  const attempt = connect({
    platform: { url: held.url, key: held.key },
    cwd: options.cwd,
    repoPrompts: options.repoPrompt,
    signal: options.signal,
    retell: options.retell,
    fetchImpl: options.fetchImpl,
    say: (line) => options.out(`note: ${line}`),
    beforeRegistering: async () => {
      try {
        await bindRepositoryPlatform(options.cwd, {
          origin: options.access.url,
        });
      } catch (cause) {
        // Carried out rather than answered from in here: the flow has no
        // ending for this, and an agent must not be registered on a platform
        // this repository has already refused.
        binding.refused = cause instanceof Error ? cause : new Error(String(cause));
        throw cause;
      }
    },
    askForKey: () => {
      // The same two lines the wizard's screen draws, so a coding agent reading
      // this is told exactly what a person is told. There is nobody to ask
      // twice, so the second ask answers with nothing and the flow ends.
      if (asked) return Promise.resolve(null);
      asked = true;
      for (const line of keyAskLines({ asking: KEY_ASK_LINE, custody: CUSTODY_LINE, problem: null })) {
        options.out(`note: ${line}`);
      }
      return Promise.resolve(RetellKey.from(typed));
    },
    chooseAgent: (agents) => {
      for (const agent of agents) {
        options.out(`retell_agent: ${agent.id} ${agent.name}`.trimEnd());
      }
      const wanted = (options.agentId ?? options.env[AGENT_VARIABLE] ?? "").trim();
      return Promise.resolve(wanted === "" ? null : wanted);
    },
    // The same question the wizard's screen asks, and the same two lines, so a
    // coding agent reading this is told exactly what a person is told. There is
    // nobody here to answer it, so it is answered in the command or not at all
    // — and not at all creates nothing, which is the point.
    chooseReach: (offered) => {
      options.out(`note: ${REACH_ASK_LINE}`);
      for (const way of offered) {
        options.out(`reach_option: ${way} ${REACH_LINES[way]}`);
      }
      return Promise.resolve(named === null ? null : named.reach);
    },
    chooseNumber: (numbers) => {
      options.out(`note: ${NUMBER_ASK_LINE}`);
      for (const number of numbers) {
        options.out(`retell_number: ${number.number} ${number.label}`.trimEnd());
      }
      const wanted = (options.phoneNumber ?? options.env[NUMBER_VARIABLE] ?? "").trim();
      return Promise.resolve(wanted === "" ? null : wanted);
    },
  });

  let outcome: ConnectOutcome;
  try {
    outcome = await attempt;
  } catch (cause) {
    if (binding.refused === null) throw cause;
    options.out("status: refused");
    options.fail(binding.refused.message);
    return CONNECT_EXIT.unreachable;
  }

  switch (outcome.kind) {
    case "connected": {
      const { registered, config } = outcome;
      // The repository target is separate from its suites. Suites are created
      // through their own platform-backed command and live in manifests.
      const paths = folderPathsIn(options.cwd);
      const project = await readProject(
        { url: held.url, key: held.key },
        registered.agent.projectId,
        options.fetchImpl,
      );
      await updateConfig(paths.config, {
        project,
        agent: { name: registered.agent.name, id: registered.agent.id },
        connection: {
          name: registered.connection.name,
          id: registered.connection.id,
        },
      });
      options.out(`retell_agents: ${outcome.onTheAccount}`);
      options.out(`retell_agent_id: ${config.agentId}`);
      options.out(`retell_response_engine: ${config.engine}`);
      options.out(`prompt_characters: ${config.prompt === null ? 0 : config.prompt.length}`);
      options.out(`tools: ${config.tools.length}`);
      options.out(`reach: ${outcome.reach}`);
      // The number, or the word that there is none. Absent would read as an
      // older egma that never printed it; `none` says a Chat connection dials
      // nothing, which is a fact about the connection rather than a gap.
      options.out(`phone_number: ${outcome.number ?? "none"}`);
      options.out(`agent_id: ${registered.agent.id}`);
      options.out(`agent_name: ${registered.agent.name}`);
      options.out(`connection_id: ${registered.connection.id}`);
      options.out(`connection_name: ${registered.connection.name}`);
      options.out(`agent_platform: ${registered.connection.agentPlatform ?? "unknown"}`);
      options.out(`connection_type: ${registered.connection.connectionType}`);
      options.out(`access_variant: ${registered.connection.accessVariant}`);
      options.out(`product_label: ${registered.connection.productLabel}`);
      options.out(`connection_modality: ${registered.connection.modality}`);
      // Which of the three things egma did, as its own fact line: a coding
      // agent retrying this verb reads whether it made a second agent from
      // here rather than by counting what the platform holds.
      options.out(`registration: ${registered.result}`);
      // And the same answer split in two, because a retry cares about each
      // half: an agent that was already there with a connection that is new is
      // a different fact from both of them being new.
      options.out(`agent_registration: ${outcome.registration.agent}`);
      options.out(`connection_registration: ${outcome.registration.connection}`);
      const already = registrationLine(registered);
      if (already !== null) options.out(`note: ${already}`);
      options.out(driftLine(outcome));
      // Which half the tests will be written from, said the same way the
      // wizard says it, so neither surface can promise the other's answer.
      options.out("grounded_in: retell");
      if (outcome.drift === "differs") options.out(`note: ${DRIFT_LINE}`);
      options.out("status: connected");
      break;
    }
    case "invalid-key":
      options.out("status: invalid-key");
      options.fail("Retell would not take that key. Nothing was written.");
      break;
    case "no-agents":
      options.out("status: no-agents");
      options.fail("That key works, and the Retell account it belongs to has no agents on it.");
      break;
    case "unchosen":
      options.out(`retell_agents: ${outcome.agents.length}`);
      options.out("status: unchosen");
      options.fail(
        `That key reaches ${outcome.agents.length} agents. Name one with --retell-agent, or with ${AGENT_VARIABLE}.`,
      );
      break;
    case "unchosen-reach":
      options.out("status: unchosen-reach");
      options.fail(
        `Choose ${outcome.offered.map((reach) => `--reach ${reach}`).join(" or ")}, ` +
          `or set ${REACH_VARIABLE}. Nothing was written.`,
      );
      break;
    case "incompatible-reach":
      options.out(`compatible_reach: ${outcome.compatible}`);
      options.out("status: incompatible-reach");
      options.fail(outcome.reason);
      break;
    case "unchosen-number":
      options.out(`retell_numbers: ${outcome.numbers.length}`);
      options.out("status: unchosen-number");
      options.fail(
        `Retell routes ${outcome.numbers.length} numbers to that agent. Name the one Egma ` +
          `should dial with --phone-number, or with ${NUMBER_VARIABLE}. Nothing was written.`,
      );
      break;
    case "no-numbers":
      options.out("status: no-numbers");
      options.fail(NO_NUMBERS_LINE);
      break;
    case "no-key":
      options.out("status: no-key");
      options.fail(
        `No Retell key was given, or what arrived was too short to be one. Send it on standard input, or set ${KEY_VARIABLES[0]}.`,
      );
      break;
    case "interrupted":
      options.out("status: interrupted");
      options.fail("The egma connect command was stopped before it finished. Nothing was written.");
      break;
    case "failed":
      options.out("status: failed");
      options.out(`reason: ${outcome.reason}`);
      options.fail(outcome.reason);
      break;
  }

  return exitCodeFor(outcome);
}
