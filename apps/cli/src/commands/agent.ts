/**
 * Agent and Connection commands for the skills-led CLI.
 *
 * These commands do not run a wizard. A skill or a developer supplies the
 * choices on the command line. Egma's API supplies the connection catalog and
 * Retell discovery results, so this client does not keep a second list of
 * required fields or supported connection tuples.
 */

import path from "node:path";

import {
  folderPathsIn,
  readConfig,
  type FolderConfig,
  type FolderPaths,
  type IdentifiedThing,
} from "../folder/egma-folder.ts";
import {
  addConnection,
  readAgent,
  registerAgentIdentity,
  type NewConnection,
  type RegisteredAgent,
  type RegisteredConnection,
  type RegisterOutcome,
  type RegisterOptions,
} from "../platform/agents.ts";
import { ConnectionCredentials } from "../platform/connection-credentials.ts";
import {
  connectionOptionsForPlatform,
  readConnectionOptions,
  type ConnectionOption,
} from "../platform/connection-options.ts";
import type { PlatformAccess } from "../platform/credentials.ts";
import {
  discoverRetellAgents,
  type DiscoveredAgent,
  type DiscoveredConnection,
} from "../platform/discovery.ts";
import type { Fetch } from "../platform/device-flow.ts";
import {
  notSignedInRefusal,
  signedInAt,
  type SignedIn,
} from "../platform/signed-in.ts";
import { refreshProjectTargets } from "../sync/targets.ts";
import { connectionFieldIssue } from "../ui/connection-field-validation.ts";
import { oneLineFactText } from "../ui/fact-value.ts";
import {
  readApiKeyCredential,
  readCredentialStdin,
  type CredentialStdin,
} from "./credential-stdin.ts";

export const RETELL_API_KEY_ACCESS = "retell-api-key";
export const RETELL_PHONE_NUMBER_ACCESS = "retell-phone-number";
export const LIVEKIT_PROJECT_CREDENTIALS_ACCESS =
  "livekit-project-credentials";
export const LIVEKIT_TOKEN_ENDPOINT_ACCESS = "livekit-token-endpoint";

export const AGENT_EXIT = {
  done: 0,
  nothing: 1,
  notSignedIn: 1,
  refused: 1,
  incomplete: 1,
  noCredentials: 1,
  localWriteFailed: 1,
  interrupted: 130,
} as const;

type AgentPlatform = "retell" | "livekit";
type Modality = "chat" | "voice";
type CommandIO = {
  readonly access: PlatformAccess;
  readonly cwd: string;
  readonly credentialsStdin: boolean;
  readonly env: NodeJS.ProcessEnv;
  readonly stdin?: CredentialStdin;
  readonly signal: AbortSignal;
  readonly out: (line: string) => void;
  readonly fail: (line: string) => void;
  readonly fetchImpl?: Fetch;
};

export type AgentConnectionOptionsCommandOptions = CommandIO & {
  readonly platform: string | null;
  /** Optional Egma Agent whose server-held Retell key should be reused. */
  readonly agentId: string | null;
};

type ConnectionFlags = {
  /** The public `--access` value, not the API's internal access-variant id. */
  readonly accessMethod: string | null;
  readonly modality: string | null;
  readonly name: string | null;
  readonly retellAgentId: string | null;
  readonly retellPhoneNumber: string | null;
  readonly livekitUrl: string | null;
  readonly livekitAgentName: string | null;
  readonly livekitTokenEndpoint: string | null;
};

export type AgentRegisterCommandOptions = CommandIO & {
  readonly platform: string | null;
  /** Optional Egma name. The repository directory name is the default. */
  readonly name: string | null;
};

export type AgentConnectionAddCommandOptions = CommandIO &
  ConnectionFlags & {
    /** An existing Egma Agent id from config.yaml. */
    readonly agentId: string | null;
  };

type Ready = {
  readonly paths: FolderPaths;
  readonly config: FolderConfig;
  readonly project: IdentifiedThing;
  readonly signedIn: SignedIn;
  readonly request: RegisterOptions;
};

type Stop = { readonly code: number };

function stopped(code: number): Stop {
  return { code };
}

function clean(value: string | null | undefined): string {
  return value?.trim() ?? "";
}

function sayFailure(
  options: Pick<CommandIO, "out" | "fail">,
  _status: string,
  message: string,
  code: number = AGENT_EXIT.refused,
): Stop {
  options.fail(message);
  return stopped(code);
}

function interrupted(options: CommandIO): Stop | null {
  return options.signal.aborted
    ? sayFailure(
        options,
        "interrupted",
        "The command was stopped before it finished.",
        AGENT_EXIT.interrupted,
      )
    : null;
}

function platformWord(
  value: string | null,
): AgentPlatform | { readonly said: string } | null {
  const word = clean(value).toLowerCase();
  if (word === "") return null;
  return word === "retell" || word === "livekit" ? word : { said: word };
}

function modalityWord(
  value: string | null,
): Modality | { readonly said: string } | null {
  const word = clean(value).toLowerCase();
  if (word === "") return null;
  return word === "chat" || word === "voice" ? word : { said: word };
}

