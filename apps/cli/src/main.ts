/** The promptless Egma CLI and its small coding-agent handoff. */

import { readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

import {
  AGENT_VARIABLE,
  argumentRefusal,
  KEY_VARIABLES,
  LANES_VARIABLE,
  NUMBER_VARIABLE,
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
import { runPersonasCommand } from "./commands/personas.ts";
import { runPullCommand } from "./commands/pull.ts";
import { runPushCommand } from "./commands/push.ts";
import { runWithOptionalLocalLiveKitWorker } from "./commands/run-local-worker.ts";
import { runRunCommand } from "./commands/run.ts";
import {
  isSelfHostInvocation,
  runSelfHostCommand,
} from "./commands/self-host.ts";
import { runSetupCommand } from "./commands/setup.ts";
import { runSuiteCreateCommand } from "./commands/suite.ts";
import { runValidateCommand } from "./commands/validate.ts";
import type { PlatformBinding } from "./folder/egma-folder.ts";
import {
  BoundPlatformAddressError,
  choosePlatform,
  credentialsFileIn,
  DEFAULT_PLATFORM_URL,
  KEYS_UNUSABLE,
  KeysUnusableError,
  RepositoryPlatformConfigError,
  selectPlatform,
  UnboundPlatformIdentifiersError,
  UnusableUrlError,
  type PlatformAccess,
} from "./platform/credentials.ts";
import { PlatformUnreachableError } from "./platform/device-flow.ts";
import { RETELL_API } from "./retell/client.ts";

/** Named commands are promptless and print stable fact lines for coding agents. */
export const VERBS = [
  "login",
  "connect",
  "init",
  "pull",
  "push",
  "run",
  "suite",
  "personas",
  "validate",
  "monitoring",
] as const;

export const RETELL_URL_VARIABLE = "EGMA_RETELL_URL";

export type Verb = (typeof VERBS)[number];

export type Invocation = {
  readonly help: boolean;
  readonly version: boolean;
  readonly verb: Verb | null;
  readonly cwd: string | null;
  readonly url: string | null;
  readonly force: boolean;
  readonly noFollow: boolean;
  readonly retellAgentId: string | null;
  readonly lanes: string | null;
  readonly phoneNumber: string | null;
  readonly repoPrompt: string | null;
  readonly showContext: boolean;
  readonly modality: string | null;
  readonly accessVariant: string | null;
  readonly livekitUrl: string | null;
  readonly dispatchName: string | null;
  readonly tokenEndpoint: string | null;
  readonly metadata: string | null;
  readonly agentName: string | null;
  readonly connectionName: string | null;
  readonly suiteAction: string | null;
  readonly monitoringAction: string | null;
  readonly platformWord: string | null;
  readonly platformAgentId: string | null;
  readonly monitoringKeyId: string | null;
  readonly suiteDirectory: string | null;
  readonly name: string | null;
  readonly workerEntrypoint: string | null;
  readonly workerDependencyManifest: string | null;
  readonly workerDispatchName: string | null;
  readonly unknown: readonly string[];
};

function isVerb(argument: string): argument is Verb {
  return (VERBS as readonly string[]).includes(argument);
}

/** Parse without a framework so every accepted word is visible in this file. */
export function parseArgs(argv: readonly string[]): Invocation {
  let help = false;
  let version = false;
  let verb: Verb | null = null;
  let cwd: string | null = null;
  let url: string | null = null;
  let force = false;
  let noFollow = false;
  let retellAgentId: string | null = null;
  let lanes: string | null = null;
  let phoneNumber: string | null = null;
  let repoPrompt: string | null = null;
  let showContext = false;
  let modality: string | null = null;
  let accessVariant: string | null = null;
  let livekitUrl: string | null = null;
  let dispatchName: string | null = null;
  let tokenEndpoint: string | null = null;
  let metadata: string | null = null;
  let agentName: string | null = null;
  let connectionName: string | null = null;
  let suiteAction: string | null = null;
  let monitoringAction: string | null = null;
  let platformWord: string | null = null;
  let platformAgentId: string | null = null;
  let monitoringKeyId: string | null = null;
  let suiteDirectory: string | null = null;
  let name: string | null = null;
  let workerEntrypoint: string | null = null;
  let workerDependencyManifest: string | null = null;
  let workerDispatchName: string | null = null;
  const unknown: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index] as string;
    if (argument === "-h" || argument === "--help") help = true;
    else if (argument === "-v" || argument === "--version") version = true;
    else if (argument === "--cwd") cwd = argv[(index += 1)] ?? null;
    else if (argument === "--url") url = argv[(index += 1)] ?? null;
    else if (argument === "--force") force = true;
    else if (argument === "--no-follow") noFollow = true;
    else if (argument === "--retell-agent") retellAgentId = argv[(index += 1)] ?? null;
    else if (argument === "--lanes") lanes = argv[(index += 1)] ?? null;
    else if (argument === "--phone-number") phoneNumber = argv[(index += 1)] ?? null;
    else if (argument === "--repo-prompt") repoPrompt = argv[(index += 1)] ?? null;
    else if (argument === "--show-context") showContext = true;
    else if (argument === "--modality") modality = argv[(index += 1)] ?? null;
    else if (argument === "--access-variant") accessVariant = argv[(index += 1)] ?? null;
    else if (argument === "--livekit-url") livekitUrl = argv[(index += 1)] ?? null;
    else if (argument === "--dispatch-name") dispatchName = argv[(index += 1)] ?? null;
    else if (argument === "--token-endpoint") tokenEndpoint = argv[(index += 1)] ?? null;
    else if (argument === "--metadata") metadata = argv[(index += 1)] ?? null;
    else if (argument === "--agent") agentName = argv[(index += 1)] ?? null;
    else if (argument === "--connection") connectionName = argv[(index += 1)] ?? null;
    else if (argument === "--name") name = argv[(index += 1)] ?? null;
    else if (argument === "--platform") platformWord = argv[(index += 1)] ?? null;
    else if (argument === "--platform-agent") platformAgentId = argv[(index += 1)] ?? null;
    else if (argument === "--monitoring-key-id") {
      monitoringKeyId = argv[(index += 1)] ?? null;
    } else if (argument === "--worker-entrypoint") {
      workerEntrypoint = argv[(index += 1)] ?? null;
    } else if (argument === "--worker-dependency-manifest") {
      workerDependencyManifest = argv[(index += 1)] ?? null;
    } else if (argument === "--worker-dispatch-name") {
      workerDispatchName = argv[(index += 1)] ?? null;
    } else if (verb === null && isVerb(argument)) verb = argument;
    else if (verb === "suite" && suiteAction === null) suiteAction = argument;
    else if (verb === "monitoring" && monitoringAction === null) {
      monitoringAction = argument;
    } else if (
      suiteDirectory === null &&
      (verb === "run" || (verb === "suite" && suiteAction === "create"))
    ) {
      suiteDirectory = argument;
    } else unknown.push(argument);
  }

  return {
    help,
    version,
    verb,
    cwd,
    url,
    force,
    noFollow,
    retellAgentId,
    lanes,
    phoneNumber,
    repoPrompt,
    showContext,
    modality,
    accessVariant,
    livekitUrl,
    dispatchName,
    tokenEndpoint,
    metadata,
    agentName,
    connectionName,
    suiteAction,
    monitoringAction,
    platformWord,
    platformAgentId,
    monitoringKeyId,
    suiteDirectory,
    name,
    workerEntrypoint,
    workerDependencyManifest,
    workerDispatchName,
    unknown,
  };
}

