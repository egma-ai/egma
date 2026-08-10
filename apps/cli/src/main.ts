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
  DEFAULT_DRIVEN_AGENT_ID,
  REGISTRY_SNAPSHOT_MIRRORED_ON,
  UnlaunchableDrivenAgentError,
  launchForId,
  type DrivenAgentLaunch,
} from "./acp/registry.ts";
import {
  AGENT_VARIABLE,
  argumentRefusal,
  KEY_VARIABLES,
  refusedArgumentIn,
  runConnectCommand,
} from "./commands/connect.ts";
import type { FolderCommandOptions } from "./commands/folder-verbs.ts";
import { runInitCommand } from "./commands/init.ts";
import { runLoginCommand } from "./commands/login.ts";
import { runPullCommand } from "./commands/pull.ts";
import { runPushCommand } from "./commands/push.ts";
import { runRunCommand } from "./commands/run.ts";
import {
  isSelfHostInvocation,
  runSelfHostCommand,
} from "./commands/self-host.ts";
import {
  BoundPlatformAddressError,
  BoundPlatformUnavailableError,
  credentialsFileIn,
  DEFAULT_PLATFORM_URL,
  DefaultPlatformUnusableError,
  KEYS_UNUSABLE,
  KeysUnusableError,
  PlatformBindingMismatchError,
  RepositoryPlatformConfigError,
  resolvePlatformAccess,
  UnusableUrlError,
  type PlatformAccess,
  type VerifiedPlatformAccess,
} from "./platform/credentials.ts";
import { PlatformUnreachableError } from "./platform/device-flow.ts";
import {
  PlatformIdentityError,
  PlatformOriginMismatchError,
} from "./platform/identity.ts";
import { RETELL_API } from "./retell/client.ts";
import { HeadlessUI } from "./ui/headless-ui.ts";
import { buildExitNotice, exitLines, type ExitReport } from "./wizard/exit-line.ts";
import type { PlatformAccess as WizardPlatformAccess } from "./wizard/login-step.ts";
import { pasteFallbackMessage } from "./wizard/no-coding-agent.ts";
import type { StopReason } from "./wizard/stop.ts";

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
  readonly walk: typeof import("./wizard/walk.ts").walk;
}> {
  const [{ startTui }, { walk }] = await Promise.all([
    import("./ui/tui/start-tui.ts"),
    import("./wizard/walk.ts"),
  ]);
  return { startTui, walk };
}

/**
 * The verbs. A bare `egma` runs the wizard; naming one runs it headlessly,
 * because a verb is what a coding agent types and a coding agent has no
 * keystroke to give.
 */
export const VERBS = ["login", "connect", "init", "pull", "push", "run"] as const;

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
  /** `--repo-prompt`: the repository's prompt, to compare the provider's with. */
  readonly repoPrompt: string | null;
  /** `--existing-tests`: the test cases the developer already had written down. */
  readonly existingTests: string | null;
  /** What `egma init` should write into the folder's config file. */
  readonly agentName: string | null;
  readonly connectionName: string | null;
  readonly suiteName: string | null;
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
  let drivenAgentId = DEFAULT_DRIVEN_AGENT_ID;
  let drivenAgentNamed = false;
  let cwd: string | null = null;
  let url: string | null = null;
  let force = false;
  let noFollow = false;
  let retellAgentId: string | null = null;
  let repoPrompt: string | null = null;
  let existingTests: string | null = null;
  let agentName: string | null = null;
  let connectionName: string | null = null;
  let suiteName: string | null = null;
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
    else if (argument === "--repo-prompt") repoPrompt = argv[(index += 1)] ?? null;
    else if (argument === "--existing-tests") existingTests = argv[(index += 1)] ?? null;
    else if (argument === "--agent") agentName = argv[(index += 1)] ?? null;
    else if (argument === "--connection") connectionName = argv[(index += 1)] ?? null;
    else if (argument === "--suite") suiteName = argv[(index += 1)] ?? null;
    else if (verb === null && isVerb(argument)) verb = argument;
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
    repoPrompt,
    existingTests,
    agentName,
    connectionName,
    suiteName,
    drivenAgentCommand,
    unknown,
  };
}