async function prepare(options: CommandIO): Promise<Ready | Stop> {
  const paths = folderPathsIn(options.cwd);
  let config: FolderConfig;
  try {
    config = await readConfig(paths.config);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") {
      return sayFailure(
        options,
        "not-initialized",
        `There is no egma/config.yaml in ${options.cwd}. Run egma init here first.`,
        AGENT_EXIT.nothing,
      );
    }
    return sayFailure(
      options,
      "invalid-config",
      cause instanceof Error ? cause.message : "Egma could not read egma/config.yaml.",
      AGENT_EXIT.nothing,
    );
  }

  if (config.platform === null || config.project === null) {
    return sayFailure(
      options,
      "not-initialized",
      "egma/config.yaml is not bound to an Egma Project. Run egma init here first.",
      AGENT_EXIT.nothing,
    );
  }

  const signedIn = await signedInAt(options.access, options.env);
  if (signedIn === null) {
    return sayFailure(
      options,
      "not-signed-in",
      notSignedInRefusal(options.access.url),
      AGENT_EXIT.notSignedIn,
    );
  }

  return {
    paths,
    config,
    project: config.project,
    signedIn,
    request: {
      url: signedIn.url,
      key: signedIn.key,
      fetchImpl: options.fetchImpl,
      signal: options.signal,
    },
  };
}

function publicAccess(option: ConnectionOption): string | null {
  if (
    option.agentPlatform === "retell" &&
    ((option.connectionType === "retell_chat_api" &&
      option.accessVariant === "retell_chat_api.api_key") ||
      (option.connectionType === "retell_text_mode" &&
        option.accessVariant === "retell_text_mode.api_key") ||
      (option.connectionType === "retell_web_call" &&
        option.accessVariant === "retell_web_call.api_key"))
  ) {
    return RETELL_API_KEY_ACCESS;
  }
  if (
    option.agentPlatform === "retell" &&
    option.connectionType === "phone_number" &&
    option.accessVariant === "phone_number.public_e164"
  ) {
    return RETELL_PHONE_NUMBER_ACCESS;
  }
  if (
    option.agentPlatform === "livekit" &&
    option.connectionType === "livekit_room" &&
    option.accessVariant === "livekit_room.project_credentials"
  ) {
    return LIVEKIT_PROJECT_CREDENTIALS_ACCESS;
  }
  if (
    option.agentPlatform === "livekit" &&
    option.connectionType === "livekit_room" &&
    option.accessVariant === "livekit_room.customer_token_endpoint"
  ) {
    return LIVEKIT_TOKEN_ENDPOINT_ACCESS;
  }
  return null;
}

function optionsForPublicChoice(
  catalog: readonly ConnectionOption[],
  accessMethod: string,
  modality: Modality,
): readonly ConnectionOption[] {
  return catalog.filter(
    (option) =>
      publicAccess(option) === accessMethod && option.modality === modality,
  );
}

function selectedOption(
  catalog: readonly ConnectionOption[],
  accessMethod: string,
  modality: Modality,
  options: Pick<CommandIO, "out" | "fail">,
): ConnectionOption | Stop {
  const matches = optionsForPublicChoice(catalog, accessMethod, modality);
  if (matches.length === 1) return matches[0]!;

  const available = [
    ...new Set(
      catalog.flatMap((option) => {
        const access = publicAccess(option);
        return access === null ? [] : [`${access} (${option.modality})`];
      }),
    ),
  ];
  if (available.length > 0) options.out("Available Connections:");
  for (const choice of available) options.out(`- ${choice}`);
  const message =
    matches.length === 0
      ? `Egma does not offer --access ${accessMethod} with --modality ${modality} on this platform.`
      : `Egma returned more than one connection for --access ${accessMethod} with --modality ${modality}. Update the CLI before choosing between them.`;
  return sayFailure(options, "unsupported-connection", message, AGENT_EXIT.incomplete);
}

function connectionFlag(key: string): string | null {
  if (key === "retellAgentId") return "--retell-agent";
  return CONFIG_FLAGS.find(([field]) => field === key)?.[1] ?? null;
}

function flagValue(key: string, flags: ConnectionFlags): string {
  const descriptor = CONFIG_FLAGS.find(([field]) => field === key);
  return descriptor === undefined ? "" : clean(flags[descriptor[2]]);
}

const CONFIG_FLAGS = [
  ["phoneNumber", "--retell-phone-number", "retellPhoneNumber"],
  ["url", "--livekit-url", "livekitUrl"],
  ["agentName", "--livekit-agent-name", "livekitAgentName"],
  ["tokenEndpoint", "--livekit-token-endpoint", "livekitTokenEndpoint"],
] as const;

function irrelevantConnectionFlags(
  platform: AgentPlatform,
  option: ConnectionOption,
  flags: ConnectionFlags,
): readonly string[] {
  const accepted = new Set(option.fields.map((field) => field.key));
  const irrelevant: string[] = CONFIG_FLAGS.flatMap(
    ([field, flag, property]) =>
      clean(flags[property]) !== "" && !accepted.has(field) ? [flag] : [],
  );
  if (clean(flags.retellAgentId) !== "" && platform !== "retell") {
    irrelevant.push("--retell-agent");
  }
  return irrelevant;
}

function rejectIrrelevantConnectionFlags(
  platform: AgentPlatform,
  option: ConnectionOption,
  flags: ConnectionFlags,
  io: Pick<CommandIO, "out" | "fail">,
): Stop | null {
  const irrelevant = irrelevantConnectionFlags(platform, option, flags);
  if (irrelevant.length === 0) return null;
  return sayFailure(
    io,
    "unused-option",
    `${irrelevant.join(", ")} ${irrelevant.length === 1 ? "does" : "do"} not apply to this Connection option. Remove ${irrelevant.length === 1 ? "it" : "them"}, then try again.`,
    AGENT_EXIT.incomplete,
  );
}

type BuiltConfig =
  | { readonly kind: "config"; readonly config: Readonly<Record<string, string>> }
  | { readonly kind: "stop"; readonly stop: Stop };