export function helpText(): string {
  return [
    "Egma — take a voice agent to reviewed, graded results.",
    "",
    "The bare command prints the public skill install command and the exact",
    "handoff for your coding agent. The coding agent runs login and every later",
    "step. Egma does not start or control it.",
    "",
    "Usage:",
    "  egma [options]                         Print the coding-agent handoff.",
    "  egma login [options]                   Sign this machine in.",
    "  egma connect [options]                 Register a Retell or LiveKit agent.",
    "  egma init [options]                    Create the repository egma/ folder.",
    "  egma personas                          List project personas for test files.",
    "  egma suite create <directory> --name <name>",
    "                                         Create a suite and local manifest.",
    "  egma validate                          Check the complete local repository.",
    "  egma pull                              Pull tests and mock tools.",
    "  egma push                              Upload the complete local repository.",
    "  egma run <suite-directory> [options]   Run and follow one complete suite.",
    "  egma monitoring <enable|disable|status|record> [options]",
    "                                         Manage production monitoring.",
    "  egma self-host up                      Start a local Egma platform.",
    "",
    "Common options:",
    "  --cwd <path>         Repository root. Default: this folder.",
    "  --url <address>      Egma platform for this command.",
    "  --force              With login: sign in again.",
    "  -h, --help           Print this help.",
    "  -v, --version        Print the version.",
    "",
    "Retell connect:",
    "  --platform retell              Select Retell. It is the default.",
    "  --retell-agent <id>            Select an exact Retell agent.",
    "  --lanes <list>                 text, web-call, phone, or a comma list.",
    "  --phone-number <e164>          Select the real number for phone runs.",
    "  --repo-prompt <path>           Compare a local prompt with Retell.",
    "  --show-context                 Print provider prompt and tools as JSON.",
    "",
    "LiveKit connect:",
    "  --platform livekit             Select LiveKit.",
    "  --name <name>                  Name the Egma agent.",
    "  --modality <chat|voice>        Select a catalog modality.",
    "  --access-variant <id>          Select a catalog connection method.",
    "  --livekit-url <wss-url>        LiveKit project URL.",
    "  --dispatch-name <name>         Exact registered worker name.",
    "  --token-endpoint <https-url>   Customer token endpoint, when selected.",
    "  --metadata <json>              Optional room metadata object.",
    "",
    "Run options:",
    "  --agent <name-or-id>                 Select a configured agent.",
    "  --connection <name-or-id>            Select its configured connection.",
    "  --name <name>                        Optional run name.",
    "  --no-follow                          Return after the run starts.",
    "  --worker-entrypoint <path>           Start this local LiveKit worker.",
    "  --worker-dependency-manifest <path>  Its dependency manifest.",
    "  --worker-dispatch-name <name>        Its exact registered worker name.",
    "",
    "Secrets:",
    `  ${KEY_VARIABLES[0]} or ${KEY_VARIABLES[1]}   Retell API key. Standard input also works.`,
    "  EGMA_LIVEKIT_API_KEY                 LiveKit project API key.",
    "  EGMA_LIVEKIT_API_SECRET              LiveKit project API secret.",
    "  EGMA_LIVEKIT_TOKEN_HEADERS           Token endpoint headers as JSON.",
    "  LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET",
    "                                       Local worker runtime credentials.",
    "  EGMA_HOME                            Egma credentials folder.",
    `  ${AGENT_VARIABLE}              Same as --retell-agent.`,
    `  ${LANES_VARIABLE}                     Same as --lanes.`,
    `  ${NUMBER_VARIABLE}              Same as --phone-number.`,
    `  ${RETELL_URL_VARIABLE}               Retell API URL. Default: ${RETELL_API}`,
    "",
    "Login facts and exit codes:",
    "  code, approve_url, browser, waiting, status, credentials",
    "  0 signed in   2 denied   3 expired",
    "  4 Egma did not answer, or refused   130 interrupted",
    "",
    "Connect exit codes:",
    "  0 connected   2 the key was refused   3 no provider agents",
    "  4 provider or Egma refused   5 a required choice is missing",
    "  6 provider credentials are missing   7 not signed in",
    "  8 no routed Retell number   130 interrupted",
    "",
    "Every named command asks no questions, prints one fact per line, and uses",
    "its exit code as the branch. Credentials never belong in command arguments.",
    `An unusable credentials file prints status: ${KEYS_UNUSABLE} and changes nothing.`,
  ].join("\n");
}

