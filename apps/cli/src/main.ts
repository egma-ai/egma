/**
 * What `egma` does with the words after it.
 *
 * A bare invocation runs the wizard. Everything else is a flag on the same
 * walk, because the wizard is a skin over the same code and never a second path
 * through it.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

import {
  discoverCodingAgents,
  installedCodingAgent,
  supportedCodingAgentId,
  SUPPORTED_CODING_AGENT_IDS,
  type DrivenAgentLaunch,
  type InstalledCodingAgent,
} from "./acp/coding-agents.ts";
import {
  AGENT_VARIABLE,
  argumentRefusal,
  KEY_VARIABLES,
  NUMBER_VARIABLE,
  REACH_VARIABLE,
  refusedArgumentIn,
  runConnectCommand,
} from "./commands/connect.ts";
import type { FolderCommandOptions } from "./commands/folder-verbs.ts";
import { runInitCommand } from "./commands/init.ts";
import { runLoginCommand } from "./commands/login.ts";
import {
  MONITORING_ACTIONS,
  runMonitoringCommand,
  unknownActionRefusal,
  type MonitoringAction,
} from "./commands/monitoring.ts";
import { runPullCommand } from "./commands/pull.ts";
import { runPushCommand } from "./commands/push.ts";
import { runRunCommand } from "./commands/run.ts";
import { runSuiteCreateCommand } from "./commands/suite.ts";
import {
  isSelfHostInvocation,
  runSelfHostCommand,
} from "./commands/self-host.ts";
import type { PlatformBinding } from "./folder/egma-folder.ts";
import {
  BoundPlatformAddressError,
  choosePlatform,
  credentialsFileIn,
  KEYS_UNUSABLE,
  KeysUnusableError,
  RepositoryPlatformConfigError,
  UnboundPlatformIdentifiersError,
  UnusableUrlError,
  type ChosenPlatform,
  type PlatformAccess,
} from "./platform/credentials.ts";
import { PlatformUnreachableError } from "./platform/device-flow.ts";
import { RETELL_API } from "./retell/client.ts";
import { HeadlessUI } from "./ui/headless-ui.ts";
import { walkExitCode } from "./wizard/exit-code.ts";
import { buildExitNotice, exitLines, type ExitReport } from "./wizard/exit-line.ts";
import type { WizardPlatform } from "./wizard/login-step.ts";
import { pasteFallbackMessage } from "./wizard/no-coding-agent.ts";
import type { StopReason } from "./wizard/stop.ts";
import type { WizardCodingAgent } from "./wizard/wizard-flow.ts";

/**
 * The wizard's machinery arrives through a dynamic import, and the verbs never
 * ask for it.
 *
 * A terminal renderer and a protocol client are the two most expensive things
 * this package loads, and a headless verb uses neither — it prints lines and
 * talks to egma over HTTP. Loading them anyway put a quarter of a second in
 * front of every `egma login`, `egma pull` and `egma push`, which is time a
 * coding agent driving the product pays on every single call.
 */
async function wizardMachinery(): Promise<{
  readonly startTui: typeof import("./ui/tui/start-tui.ts").startTui;
  readonly runWizard: typeof import("./wizard/wizard-flow.ts").runWizard;
}> {
  const [{ startTui }, { runWizard }] = await Promise.all([
    import("./ui/tui/start-tui.ts"),
    import("./wizard/wizard-flow.ts"),
  ]);
  return { startTui, runWizard };
}

/**
 * The verbs. A bare `egma` runs the wizard; naming one runs it headlessly,
 * because a verb is what a coding agent types and a coding agent has no
 * keystroke to give.
 */
export const VERBS = [
  "login",
  "connect",
  "init",
  "pull",
  "push",
  "run",
  "suite",
  "monitoring",
] as const;

/**
 * The Retell the CLI talks to, for a check that stands one in.
 *
 * It is read here rather than deep in the client so that there is one place
 * where "which Retell" is decided, exactly as there is one for which egma.
 */
export const RETELL_URL_VARIABLE = "EGMA_RETELL_URL";

/** The test cases a headless walk would have been pointed at. */
export const EXISTING_TESTS_VARIABLE = "EGMA_EXISTING_TESTS";

export type Verb = (typeof VERBS)[number];

