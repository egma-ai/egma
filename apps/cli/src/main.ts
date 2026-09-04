/** The promptless Egma CLI used by developers and coding agents. */

import { readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

import {
  runAgentConnectionAddCommand,
  runAgentConnectionOptionsCommand,
  runAgentRegisterCommand,
} from "./commands/agent.ts";
import {
  runAgentMonitoringSetupCommand,
  runAgentMonitoringStopCommand,
} from "./commands/agent-monitoring.ts";
import type { FolderCommandOptions } from "./commands/folder-verbs.ts";
import { runInitCommand } from "./commands/init.ts";
import { runLoginCommand } from "./commands/login.ts";
import { runLogoutCommand } from "./commands/logout.ts";
import { runPersonasCommand } from "./commands/personas.ts";
import { runProjectApiKeyCreateCommand } from "./commands/project-api-key.ts";
import { runPullCommand } from "./commands/pull.ts";
import { runPushCommand } from "./commands/push.ts";
import { runCancelCommand, runCreateCommand } from "./commands/run.ts";
import { runSelfHostCommand } from "./commands/self-host.ts";
import { runSuiteCreateCommand } from "./commands/suite.ts";
import {
  BoundPlatformAddressError,
  choosePlatform,
  KEYS_UNUSABLE,
  KeysUnusableError,
  RepositoryPlatformConfigError,
  UnboundPlatformIdentifiersError,
  UnusableUrlError,
  type PlatformAccess,
} from "./platform/credentials.ts";
import { PlatformUnreachableError } from "./platform/device-flow.ts";
import { PlatformRefusedError } from "./platform/refused.ts";

/** The only public root commands. Nested commands are listed in their help. */
export const VERBS = [
  "login",
  "logout",
  "init",
  "pull",
  "push",
  "agent",
  "project",
  "persona",
  "suite",
  "run",
  "self-host",
] as const;

export type Verb = (typeof VERBS)[number];

export const COMMANDS = [
  "login",
  "logout",
  "init",
  "pull",
  "push",
  "agent register",
  "agent connection options",
  "agent connection add",
  "agent monitoring setup",
  "agent monitoring stop",
  "project api-key create",
  "persona list",
  "suite create",
  "run create",
  "run cancel",
  "self-host up",
] as const;

export type Command = (typeof COMMANDS)[number];

export const HELP_TOPICS = [
  "root",
  "agent",
  "agent connection",
  "agent monitoring",
  "project",
  "project api-key",
  "persona",
  "suite",
  "run",
  "self-host",
  ...COMMANDS,
] as const;

export type HelpTopic = (typeof HELP_TOPICS)[number];

export type ParsedArguments = {
  readonly values: Readonly<Record<string, string>>;
  readonly switches: ReadonlySet<string>;
  readonly positionals: readonly string[];
};

export type Invocation =
  | { readonly kind: "help"; readonly topic: HelpTopic }
  | { readonly kind: "version" }
  | {
      readonly kind: "command";
      readonly command: Command;
      readonly arguments: ParsedArguments;
    }
  | { readonly kind: "invalid"; readonly message: string };

type OptionSchema = {
  readonly values: readonly string[];
  readonly switches?: readonly string[];
  readonly positionals: number;
};

const REPOSITORY_OPTION = "--cwd";
const ACCESS_VALUES =
  "retell-api-key, retell-phone-number, livekit-project-credentials, or livekit-token-endpoint";

const SCHEMAS: Readonly<Record<Command, OptionSchema>> = {
  login: {
    values: ["--url", REPOSITORY_OPTION],
    switches: ["--force"],
    positionals: 0,
  },
  logout: { values: ["--url", REPOSITORY_OPTION], positionals: 0 },
  init: {
    values: ["--url", "--project", REPOSITORY_OPTION],
    positionals: 0,
  },
  pull: { values: [REPOSITORY_OPTION], positionals: 0 },
  push: { values: [REPOSITORY_OPTION], positionals: 0 },
  "agent register": {
    values: [
      "--platform",
      "--access",
      "--modality",
      "--name",
      "--connection-name",
      "--retell-agent",
      "--phone-number",
      "--livekit-url",
      "--dispatch-name",
      "--token-endpoint",
      REPOSITORY_OPTION,
    ],
    switches: ["--credentials-stdin"],
    positionals: 0,
  },
  "agent connection options": {
    values: ["--platform", "--agent", REPOSITORY_OPTION],
    switches: ["--credentials-stdin"],
    positionals: 0,
  },
  "agent connection add": {
    values: [
      "--agent",
      "--access",
      "--modality",
      "--connection-name",
      "--phone-number",
      "--livekit-url",
      "--dispatch-name",
      "--token-endpoint",
      REPOSITORY_OPTION,
    ],
    switches: ["--credentials-stdin"],
    positionals: 0,
  },
  "agent monitoring setup": {
    values: ["--agent", "--platform", REPOSITORY_OPTION],
    positionals: 0,
  },
  "agent monitoring stop": {
    values: ["--agent", REPOSITORY_OPTION],
    positionals: 0,
  },
  "project api-key create": {
    values: ["--name", REPOSITORY_OPTION],
    positionals: 0,
  },
  "persona list": { values: [REPOSITORY_OPTION], positionals: 0 },
  "suite create": {
    values: ["--name", REPOSITORY_OPTION],
    positionals: 1,
  },
  "run create": {
    values: ["--agent", "--connection", "--name", REPOSITORY_OPTION],
    positionals: 1,
  },
  "run cancel": { values: [REPOSITORY_OPTION], positionals: 1 },
  "self-host up": { values: [REPOSITORY_OPTION], positionals: 0 },
};

const LEAF_PATHS = [...COMMANDS]
  .map((command) => ({ command, words: command.split(" ") }))
  .sort((left, right) => right.words.length - left.words.length);

const NODE_PATHS = [
  "agent connection",
  "agent monitoring",
  "project api-key",
  "agent",
  "project",
  "persona",
  "suite",
  "run",
  "self-host",
] as const;

function beginsWith(words: readonly string[], prefix: readonly string[]): boolean {
  return prefix.every((word, index) => words[index] === word);
}

function optionName(argument: string): string {
  const equals = argument.indexOf("=");
  return equals === -1 ? argument : argument.slice(0, equals);
}

function invalidOption(name: string, command: Command): Invocation {
  return {
    kind: "invalid",
    message: `egma ${command} does not know the option ${name}. Run egma ${command} --help.`,
  };
}

function parseLeafArguments(
  command: Command,
  argv: readonly string[],
): Invocation {
  const schema = SCHEMAS[command];
  const values: Record<string, string> = {};
  const switches = new Set<string>();
  const positionals: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index] as string;
    if (!argument.startsWith("-")) {
      positionals.push(argument);
      continue;
    }

    const name = optionName(argument);
    const equals = argument.indexOf("=");
    const attached = equals === -1 ? null : argument.slice(equals + 1);

    if ((schema.switches ?? []).includes(name)) {
      if (attached !== null) {
        return {
          kind: "invalid",
          message: `${name} does not take a value. Run egma ${command} --help.`,
        };
      }
      if (switches.has(name)) {
        return {
          kind: "invalid",
          message: `Use ${name} only once. Run egma ${command} --help.`,
        };
      }
      switches.add(name);
      continue;
    }

    if (schema.values.includes(name)) {
      const next = attached ?? argv[index + 1];
      if (next === undefined || next === "" || (attached === null && next.startsWith("-"))) {
        return {
          kind: "invalid",
          message: `${name} needs a value. Run egma ${command} --help.`,
        };
      }
      if (Object.hasOwn(values, name)) {
        return {
          kind: "invalid",
          message: `Use ${name} only once. Run egma ${command} --help.`,
        };
      }
      values[name] = next;
      if (attached === null) index += 1;
      continue;
    }

    // Never repeat an attached value. An unknown option may contain a secret.
    return invalidOption(name, command);
  }

  if (positionals.length !== schema.positionals) {
    const expected = schema.positionals === 0 ? "no positional arguments" : "one positional argument";
    return {
      kind: "invalid",
      message: `egma ${command} needs ${expected}. Run egma ${command} --help.`,
    };
  }

  return {
    kind: "command",
    command,
    arguments: { values, switches, positionals },
  };
}