export function version(): string {
  const manifest = readFileSync(new URL("../package.json", import.meta.url), "utf8");
  return (JSON.parse(manifest) as { version?: string }).version ?? "0.0.0";
}

function retellReach(env: NodeJS.ProcessEnv): { readonly url: string } | undefined {
  const named = env[RETELL_URL_VARIABLE]?.trim();
  return named === undefined || named === "" ? undefined : { url: named };
}

function platformRefusal(error: unknown): "refused" | "unreachable" | null {
  if (
    error instanceof BoundPlatformAddressError ||
    error instanceof RepositoryPlatformConfigError ||
    error instanceof UnboundPlatformIdentifiersError
  ) {
    return "refused";
  }
  return error instanceof PlatformUnreachableError ? "unreachable" : null;
}

function sayPlatformRefusal(status: "refused" | "unreachable", message: string): void {
  const sentence = message.split("\n")[0] as string;
  process.stdout.write(`status: ${status}\nreason: ${sentence}\n`);
  process.stderr.write(`${message}\n`);
  process.exitCode = 4;
}

function commandOptions(invocation: Invocation, access: PlatformAccess): FolderCommandOptions {
  return {
    access,
    cwd: path.resolve(invocation.cwd ?? process.cwd()),
    out: (line) => void process.stdout.write(`${line}\n`),
    fail: (line) => void process.stderr.write(`${line}\n`),
  };
}