export type Invocation = {
  readonly help: boolean;
  readonly version: boolean;
  /** The verb that was named, or `null` for the wizard. */
  readonly verb: Verb | null;
  /** The developer has said, in the command, to run with nobody watching. */
  readonly headless: boolean;
  readonly drivenAgentId: string;
  /**
   * The developer said which coding agent this is, rather than taking the
   * default. It matters for one thing: what egma calls the agent it drove, and
   * therefore where it would put a skill for it.
   */
  readonly drivenAgentNamed: boolean;
  readonly cwd: string | null;
  /** `--url`: which egma to talk to, when it is not egma's own. */
  readonly url: string | null;
  /** `--force`: do the work again even though it has been done. */
  readonly force: boolean;
  /** `--no-follow`: with run, start it and return without waiting. */
  readonly noFollow: boolean;
  /** `--retell-agent`: which agent, when the account holds several. */
  readonly retellAgentId: string | null;
  /** `--reach`: whether egma reaches the agent by text or by phone. */
  readonly reach: string | null;
  /** `--phone-number`: which number to dial, when several reach the agent. */
  readonly phoneNumber: string | null;
  /** `--repo-prompt`: the repository's prompt, to compare the provider's with. */
  readonly repoPrompt: string | null;
  /** `--existing-tests`: the test cases the developer already had written down. */
  readonly existingTests: string | null;
  /** What `egma init` should write into the folder's config file. */
  readonly agentName: string | null;
  readonly connectionName: string | null;
  /** The only suite subcommand this CLI exposes. */
  readonly suiteAction: string | null;
  /** Which of the three things `egma monitoring` does. */
  readonly monitoringAction: string | null;
  /** `--platform`: which platform runs this agent, when Egma cannot tell. */
  readonly platformWord: string | null;
  /** `--platform-agent`: which agent on the account to watch. */
  readonly platformAgentId: string | null;
  /** A direct child under `egma/tests`, for suite create or run. */
  readonly suiteDirectory: string | null;
  /** Mutable suite display name on create, or optional run name. */
  readonly name: string | null;
  /**
   * A test seam, not product surface: `-- <command>` starts a scripted agent in
   * place of a real one. It is not documented and it is not stable.
   */
  readonly drivenAgentCommand: readonly string[];
  readonly unknown: readonly string[];
};

function isVerb(argument: string): argument is Verb {
  return (VERBS as readonly string[]).includes(argument);
}

export function parseArgs(argv: readonly string[]): Invocation {
  let help = false;
  let version = false;
  let verb: Verb | null = null;
  let headless = false;
  let drivenAgentId = "claude";
  let drivenAgentNamed = false;
  let cwd: string | null = null;
  let url: string | null = null;
  let force = false;
  let noFollow = false;
  let retellAgentId: string | null = null;
  let reach: string | null = null;
  let phoneNumber: string | null = null;
  let repoPrompt: string | null = null;
  let existingTests: string | null = null;
  let agentName: string | null = null;
  let connectionName: string | null = null;
  let suiteAction: string | null = null;
  let monitoringAction: string | null = null;
  let platformWord: string | null = null;
  let platformAgentId: string | null = null;
  let suiteDirectory: string | null = null;
  let name: string | null = null;
  let drivenAgentCommand: string[] = [];
  const unknown: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index] as string;
    if (argument === "--") {
      drivenAgentCommand = argv.slice(index + 1) as string[];
      break;
    }
    if (argument === "-h" || argument === "--help") help = true;
    else if (argument === "-v" || argument === "--version") version = true;
    else if (argument === "--headless") headless = true;
    else if (argument === "--coding-agent") {
      const named = argv[(index += 1)];
      if (named !== undefined) {
        drivenAgentId = named;
        drivenAgentNamed = true;
      }
    }
    else if (argument === "--cwd") cwd = argv[(index += 1)] ?? null;
    else if (argument === "--url") url = argv[(index += 1)] ?? null;
    else if (argument === "--force") force = true;
    else if (argument === "--no-follow") noFollow = true;
    else if (argument === "--retell-agent") retellAgentId = argv[(index += 1)] ?? null;
    else if (argument === "--reach") reach = argv[(index += 1)] ?? null;
    else if (argument === "--phone-number") phoneNumber = argv[(index += 1)] ?? null;
    else if (argument === "--repo-prompt") repoPrompt = argv[(index += 1)] ?? null;
    else if (argument === "--existing-tests") existingTests = argv[(index += 1)] ?? null;
    else if (argument === "--agent") agentName = argv[(index += 1)] ?? null;
    else if (argument === "--connection") connectionName = argv[(index += 1)] ?? null;
    else if (argument === "--name") name = argv[(index += 1)] ?? null;
    else if (argument === "--platform") platformWord = argv[(index += 1)] ?? null;
    else if (argument === "--platform-agent") platformAgentId = argv[(index += 1)] ?? null;
    else if (verb === null && isVerb(argument)) verb = argument;
    else if (verb === "suite" && suiteAction === null) suiteAction = argument;
    else if (verb === "monitoring" && monitoringAction === null) {
      monitoringAction = argument;
    }
    else if (
      suiteDirectory === null &&
      (verb === "run" || (verb === "suite" && suiteAction === "create"))
    ) {
      suiteDirectory = argument;
    }
    else unknown.push(argument);
  }

  return {
    help,
    version,
    verb,
    headless,
    drivenAgentId,
    drivenAgentNamed,
    cwd,
    url,
    force,
    noFollow,
    retellAgentId,
    reach,
    phoneNumber,
    repoPrompt,
    existingTests,
    agentName,
    connectionName,
    suiteAction,
    monitoringAction,
    platformWord,
    platformAgentId,
    suiteDirectory,
    name,
    drivenAgentCommand,
    unknown,
  };
}