/** Parse one command path first, then only the options owned by that command. */
export function parseArgs(argv: readonly string[]): Invocation {
  if (argv.length === 0 || (argv.length === 1 && ["-h", "--help"].includes(argv[0] ?? ""))) {
    return { kind: "help", topic: "root" };
  }
  if (argv.length === 1 && ["-v", "--version"].includes(argv[0] ?? "")) {
    return { kind: "version" };
  }

  for (const route of LEAF_PATHS) {
    if (!beginsWith(argv, route.words)) continue;
    const rest = argv.slice(route.words.length);
    if (rest.includes("--help") || rest.includes("-h")) {
      return { kind: "help", topic: route.command };
    }
    return parseLeafArguments(route.command, rest);
  }

  for (const node of NODE_PATHS) {
    const words = node.split(" ");
    if (!beginsWith(argv, words)) continue;
    const rest = argv.slice(words.length);
    if (rest.length === 0 || (rest.length === 1 && ["-h", "--help"].includes(rest[0] ?? ""))) {
      return { kind: "help", topic: node };
    }
    return {
      kind: "invalid",
      message: `Egma does not know that ${node} subcommand. Run egma ${node} --help.`,
    };
  }

  return {
    kind: "invalid",
    message: `Egma does not know the command ${JSON.stringify(argv[0] ?? "")}. Run egma --help to see the command tree.`,
  };
}