export function helpText(): string {
  return [
    "egma — walk from a voice agent to graded results.",
    "",
    "Usage:",
    "  egma [options]           The wizard.",
    "  egma login [options]     Sign this machine in. No questions, plain lines.",
    "  egma connect [options]   Register your voice agent and a way to reach it.",
    "                           The key comes in on standard input or from the",
    "                           environment, never as an argument.",
    "  egma init [options]      Make the egma folder this repository's tests",
    "                           live in. Safe to run again.",
    "  egma pull [options]      Write egma's current test versions into it.",
    "  egma push [options]      Upload the tests in it. Refuses, naming names,",
    "                           when egma has moved on since your last pull.",
    "  egma run [options]       Run this folder's tests, pinning the version of",
    "                           each. Follows the run and prints every change.",
    "",
    "In a platform workspace — the directory your egma deployment lives in,",
    "which is never your agent repository:",
    "",
    "  egma self-host up               Start the whole platform: API, web,",
    "                                  both stores, simulator, grader, LiveKit,",
    "                                  its SIP gateway and their Redis. Prints",
    "                                  the address an agent repository uses.",
    "  egma self-host phone setup      Make that platform able to place phone",
    "                                  calls. Asks for a Twilio account, a",
    "                                  number it already owns and one OpenAI",
    "                                  key; shows a plan before it writes",
    "                                  anything to your carrier. It never buys",
    "                                  a number. --plan shows the plan and",
    "                                  stops; --apply --yes --json is the same",
    "                                  work with nobody watching.",
    "",
    "Options:",
    "  --coding-agent <id>  Which coding agent to drive, named as the agent",
    `                       registry names it. Default: ${DEFAULT_DRIVEN_AGENT_ID}`,
    "  --cwd <path>         The folder to work in. Default: this folder.",
    "  --url <address>      The egma to talk to. The wizard records its verified",
    "                       identity in egma/config.yaml. EGMA_URL selects one",
    "                       for a whole shell.",
    "  --force              With login: sign in again even when this machine",
    "                       already holds a key.",
    "  --no-follow          With run: start the run and return at once, without",
    "                       waiting for a verdict. The run carries on on egma.",
    "  --retell-agent <id>  With connect: which agent, when the Retell account",
    "                       holds more than one.",
    "  --repo-prompt <path> With connect: the prompt file in this repository, so",
    "                       egma can say whether it and Retell have drifted apart.",
    "  --existing-tests <path>",
    "                       With the wizard: test cases you already have written",
    "                       down, inside this folder. They are turned into test",
    "                       files before egma writes any of its own.",
    "  --agent <name>       With init: what to call the voice agent this",
    "                       folder's tests are for.",
    "  --connection <name>  With init: what to call the way egma reaches it.",
    "  --suite <name>       With init: what to call this folder's test suite.",
    "  --headless           Run with no terminal and no keystroke: plain lines,",
    "                       and the task taken as already agreed to.",
    "  -h, --help           Print this.",
    "  -v, --version        Print the version.",
    "",
    "Environment:",
    "  EGMA_URL             The egma to talk to, for a whole shell. Same as --url.",
    "  EGMA_HOME            The folder egma keeps this machine's keys in, one",
    "                       for each platform origin.",
    "                       Default: ~/.egma",
    `  ${KEY_VARIABLES[0]}  Your Retell key, for egma connect. ${KEY_VARIABLES[1]}`,
    "                       is read too, so an environment that already has one",
    "                       needs nothing new.",
    `  ${AGENT_VARIABLE} Which Retell agent, same as --retell-agent.`,
    `  ${RETELL_URL_VARIABLE}      The Retell to talk to. Default: ${RETELL_API}`,
    `  ${EXISTING_TESTS_VARIABLE}  Your existing test cases, same as --existing-tests.`,
    "  VISUAL, EDITOR       What e opens a generated test in, at the gate.",
    "",
    "When egma cannot use this machine's keys — the file is damaged, or another",
    `egma is holding it — every command prints status: ${KEYS_UNUSABLE} with the`,
    "reason, changes nothing, and answers 1.",
    "",
    "What egma login prints, one fact per line:",
    "  url, code, approve_url, browser, waiting, status, credentials",
    "",
    "What egma login answers with:",
    "  0 signed in   2 denied   3 the code ran out",
    "  4 egma did not answer, or refused   130 stopped part way",
    "",
    "What egma connect prints, one fact per line:",
    "  url, retell_agents, retell_agent, retell_agent_id, retell_response_engine,",
    "  prompt_characters, tools, agent_id, agent_name, connection_id,",
    "  connection_name, connection_type, connection_modality, registration,",
    "  drift, grounded_in, status",
    "",
    "  registration says which of three things egma did: created, reused (this",
    "  Retell agent was already registered, so nothing new was written), or",
    "  connection_added (the same agent gained another way of being reached).",
    "  The two that are not created also print a note: line saying so plainly.",
    "",
    "What egma connect answers with:",
    "  0 connected   2 the key was refused   3 no agents on that account",
    "  4 Retell or egma did not answer, or refused   5 several agents, none named",
    "  6 no key given   7 not signed in to egma   130 stopped part way",
    "",
    "What egma init, pull and push print, one fact per line:",
    "  url, folder, and then one line per test: what happened to it, the file,",
    "  and the version the file now pins. push names every conflicting test on",
    "  its own conflict: line.",
    "",
    "What egma init, pull and push answer with:",
    "  0 done   1 no egma folder here   2 not signed in",
    "  4 egma did not answer, or refused",
    "  5 push refused: egma has moved on, pull first",
    "  6 egma turned a test away at its door   130 stopped part way",
    "",
    "What egma run prints, one fact per line:",
    "  url, folder, agent, connection, one pin: line per test version it pinned,",
    "  run, tests, simulations, results, then one simulation: line per change,",
    "  one verdict: line per verdict, first-verdict: once, and the four counts",
    "  passed, failed, skipped, errored, plus pending and simulations.",
    "",
    "What egma run answers with:",
    "  0 the run finished and nothing failed or errored",
    "  1 nothing here to run   2 not signed in   3 a test failed",
    "  4 egma did not answer, or refused",
    "  5 egma would not start the run, and said why",
    "  6 a simulation errored, so nothing concluded   130 stopped part way",
    "",
    `The agent registry was mirrored on ${REGISTRY_SNAPSHOT_MIRRORED_ON}.`,
  ].join("\n");
}