/** Build only the fields the selected server option names. */
function configForOption(
  option: ConnectionOption,
  flags: ConnectionFlags,
  io: Pick<CommandIO, "out" | "fail">,
  discovered?: Readonly<Record<string, string>>,
): BuiltConfig {
  const config: Record<string, string> = {};
  for (const field of option.fields) {
    const fromDiscovery = discovered?.[field.key];
    const value = clean(fromDiscovery ?? flagValue(field.key, flags));
    const issue = connectionFieldIssue(field, value);
    if (issue !== null) {
      const flag = connectionFlag(field.key);
      const message =
        flag === null
          ? `This Egma platform requires connection field ${field.key}, but this CLI does not map it yet. Update the CLI and try again.`
          : issue === "invalid-json"
            ? `${flag} must be one JSON object.`
            : `${flag} is required for this connection.`;
      return {
        kind: "stop",
        stop: sayFailure(io, "missing-option", message, AGENT_EXIT.incomplete),
      };
    }
    if (value !== "") config[field.key] = value;
  }
  return { kind: "config", config };
}

function retellCredentialFromEnvironment(env: NodeJS.ProcessEnv): string {
  return clean(env["EGMA_RETELL_API_KEY"]);
}

async function retellCredential(
  options: CommandIO,
): Promise<ConnectionCredentials | Stop> {
  let apiKey: string;
  if (options.credentialsStdin) {
    const read = await readApiKeyCredential(options.stdin, options.signal);
    if (read.kind === "interrupted") {
      return sayFailure(
        options,
        "interrupted",
        "The command was interrupted before credentials finished reading.",
        AGENT_EXIT.interrupted,
      );
    }
    if (read.kind === "missing") {
      return sayFailure(
        options,
        "credentials-required",
        'No credentials arrived on standard input. Pipe one JSON object such as {"apiKey":"..."}, or remove --credentials-stdin and set EGMA_RETELL_API_KEY.',
        AGENT_EXIT.noCredentials,
      );
    }
    if (read.kind === "invalid") {
      return sayFailure(
        options,
        "invalid-credentials",
        'Retell credentials on standard input must be one JSON object shaped {"apiKey":"..."}.',
        AGENT_EXIT.noCredentials,
      );
    }
    apiKey = read.apiKey;
  } else {
    apiKey = retellCredentialFromEnvironment(options.env);
  }
  if (apiKey === "") {
    return sayFailure(
      options,
      "credentials-required",
      'Set EGMA_RETELL_API_KEY, or pipe {"apiKey":"..."} into this command with --credentials-stdin.',
      AGENT_EXIT.noCredentials,
    );
  }
  return ConnectionCredentials.hold({ apiKey });
}

function credentialEnvironmentVariable(
  platform: AgentPlatform,
  field: string,
): string | null {
  if (platform === "retell" && field === "apiKey") {
    return "EGMA_RETELL_API_KEY";
  }
  if (platform === "livekit" && field === "apiKey") {
    return "EGMA_LIVEKIT_API_KEY";
  }
  if (platform === "livekit" && field === "apiSecret") {
    return "EGMA_LIVEKIT_API_SECRET";
  }
  if (platform === "livekit" && field === "headers") {
    return "EGMA_LIVEKIT_TOKEN_ENDPOINT_HEADERS";
  }
  return null;
}

/** Refuse new server vocabulary before the CLI hides or mislabels any part. */
function incompatibleCatalog(
  platform: AgentPlatform,
  catalog: readonly ConnectionOption[],
  options: Pick<CommandIO, "out" | "fail">,
): Stop | null {
  const unsupported = catalog.some(
    (option) =>
      publicAccess(option) === null ||
      option.fields.some((field) => connectionFlag(field.key) === null) ||
      option.credentialFields.some(
        (field) =>
          credentialEnvironmentVariable(platform, field.field) === null,
      ),
  );
  return unsupported
    ? sayFailure(
        options,
        "unsupported-catalog",
        "Egma returned a Connection option this CLI does not understand. Update egma-cli, then try again.",
        AGENT_EXIT.incomplete,
      )
    : null;
}

type BuiltCredentials =
  | { readonly kind: "credentials"; readonly credentials?: ConnectionCredentials }
  | { readonly kind: "stop"; readonly stop: Stop };

function objectFromStdin(
  text: string,
  option: ConnectionOption,
): Readonly<Record<string, string>> | { readonly message: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return { message: "Credentials on standard input must be one JSON object." };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { message: "Credentials on standard input must be one JSON object." };
  }
  const accepted = new Set(option.credentialFields.map((field) => field.field));
  if (Object.keys(parsed).some((field) => !accepted.has(field))) {
    return {
      message:
        "Credentials on standard input contain unsupported fields. Read the accepted fields with egma agent connection options.",
    };
  }
  const values: Record<string, string> = {};
  for (const [field, value] of Object.entries(parsed)) {
    const described = option.credentialFields.find((one) => one.field === field);
    if (
      described?.kind === "json" &&
      typeof value === "object" &&
      value !== null &&
      !Array.isArray(value)
    ) {
      values[field] = JSON.stringify(value);
      continue;
    }
    if (typeof value !== "string") {
      return {
        message:
          described?.kind === "json"
            ? `Credential field ${field} must be a JSON object.`
            : `Credential field ${field} must be a string.`,
      };
    }
    values[field] = value.trim();
  }
  return values;
}