const HELP: Readonly<Record<HelpTopic, readonly string[]>> = {
  root: [
    "Egma CLI — use Egma from a repository with an Egma skill.",
    "",
    "Usage:",
    "  egma <command> [options]",
    "",
    "Commands:",
    "  egma login                         Sign this machine in.",
    "  egma logout                        Revoke this machine login and sign out.",
    "  egma init                          Initialize or pull the repository's Egma Project.",
    "  egma pull                          Pull Agents, Connections, suites, and tests.",
    "  egma push                          Validate and push suites and tests.",
    "  egma agent                         Register Agents, add Connections, and set up monitoring.",
    "  egma project                       Manage the bound Egma Project.",
    "  egma persona                       Read the Project's test personas.",
    "  egma suite                         Create local test suites.",
    "  egma run                           Create or cancel simulation Runs.",
    "  egma self-host                     Start a self-hosted Egma platform.",
    "",
    "Run egma <command> --help at any command or command group.",
    "Repository commands read the platform URL and Project from egma/config.yaml.",
    "If that file is absent, run egma init.",
  ],
  agent: [
    "Usage:",
    "  egma agent register [options]",
    "  egma agent connection <command>",
    "  egma agent monitoring <command>",
    "",
    "Commands:",
    "  register      Create or reuse an Egma Agent and add its first Connection.",
    "  connection    List provider choices or add another Connection.",
    "  monitoring    Set up or stop production monitoring for one Agent.",
  ],
  "agent connection": [
    "Usage:",
    "  egma agent connection options --platform <retell|livekit> [options]",
    "  egma agent connection add --agent <Egma Agent ID> [options]",
    "",
    "Commands:",
    "  options       Read valid Access, Modality, fields, and provider Agents.",
    "  add           Add one Connection to an existing Egma Agent.",
  ],
  "agent monitoring": [
    "Usage:",
    "  egma agent monitoring setup --agent <Egma Agent ID> --platform <retell|livekit>",
    "  egma agent monitoring stop --agent <Egma Agent ID>",
    "",
    "Retell setup uses the provider key already sealed on the Egma Agent.",
    "LiveKit prints the integrate-egma skill handoff; the CLI does not edit monitoring code.",
  ],
  project: [
    "Usage:",
    "  egma project api-key <command>",
    "",
    "Commands:",
    "  api-key       Manage API keys for the bound Egma Project.",
  ],
  "project api-key": [
    "Usage:",
    "  egma project api-key create --name <name>",
    "",
    "The secret is printed once. The CLI does not save it.",
  ],
  persona: ["Usage:", "  egma persona list [--cwd <path>]"],
  suite: [
    "Usage:",
    "  egma suite create <directory> --name <name> [--cwd <path>]",
    "",
    "The directory is one direct child of egma/tests, not a Suite ID.",
  ],
  run: [
    "Usage:",
    "  egma run create <suite-directory> --agent <Agent ID> --connection <Connection ID> [options]",
    "  egma run cancel <Run ID> [--cwd <path>]",
    "",
    "create pushes the complete repository first, starts the Run, prints its results URL, and returns.",
  ],
  "self-host": ["Usage:", "  egma self-host up [--cwd <platform-workspace>]"],
  login: [
    "Usage:",
    "  egma login [--url <address>] [--force] [--cwd <path>]",
    "",
    "Without --url, Egma uses this repository's platform URL or the hosted Egma URL.",
    "--force replaces an existing saved login for the selected platform.",
    "EGMA_HOME changes the machine-local folder that holds the saved login.",
    "",
    "While approval is pending, the command prints code and approve_url facts.",
    "Exit 0 means signed in, 2 means denied, 3 means expired, 4 means the platform",
    "refused or did not answer, and 130 means interrupted.",
  ],
  logout: [
    "Usage:",
    "  egma logout [--url <Egma URL>] [--cwd <path>]",
    "",
    "Logout revokes the selected saved login, then removes only that local credential entry.",
    "It never removes egma/ and never revokes EGMA_API_KEY from your environment.",
  ],
  init: [
    "Usage:",
    "  egma init [--url <Egma URL>] [--project <Project ID>] [--cwd <path>]",
    "",
    "If the login identifies a Project, init selects it and pulls its current repository state.",
    "Use --project only when the credential does not identify one Project.",
  ],
  pull: [
    "Usage:",
    "  egma pull [--cwd <path>]",
    "",
    "The platform URL and Project come from egma/config.yaml.",
  ],
  push: [
    "Usage:",
    "  egma push [--cwd <path>]",
    "",
    "Push validates the complete local repository before it uploads anything.",
    "The platform API remains the source of truth for its accepted contract.",
  ],
  "agent register": [
    "Usage:",
    "  egma agent register --platform <retell|livekit> --access <method> --modality <voice|chat> [options]",
    "",
    "Creates or reuses one Egma Agent and adds its first Connection atomically.",
    "",
    "Identity:",
    "  --name <name>                 Optional Egma Agent name; provider name is the default.",
    "  --connection-name <name>      Optional Connection name.",
    "  --retell-agent <id>           Retell Agent ID for initial Retell registration only.",
    "",
    "Connection:",
    `  --access <method>             ${ACCESS_VALUES}.`,
    "  --modality <voice|chat>       Connection Modality.",
    "  --phone-number <E.164>        Retell phone number when the selected option requires it.",
    "  --livekit-url <wss-url>       LiveKit project URL (project credentials).",
    "  --dispatch-name <name>        LiveKit worker dispatch name.",
    "  --token-endpoint <https-url>  LiveKit token endpoint.",
    "",
    "Credentials:",
    "  --credentials-stdin           Retell: raw API key. LiveKit project: {\"apiKey\":\"...\",\"apiSecret\":\"...\"}.",
    "                                LiveKit endpoint: {\"headers\":{\"Authorization\":\"Bearer ...\"}}.",
    "  Otherwise use EGMA_RETELL_API_KEY, EGMA_LIVEKIT_API_KEY with",
    "  EGMA_LIVEKIT_API_SECRET, or EGMA_LIVEKIT_TOKEN_HEADERS as applicable.",
    "  Provider credentials are sent for setup and are never written to egma/config.yaml.",
    "",
    "Repository:",
    "  --cwd <path>                  Repository root. Default: current directory.",
  ],
  "agent connection options": [
    "Usage:",
    "  egma agent connection options --platform <retell|livekit> [options]",
    "",
    "Options:",
    "  --agent <Egma Agent ID>       Reuse that Agent's stored provider credential.",
    "  --credentials-stdin           Use the same standard-input forms as agent register.",
    "  --cwd <path>                  Repository root. Default: current directory.",
    "",
    "Egma gets valid Access and Modality combinations and required fields from the platform API.",
    "For Retell it also lists provider Agent IDs, names, and attached phone numbers.",
  ],
  "agent connection add": [
    "Usage:",
    "  egma agent connection add --agent <Egma Agent ID> --access <method> --modality <voice|chat> [options]",
    "",
    "The Egma Agent supplies its platform and provider Agent ID. Do not pass --platform or --retell-agent.",
    "",
    "Options:",
    `  --access <method>             ${ACCESS_VALUES}.`,
    "  --modality <voice|chat>       Connection Modality.",
    "  --connection-name <name>      Optional Connection name.",
    "  --phone-number <E.164>        Retell phone number when required.",
    "  --livekit-url <wss-url>       LiveKit project URL (project credentials).",
    "  --dispatch-name <name>        LiveKit worker dispatch name.",
    "  --token-endpoint <https-url>  LiveKit token endpoint.",
    "  --credentials-stdin           Read provider credentials from standard input.",
    "  --cwd <path>                  Repository root. Default: current directory.",
    "",
    "The platform API supplies the valid combinations and required fields.",
  ],
  "agent monitoring setup": [
    "Usage:",
    "  egma agent monitoring setup --agent <Egma Agent ID> --platform <retell|livekit> [--cwd <path>]",
    "",
    "Retell uses the provider key stored on the Agent. LiveKit prints the integrate-egma skill command.",
  ],
  "agent monitoring stop": [
    "Usage:",
    "  egma agent monitoring stop --agent <Egma Agent ID> [--cwd <path>]",
    "",
    "The selected Agent supplies its platform.",
  ],
  "project api-key create": [
    "Usage:",
    "  egma project api-key create --name <name> [--cwd <path>]",
    "",
    "Creates one Project-scoped API key for the Project in egma/config.yaml.",
    "The secret is printed once and is not stored by the CLI.",
  ],
  "persona list": ["Usage:", "  egma persona list [--cwd <path>]"],
  "suite create": [
    "Usage:",
    "  egma suite create <directory> --name <name> [--cwd <path>]",
    "",
    "Creates egma/tests/<directory>/suite.yaml and its remote Suite.",
  ],
  "run create": [
    "Usage:",
    "  egma run create <suite-directory> --agent <Agent ID> --connection <Connection ID> [--name <name>] [--cwd <path>]",
    "",
    "The suite directory is the direct child under egma/tests, not a Suite ID.",
    "Egma pushes first. It creates no Run if the push fails.",
    "On success it prints the Run ID, results URL, and status, then returns.",
  ],
  "run cancel": ["Usage:", "  egma run cancel <Run ID> [--cwd <path>]"],
  "self-host up": ["Usage:", "  egma self-host up [--cwd <platform-workspace>]"],
};