export function helpText(): string {
  return [
    "Egma — take a voice agent to graded results.",
    "",
    "Usage:",
    "  egma [options]           The wizard.",
    "  egma login [options]     Sign this machine in. No questions, plain lines.",
    "  egma connect [options]   Register your voice agent and a way to reach it.",
    "                           The key comes in on standard input or from the",
    "                           environment, never as an argument.",
    "  egma init [options]      Make the egma folder this repository's tests",
    "                           live in. Talks to nobody, unless --url names an",
    "                           Egma platform URL to bind this repository to. Safe to run",
    "                           again.",
    "  egma pull [options]      Write Egma's current test versions, and the mock",
    "                           tools it answers with, into it.",
    "  egma push [options]      Upload what is in it. Refuses, naming names,",
    "                           when Egma has moved on since your last pull.",
    "  egma suite create <directory> --name <name>",
    "                           Create the platform suite, then its local manifest.",
    "  egma run <suite-directory> [options]",
    "                           Run the complete suite after an exact sync check.",
    "  egma monitoring enable [options]",
    "                           Start watching this agent's production traffic.",
    "                           On Retell the account key comes in on standard",
    "                           input, never as an argument. On LiveKit Egma",
    "                           mints a project key and writes the two lines the",
    "                           Egma SDK reads into .env when Git ignores it,",
    "                           printing them either way.",
    "  egma monitoring disable  Turn the switch off. Everything stored stays",
    "                           stored: the conversations, the platform binding",
    "                           and the sealed key.",
    "  egma monitoring status   Print the switch, the binding, the key hint, and",
    "                           when a production conversation last arrived. It",
    "                           is where arrivals are read: enable asks once and",
    "                           does not wait.",
    "",
    "In a platform workspace — the directory your Egma deployment lives in,",
    "which is never your agent repository:",
    "",
    "  egma self-host up               Start the whole platform: API, web,",
    "                                  both stores, simulator, grader, LiveKit,",
    "                                  its SIP gateway and their Redis. Prints",
    "                                  the address an agent repository uses.",
    "  egma self-host setup            Configure that platform's carrier route.",
    "                                  It asks only for what the platform does",
    "                                  not already hold and writes every answer",
    "                                  through the platform's own API. For the",
    "                                  carrier it asks for the trunk address,",
    "                                  source number, and, when required, a SIP",
    "                                  username and password. It copies them into the",
    "                                  platform and never contacts Twilio.",
    "                                  --plan lists what it would ask for and",
    "                                  stops; --json is the same work with",
    "                                  nobody watching. --replace-carrier --yes",
    "                                  is recovery after an administrator adds",
    "                                  a replacement beside the old credential.",
    "",
    "Options:",
    "  --coding-agent <id>  Use one installed coding agent without asking.",
    `                       ${SUPPORTED_CODING_AGENT_IDS.join(", ")}`,
    "  --cwd <path>         The folder to work in. Default: this folder.",
    "  --url <address>      Which Egma platform this one command talks to. It is the only",
    "                       way to name one, so a command that should reach that",
    "                       platform carries it. With init and with the wizard, Egma",
    "                       records the normalized URL in egma/config.yaml, and every",
    "                       later command in this repository needs no address at all.",
    "  --force              With login: sign in again even when this machine",
    "                       already holds a key.",
    "  --no-follow          With run: start the run and return at once, without",
    "                       waiting for a verdict. The run carries on on Egma.",
    "  --retell-agent <id>  With connect: which agent, when the Retell account",
    "                       holds more than one.",
    "  --reach <text|phone> With connect and a headless wizard: how Egma should",
    "                       reach the selected Retell agent. text creates its",
    "                       Chat connection; phone creates its Phone connection.",
    "                       Retell's agent modality must match the value, and",
    "                       Egma creates nothing when neither is said.",
    "  --phone-number <e164>",
    "                       With --reach phone: which of the agent's numbers to",
    "                       dial, when Retell routes more than one to it.",
    "  --repo-prompt <path> With connect: the prompt file in this repository, so",
    "                       Egma can say whether it and Retell have drifted apart.",
    "  --existing-tests <path>",
    "                       With the wizard: test cases you already have written",
    "                       down, inside this folder. They are turned into test",
    "                       files before Egma writes any of its own.",
    "  --agent <name>       With init: what to call the voice agent this",
    "                       folder's tests are for.",
    "  --connection <name>  With init: what to call the way Egma reaches it.",
    "  --name <name>        With suite create: the suite display name. With run:",
    "                       an optional name for this run. With monitoring",
    "                       enable: what to call the agent Egma writes.",
    "  --platform <retell|livekit>",
    "                       With monitoring enable: which platform runs this",
    "                       agent. Left out, Egma reads it from the agent's own",
    "                       binding, or from the connections that reach it, and",
    "                       refuses when it cannot tell.",
    "  --platform-agent <id>",
    "                       With monitoring enable on Retell: which agent on the",
    "                       account to watch, when it holds more than one.",
    "  --headless           Run with no terminal and no keystroke: plain lines,",
    "                       and the task taken as already agreed to.",
    "  -h, --help           Print this.",
    "  -v, --version        Print the version.",
    "",
    "Environment:",
    "  EGMA_HOME            The folder Egma keeps this machine's keys in, one",
    "                       for each platform origin.",
    "                       Default: ~/.egma",
    `  ${KEY_VARIABLES[0]}  Your Retell key, for egma connect. ${KEY_VARIABLES[1]}`,
    "                       is read too, so an environment that already has one",
    "                       needs nothing new.",
    `  ${AGENT_VARIABLE} Which Retell agent, same as --retell-agent.`,
    `  ${REACH_VARIABLE}            text or phone, same as --reach.`,
    `  ${NUMBER_VARIABLE}     Which number to dial, same as --phone-number.`,
    `  ${RETELL_URL_VARIABLE}      The Retell to talk to. Default: ${RETELL_API}`,
    `  ${EXISTING_TESTS_VARIABLE}  Your existing test cases, same as --existing-tests.`,
    "  VISUAL, EDITOR       What e opens a generated test in, at the gate.",
    "",
    "When Egma cannot use this machine's keys — the file is damaged, or another",
    `Egma process is holding it — every command prints status: ${KEYS_UNUSABLE} with the`,
    "reason, changes nothing, and answers 1.",
    "",
    "What egma login prints, one fact per line:",
    "  url, code, approve_url, browser, waiting, status, credentials",
    "",
    "What egma login answers with:",
    "  0 signed in   2 denied   3 the code ran out",
    "  4 Egma did not answer, or refused   130 stopped part way",
    "",
    "What egma connect prints, one fact per line:",
    "  url, retell_agents, retell_agent, retell_agent_id, retell_response_engine,",
    "  prompt_characters, tools, reach_option, retell_number, reach, phone_number,",
    "  agent_id, agent_name, connection_id, connection_name, agent_platform,",
    "  connection_type, access_variant, product_label, connection_modality,",
    "  registration, agent_registration,",
    "  connection_registration, drift, grounded_in, status",
    "",
    "  registration says which of three things Egma did: created, reused (this",
    "  voice agent was already registered and already reached this way, so",
    "  nothing was written), or connection_added (the same agent gained another",
    "  way of being reached). The two that are not created also print a note:",
    "  line saying so plainly. agent_registration and connection_registration",
    "  say the same thing for each half, as created or reused.",
    "",
    "What egma connect answers with:",
    "  0 connected   2 the key was refused   3 no agents on that account",
    "  4 Retell or Egma did not answer, or refused",
    "  5 a choice only you can make was not made: which agent, text or phone, or",
    "    which number   6 no key given   7 not signed in to Egma",
    "  8 Retell routes no number to that agent   130 stopped part way",
    "",
    "What egma init, suite create, pull and push print, one fact per line:",
    "  url and folder, then each suite, test, and Mock Tool the complete",
    "  repository operation handled. A pull names every local draft or deleted",
    "  remote resource it kept, with the reason. An atomic push refusal writes",
    "  no platform resource.",
    "  init adds a platform: line whenever this repository is bound, whether",
    "  this run bound it or found it already bound.",
    "",
    "What egma init, pull and push answer with:",
    "  0 done   1 no egma folder here   2 not signed in",
    "  4 Egma did not answer, or refused",
    "  5 atomic push conflict: pull and inspect first",
    "  6 Egma turned a test or a mock tool away at its door",
    "  130 stopped part way",
    "",
    "What egma run prints, one fact per line:",
    "  url, folder, suite, directory, agent, connection, one pin: line per test,",
    "  run, tests, simulations, results, then one simulation: line per change,",
    "  one verdict: line per verdict, first-verdict: once, and the four counts",
    "  passed, failed, skipped, errored, plus pending and simulations.",
    "",
    "What egma monitoring prints, one fact per line:",
    "  url, agent_name, platform, then either the agent it is now watching",
    "  (agent_id, platform_agent_id, agent_registration, pull_production_calls,",
    "  first_conversation) or, on LiveKit, what it wired (api_key, env_file, one",
    "  env: line per environment line). status and disable print pull_production_calls,",
    "  agent_platform, platform_agent_id, monitoring_key and last_received_at.",
    "  A refusal adds refusal: with the reason and one reason: line per sentence.",
    "",
    "What egma monitoring answers with:",
    "  0 done   1 nothing here to act on   2 the Retell key was refused",
    "  3 no voice agents on that account",
    "  4 Egma did not answer, or refused",
    "  5 a choice only you can make was not made: which platform, or which agent",
    "  6 no key given   7 not signed in to Egma",
    "  8 Egma would not start watching, and said which rule refused it",
    "  130 stopped part way",
    "",
    "What egma run answers with:",
    "  0 the run finished and nothing failed or errored",
    "  1 nothing here to run   2 not signed in   3 a test failed",
    "  4 Egma did not answer, or refused",
    "  5 Egma would not start the run, and said why",
    "  6 a simulation errored, so nothing concluded   130 stopped part way",
    "",
    "The wizard finds supported coding agents already installed on this machine.",
  ].join("\n");
}