/** Read exactly the credential fields named by the selected server option. */
async function credentialsForOption(
  platform: AgentPlatform,
  option: ConnectionOption,
  options: CommandIO,
  serverCredentialAvailable = false,
): Promise<BuiltCredentials> {
  if (option.credentialRule === "forbidden") {
    return { kind: "credentials" };
  }
  if (serverCredentialAvailable) return { kind: "credentials" };

  let supplied: Readonly<Record<string, string>>;
  if (options.credentialsStdin) {
    const read = await readCredentialStdin(options.stdin, options.signal);
    if (read.kind === "interrupted") {
      return {
        kind: "stop",
        stop: sayFailure(
          options,
          "interrupted",
          "The command was interrupted before credentials finished reading.",
          AGENT_EXIT.interrupted,
        ),
      };
    }
    const document = read.text;
    if (document === "") {
      return {
        kind: "stop",
        stop: sayFailure(
          options,
          "credentials-required",
          "No credentials arrived on standard input.",
          AGENT_EXIT.noCredentials,
        ),
      };
    }
    const parsed = objectFromStdin(document, option);
    if ("message" in parsed) {
      return {
        kind: "stop",
        stop: sayFailure(
          options,
          "invalid-credentials",
          parsed.message,
          AGENT_EXIT.noCredentials,
        ),
      };
    }
    supplied = parsed;
  } else {
    const fromEnvironment: Record<string, string> = {};
    for (const field of option.credentialFields) {
      const variable = credentialEnvironmentVariable(platform, field.field);
      if (variable !== null) fromEnvironment[field.field] = clean(options.env[variable]);
    }
    supplied = fromEnvironment;
  }

  if (
    option.credentialRule === "optional" &&
    !options.credentialsStdin &&
    Object.values(supplied).every((value) => clean(value) === "")
  ) {
    return { kind: "credentials" };
  }

  const allowed = new Set(option.credentialFields.map((field) => field.field));
  const unknown = Object.keys(supplied).filter((field) => !allowed.has(field));
  if (unknown.length > 0) {
    return {
      kind: "stop",
      stop: sayFailure(
        options,
        "invalid-credentials",
        `Credentials contain unsupported fields. Read the accepted fields with egma agent connection options --platform ${platform}.`,
        AGENT_EXIT.noCredentials,
      ),
    };
  }

  const credentials: Record<string, string> = {};
  for (const field of option.credentialFields) {
    const value = clean(supplied[field.field]);
    const issue = connectionFieldIssue(field, value);
    if (issue !== null) {
      const variable = credentialEnvironmentVariable(platform, field.field);
      const source = options.credentialsStdin
        ? `field ${field.field} in the standard-input JSON object`
        : variable ?? `credential field ${field.field}`;
      const message =
        issue === "invalid-json"
          ? `${source} must be one JSON object.`
          : `${source} is required for this connection.`;
      return {
        kind: "stop",
        stop: sayFailure(
          options,
          "credentials-required",
          message,
          AGENT_EXIT.noCredentials,
        ),
      };
    }
    if (value !== "") credentials[field.field] = value;
  }

  if (Object.keys(credentials).length === 0) {
    return option.credentialRule === "required"
      ? {
          kind: "stop",
          stop: sayFailure(
            options,
            "credentials-required",
            `Credentials are required for --access ${publicAccess(option) ?? option.accessVariant}.`,
            AGENT_EXIT.noCredentials,
          ),
        }
      : { kind: "credentials" };
  }
  return {
    kind: "credentials",
    credentials: ConnectionCredentials.hold(credentials),
  };
}

function requestFailure(
  result:
    | { readonly kind: "not-authenticated"; readonly reason: string }
    | { readonly kind: "refused"; readonly reason: string }
    | { readonly kind: "unreachable"; readonly reason: string },
  options: Pick<CommandIO, "out" | "fail">,
): Stop {
  if (result.kind === "not-authenticated") {
    options.fail(result.reason);
    return sayFailure(
      options,
      "not-signed-in",
      "Egma did not accept this login. Run egma login, then try again.",
      AGENT_EXIT.notSignedIn,
    );
  }
  return sayFailure(options, result.kind, result.reason);
}