/** What a developer is told when the wizard has no terminal to run in. */
export function noTerminalRefusal(): string {
  return [
    "egma's wizard needs a terminal it can draw on and read one keystroke from, and this is not one. Nothing was started.",
    "",
    "That keystroke is how you agree to egma driving your coding agent, so egma will not drive it without one.",
    "",
    "Run egma --headless to say here and now that you agree, and to get plain lines instead of a wizard. Run egma --help for the rest.",
  ].join("\n");
}

export function version(): string {
  const manifest = readFileSync(new URL("../package.json", import.meta.url), "utf8");
  return (JSON.parse(manifest) as { version?: string }).version ?? "0.0.0";
}

function launchFrom(invocation: Invocation): DrivenAgentLaunch {
  const [command, ...args] = invocation.drivenAgentCommand;
  if (command !== undefined) {
    // egma was told a command, not an agent, so the command is all it can
    // honestly call the thing — unless the developer also said which agent it
    // is, in which case that is what it is and egma may act on it.
    return {
      id: invocation.drivenAgentNamed ? invocation.drivenAgentId : "named-command",
      name: path.basename(command),
      command,
      args,
      env: {},
    };
  }
  return launchForId(invocation.drivenAgentId);
}

/** What the whole walk answers with, which is not what `egma login` answers. */
function walkExitCode(report: ExitReport): number {
  switch (report.kind) {
    // The files are written either way, and the developer decided what happens
    // to them. Pressing `q` over the list is the run finishing; pressing Ctrl-C
    // over it leaves the same files and is still an interruption to a shell.
    case "tests-kept":
      return report.stopped ? 130 : 0;
    case "found-agent":
    case "connected":
    case "tests-pushed":
    // The run is going and the developer has what they need to watch it. That
    // the suite is not finished is the design, not an incomplete run.
    case "run-started":
    case "quit":
    // egma did everything it could here: it named what is missing and handed
    // over words that work without it. That is the run finishing, not failing.
    case "no-coding-agent":
      return 0;
    case "interrupted":
      return 130;
    case "no-agent-context":
    // The coding agent stopped the work itself. Nothing was found, and the run
    // did not do what it set out to do.
    case "coding-agent-stopped":
    case "failed":
      return 1;
  }
}