/** What a developer is told when the wizard has no terminal to run in. */
export function noTerminalRefusal(): string {
  return [
    "Egma's wizard needs a terminal it can draw on and read one keystroke from, and this is not one. Nothing was started.",
    "",
    "That keystroke is how you agree to Egma driving your coding agent, so Egma will not drive it without one.",
    "",
    "Run egma --headless to say here and now that you agree, and to get plain lines instead of a wizard. Run egma --help for the rest.",
  ].join("\n");
}

export function version(): string {
  const manifest = readFileSync(new URL("../package.json", import.meta.url), "utf8");
  return (JSON.parse(manifest) as { version?: string }).version ?? "0.0.0";
}

function commandedLaunchFrom(invocation: Invocation): DrivenAgentLaunch | null {
  const [command, ...args] = invocation.drivenAgentCommand;
  if (command === undefined) return null;
  // egma was told a command, not an agent, so the command is all it can
  // honestly call the thing — unless the developer also said which supported
  // agent it stands in for. This is an internal scripted-agent seam.
  const supported = supportedCodingAgentId(invocation.drivenAgentId);
  return {
    id: invocation.drivenAgentNamed && supported !== null ? supported : "named-command",
    name: path.basename(command),
    command,
    args,
    env: {},
  };
}

function installedAgentLines(installed: readonly InstalledCodingAgent[]): string[] {
  return installed.map(
    (agent) => `  ${agent.id}  ${agent.name} ${agent.version}  ${agent.executable}`,
  );
}