export function helpText(topic: HelpTopic = "root"): string {
  return HELP[topic].join("\n");
}

export function version(): string {
  const manifest = readFileSync(new URL("../package.json", import.meta.url), "utf8");
  return (JSON.parse(manifest) as { version?: string }).version ?? "0.0.0";
}

function value(arguments_: ParsedArguments, name: string): string | null {
  return arguments_.values[name] ?? null;
}

function switched(arguments_: ParsedArguments, name: string): boolean {
  return arguments_.switches.has(name);
}

function required(
  invocation: Extract<Invocation, { readonly kind: "command" }>,
  names: readonly string[],
): string | null {
  for (const name of names) {
    if ((value(invocation.arguments, name) ?? "").trim() === "") {
      return `${name} is required. Run egma ${invocation.command} --help.`;
    }
  }
  return null;
}

function requiredArguments(
  invocation: Extract<Invocation, { readonly kind: "command" }>,
): string | null {
  switch (invocation.command) {
    case "agent register":
      return required(invocation, ["--platform", "--access", "--modality"]);
    case "agent connection options":
      return required(invocation, ["--platform"]);
    case "agent connection add":
      return required(invocation, ["--agent", "--access", "--modality"]);
    case "agent monitoring setup":
      return required(invocation, ["--agent", "--platform"]);
    case "agent monitoring stop":
      return required(invocation, ["--agent"]);
    case "project api-key create":
    case "suite create":
      return required(invocation, ["--name"]);
    case "run create":
      return required(invocation, ["--agent", "--connection"]);
    default:
      return null;
  }
}