async function runFolderVerb(
  verb: "init" | "pull" | "push" | "run" | "suite" | "personas" | "validate",
  invocation: Invocation,
  access: PlatformAccess,
  binding: PlatformBinding | null = null,
): Promise<number> {
  const controller = new AbortController();
  const onSignal = (): void => controller.abort("interrupt");
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  const options = commandOptions(invocation, access);

  try {
    if (verb === "init") return await runInitCommand({ ...options, binding });
    if (verb === "personas") return await runPersonasCommand(options);
    if (verb === "validate") return await runValidateCommand(options);
    if (verb === "suite") {
      return await runSuiteCreateCommand({
        ...options,
        directory: invocation.suiteDirectory ?? "",
        name: invocation.name ?? "",
      });
    }
    if (verb === "run") {
      return await runWithOptionalLocalLiveKitWorker(
        {
          cwd: options.cwd,
          workerEntrypoint: invocation.workerEntrypoint,
          workerDependencyManifest: invocation.workerDependencyManifest,
          workerDispatchName: invocation.workerDispatchName,
          noFollow: invocation.noFollow,
          signal: controller.signal,
          env: process.env,
          out: options.out,
          fail: options.fail,
        },
        async (signal) =>
          await runRunCommand({
            ...options,
            suiteDirectory: invocation.suiteDirectory ?? "",
            ...(invocation.agentName === null ? {} : { agent: invocation.agentName }),
            ...(invocation.connectionName === null
              ? {}
              : { connection: invocation.connectionName }),
            ...(invocation.name === null ? {} : { name: invocation.name }),
            noFollow: invocation.noFollow,
            signal,
          }),
      );
    }
    return verb === "pull" ? await runPullCommand(options) : await runPushCommand(options);
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  }
}

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
      agent: invocation.agentName,
      platform: invocation.platformWord,
      platformAgentId: invocation.platformAgentId,
      monitoringKeyId: invocation.monitoringKeyId,
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