function noSelectedCodingAgent(
  requested: string | null,
  installed: readonly InstalledCodingAgent[],
): string {
  const first =
    requested === null
      ? "Egma needs --coding-agent when more than one supported coding agent is installed."
      : `Egma could not find an installed supported coding agent called "${requested}".`;
  return [
    first,
    "",
    ...(installed.length === 0
      ? ["No supported coding agents were found."]
      : ["Installed coding agents:", ...installedAgentLines(installed)]),
    "",
    `Supported ids: ${SUPPORTED_CODING_AGENT_IDS.join(", ")}.`,
  ].join("\n");
}

/** Where Retell is for this run, or `undefined` for Retell's own address. */
function retellReach(env: NodeJS.ProcessEnv): { readonly url: string } | undefined {
  const named = env[RETELL_URL_VARIABLE]?.trim();
  return named === undefined || named === "" ? undefined : { url: named };
}

/**
 * egma declining to talk to an address, in the one shape every command answers
 * it in.
 *
 * Two kinds, and the difference is whether anything is worth retrying.
 * `unreachable` is nobody answering; `refused` is egma declining to send this
 * repository's identifiers to the address on offer. `null` is anything else,
 * which is not this function's to explain.
 *
 * Address-selection refusals happen before network work. Transport failures
 * come from the operation the developer asked for.
 */
function platformRefusal(error: unknown): "refused" | "unreachable" | null {
  if (
    error instanceof BoundPlatformAddressError ||
    error instanceof RepositoryPlatformConfigError ||
    error instanceof UnboundPlatformIdentifiersError
  ) {
    return "refused";
  }
  if (error instanceof PlatformUnreachableError) {
    return "unreachable";
  }
  return null;
}

/**
 * Says the refusal both ways — machine-readable, and to a person — and answers 4.
 *
 * A refusal that teaches something is more than one line now: the one that
 * keeps a bound repository where it belongs ends with every line a developer
 * deletes to move it. Those lines go to the error stream, whole, where every
 * other block egma teaches with already goes — the refusal of a piped wizard
 * and the refusal of a key in an argument are both written that way.
 *
 * What goes on the output stream is the sentence alone. That stream is one fact
 * per line, which is what makes it readable by the thing that started the
 * command, and a `reason:` running to eight lines would break that reading to
 * repeat what is already on the other stream.
 */
function sayPlatformRefusal(status: "refused" | "unreachable", message: string): void {
  const sentence = message.split("\n")[0] as string;
  process.stdout.write(`status: ${status}\nreason: ${sentence}\n`);
  process.stderr.write(`${message}\n`);
  process.exitCode = 4;
}

/**
 * What a headless walk would have been told, for the one question it cannot
 * ask: the key, which arrives from the environment because a run with nobody
 * watching has nobody to type it.
 *
 * Standard input is deliberately not read here. The wizard's own walk may still
 * be reading it for keystrokes, and a flag that says "nobody is watching" must
 * not change where a secret comes from.
 */
/** The answers a run with nobody watching can be given in advance. */
type Held = "retell-key" | "retell-agent" | "reach" | "phone-number" | "existing-tests";

function headlessAnswers(
  invocation: Invocation,
  env: NodeJS.ProcessEnv,
): Partial<Record<Held, string>> {
  const answers: Partial<Record<Held, string>> = {};
  for (const variable of KEY_VARIABLES) {
    const held = env[variable];
    if (typeof held === "string" && held.trim() !== "") {
      answers["retell-key"] = held;
      break;
    }
  }
  const named = (invocation.retellAgentId ?? env[AGENT_VARIABLE] ?? "").trim();
  if (named !== "") answers["retell-agent"] = named;

  // Which way to reach the agent is knowledge, not consent: a run with nobody
  // watching says it in the command or egma creates nothing at all. Left out
  // deliberately means left out — egma never picks one of the two, because
  // only one of them dials a real telephone.
  const way = (invocation.reach ?? env[REACH_VARIABLE] ?? "").trim();
  if (way !== "") answers["reach"] = way;
  const dialling = (invocation.phoneNumber ?? env[NUMBER_VARIABLE] ?? "").trim();
  if (dialling !== "") answers["phone-number"] = dialling;

  // Prior work is knowledge and not consent, so a run with nobody watching is
  // pointed at it in the command or it has none — exactly as the pointer to a
  // repository's prompts is.
  const material = (invocation.existingTests ?? env[EXISTING_TESTS_VARIABLE] ?? "").trim();
  if (material !== "") answers["existing-tests"] = material;
  return answers;
}