function platformRefusal(error: unknown): "refused" | "unreachable" | null {
  if (
    error instanceof BoundPlatformAddressError ||
    error instanceof RepositoryPlatformConfigError ||
    error instanceof UnboundPlatformIdentifiersError ||
    error instanceof PlatformRefusedError
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

function output(line: string): void {
  process.stdout.write(`${line}\n`);
}

function failure(line: string): void {
  process.stderr.write(`${line}\n`);
}

function commandOptions(
  invocation: Extract<Invocation, { readonly kind: "command" }>,
  access: PlatformAccess,
): FolderCommandOptions {
  return {
    access,
    cwd: path.resolve(value(invocation.arguments, REPOSITORY_OPTION) ?? process.cwd()),
    out: output,
    fail: failure,
  };
}

async function withCommandSignal(
  run: (signal: AbortSignal) => Promise<number>,
): Promise<number> {
  const controller = new AbortController();
  const onSignal = (): void => controller.abort("interrupt");
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  try {
    return await run(controller.signal);
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  }
}

async function dispatch(
  invocation: Extract<Invocation, { readonly kind: "command" }>,
  access: PlatformAccess,
): Promise<number> {
  const options = commandOptions(invocation, access);
  const args = invocation.arguments;

  switch (invocation.command) {
    case "login":
      return withCommandSignal(async (signal) =>
        runLoginCommand({
          access,
          force: switched(args, "--force"),
          env: process.env,
          signal,
          out: output,
          fail: failure,
        }),
      );
    case "logout":
      return withCommandSignal(async (signal) =>
        runLogoutCommand({
          access,
          env: process.env,
          signal,
          out: output,
          fail: failure,
        }),
      );
    case "init": {
      const projectId = value(args, "--project");
      return runInitCommand({
        ...options,
        binding: { origin: access.url },
        ...(projectId === null ? {} : { projectId }),
      });
    }
    case "pull":
      return runPullCommand(options);
    case "push":
      return runPushCommand(options);
    case "persona list":
      return runPersonasCommand(options);
    case "suite create":
      return runSuiteCreateCommand({
        ...options,
        directory: args.positionals[0] as string,
        name: value(args, "--name") as string,
      });
    case "run create": {
      const name = value(args, "--name");
      return withCommandSignal(async (signal) =>
        runCreateCommand({
          ...options,
          suiteDirectory: args.positionals[0] as string,
          agent: value(args, "--agent") as string,
          connection: value(args, "--connection") as string,
          ...(name === null ? {} : { name }),
          signal,
        }),
      );
    }
    case "run cancel":
      return withCommandSignal(async (signal) =>
        runCancelCommand({
          ...options,
          runId: args.positionals[0] as string,
          signal,
        }),
      );
    case "agent register":
      return withCommandSignal(async (signal) =>
        runAgentRegisterCommand({
          ...options,
          platform: value(args, "--platform"),
          accessMethod: value(args, "--access"),
          modality: value(args, "--modality"),
          name: value(args, "--name"),
          connectionName: value(args, "--connection-name"),
          retellAgentId: value(args, "--retell-agent"),
          phoneNumber: value(args, "--phone-number"),
          livekitUrl: value(args, "--livekit-url"),
          dispatchName: value(args, "--dispatch-name"),
          tokenEndpoint: value(args, "--token-endpoint"),
          credentialsStdin: switched(args, "--credentials-stdin"),
          env: process.env,
          stdin: process.stdin,
          signal,
        }),
      );
    case "agent connection options":
      return withCommandSignal(async (signal) =>
        runAgentConnectionOptionsCommand({
          ...options,
          platform: value(args, "--platform"),
          agentId: value(args, "--agent"),
          credentialsStdin: switched(args, "--credentials-stdin"),
          env: process.env,
          stdin: process.stdin,
          signal,
        }),
      );
    case "agent connection add":
      return withCommandSignal(async (signal) =>
        runAgentConnectionAddCommand({
          ...options,
          agentId: value(args, "--agent"),
          accessMethod: value(args, "--access"),
          modality: value(args, "--modality"),
          connectionName: value(args, "--connection-name"),
          phoneNumber: value(args, "--phone-number"),
          livekitUrl: value(args, "--livekit-url"),
          dispatchName: value(args, "--dispatch-name"),
          tokenEndpoint: value(args, "--token-endpoint"),
          credentialsStdin: switched(args, "--credentials-stdin"),
          env: process.env,
          stdin: process.stdin,
          signal,
        }),
      );
    case "agent monitoring setup":
      return withCommandSignal(async (signal) =>
        runAgentMonitoringSetupCommand({
          ...options,
          agent: value(args, "--agent") as string,
          platform: value(args, "--platform") as string,
          signal,
        }),
      );
    case "agent monitoring stop":
      return withCommandSignal(async (signal) =>
        runAgentMonitoringStopCommand({
          ...options,
          agent: value(args, "--agent") as string,
          signal,
        }),
      );
    case "project api-key create":
      return withCommandSignal(async (signal) =>
        runProjectApiKeyCreateCommand({
          ...options,
          name: value(args, "--name") as string,
          signal,
        }),
      );
    case "self-host up":
      throw new Error("self-host up is dispatched before platform selection");
  }
}

/** Execute one public command. */
export async function main(argv: readonly string[]): Promise<void> {
  const invocation = parseArgs(argv);
  if (invocation.kind === "help") {
    process.stdout.write(`${helpText(invocation.topic)}\n`);
    return;
  }
  if (invocation.kind === "version") {
    process.stdout.write(`${version()}\n`);
    return;
  }
  if (invocation.kind === "invalid") {
    process.stderr.write(`${invocation.message}\n`);
    process.exitCode = 1;
    return;
  }

  const missing = requiredArguments(invocation);
  if (missing !== null) {
    process.stderr.write(`${missing}\n`);
    process.exitCode = 1;
    return;
  }

  if (invocation.command === "self-host up") {
    process.exitCode = await withCommandSignal(async (signal) =>
      runSelfHostCommand({
        argv,
        cwd: process.cwd(),
        env: process.env,
        stdin: process.stdin,
        stdout: process.stdout,
        out: output,
        fail: failure,
        signal,
      }),
    );
    return;
  }

  const cwd = path.resolve(value(invocation.arguments, REPOSITORY_OPTION) ?? process.cwd());
  const mayChooseUrl = ["login", "logout", "init"].includes(invocation.command);

  let access: PlatformAccess;
  try {
    const chosen = await choosePlatform({
      env: process.env,
      flag: mayChooseUrl ? value(invocation.arguments, "--url") : null,
      cwd,
    });
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
    process.exitCode = await dispatch(invocation, access);
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