/** Where Retell is for this run, or `undefined` for Retell's own address. */
function retellReach(env: NodeJS.ProcessEnv): { readonly url: string } | undefined {
  const named = env[RETELL_URL_VARIABLE]?.trim();
  return named === undefined || named === "" ? undefined : { url: named };
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
type Held = "retell-key" | "retell-agent" | "existing-tests";

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
  platform: WizardPlatformAccess,
): Promise<number> {
  const controller = new AbortController();
  const stop = (reason: StopReason): void => controller.abort(reason);
  const onSignal = (): void => stop("interrupt");
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  const { walk } = await wizardMachinery();
  const ui = new HeadlessUI({
    write: (line) => process.stdout.write(`${line}\n`),
    answers: headlessAnswers(invocation, process.env),
  });
  try {
    const report = await walk({
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

async function runWizard(
  launch: DrivenAgentLaunch,
  cwd: string,
  platform: WizardPlatformAccess,
): Promise<number> {
  const { startTui, walk } = await wizardMachinery();
  const controller = new AbortController();
  const tui = startTui({ stop: (reason) => controller.abort(reason) });

  // A signal can arrive when the terminal cannot deliver a keystroke, so the
  // same teardown is wired to both.
  const onSignal = (): void => controller.abort("interrupt");
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  try {
    const report = await walk({
      ui: tui.ui,
      launch,
      cwd,
      signal: controller.signal,
      platform,
      retell: retellReach(process.env),
    });
    tui.close(report);
    return walkExitCode(report);
  } catch (error) {
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
  verb: "init" | "pull" | "push" | "run",
  invocation: Invocation,
  access: PlatformAccess,
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
          suite: invocation.suiteName,
        },
      });
    }
    if (verb === "run") {
      return await runRunCommand({
        ...options,
        noFollow: invocation.noFollow,
        signal: controller.signal,
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

/** The connect verb: a key from a pipe or the environment, and plain lines. */
async function runConnect(
  invocation: Invocation,
  access: VerifiedPlatformAccess,
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

/** `--cwd` for a self-host command, read without the repository parser. */
function selfHostCwd(argv: readonly string[]): string {
  const named = argv.indexOf("--cwd");
  const value = named === -1 ? undefined : argv[named + 1];
  return path.resolve(value ?? process.cwd());
}

export async function main(argv: readonly string[]): Promise<void> {
  // Before anything is parsed or printed: an argument that would have carried
  // a secret is refused by name, and its value is never repeated back.
  const leaked = refusedArgumentIn(argv);
  if (leaked !== null) {
    process.stderr.write(`${argumentRefusal(leaked)}\n`);
    process.exitCode = 1;
    return;
  }

  // The platform operator's half of the CLI, and the one thing here that never
  // reads a repository or resolves a platform binding: `self-host` operates a
  // deployment, and a deployment is not something an agent repository points
  // at. It is settled before the arguments are parsed for the other half,
  // because none of those flags mean anything here.
  if (isSelfHostInvocation(argv)) {
    const controller = new AbortController();
    const onSignal = (): void => controller.abort("interrupt");
    process.on("SIGINT", onSignal);
    process.on("SIGTERM", onSignal);
    try {
      process.exitCode = await runSelfHostCommand({
        argv,
        cwd: selfHostCwd(argv),
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

  const invocation = parseArgs(argv);

  if (invocation.help) {
    process.stdout.write(`${helpText()}\n`);
    return;
  }
  if (invocation.version) {
    process.stdout.write(`${version()}\n`);
    return;
  }
  if (invocation.unknown.length > 0) {
    // Only the name is said back. Something written as `--thing=value` may be
    // carrying anything, and a refusal is no place to print it.
    const named = (invocation.unknown[0] as string).split("=")[0] as string;
    process.stderr.write(
      `egma does not know the option ${named}. Run egma --help to see the ones it does.\n`,
    );
    process.exitCode = 1;
    return;
  }

  const cwd = path.resolve(invocation.cwd ?? process.cwd());

  // `init` is only a local folder write. It never verifies a platform, signs
  // in, or sends an identifier anywhere.
  if (invocation.verb === "init") {
    process.exitCode = await runFolderVerb(invocation.verb, invocation, {
      url: DEFAULT_PLATFORM_URL,
      credentialsFile: credentialsFileIn(process.env),
    });
    return;
  }

  // The wizard's remaining work, held as one closure rather than a launch the
  // compiler cannot prove is there. Everything a bare command needs — the
  // keystroke of consent, the coding agent it will drive — is settled here,
  // before a single network read, and what comes out is either the rest of the
  // walk or nothing at all.
  let theWizard: ((access: VerifiedPlatformAccess) => Promise<number>) | null = null;
  if (invocation.verb === null) {
    // Consent is checked before a network read. A piped bare command cannot
    // start either the wizard or platform selection.
    const drawable = process.stdout.isTTY === true && process.stdin.isTTY === true;
    if (!invocation.headless && !drawable) {
      process.stderr.write(`${noTerminalRefusal()}\n`);
      process.exitCode = 1;
      return;
    }

    let launch: DrivenAgentLaunch;
    try {
      launch = launchFrom(invocation);
    } catch (error) {
      if (error instanceof UnlaunchableDrivenAgentError) {
        process.stdout.write(`${error.message}\n\n${pasteFallbackMessage()}\n`);
        return;
      }
      throw error;
    }
    theWizard = async (access) =>
      invocation.headless
        ? runHeadless(invocation, launch, cwd, access)
        : runWizard(launch, cwd, access);
  }

  // Which egma, resolved once for every path below, and refused here when the
  // address a developer named is not one. A bad address is turned away before
  // anything is started on it rather than after.
  let access: VerifiedPlatformAccess;
  try {
    access = await resolvePlatformAccess({
      env: process.env,
      flag: invocation.url,
      cwd,
    });
  } catch (error) {
    if (error instanceof UnusableUrlError) {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 1;
      return;
    }
    // Two shapes, and the difference is whether anything is worth retrying.
    // `unreachable` is nobody answering; `refused` is egma declining to send
    // this repository's identifiers to the address on offer.
    const refused =
      error instanceof PlatformBindingMismatchError ||
      error instanceof BoundPlatformAddressError ||
      error instanceof PlatformOriginMismatchError ||
      error instanceof RepositoryPlatformConfigError;
    if (
      refused ||
      error instanceof PlatformUnreachableError ||
      error instanceof PlatformIdentityError ||
      error instanceof BoundPlatformUnavailableError ||
      error instanceof DefaultPlatformUnusableError
    ) {
      const status = refused ? "refused" : "unreachable";
      const message = (error as Error).message;
      process.stdout.write(`status: ${status}\nreason: ${message}\n`);
      process.stderr.write(`${message}\n`);
      process.exitCode = 4;
      return;
    }
    throw error;
  }

  try {
    // A verb needs no terminal and takes no keystroke: it drives no coding
    // agent, so there is nothing for a keystroke to agree to.
    if (invocation.verb === "login") {
      process.exitCode = await runLogin(invocation, access);
      return;
    }
    if (invocation.verb === "connect") {
      process.exitCode = await runConnect(invocation, access);
      return;
    }
    if (
      invocation.verb === "pull" ||
      invocation.verb === "push" ||
      invocation.verb === "run"
    ) {
      process.exitCode = await runFolderVerb(invocation.verb, invocation, access);
      return;
    }

    // Every verb has returned by now, so what is left is the bare command, and
    // the walk it needs was built above.
    if (theWizard !== null) process.exitCode = await theWizard(access);
  } catch (error) {
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
