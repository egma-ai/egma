/**
 * Agent and Connection commands for the skills-led CLI.
 *
 * These commands do not run a wizard. A skill or a developer supplies the
 * choices on the command line. Egma's API supplies the connection catalog and
 * Retell discovery results, so this client does not keep a second list of
 * required fields or supported connection tuples.
 */

import type { Readable } from "node:stream";

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
  registerAgent,
  type NewConnection,
  type Registered,
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

export const RETELL_API_KEY_ACCESS = "retell-api-key";
export const RETELL_PHONE_NUMBER_ACCESS = "retell-phone-number";
export const LIVEKIT_PROJECT_CREDENTIALS_ACCESS =
  "livekit-project-credentials";
export const LIVEKIT_TOKEN_ENDPOINT_ACCESS = "livekit-token-endpoint";

export const AGENT_EXIT = {
  done: 0,
  nothing: 1,
  notSignedIn: 2,
  refused: 4,
  incomplete: 5,
  noCredentials: 6,
  localWriteFailed: 8,
  interrupted: 130,
} as const;

type AgentPlatform = "retell" | "livekit";
type Modality = "chat" | "voice";
type CredentialStdin = Readable & { readonly isTTY?: boolean };

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
  readonly connectionName: string | null;
  readonly phoneNumber: string | null;
  readonly livekitUrl: string | null;
  readonly dispatchName: string | null;
  readonly tokenEndpoint: string | null;
  readonly metadata: string | null;
};