async function runHeadless(
  invocation: Invocation,
  launch: DrivenAgentLaunch,
  cwd: string,
  platform: WizardPlatform,
): Promise<number> {
  const controller = new AbortController();
  const stop = (reason: StopReason): void => controller.abort(reason);
  const onSignal = (): void => stop("interrupt");
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  const { runWizard } = await wizardMachinery();
  const ui = new HeadlessUI({
    write: (line) => process.stdout.write(`${line}\n`),
    answers: headlessAnswers(invocation, process.env),
  });
  try {
    const report = await runWizard({
      ui,
      launch,
      cwd,
      signal: controller.signal,
      platform,
      retell: retellReach(process.env),
    });
    const notice = buildExitNotice(report);
    if (notice !== null) process.stdout.write(`${notice}\n\n`);
    process.stdout.write(`${exitLines(report).join("\n")}\n`);
    return walkExitCode(report);
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  }
}

async function runInteractiveWizard(
  codingAgent: WizardCodingAgent,
  cwd: string,
  platform: WizardPlatform,
): Promise<number> {
  const { startTui, runWizard } = await wizardMachinery();
  const controller = new AbortController();
  const tui = startTui({ stop: (reason) => controller.abort(reason) });

  // A signal can arrive when the terminal cannot deliver a keystroke, so the
  // same teardown is wired to both.
  const onSignal = (): void => controller.abort("interrupt");
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  try {
    const report = await runWizard({
      ui: tui.ui,
      codingAgent,
      cwd,
      signal: controller.signal,
      platform,
      retell: retellReach(process.env),
    });
    tui.close(report);
    return walkExitCode(report);
  } catch (error) {
    // A platform refusal is not the walk failing. It is egma declining to talk
    // to an address, and it is answered in plain lines with a number of its own
    // — the same ones every verb answers with. So the screen comes down leaving
    // nothing behind, and the sentence is written once, by the caller.
    if (platformRefusal(error) !== null) {
      tui.close(null);
      throw error;
    }
    const reason = error instanceof Error ? error.message : String(error);
    tui.close({ kind: "failed", reason });
    return 1;
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  }
}

/**
 * The folder verbs: no terminal needed, no keystroke taken, no question asked.
 *
 * One runner for the three of them, because what they share is everything a
 * caller sees — where they work, where they print, and that a signal stops them
 * rather than leaving half a folder behind.
 */
async function runFolderVerb(
  verb: "init" | "pull" | "push" | "run" | "suite",
  invocation: Invocation,
  access: PlatformAccess,
  /** For `init`: the selected platform URL to commit, when `--url` named one. */
  binding: PlatformBinding | null = null,
): Promise<number> {
  const controller = new AbortController();
  const onSignal = (): void => controller.abort("interrupt");
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  const options: FolderCommandOptions = {
    access,
    cwd: path.resolve(invocation.cwd ?? process.cwd()),
    out: (line) => void process.stdout.write(`${line}\n`),
    fail: (line) => void process.stderr.write(`${line}\n`),
  };

  try {
    if (verb === "init") {
      return await runInitCommand({
        ...options,
        names: {
          agent: invocation.agentName,
          connection: invocation.connectionName,
        },
        binding,
      });
    }
    if (verb === "run") {
      return await runRunCommand({
        ...options,
        suiteDirectory: invocation.suiteDirectory ?? "",
        ...(invocation.name === null ? {} : { name: invocation.name }),
        noFollow: invocation.noFollow,
        signal: controller.signal,
      });
    }
    if (verb === "suite") {
      return await runSuiteCreateCommand({
        ...options,
        directory: invocation.suiteDirectory ?? "",
        name: invocation.name ?? "",
      });
    }
    return verb === "pull" ? await runPullCommand(options) : await runPushCommand(options);
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  }
}

/** The login verb: no terminal needed, no keystroke taken, no question asked. */
async function runLogin(invocation: Invocation, access: PlatformAccess): Promise<number> {
  const controller = new AbortController();
  const onSignal = (): void => controller.abort("interrupt");
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  try {
    return await runLoginCommand({
      access,
      force: invocation.force,
      env: process.env,
      signal: controller.signal,
      out: (line) => process.stdout.write(`${line}\n`),
      fail: (line) => process.stderr.write(`${line}\n`),
    });
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  }
}

/**
 * The monitoring verb: no terminal, no keystroke, no question — and the Retell
 * key on standard input, never in an argument.
 */
async function runMonitoring(
  invocation: Invocation,
  access: PlatformAccess,
  action: MonitoringAction,
): Promise<number> {
  const controller = new AbortController();
  const onSignal = (): void => controller.abort("interrupt");
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  try {
    return await runMonitoringCommand({
      access,
      cwd: path.resolve(invocation.cwd ?? process.cwd()),
      action,
      platform: invocation.platformWord,
      platformAgentId: invocation.platformAgentId,
      name: invocation.name,
      signal: controller.signal,
      stdin: process.stdin,
      out: (line) => process.stdout.write(`${line}\n`),
      fail: (line) => process.stderr.write(`${line}\n`),
    });
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  }
}