function shellWord(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function optionCommand(
  platform: AgentPlatform,
  option: ConnectionOption,
): string {
  const access = publicAccess(option);
  if (access === null) return "";
  const parts = [
    "egma",
    "agent",
    "connection",
    "add",
    "--agent",
    shellWord("<Egma Agent ID>"),
    "--access",
    access,
    "--modality",
    option.modality,
  ];
  if (platform === "retell") {
    parts.push("--retell-agent", shellWord("<Retell Agent ID>"));
  }
  for (const field of option.fields) {
    if (!field.required || field.key === "retellAgentId") continue;
    const flag = connectionFlag(field.key);
    if (flag !== null && !parts.includes(flag)) {
      parts.push(flag, shellWord(`<${field.label}>`));
    }
  }
  return parts.join(" ");
}

function sayCredentialSources(
  platform: AgentPlatform,
  option: ConnectionOption,
  out: (line: string) => void,
): void {
  if (option.credentialHelp !== "") {
    out(`  Credential guidance: ${option.credentialHelp}`);
  }
  if (option.credentialRule === "forbidden") {
    out("  Connection credential: none");
    if (platform === "retell") {
      out(
        "  First Retell Connection verification: EGMA_RETELL_API_KEY or {\"apiKey\":\"...\"} with --credentials-stdin",
      );
    }
    return;
  }
  out(`  Connection credential: ${option.credentialRule}`);
  const variables = option.credentialFields.flatMap((field) => {
    const variable = credentialEnvironmentVariable(platform, field.field);
    return variable === null ? [] : [variable];
  });
  for (const field of option.credentialFields) {
    const requirement = field.required ? "required" : "optional";
    const help = field.help === "" ? field.label : field.help;
    out(`  Credential field ${field.field} (${requirement}): ${help}`);
  }
  if (variables.length > 0) out(`  Credential environment: ${variables.join(", ")}`);
  const shape = option.credentialFields
    .map((field) =>
      field.kind === "json"
        ? `\"${field.field}\":{\"Authorization\":\"Bearer ...\"}`
        : `\"${field.field}\":\"...\"`,
    )
    .join(",");
  out(`  Credential stdin: {${shape}} with --credentials-stdin`);
}

function sayRetellAgent(
  agent: DiscoveredAgent,
  out: (line: string) => void,
): void {
  out(`- ${oneLineFactText(agent.name, "Unnamed")} (${oneLineFactText(agent.id, "unknown")})`);
  const phones = agent.connections
    .filter((candidate) => candidate.connectionType === "phone_number")
    .map((candidate) =>
      oneLineFactText(clean(candidate.config["phoneNumber"]), ""),
    )
    .filter((phone) => phone !== "");
  out(`  Phone numbers: ${phones.length === 0 ? "none" : phones.join(", ")}`);
}

function sayConnectionOption(
  platform: AgentPlatform,
  option: ConnectionOption,
  out: (line: string) => void,
): void {
  const access = publicAccess(option);
  if (access === null) return;
  out("");
  out(`${option.productLabel} (${option.modality})`);
  out(`  Access: ${access}`);
  const required = option.fields
    .filter((field) => field.required)
    .flatMap((field) => connectionFlag(field.key) ?? []);
  const optional = option.fields
    .filter((field) => !field.required)
    .flatMap((field) => connectionFlag(field.key) ?? []);
  out(`  Required flags: ${required.length === 0 ? "none" : required.join(", ")}`);
  out(`  Optional flags: ${optional.length === 0 ? "none" : optional.join(", ")}`);
  for (const field of option.fields) {
    const flag = connectionFlag(field.key);
    if (flag === null) continue;
    const requirement = field.required ? "required" : "optional";
    const help = field.help === "" ? field.label : field.help;
    out(`  ${flag} (${requirement}): ${help}`);
  }
  sayCredentialSources(platform, option, out);
  out(`  Command: ${optionCommand(platform, option)}`);
}

/** List server-owned connection choices and, for Retell, provider Agents. */
export async function runAgentConnectionOptionsCommand(
  options: AgentConnectionOptionsCommandOptions,
): Promise<number> {
  const stoppedBefore = interrupted(options);
  if (stoppedBefore !== null) return stoppedBefore.code;
  const platform = platformWord(options.platform);
  if (platform === null || typeof platform === "object") {
    return sayFailure(
      options,
      platform === null ? "platform-required" : "unsupported-platform",
      "Choose --platform retell or --platform livekit.",
      AGENT_EXIT.incomplete,
    ).code;
  }
  const ready = await prepare(options);
  if ("code" in ready) return ready.code;
  const stoppedAfterPrepare = interrupted(options);
  if (stoppedAfterPrepare !== null) return stoppedAfterPrepare.code;
  const catalogResult = await readConnectionOptions(ready.request);
  const stoppedAfterCatalog = interrupted(options);
  if (stoppedAfterCatalog !== null) return stoppedAfterCatalog.code;
  if (catalogResult.kind !== "catalog") {
    return requestFailure(catalogResult, options).code;
  }
  const catalog = connectionOptionsForPlatform(catalogResult.catalog, platform);
  const catalogProblem = incompatibleCatalog(platform, catalog, options);
  if (catalogProblem !== null) return catalogProblem.code;

  if (platform === "retell") {
    const agentId = clean(options.agentId);
    let discoveryInput:
      | { readonly projectId: string; readonly agentId: string }
      | {
          readonly projectId: string;
          readonly credentials: ConnectionCredentials;
        };
    if (agentId === "") {
      const credential = await retellCredential(options);
      if ("code" in credential) return credential.code;
      discoveryInput = {
        projectId: ready.project.id,
        credentials: credential,
      };
    } else {
      const local = localAgent(ready.config, agentId);
      if (local === null) {
        return sayFailure(
          options,
          "agent-not-found",
          `egma/config.yaml does not list Agent ${agentId}. Run egma pull, then choose an Agent ID from the file.`,
          AGENT_EXIT.incomplete,
        ).code;
      }
      const remote = await readAgent(agentId, ready.project.id, ready.request);
      const stoppedAfterRead = interrupted(options);
      if (stoppedAfterRead !== null) return stoppedAfterRead.code;
      if (remote.kind !== "agent") {
        if (remote.kind === "not-found") {
          options.fail(remote.reason);
          return sayFailure(
            options,
            "agent-not-found",
            `Egma does not have Agent ${agentId}. Run egma pull and choose an Agent ID that still exists.`,
            AGENT_EXIT.incomplete,
          ).code;
        }
        return requestFailure(remote, options).code;
      }
      if (remote.agent.agentPlatform !== "retell") {
        return sayFailure(
          options,
          "platform-mismatch",
          `Agent ${agentId} uses ${remote.agent.agentPlatform}, not retell.`,
          AGENT_EXIT.incomplete,
        ).code;
      }
      if (remote.agent.monitoringKeyPresent === false) {
        const credential = await retellCredential(options);
        if ("code" in credential) return credential.code;
        discoveryInput = {
          projectId: ready.project.id,
          credentials: credential,
        };
      } else {
        discoveryInput = { projectId: ready.project.id, agentId };
      }
    }
    const discovered = await discoverRetellAgents(
      discoveryInput,
      ready.request,
    );
    const stoppedAfterDiscovery = interrupted(options);
    if (stoppedAfterDiscovery !== null) return stoppedAfterDiscovery.code;
    if (discovered.kind !== "agents") {
      return requestFailure(discovered, options).code;
    }
    if (discovered.agents.length === 0) {
      options.out("Retell Agents: none");
    } else {
      options.out("Retell Agents");
      for (const agent of discovered.agents) {
        sayRetellAgent(agent, options.out);
      }
    }
    options.out("");
    options.out("Connection commands");
    options.out("Use the selected Retell Agent ID on the first Connection. Later Connections may reuse the stored binding.");
    for (const option of catalog) sayConnectionOption(platform, option, options.out);
    return AGENT_EXIT.done;
  }

  if (clean(options.agentId) !== "") {
    return sayFailure(
      options,
      "agent-not-used",
      "--agent is only used to reuse a stored Retell credential. Remove it for LiveKit connection options.",
      AGENT_EXIT.incomplete,
    ).code;
  }

  options.out("LiveKit connection options");
  for (const option of catalog) sayConnectionOption(platform, option, options.out);
  return AGENT_EXIT.done;
}

type LoadedCatalog = {
  readonly ready: Ready;
  readonly platform: AgentPlatform;
  readonly modality: Modality;
  readonly accessMethod: string;
  readonly catalog: readonly ConnectionOption[];
};

async function loadChoiceForReady(
  options: CommandIO & {
    readonly modality: string | null;
    readonly accessMethod: string | null;
  },
  ready: Ready,
  platform: AgentPlatform,
): Promise<LoadedCatalog | Stop> {
  const modality = modalityWord(options.modality);
  if (modality === null || typeof modality === "object") {
    return sayFailure(
      options,
      modality === null ? "modality-required" : "unsupported-modality",
      "Choose --modality chat or --modality voice.",
      AGENT_EXIT.incomplete,
    );
  }
  const accessMethod = clean(options.accessMethod);
  if (accessMethod === "") {
    return sayFailure(
      options,
      "access-required",
      "Choose an access method with --access. Run egma agent connection options --platform " +
        `${platform} to see the available values.`,
      AGENT_EXIT.incomplete,
    );
  }
  const result = await readConnectionOptions(ready.request);
  const stoppedAfterCatalog = interrupted(options);
  if (stoppedAfterCatalog !== null) return stoppedAfterCatalog;
  if (result.kind !== "catalog") return requestFailure(result, options);
  const catalog = connectionOptionsForPlatform(result.catalog, platform);
  const catalogProblem = incompatibleCatalog(platform, catalog, options);
  if (catalogProblem !== null) return catalogProblem;
  return {
    ready,
    platform,
    modality,
    accessMethod,
    catalog,
  };
}

function discoveredCandidate(
  agent: DiscoveredAgent,
  option: ConnectionOption,
  flags: ConnectionFlags,
): DiscoveredConnection | null {
  const matching = agent.connections.filter(
    (candidate) =>
      candidate.connectionType === option.connectionType &&
      candidate.accessVariant === option.accessVariant &&
      candidate.modality === option.modality,
  );
  if (option.connectionType !== "phone_number") return matching[0] ?? null;
  const phone = clean(flags.retellPhoneNumber);
  if (phone === "") return null;
  return (
    matching.find(
      (candidate) => clean(candidate.config["phoneNumber"]) === phone,
    ) ?? null
  );
}

type DiscoveredChoice = {
  readonly option: ConnectionOption;
  readonly candidate: DiscoveredConnection;
};

/**
 * Match a public Retell choice after discovery has said what this Agent offers.
 *
 * More than one server catalog row can share one public access name and
 * modality. The discovered candidate carries the internal connection type, so
 * it is the missing fact that selects the exact catalog row.
 */
function discoveredChoices(
  agent: DiscoveredAgent,
  catalog: readonly ConnectionOption[],
  accessMethod: string,
  modality: Modality,
  flags: ConnectionFlags,
): readonly DiscoveredChoice[] {
  return optionsForPublicChoice(catalog, accessMethod, modality).flatMap(
    (option) => {
      const candidate = discoveredCandidate(agent, option, flags);
      return candidate === null ? [] : [{ option, candidate }];
    },
  );
}

function retellAgentNamed(
  agents: readonly DiscoveredAgent[],
  id: string,
): DiscoveredAgent | null {
  return agents.find((agent) => agent.id === id) ?? null;
}

type WrittenResource = {
  readonly result: RegisterOutcome;
  readonly agent: RegisteredAgent;
  readonly connection?: RegisteredConnection;
};

function sayWritten(written: WrittenResource, out: (line: string) => void): void {
  const verb = written.result === "created" ? "Registered" : "Using";
  out(`${verb} Agent ${JSON.stringify(written.agent.name)} (${written.agent.id}).`);
  if (written.connection !== undefined) {
    out(`Added Connection ${JSON.stringify(written.connection.name)} (${written.connection.id}).`);
  }
}

async function refreshAfterWrite(
  written: WrittenResource,
  ready: Ready,
  options: CommandIO,
): Promise<number> {
  sayWritten(written, options.out);
  try {
    const refreshed = await refreshProjectTargets(
      {
        paths: ready.paths,
        project: ready.project,
        expected: {
          agentId: written.agent.id,
          ...(written.connection === undefined
            ? {}
            : { connectionId: written.connection.id }),
        },
      },
      ready.request,
    );
    if (refreshed.kind !== "synced") {
      if (options.signal.aborted) {
        options.fail(
          "The remote write succeeded, but egma/config.yaml was not refreshed. Run egma pull.",
        );
        options.fail(
          "The command was interrupted before the refresh received a complete answer.",
        );
        return AGENT_EXIT.interrupted;
      }
      const stopped = requestFailure(refreshed, options);
      options.fail(
        `The remote write succeeded, but egma/config.yaml was not refreshed. Run egma pull.`,
      );
      return stopped.code;
    }
    options.out("Updated egma/config.yaml.");
    return AGENT_EXIT.done;
  } catch (cause) {
    if (options.signal.aborted) {
      options.fail(
        "The remote write succeeded, but egma/config.yaml was not refreshed. Run egma pull.",
      );
      options.fail(
        "The command was interrupted before the refresh received a complete answer.",
      );
      return AGENT_EXIT.interrupted;
    }
    const detail = oneLineFactText(
      cause instanceof Error ? cause.message : String(cause),
      "unknown local write error",
    );
    options.fail(
      `The remote write succeeded, but egma/config.yaml was not refreshed: ${detail}. Run egma pull.`,
    );
    return AGENT_EXIT.localWriteFailed;
  }
}

function interruptedAfterWrite(
  written: WrittenResource,
  options: CommandIO,
): number {
  sayWritten(written, options.out);
  options.fail(
    "The command was interrupted after Egma answered, before egma/config.yaml was refreshed. Run egma pull.",
  );
  return AGENT_EXIT.interrupted;
}

function reportedConfig(
  option: ConnectionOption,
  flags: ConnectionFlags,
  options: Pick<CommandIO, "out" | "fail">,
  discovered?: Readonly<Record<string, string>>,
): BuiltConfig {
  return configForOption(option, flags, options, discovered);
}

/** Register one Egma Agent identity. Connections are separate resources. */
export async function runAgentRegisterCommand(
  options: AgentRegisterCommandOptions,
): Promise<number> {
  const before = interrupted(options);
  if (before !== null) return before.code;
  const platform = platformWord(options.platform);
  if (platform === null || typeof platform === "object") {
    return sayFailure(
      options,
      platform === null ? "platform-required" : "unsupported-platform",
      "Choose --platform retell or --platform livekit.",
      AGENT_EXIT.incomplete,
    ).code;
  }
  const ready = await prepare(options);
  if ("code" in ready) return ready.code;
  const stoppedAfterPrepare = interrupted(options);
  if (stoppedAfterPrepare !== null) return stoppedAfterPrepare.code;
  const name = clean(options.name) || path.basename(path.resolve(options.cwd));
  if (name === "") {
    return sayFailure(
      options,
      "name-required",
      "Choose an Agent name with --name.",
      AGENT_EXIT.incomplete,
    ).code;
  }
  const result = await registerAgentIdentity(
    {
      name,
      agentPlatform: platform,
      project: ready.project.id,
    },
    ready.request,
  );
  if (options.signal.aborted) {
    if (result.kind === "registered") {
      return interruptedAfterWrite(
        { result: result.result, agent: result.agent },
        options,
      );
    }
    options.fail(
      "The command was interrupted before it received a complete answer. Run egma pull before you try to register the Agent again.",
    );
    return AGENT_EXIT.interrupted;
  }
  if (result.kind !== "registered") {
    if (result.kind === "name-taken") {
      options.fail(result.reason);
      return sayFailure(
        options,
        "name-taken",
        `An Egma Agent named ${JSON.stringify(result.name)} already exists. Choose another --name.`,
        AGENT_EXIT.incomplete,
      ).code;
    }
    if (result.kind === "uncertain") {
      return sayFailure(options, "uncertain", result.reason).code;
    }
    return requestFailure(result, options).code;
  }
  return await refreshAfterWrite(
    { result: result.result, agent: result.agent },
    ready,
    options,
  );
}

function localAgent(
  config: FolderConfig,
  agentId: string,
): FolderConfig["agents"][number] | null {
  return config.agents.find((agent) => agent.id === agentId) ?? null;
}

/** Add one Connection to an explicit existing Egma Agent. */
export async function runAgentConnectionAddCommand(
  options: AgentConnectionAddCommandOptions,
): Promise<number> {
  const before = interrupted(options);
  if (before !== null) return before.code;
  const agentId = clean(options.agentId);
  if (agentId === "") {
    return sayFailure(
      options,
      "agent-required",
      "Choose an Egma Agent with --agent <Agent ID>.",
      AGENT_EXIT.incomplete,
    ).code;
  }
  const ready = await prepare(options);
  if ("code" in ready) return ready.code;
  const stoppedAfterPrepare = interrupted(options);
  if (stoppedAfterPrepare !== null) return stoppedAfterPrepare.code;
  const local = localAgent(ready.config, agentId);
  if (local === null) {
    return sayFailure(
      options,
      "agent-not-found",
      `egma/config.yaml does not list Agent ${agentId}. Run egma pull, then choose an Agent ID from the file.`,
      AGENT_EXIT.incomplete,
    ).code;
  }

  const remote = await readAgent(agentId, ready.project.id, ready.request);
  const stoppedAfterRead = interrupted(options);
  if (stoppedAfterRead !== null) return stoppedAfterRead.code;
  if (remote.kind !== "agent") {
    if (remote.kind === "not-found") {
      options.fail(remote.reason);
      return sayFailure(
        options,
        "agent-not-found",
        `Egma does not have Agent ${agentId}. Run egma pull and choose an Agent ID that still exists.`,
        AGENT_EXIT.incomplete,
      ).code;
    }
    return requestFailure(remote, options).code;
  }
  const platform = remote.agent.agentPlatform;
  if (local.platform !== platform) {
    return sayFailure(
      options,
      "platform-mismatch",
      `egma/config.yaml says Agent ${agentId} uses ${local.platform}, but Egma says it uses ${platform}. Run egma pull before adding a Connection.`,
      AGENT_EXIT.incomplete,
    ).code;
  }

  const loaded = await loadChoiceForReady(options, ready, platform);
  if ("code" in loaded) return loaded.code;
  const stoppedAfterCatalog = interrupted(options);
  if (stoppedAfterCatalog !== null) return stoppedAfterCatalog.code;

  let connection: NewConnection;
  if (loaded.platform === "retell") {
    const storedProviderAgentId = remote.agent.platformAgentId;
    const suppliedProviderAgentId = clean(options.retellAgentId);
    if (
      storedProviderAgentId !== null &&
      suppliedProviderAgentId !== "" &&
      suppliedProviderAgentId !== storedProviderAgentId
    ) {
      return sayFailure(
        options,
        "retell-agent-mismatch",
        `Agent ${agentId} is already bound to Retell Agent ${storedProviderAgentId}. Use that Retell Agent or register another Egma Agent.`,
        AGENT_EXIT.incomplete,
      ).code;
    }
    const providerAgentId = storedProviderAgentId ?? suppliedProviderAgentId;
    if (providerAgentId === "") {
      return sayFailure(
        options,
        "retell-agent-not-bound",
        `Agent ${agentId} has no Retell Agent ID. Add --retell-agent <Retell Agent ID> to its first Connection.`,
        AGENT_EXIT.incomplete,
      ).code;
    }

    // The Agent row is the server's answer about whether it can reuse a key.
    // Environment values are ignored when the row already has one, so a stale
    // shell variable cannot rotate a working credential by accident.
    const hasStoredCredential = remote.agent.monitoringKeyPresent === true;
    let credential: ConnectionCredentials | undefined;
    if (!hasStoredCredential) {
      const supplied = await retellCredential(options);
      if ("code" in supplied) return supplied.code;
      credential = supplied;
    }
    const discovered = await discoverRetellAgents(
      hasStoredCredential
        ? { projectId: loaded.ready.project.id, agentId }
        : {
            projectId: loaded.ready.project.id,
            ...(credential === undefined ? {} : { credentials: credential }),
          },
      loaded.ready.request,
    );
    const stoppedAfterDiscovery = interrupted(options);
    if (stoppedAfterDiscovery !== null) return stoppedAfterDiscovery.code;
    if (discovered.kind !== "agents") {
      return requestFailure(discovered, options).code;
    }
    const agent = retellAgentNamed(discovered.agents, providerAgentId);
    if (agent === null) {
      return sayFailure(
        options,
        "retell-agent-not-found",
        `Retell no longer lists Agent ${providerAgentId}. Run egma agent connection options --platform retell to inspect the account.`,
        AGENT_EXIT.incomplete,
      ).code;
    }
    const matches = discoveredChoices(
      agent,
      loaded.catalog,
      loaded.accessMethod,
      loaded.modality,
      options,
    );
    if (matches.length !== 1) {
      const message =
        loaded.accessMethod === RETELL_PHONE_NUMBER_ACCESS &&
        clean(options.retellPhoneNumber) === ""
          ? "--retell-phone-number is required for a Retell phone connection."
          : matches.length === 0
            ? `Retell Agent ${providerAgentId} does not offer this connection.`
            : `Retell Agent ${providerAgentId} offers more than one matching connection.`;
      return sayFailure(
        options,
        "connection-not-found",
        message,
        AGENT_EXIT.incomplete,
      ).code;
    }
    const { option: choice, candidate } = matches[0]!;
    const irrelevant = rejectIrrelevantConnectionFlags(
      loaded.platform,
      choice,
      options,
      options,
    );
    if (irrelevant !== null) return irrelevant.code;
    const builtConfig = reportedConfig(choice, options, options, candidate.config);
    if (builtConfig.kind === "stop") return builtConfig.stop.code;
    const config = builtConfig.config;
    connection = {
      name: clean(options.name) || choice.productLabel,
      agentPlatform: "retell",
      connectionType: candidate.connectionType,
      accessVariant: candidate.accessVariant,
      modality: candidate.modality,
      config,
      platformAgentId: providerAgentId,
      ...(credential === undefined ? {} : { credentials: credential }),
    };
  } else {
    const choice = selectedOption(
      loaded.catalog,
      loaded.accessMethod,
      loaded.modality,
      options,
    );
    if ("code" in choice) return choice.code;
    const irrelevant = rejectIrrelevantConnectionFlags(
      loaded.platform,
      choice,
      options,
      options,
    );
    if (irrelevant !== null) return irrelevant.code;
    const builtConfig = reportedConfig(choice, options, options);
    if (builtConfig.kind === "stop") return builtConfig.stop.code;
    const config = builtConfig.config;
    const credentials = await credentialsForOption(
      loaded.platform,
      choice,
      options,
    );
    if (credentials.kind === "stop") return credentials.stop.code;
    connection = {
      name: clean(options.name) || choice.productLabel,
      agentPlatform: "livekit",
      connectionType: choice.connectionType,
      accessVariant: choice.accessVariant,
      modality: choice.modality,
      config,
      ...(credentials.credentials === undefined
        ? {}
        : { credentials: credentials.credentials }),
    };
  }

  const result = await addConnection(
    agentId,
    loaded.ready.project.id,
    connection,
    loaded.ready.request,
  );
  if (options.signal.aborted) {
    if (result.kind === "added") {
      return interruptedAfterWrite(
        {
          result: "connection_added",
          agent: remote.agent,
          connection: result.connection,
        },
        options,
      );
    }
    options.fail(
      "The command was interrupted before it received a complete answer. Run egma pull before you try to add the Connection again.",
    );
    return AGENT_EXIT.interrupted;
  }
  if (result.kind !== "added") {
    if (result.kind === "name-taken") {
      options.fail(result.reason);
      return sayFailure(
        options,
        "name-taken",
        `A Connection named ${JSON.stringify(result.name)} already exists on Agent ${agentId}. Choose another --name.`,
        AGENT_EXIT.incomplete,
      ).code;
    }
    if (result.kind === "not-found") {
      options.fail(result.reason);
      return sayFailure(
        options,
        "agent-not-found",
        `Egma does not have Agent ${agentId}. Run egma pull and choose an Agent ID that still exists.`,
        AGENT_EXIT.incomplete,
      ).code;
    }
    return requestFailure(result, options).code;
  }

  return await refreshAfterWrite(
    {
      result: "connection_added",
      agent: remote.agent,
      connection: result.connection,
    },
    loaded.ready,
    options,
  );
}