export type AgentRegisterCommandOptions = CommandIO &
  ConnectionFlags & {
    readonly platform: string | null;
    /** Optional Egma name. Retell and LiveKit project credentials have defaults. */
    readonly name: string | null;
    /** The provider id printed by `agent connection options`. */
    readonly retellAgentId: string | null;
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
  status: string,
  message: string,
  code: number = AGENT_EXIT.refused,
): Stop {
  options.out(`status: ${status}`);
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
  if (option.agentPlatform === "retell") {
    return option.connectionType === "phone_number"
      ? RETELL_PHONE_NUMBER_ACCESS
      : RETELL_API_KEY_ACCESS;
  }
  if (
    option.agentPlatform === "livekit" &&
    option.accessVariant === "livekit_room.project_credentials"
  ) {
    return LIVEKIT_PROJECT_CREDENTIALS_ACCESS;
  }
  if (
    option.agentPlatform === "livekit" &&
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
  for (const choice of available) options.out(`option: ${choice}`);
  const message =
    matches.length === 0
      ? `Egma does not offer --access ${accessMethod} with --modality ${modality} on this platform.`
      : `Egma returned more than one connection for --access ${accessMethod} with --modality ${modality}. Update the CLI before choosing between them.`;
  return sayFailure(options, "unsupported-connection", message, AGENT_EXIT.incomplete);
}

function connectionFlag(key: string): string | null {
  switch (key) {
    case "phoneNumber":
      return "--phone-number";
    case "url":
      return "--livekit-url";
    case "agentName":
      return "--dispatch-name";
    case "tokenEndpoint":
      return "--token-endpoint";
    case "metadata":
      return "--metadata";
    case "retellAgentId":
      return "--retell-agent";
    default:
      return null;
  }
}

function flagValue(key: string, flags: ConnectionFlags): string {
  switch (key) {
    case "phoneNumber":
      return clean(flags.phoneNumber);
    case "url":
      return clean(flags.livekitUrl);
    case "agentName":
      return clean(flags.dispatchName);
    case "tokenEndpoint":
      return clean(flags.tokenEndpoint);
    case "metadata":
      return clean(flags.metadata);
    default:
      return "";
  }
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

async function readStdin(stdin: CredentialStdin | undefined): Promise<string> {
  if (stdin === undefined || stdin.isTTY === true) return "";
  const chunks: Buffer[] = [];
  for await (const chunk of stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString("utf8").trim();
}

function retellCredentialFromEnvironment(env: NodeJS.ProcessEnv): string {
  return clean(env["EGMA_RETELL_API_KEY"]);
}

async function retellCredential(
  options: CommandIO,
): Promise<ConnectionCredentials | Stop> {
  const raw = options.credentialsStdin
    ? await readStdin(options.stdin)
    : retellCredentialFromEnvironment(options.env);
  if (raw === "") {
    return sayFailure(
      options,
      "credentials-required",
      options.credentialsStdin
        ? "No Retell API key arrived on standard input. Pipe the key into this command, or remove --credentials-stdin and set EGMA_RETELL_API_KEY."
        : "Set EGMA_RETELL_API_KEY, or pipe the Retell API key into this command with --credentials-stdin.",
      AGENT_EXIT.noCredentials,
    );
  }
  return ConnectionCredentials.hold({ apiKey: raw });
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
    return "EGMA_LIVEKIT_TOKEN_HEADERS";
  }
  return null;
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
    const document = await readStdin(options.stdin);
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

  const allowed = new Set(option.credentialFields.map((field) => field.field));
  const unknown = Object.keys(supplied).filter((field) => !allowed.has(field));
  if (unknown.length > 0) {
    return {
      kind: "stop",
      stop: sayFailure(
        options,
        "invalid-credentials",
        `This connection does not use credential ${unknown.join(", ")}. Read the accepted fields with egma agent connection options --platform ${platform}.`,
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
    | { readonly kind: "not-authenticated" }
    | { readonly kind: "refused"; readonly reason: string }
    | { readonly kind: "unreachable"; readonly reason: string },
  options: Pick<CommandIO, "out" | "fail">,
): Stop {
  if (result.kind === "not-authenticated") {
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
  command: "register" | "add",
  fixed: readonly string[] = [],
): string {
  const access = publicAccess(option);
  if (access === null) return "";
  const parts = [
    "egma",
    "agent",
    ...(command === "register" ? ["register"] : ["connection", "add"]),
    ...(command === "register" ? ["--platform", platform] : []),
    "--access",
    access,
    "--modality",
    option.modality,
    ...fixed,
  ];
  for (const field of option.fields) {
    if (!field.required || field.key === "retellAgentId") continue;
    const flag = connectionFlag(field.key);
    if (flag !== null && !parts.includes(flag)) {
      parts.push(flag, shellWord(`<${field.label}>`));
    }
  }
  if (
    command === "register" &&
    platform === "livekit" &&
    !option.fields.some((field) => field.key === "agentName")
  ) {
    parts.push("--name", shellWord("<Egma Agent name>"));
  }
  return parts.join(" ");
}

function sayCredentialSources(
  platform: AgentPlatform,
  option: ConnectionOption,
  out: (line: string) => void,
): void {
  if (option.credentialRule === "forbidden") {
    out("  Connection credential: none");
    return;
  }
  const variables = option.credentialFields.flatMap((field) => {
    const variable = credentialEnvironmentVariable(platform, field.field);
    return variable === null ? [] : [variable];
  });
  if (variables.length > 0) out(`  Credential environment: ${variables.join(", ")}`);
  const shape = option.credentialFields
    .map((field) => `\"${field.field}\":\"...\"`)
    .join(",");
  out(`  Credential stdin: {${shape}} with --credentials-stdin`);
}

function candidateOption(
  candidate: DiscoveredConnection,
  catalog: readonly ConnectionOption[],
): ConnectionOption | null {
  return (
    catalog.find(
      (option) =>
        option.agentPlatform === candidate.agentPlatform &&
        option.connectionType === candidate.connectionType &&
        option.accessVariant === candidate.accessVariant &&
        option.modality === candidate.modality,
    ) ?? null
  );
}

function sayRetellAgent(
  agent: DiscoveredAgent,
  catalog: readonly ConnectionOption[],
  egmaAgentId: string | null,
  out: (line: string) => void,
): void {
  out(`Retell Agent: ${oneLineFactText(agent.name, "Unnamed")}`);
  out(`  Retell Agent ID: ${oneLineFactText(agent.id, "unknown")}`);
  const phones = agent.connections
    .filter((candidate) => candidate.connectionType === "phone_number")
    .map((candidate) => clean(candidate.config["phoneNumber"]))
    .filter((phone) => phone !== "");
  if (phones.length === 0) out("  Phone numbers: none");
  else for (const phone of phones) out(`  Phone number: ${phone}`);
  out(
    egmaAgentId === null
      ? "  Registration commands:"
      : "  Connection add commands:",
  );
  for (const candidate of agent.connections) {
    const option = candidateOption(candidate, catalog);
    if (option === null) continue;
    const fixed =
      egmaAgentId === null
        ? ["--retell-agent", shellWord(agent.id)]
        : ["--agent", shellWord(egmaAgentId)];
    if (candidate.connectionType === "phone_number") {
      const phone = clean(candidate.config["phoneNumber"]);
      if (phone !== "") fixed.push("--phone-number", shellWord(phone));
    }
    out(
      `    ${optionCommand(
        "retell",
        option,
        egmaAgentId === null ? "register" : "add",
        fixed,
      )}`,
    );
  }
}

/** List server-owned connection choices and, for Retell, provider Agents. */
export async function runAgentConnectionOptionsCommand(
  options: AgentConnectionOptionsCommandOptions,
): Promise<number> {
  const stoppedBefore = interrupted(options);
  if (stoppedBefore !== null) return stoppedBefore.code;
  const platform = platformWord(options.platform);
  if (platform === null || typeof platform === "object") {
    options.out("platform: retell");
    options.out("platform: livekit");
    return sayFailure(
      options,
      platform === null ? "platform-required" : "unsupported-platform",
      "Choose --platform retell or --platform livekit.",
      AGENT_EXIT.incomplete,
    ).code;
  }
  const ready = await prepare(options);
  if ("code" in ready) return ready.code;
  const catalogResult = await readConnectionOptions(ready.request);
  if (catalogResult.kind !== "catalog") {
    return requestFailure(catalogResult, options).code;
  }
  const catalog = connectionOptionsForPlatform(catalogResult.catalog, platform);

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
      const remote = await readAgent(agentId, ready.request);
      if (remote.kind !== "agent") {
        if (remote.kind === "not-found") {
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
    if (discovered.kind !== "agents") {
      return requestFailure(discovered, options).code;
    }
    if (discovered.agents.length === 0) {
      options.out("Retell Agents: none");
    } else {
      for (const [index, agent] of discovered.agents.entries()) {
        if (index > 0) options.out("");
        sayRetellAgent(
          agent,
          catalog,
          agentId === "" ? null : agentId,
          options.out,
        );
      }
    }
    options.out("status: listed");
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
  for (const option of catalog) {
    const access = publicAccess(option);
    if (access === null) continue;
    options.out("");
    options.out(`${option.productLabel} (${option.modality})`);
    options.out(`  Access: ${access}`);
    const required = option.fields
      .filter((field) => field.required)
      .flatMap((field) => connectionFlag(field.key) ?? []);
    const optional = option.fields
      .filter((field) => !field.required)
      .flatMap((field) => connectionFlag(field.key) ?? []);
    options.out(`  Required flags: ${required.length === 0 ? "none" : required.join(", ")}`);
    options.out(`  Optional flags: ${optional.length === 0 ? "none" : optional.join(", ")}`);
    sayCredentialSources(platform, option, options.out);
    options.out(`  Command: ${optionCommand(platform, option, "register")}`);
  }
  options.out("status: listed");
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
  if (result.kind !== "catalog") return requestFailure(result, options);
  return {
    ready,
    platform,
    modality,
    accessMethod,
    catalog: connectionOptionsForPlatform(result.catalog, platform),
  };
}

async function loadChoice(
  options: CommandIO & {
    readonly platform: string | null;
    readonly modality: string | null;
    readonly accessMethod: string | null;
  },
): Promise<LoadedCatalog | Stop> {
  const before = interrupted(options);
  if (before !== null) return before;
  const platform = platformWord(options.platform);
  if (platform === null || typeof platform === "object") {
    return sayFailure(
      options,
      platform === null ? "platform-required" : "unsupported-platform",
      "Choose --platform retell or --platform livekit.",
      AGENT_EXIT.incomplete,
    );
  }
  const ready = await prepare(options);
  if ("code" in ready) return ready;
  return await loadChoiceForReady(options, ready, platform);
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
  const phone = clean(flags.phoneNumber);
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

function sayRegistered(registered: Registered, out: (line: string) => void): void {
  out(`Agent: ${registered.agent.name} (${registered.agent.id})`);
  out(`Connection: ${registered.connection.name} (${registered.connection.id})`);
}

async function refreshAfterWrite(
  registered: Registered,
  ready: Ready,
  options: CommandIO,
): Promise<number> {
  sayRegistered(registered, options.out);
  try {
    const refreshed = await refreshProjectTargets(
      { paths: ready.paths, project: ready.project },
      ready.request,
    );
    if (refreshed.kind !== "synced") {
      const stopped = requestFailure(refreshed, options);
      options.fail(
        `The remote write succeeded, but egma/config.yaml was not refreshed. Run egma pull.`,
      );
      return stopped.code;
    }
    const result =
      registered.result === "connection_added"
        ? "connection-added"
        : registered.result;
    options.out(`status: ${result}`);
    return AGENT_EXIT.done;
  } catch (cause) {
    const detail = oneLineFactText(
      cause instanceof Error ? cause.message : String(cause),
      "unknown local write error",
    );
    options.out("status: local-refresh-failed");
    options.fail(
      `The remote write succeeded, but egma/config.yaml was not refreshed: ${detail}. Run egma pull.`,
    );
    return AGENT_EXIT.localWriteFailed;
  }
}

function reportedConfig(
  option: ConnectionOption,
  flags: ConnectionFlags,
  options: Pick<CommandIO, "out" | "fail">,
  discovered?: Readonly<Record<string, string>>,
): BuiltConfig {
  return configForOption(option, flags, options, discovered);
}

/** Atomically register an Egma Agent and its first Connection. */
export async function runAgentRegisterCommand(
  options: AgentRegisterCommandOptions,
): Promise<number> {
  const loaded = await loadChoice(options);
  if ("code" in loaded) return loaded.code;

  if (loaded.platform === "retell") {
    const retellAgentId = clean(options.retellAgentId);
    if (retellAgentId === "") {
      return sayFailure(
        options,
        "retell-agent-required",
        "Choose a Retell Agent with --retell-agent. Run egma agent connection options --platform retell to list Agent IDs.",
        AGENT_EXIT.incomplete,
      ).code;
    }
    const credential = await retellCredential(options);
    if ("code" in credential) return credential.code;
    const discovered = await discoverRetellAgents(
      { projectId: loaded.ready.project.id, credentials: credential },
      loaded.ready.request,
    );
    if (discovered.kind !== "agents") {
      return requestFailure(discovered, options).code;
    }
    const agent = retellAgentNamed(discovered.agents, retellAgentId);
    if (agent === null) {
      return sayFailure(
        options,
        "retell-agent-not-found",
        `Retell did not list Agent ${retellAgentId}. Run egma agent connection options --platform retell again.`,
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
        clean(options.phoneNumber) === ""
          ? "--phone-number is required for a Retell phone connection."
          : matches.length === 0
            ? `Retell Agent ${retellAgentId} does not offer this connection. Run egma agent connection options --platform retell again.`
            : `Retell Agent ${retellAgentId} offers more than one matching connection. Run egma agent connection options --platform retell again.`;
      return sayFailure(
        options,
        "connection-not-found",
        message,
        AGENT_EXIT.incomplete,
      ).code;
    }
    const { option: choice, candidate } = matches[0]!;
    const builtConfig = reportedConfig(choice, options, options, candidate.config);
    if (builtConfig.kind === "stop") return builtConfig.stop.code;
    const config = builtConfig.config;
    const connection: NewConnection = {
      ...(clean(options.connectionName) === ""
        ? {}
        : { name: clean(options.connectionName) }),
      agentPlatform: "retell",
      connectionType: candidate.connectionType,
      accessVariant: candidate.accessVariant,
      modality: candidate.modality,
      config,
      platformAgentId: agent.id,
      credentials: credential,
    };
    const result = await registerAgent(
      {
        name: clean(options.name) || agent.name,
        agentPlatform: "retell",
        project: loaded.ready.project.id,
        connection,
      },
      loaded.ready.request,
    );
    if (result.kind !== "registered") {
      if (result.kind === "name-taken") {
        return sayFailure(
          options,
          "name-taken",
          `An Egma Agent named ${JSON.stringify(result.name)} already exists. Choose another --name.`,
          AGENT_EXIT.incomplete,
        ).code;
      }
      return requestFailure(result, options).code;
    }
    return await refreshAfterWrite(result.registered, loaded.ready, options);
  }

  const choice = selectedOption(
    loaded.catalog,
    loaded.accessMethod,
    loaded.modality,
    options,
  );
  if ("code" in choice) return choice.code;
  const builtConfig = reportedConfig(choice, options, options);
  if (builtConfig.kind === "stop") return builtConfig.stop.code;
  const config = builtConfig.config;
  const credentials = await credentialsForOption(
    loaded.platform,
    choice,
    options,
  );
  if (credentials.kind === "stop") return credentials.stop.code;
  const defaultName = clean(options.dispatchName);
  const name = clean(options.name) || defaultName;
  if (name === "") {
    return sayFailure(
      options,
      "name-required",
      "--name is required when this LiveKit connection has no --dispatch-name to use as its default.",
      AGENT_EXIT.incomplete,
    ).code;
  }
  const result = await registerAgent(
    {
      name,
      agentPlatform: "livekit",
      project: loaded.ready.project.id,
      connection: {
        ...(clean(options.connectionName) === ""
          ? {}
          : { name: clean(options.connectionName) }),
        agentPlatform: "livekit",
        connectionType: choice.connectionType,
        accessVariant: choice.accessVariant,
        modality: choice.modality,
        config,
        ...(credentials.credentials === undefined
          ? {}
          : { credentials: credentials.credentials }),
      },
    },
    loaded.ready.request,
  );
  if (result.kind !== "registered") {
    if (result.kind === "name-taken") {
      return sayFailure(
        options,
        "name-taken",
        `An Egma Agent named ${JSON.stringify(result.name)} already exists. Choose another --name.`,
        AGENT_EXIT.incomplete,
      ).code;
    }
    return requestFailure(result, options).code;
  }
  return await refreshAfterWrite(result.registered, loaded.ready, options);
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
  const local = localAgent(ready.config, agentId);
  if (local === null) {
    return sayFailure(
      options,
      "agent-not-found",
      `egma/config.yaml does not list Agent ${agentId}. Run egma pull, then choose an Agent ID from the file.`,
      AGENT_EXIT.incomplete,
    ).code;
  }

  const remote = await readAgent(agentId, ready.request);
  if (remote.kind !== "agent") {
    if (remote.kind === "not-found") {
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

  let connection: NewConnection;
  if (loaded.platform === "retell") {
    const providerAgentId = remote.agent.platformAgentId;
    if (providerAgentId === null) {
      return sayFailure(
        options,
        "retell-agent-not-bound",
        `Agent ${agentId} has no Retell Agent ID. Register its first Retell connection before adding another one.`,
        AGENT_EXIT.incomplete,
      ).code;
    }

    // The Agent row is the server's answer about whether it can reuse a key.
    // Environment values are ignored when the row already has one, so a stale
    // shell variable cannot rotate a working credential by accident.
    const hasStoredCredential = remote.agent.monitoringKeyPresent === true;
    let credential: ConnectionCredentials | undefined;
    if (!hasStoredCredential && remote.agent.monitoringKeyPresent === false) {
      const supplied = await retellCredential(options);
      if ("code" in supplied) return supplied.code;
      credential = supplied;
    }
    const discovered = await discoverRetellAgents(
      hasStoredCredential || remote.agent.monitoringKeyPresent === undefined
        ? { projectId: loaded.ready.project.id, agentId }
        : {
            projectId: loaded.ready.project.id,
            ...(credential === undefined ? {} : { credentials: credential }),
          },
      loaded.ready.request,
    );
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
        clean(options.phoneNumber) === ""
          ? "--phone-number is required for a Retell phone connection."
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
    const builtConfig = reportedConfig(choice, options, options, candidate.config);
    if (builtConfig.kind === "stop") return builtConfig.stop.code;
    const config = builtConfig.config;
    connection = {
      ...(clean(options.connectionName) === ""
        ? {}
        : { name: clean(options.connectionName) }),
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
      ...(clean(options.connectionName) === ""
        ? {}
        : { name: clean(options.connectionName) }),
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

  const result = await addConnection(agentId, connection, loaded.ready.request);
  if (result.kind !== "added") {
    if (result.kind === "name-taken") {
      return sayFailure(
        options,
        "name-taken",
        `A Connection named ${JSON.stringify(result.name)} already exists on Agent ${agentId}. Choose another --connection-name.`,
        AGENT_EXIT.incomplete,
      ).code;
    }
    if (result.kind === "not-found") {
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