/** The connect verb: a key from a pipe or the environment, and plain lines. */
async function runConnect(
  invocation: Invocation,
  access: PlatformAccess,
): Promise<number> {
  const controller = new AbortController();
  const onSignal = (): void => controller.abort("interrupt");
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  try {
    return await runConnectCommand({
      access,
      cwd: path.resolve(invocation.cwd ?? process.cwd()),
      agentId: invocation.retellAgentId,
      reach: invocation.reach,
      phoneNumber: invocation.phoneNumber,
      repoPrompt: invocation.repoPrompt,
      env: process.env,
      signal: controller.signal,
      stdin: process.stdin,
      retell: retellReach(process.env),
      out: (line) => process.stdout.write(`${line}\n`),
      fail: (line) => process.stderr.write(`${line}\n`),
    });
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  }
}

export async function main(argv: readonly string[]): Promise<void> {
  // The platform operator's half of the CLI, and the one thing here that never
  // reads a repository or resolves a platform binding: `self-host` operates a
  // deployment, and a deployment is not something an agent repository points
  // at.
  //
  // **It is settled before the repository's own secret-argument refusal**, and
  // that ordering is not tidiness. Both halves refuse a secret in an argument,
  // and the repository's refusal talks about a Retell key and `egma connect`.
  // Answering a platform-workspace command with advice about a different
  // product, at the exact moment somebody is holding a credential, sends them
  // to the wrong place while the thing they typed is still in their history.
  if (isSelfHostInvocation(argv)) {
    const controller = new AbortController();
    const onSignal = (): void => controller.abort("interrupt");
    process.on("SIGINT", onSignal);
    process.on("SIGTERM", onSignal);
    try {
      process.exitCode = await runSelfHostCommand({
        argv,
        cwd: process.cwd(),
        env: process.env,
        stdin: process.stdin,
        stdout: process.stdout,
        out: (line) => void process.stdout.write(`${line}\n`),
        fail: (line) => void process.stderr.write(`${line}\n`),
        signal: controller.signal,
      });
    } finally {
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
    }
    return;
  }

  // Before anything is parsed or printed: an argument that would have carried
  // a secret is refused by name, and its value is never repeated back.
  const leaked = refusedArgumentIn(argv);
  if (leaked !== null) {
    process.stderr.write(`${argumentRefusal(leaked)}\n`);
    process.exitCode = 1;
    return;
  }

  const invocation = parseArgs(argv);

  if (invocation.help) {
    process.stdout.write(`${helpText()}\n`);
    return;
  }
  if (invocation.version) {
    process.stdout.write(`${version()}\n`);
    return;
  }
  if (
    invocation.verb === "monitoring" &&
    !(MONITORING_ACTIONS as readonly string[]).includes(invocation.monitoringAction ?? "")
  ) {
    process.stderr.write(
      `${unknownActionRefusal(invocation.monitoringAction ?? "")}\n`,
    );
    process.exitCode = 1;
    return;
  }
  if (invocation.verb === "suite" && invocation.suiteAction !== "create") {
    process.stderr.write(
      "Egma supports `egma suite create <directory> --name <name>`. Suite deletion is an explicit browser or API action.\n",
    );
    process.exitCode = 1;
    return;
  }
  if (invocation.verb === "suite" && invocation.suiteDirectory === null) {
    process.stderr.write(
      "Name the local directory: egma suite create <directory> --name <name>.\n",
    );
    process.exitCode = 1;
    return;
  }
  if (invocation.verb === "suite" && invocation.name === null) {
    process.stderr.write(
      "Name the suite: egma suite create <directory> --name <name>.\n",
    );
    process.exitCode = 1;
    return;
  }
  if (invocation.verb === "run" && invocation.suiteDirectory === null) {
    process.stderr.write("Name one local suite directory: egma run <suite-directory>.\n");
    process.exitCode = 1;
    return;
  }
  if (invocation.unknown.length > 0) {
    // Only the name is said back. Something written as `--thing=value` may be
    // carrying anything, and a refusal is no place to print it.
    const named = (invocation.unknown[0] as string).split("=")[0] as string;
    process.stderr.write(
      `Egma does not know the option ${named}. Run egma --help to see the ones it does.\n`,
    );
    process.exitCode = 1;
    return;
  }

  const cwd = path.resolve(invocation.cwd ?? process.cwd());

  // `init` with no address named is only a local folder write. It never
  // selects a platform, signs in, or sends an identifier anywhere, so it is
  // settled here rather than below and works with the network cable out.
  //
  // `init --url` is the one exception. It falls through to the ordinary
  // resolution below and commits the selected URL.
  // Sending it through the same path as every other verb is what makes a bound
  // repository refuse a second, different address here exactly as it does
  // everywhere else.
  if (invocation.verb === "init" && invocation.url === null) {
    process.exitCode = await runFolderVerb(invocation.verb, invocation, {
      // Nothing was asked of any address, so there is no platform to name.
      // Empty rather than a placeholder address: a real-looking one here would
      // be a lie the next reader has to disprove.
      url: "",
      credentialsFile: credentialsFileIn(process.env),
    });
    return;
  }

  // The wizard's remaining work, held as one closure rather than a launch the
  // compiler cannot prove is there. Everything a bare command needs — the
  // keystroke of consent, the coding agent it will drive — is settled here,
  // before a single network read, and what comes out is either the rest of the
  // walk or nothing at all.
  let theWizard: ((platform: WizardPlatform) => Promise<number>) | null = null;
  if (invocation.verb === null) {
    // Consent is checked before a network read. A piped bare command cannot
    // start either the wizard or platform selection.
    const drawable = process.stdout.isTTY === true && process.stdin.isTTY === true;
    if (!invocation.headless && !drawable) {
      process.stderr.write(`${noTerminalRefusal()}\n`);
      process.exitCode = 1;
      return;
    }

    const commanded = commandedLaunchFrom(invocation);
    let codingAgent: WizardCodingAgent;
    if (commanded !== null) {
      codingAgent = { kind: "selected", launch: commanded };
    } else {
      const installed = await discoverCodingAgents();
      if (invocation.drivenAgentNamed) {
        const selected = installedCodingAgent(installed, invocation.drivenAgentId);
        if (selected === null) {
          process.stdout.write(
            `${noSelectedCodingAgent(invocation.drivenAgentId, installed)}\n\n${pasteFallbackMessage()}\n`,
          );
          return;
        }
        codingAgent = { kind: "selected", launch: selected.launch };
      } else if (invocation.headless) {
        if (installed.length === 0) {
          process.stdout.write(`${pasteFallbackMessage()}\n`);
          return;
        }
        if (installed.length > 1) {
          process.stderr.write(`${noSelectedCodingAgent(null, installed)}\n`);
          process.exitCode = 1;
          return;
        }
        codingAgent = { kind: "selected", launch: installed[0]!.launch };
      } else {
        if (installed.length === 0) {
          process.stdout.write(`${pasteFallbackMessage()}\n`);
          return;
        }
        codingAgent = { kind: "choose", installed };
      }
    }
    if (invocation.headless) {
      if (codingAgent.kind !== "selected") {
        throw new Error("A headless wizard reached coding-agent selection.");
      }
      const launch = codingAgent.launch;
      theWizard = (platform) => runHeadless(invocation, launch, cwd, platform);
    } else {
      theWizard = (platform) => runInteractiveWizard(codingAgent, cwd, platform);
    }
  }

  // Which egma, chosen once for every path below out of what is already on this
  // machine, and refused here when the address a developer named is not one. A
  // bad address is turned away before anything is started on it rather than
  // after, and nothing has been asked of any address yet.
  let chosen: ChosenPlatform;
  let access: PlatformAccess | null = null;
  try {
    chosen = await choosePlatform({ env: process.env, flag: invocation.url, cwd });
    if (invocation.verb !== null) {
      access = { url: chosen.url, credentialsFile: chosen.credentialsFile };
    }
  } catch (error) {
    if (error instanceof UnusableUrlError) {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 1;
      return;
    }
    const status = platformRefusal(error);
    if (status !== null) {
      sayPlatformRefusal(status, (error as Error).message);
      return;
    }
    throw error;
  }

  try {
    // A verb needs no terminal and takes no keystroke: it drives no coding
    // agent, so there is nothing for a keystroke to agree to.
    if (access !== null) {
      if (invocation.verb === "login") {
        process.exitCode = await runLogin(invocation, access);
        return;
      }
      if (invocation.verb === "connect") {
        process.exitCode = await runConnect(invocation, access);
        return;
      }
      if (invocation.verb === "monitoring") {
        process.exitCode = await runMonitoring(
          invocation,
          access,
          invocation.monitoringAction as MonitoringAction,
        );
        return;
      }
      // Only `init --url` reaches here: the flagless form was answered above.
      if (invocation.verb === "init") {
        process.exitCode = await runFolderVerb(invocation.verb, invocation, access, {
          origin: access.url,
        });
        return;
      }
      if (
        invocation.verb === "pull" ||
        invocation.verb === "push" ||
        invocation.verb === "run" ||
        invocation.verb === "suite"
      ) {
        process.exitCode = await runFolderVerb(invocation.verb, invocation, access);
        return;
      }
    }

    // Every verb has returned by now, so what is left is the bare command, and
    // the walk it needs was built above. It is handed the selected address and
    // starts login only after the developer has read that address and pressed
    // the key that agrees to the rest.
    if (theWizard !== null) {
      const selected = chosen;
      process.exitCode = await theWizard({
        url: selected.url,
        credentialsFile: selected.credentialsFile,
      });
    }
  } catch (error) {
    const status = platformRefusal(error);
    if (status !== null) {
      sayPlatformRefusal(status, (error as Error).message);
      return;
    }
    if (!(error instanceof KeysUnusableError)) throw error;
    // Whatever is wrong with this machine's keys file, egma decided not to
    // write over it — and a decision is a sentence, not a stack trace. Every
    // verb can hit this and none of them owns it, so it is caught in the one
    // place they all pass through, and it answers the same way everywhere
    // rather than borrowing a number that means something else per verb.
    process.stdout.write(`status: ${KEYS_UNUSABLE}\nreason: ${error.message}\n`);
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