async function runConnect(invocation: Invocation, access: PlatformAccess): Promise<number> {
  const controller = new AbortController();
  const onSignal = (): void => controller.abort("interrupt");
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  try {
    return await runConnectCommand({
      access,
      cwd: path.resolve(invocation.cwd ?? process.cwd()),
      agentId: invocation.retellAgentId,
      lanes: invocation.lanes,
      phoneNumber: invocation.phoneNumber,
      repoPrompt: invocation.repoPrompt,
      platform: invocation.platformWord,
      showContext: invocation.showContext,
      modality: invocation.modality,
      accessVariant: invocation.accessVariant,
      livekitUrl: invocation.livekitUrl,
      dispatchName: invocation.dispatchName,
      tokenEndpoint: invocation.tokenEndpoint,
      metadata: invocation.metadata,
      name: invocation.name,
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

function invalidInvocation(invocation: Invocation): string | null {
  if (
    invocation.verb === "init" &&
    (invocation.agentName !== null || invocation.connectionName !== null)
  ) {
    return "Egma does not use --agent or --connection with init. Run egma connect to add them.";
  }
  if (
    invocation.verb === "monitoring" &&
    !(MONITORING_ACTIONS as readonly string[]).includes(invocation.monitoringAction ?? "")
  ) {
    return unknownActionRefusal(invocation.monitoringAction ?? "");
  }
  if (invocation.verb === "suite" && invocation.suiteAction !== "create") {
    return "Egma supports `egma suite create <directory> --name <name>`.";
  }
  if (invocation.verb === "suite" && invocation.suiteDirectory === null) {
    return "Name the local directory: egma suite create <directory> --name <name>.";
  }
  if (invocation.verb === "suite" && invocation.name === null) {
    return "Name the suite: egma suite create <directory> --name <name>.";
  }
  if (invocation.verb === "run" && invocation.suiteDirectory === null) {
    return "Name one local suite directory: egma run <suite-directory>.";
  }
  if (invocation.unknown.length > 0) {
    const named = (invocation.unknown[0] as string).split("=")[0] as string;
    return `Egma does not know the option ${named}. Run egma --help to see the ones it does.`;
  }
  return null;
}

export async function main(argv: readonly string[]): Promise<void> {
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

  const invalid = invalidInvocation(invocation);
  if (invalid !== null) {
    process.stderr.write(`${invalid}\n`);
    process.exitCode = 1;
    return;
  }

  if (invocation.verb === null) {
    let platformUrl: string | null = null;
    if (invocation.url !== null) {
      try {
        platformUrl = selectPlatform({
          flag: invocation.url,
          binding: null,
          fallback: DEFAULT_PLATFORM_URL,
        }).url;
      } catch (error) {
        if (!(error instanceof UnusableUrlError)) throw error;
        process.stderr.write(`${error.message}\n`);
        process.exitCode = 1;
        return;
      }
    }
    process.exitCode = runSetupCommand({
      platformUrl,
      out: (line) => process.stdout.write(`${line}\n`),
    });
    return;
  }

  const cwd = path.resolve(invocation.cwd ?? process.cwd());
  if (invocation.verb === "init" && invocation.url === null) {
    process.exitCode = await runFolderVerb(invocation.verb, invocation, {
      url: "",
      credentialsFile: credentialsFileIn(process.env),
    });
    return;
  }

  let access: PlatformAccess;
  try {
    const chosen = await choosePlatform({ env: process.env, flag: invocation.url, cwd });
    access = { url: chosen.url, credentialsFile: chosen.credentialsFile };
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
    if (invocation.verb === "init") {
      process.exitCode = await runFolderVerb(invocation.verb, invocation, access, {
        origin: access.url,
      });
      return;
    }
    process.exitCode = await runFolderVerb(invocation.verb, invocation, access);
  } catch (error) {
    const status = platformRefusal(error);
    if (status !== null) {
      sayPlatformRefusal(status, (error as Error).message);
      return;
    }
    if (!(error instanceof KeysUnusableError)) throw error;
    process.stdout.write(`status: ${KEYS_UNUSABLE}\nreason: ${error.message}\n`);
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
