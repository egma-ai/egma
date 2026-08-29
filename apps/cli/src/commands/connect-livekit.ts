/**
 * The promptless LiveKit half of `egma connect`.
 *
 * The platform catalog owns which modality, access variant, public fields and
 * credential fields this Egma instance supports. This command only maps those
 * fields to stable command inputs. Secret fields have no command input at all:
 * they can arrive only in the environment of this process.
 */

import {
  bindRepositoryPlatform,
  folderPathsIn,
  recordRegisteredTarget,
} from "../folder/egma-folder.ts";
import {
  connectLiveKit,
  liveKitKeyPair,
  liveKitTokenHeaders,
  LIVEKIT_KEY_PAIR_VARIANT,
  LIVEKIT_TOKEN_ENDPOINT_VARIANT,
  type LiveKitRegistration,
} from "../livekit/connect.ts";
import {
  matchingConnections,
  readAgent,
  type Registered,
  type RegisteredAgent,
  type RegisteredConnection,
  type RegisterOptions,
  type RegisterResult,
} from "../platform/agents.ts";
import {
  connectionOptionsForPlatform,
  readConnectionOptions,
  type ConnectionOption,
} from "../platform/connection-options.ts";
import { readCredentials, type PlatformAccess } from "../platform/credentials.ts";
import { PlatformUnreachableError } from "../platform/device-flow.ts";
import { readProject } from "../platform/projects.ts";
import { PlatformRefusedError } from "../platform/refused.ts";
import {
  laneNamed,
  laneOfConnectionType,
  registrationLine,
  type Lane,
} from "../retell/connect.ts";
import { connectionFieldIssue } from "../ui/connection-field-validation.ts";
import {
  factValueIssue,
  MAX_FACT_VALUE_LENGTH,
  oneLineFactText,
  oneLineValueIssue,
} from "../ui/fact-value.ts";

export const LIVEKIT_API_KEY_VARIABLE = "EGMA_LIVEKIT_API_KEY";
export const LIVEKIT_API_SECRET_VARIABLE = "EGMA_LIVEKIT_API_SECRET";
export const LIVEKIT_TOKEN_HEADERS_VARIABLE = "EGMA_LIVEKIT_TOKEN_HEADERS";

const LIVEKIT_EXIT = {
  connected: 0,
  unreachable: 4,
  unchosen: 5,
  noCredentials: 6,
  notSignedIn: 7,
  repositoryRecordFailed: 9,
  interrupted: 130,
} as const;

export type LiveKitConnectCommandOptions = {
  readonly access: PlatformAccess;
  readonly cwd: string;
  /** The Egma agent name discovered in the repository. */
  readonly name: string | null;
  /** `--modality`, selected from the catalog. */
  readonly modality: string | null;
  /** `--access-variant`, selected from the catalog. */
  readonly accessVariant: string | null;
  /** `--livekit-url`, supplied for the catalog's `url` field. */
  readonly livekitUrl: string | null;
  /** `--dispatch-name`, supplied for the catalog's `agentName` field. */
  readonly dispatchName: string | null;
  /** `--token-endpoint`, supplied for the catalog field with that name. */
  readonly tokenEndpoint: string | null;
  /** `--metadata`, supplied for the optional catalog field with that name. */
  readonly metadata: string | null;
  readonly env: NodeJS.ProcessEnv;
  readonly signal: AbortSignal;
  readonly out: (line: string) => void;
  readonly fail: (line: string) => void;
  readonly fetchImpl?: RegisterOptions["fetchImpl"];
};

/** Stable receipt ids or provider-public facts used to recover a local record. */
export type ConnectRecordCommandOptions = {
  readonly access: PlatformAccess;
  readonly cwd: string;
  readonly platform: "livekit" | "retell";
  readonly name: string | null;
  readonly projectId: string | null;
  readonly agentId: string | null;
  readonly connectionId: string | null;
  /** Public LiveKit worker identity, used when registration reused another Egma name. */
  readonly livekitUrl: string | null;
  readonly dispatchName: string | null;
  readonly modality: string | null;
  readonly accessVariant: string | null;
  readonly metadata: string | null;
  /** Public Retell identity and lane facts from provider discovery. */
  readonly retellAgentId: string | null;
  readonly lanes: string | null;
  readonly phoneNumber: string | null;
  /** Public token-endpoint identity for the advanced LiveKit variant. */
  readonly tokenEndpoint: string | null;
  readonly signal: AbortSignal;
  readonly out: (line: string) => void;
  readonly fail: (line: string) => void;
  readonly fetchImpl?: RegisterOptions["fetchImpl"];
};

const PUBLIC_VALUE = {
  url: "livekitUrl",
  agentName: "dispatchName",
  tokenEndpoint: "tokenEndpoint",
  metadata: "metadata",
} as const;

const SECRET_VARIABLE: Readonly<Record<string, string>> = {
  apiKey: LIVEKIT_API_KEY_VARIABLE,
  apiSecret: LIVEKIT_API_SECRET_VARIABLE,
  headers: LIVEKIT_TOKEN_HEADERS_VARIABLE,
};

function text(value: string | null | undefined): string {
  return value?.trim() ?? "";
}

function interrupted(
  options: Pick<LiveKitConnectCommandOptions, "signal" | "out" | "fail">,
): number | null {
  if (!options.signal.aborted) return null;
  options.out("status: interrupted");
  options.fail("The egma connect command was stopped before it finished. Nothing was written.");
  return LIVEKIT_EXIT.interrupted;
}

/**
 * Print the complete non-secret remote receipt before any local persistence.
 *
 * The three stable ids are enough for `egma connect record` to read the
 * project, prove the agent and connection, and finish the repository record
 * without repeating registration.
 */
function sayRegistrationReceipt(
  registered: Registered,
  out: (line: string) => void,
): void {
  out("receipt: livekit-registration");
  out(`project_id: ${registered.agent.projectId}`);
  out(`agent_id: ${registered.agent.id}`);
  out(`agent_name: ${registered.agent.name}`);
  out(`connection_id: ${registered.connection.id}`);
  out(`connection_name: ${registered.connection.name}`);
  out(`agent_platform: ${registered.connection.agentPlatform ?? "unknown"}`);
  out(`connection_type: ${registered.connection.connectionType}`);
  out(`access_variant: ${registered.connection.accessVariant}`);
  out(`product_label: ${registered.connection.productLabel}`);
  out(`connection_modality: ${registered.connection.modality}`);
  out(`registration: ${registered.result}`);
  out(
    `agent_registration: ${registered.result === "created" ? "created" : "reused"}`,
  );
  out(
    `connection_registration: ${registered.result === "reused" ? "reused" : "created"}`,
  );
  const already = registrationLine(registered);
  if (already !== null) out(`note: ${already}`);
}

/** The response must prove the exact LiveKit connection the command requested. */
function isLiveKitReceipt(
  registered: Registered,
  input: LiveKitRegistration,
): boolean {
  const config = registered.connection.config;
  const samePublicTarget =
    liveKitServerOrigin(text(config["url"])) === liveKitServerOrigin(input.url) &&
    (input.variant === LIVEKIT_KEY_PAIR_VARIANT
      ? text(config["agentName"]) === input.agentName.trim()
      : text(config["tokenEndpoint"]) === input.tokenEndpoint.trim());
  const requestedMetadata =
    input.variant === LIVEKIT_KEY_PAIR_VARIANT ? input.metadata : undefined;
  const sameMetadata = config["metadata"] === requestedMetadata;
  return (
    registered.agent.id !== "" &&
    registered.agent.projectId !== "" &&
    registered.agent.agentPlatform === "livekit" &&
    registered.connection.id !== "" &&
    registered.connection.agentPlatform === "livekit" &&
    registered.connection.connectionType === "livekit_room" &&
    registered.connection.accessVariant === input.variant &&
    registered.connection.modality === input.modality &&
    samePublicTarget &&
    sameMetadata
  );
}

function recordRecoveryCommand(
  access: PlatformAccess,
  registered: Registered,
): string {
  return (
    `egma connect record --platform livekit --project-id ${registered.agent.projectId} ` +
    `--agent-id ${registered.agent.id} --connection-id ${registered.connection.id} ` +
    `--url "${access.url}"`
  );
}

function repositoryRecordFailure(
  cause: unknown,
  registered: Registered,
  options: LiveKitConnectCommandOptions,
): number {
  const detail = oneLineFactText(
    cause instanceof Error ? cause.message : String(cause),
    "unknown repository error",
  );
  const recovery = recordRecoveryCommand(options.access, registered);
  const reason =
    `Egma finished remote LiveKit registration for agent ${registered.agent.id} and ` +
    `connection ${registered.connection.id}, but could not record it in this repository: ` +
    `${detail}. The remote registration remains active. ` +
    `Fix the repository or Egma connection, then run the recovery_command. It does not ` +
    "repeat remote registration.";
  options.out(`recovery_command: ${recovery}`);
  options.out("status: repository-record-failed");
  options.out(`reason: ${reason}`);
  options.fail(reason);
  return LIVEKIT_EXIT.repositoryRecordFailed;
}

function completeReceipt(
  options: ConnectRecordCommandOptions,
): { readonly projectId: string; readonly agentId: string; readonly connectionId: string } | null {
  const projectId = text(options.projectId);
  const agentId = text(options.agentId);
  const connectionId = text(options.connectionId);
  if (projectId !== "" && agentId !== "" && connectionId !== "") {
    return { projectId, agentId, connectionId };
  }
  return null;
}

/** The comparison key the platform uses for a LiveKit server URL. */
function liveKitServerOrigin(url: string): string {
  const written = url.trim();
  try {
    const parsed = new URL(written);
    const host = parsed.hostname.toLowerCase().replace(/\.$/u, "");
    return parsed.port === "" ? host : `${host}:${parsed.port}`;
  } catch {
    return written.toLowerCase();
  }
}

function sameLiveKitTarget(
  connection: RegisteredConnection,
  wanted: {
    readonly url: string;
    readonly dispatchName: string;
    readonly tokenEndpoint: string;
    readonly modality: string;
    readonly accessVariant: string;
    readonly metadata: string;
    readonly connectionId: string;
  },
): boolean {
  const variant =
    wanted.dispatchName === ""
      ? LIVEKIT_TOKEN_ENDPOINT_VARIANT
      : LIVEKIT_KEY_PAIR_VARIANT;
  return (
    belongsToPlatform(connection, "livekit") &&
    connection.accessVariant === variant &&
    liveKitServerOrigin(text(connection.config["url"])) === liveKitServerOrigin(wanted.url) &&
    (variant === LIVEKIT_KEY_PAIR_VARIANT
      ? text(connection.config["agentName"]) === wanted.dispatchName
      : text(connection.config["tokenEndpoint"]) === wanted.tokenEndpoint) &&
    (wanted.modality === "" || connection.modality === wanted.modality) &&
    (wanted.accessVariant === "" || connection.accessVariant === wanted.accessVariant) &&
    text(connection.config["metadata"]) === wanted.metadata &&
    (wanted.connectionId === "" || connection.id === wanted.connectionId)
  );
}

function sameRetellTarget(
  agent: RegisteredAgent,
  connection: RegisteredConnection,
  wanted: {
    readonly retellAgentId: string;
    readonly lane: Lane;
    readonly phoneNumber: string;
    readonly connectionId: string;
  },
): boolean {
  const expected = {
    text: {
      connectionType: "retell_text_mode",
      accessVariant: "retell_text_mode.api_key",
      modality: "chat",
    },
    "web-call": {
      connectionType: "retell_web_call",
      accessVariant: "retell_web_call.api_key",
      modality: "voice",
    },
    phone: {
      connectionType: "phone_number",
      accessVariant: "phone_number.public_e164",
      modality: "voice",
    },
  } as const;
  const selected = expected[wanted.lane];
  const connectionPlatformAgentId = text(connection.config["retellAgentId"]);
  const everyPresentIdentityMatches =
    (agent.platformAgentId === null ||
      agent.platformAgentId === wanted.retellAgentId) &&
    (connectionPlatformAgentId === "" ||
      connectionPlatformAgentId === wanted.retellAgentId);
  const providerIdentityMatches =
    everyPresentIdentityMatches &&
    (wanted.lane === "phone"
      ? agent.platformAgentId === wanted.retellAgentId
      : connectionPlatformAgentId === wanted.retellAgentId);
  return (
    agent.agentPlatform === "retell" &&
    belongsToPlatform(connection, "retell") &&
    providerIdentityMatches &&
    connection.connectionType === selected.connectionType &&
    connection.accessVariant === selected.accessVariant &&
    connection.modality === selected.modality &&
    (wanted.lane !== "phone" ||
      text(connection.config["phoneNumber"]) === wanted.phoneNumber) &&
    (wanted.connectionId === "" || connection.id === wanted.connectionId)
  );
}

function recoveryRemoteFailure(
  options: ConnectRecordCommandOptions,
  status:
    | "not-signed-in"
    | "refused"
    | "unreachable"
    | "receipt-not-found"
    | "registration-not-found",
  reason: string,
): number {
  options.out(`status: ${status}`);
  options.out(`reason: ${reason}`);
  options.fail(reason);
  return status === "not-signed-in"
    ? LIVEKIT_EXIT.notSignedIn
    : LIVEKIT_EXIT.unreachable;
}

function belongsToPlatform(
  connection: RegisteredConnection,
  platform: "livekit" | "retell",
): boolean {
  if (connection.agentPlatform !== platform) return false;
  return platform === "livekit"
    ? connection.connectionType === "livekit_room"
    : laneOfConnectionType(connection.connectionType) !== null;
}

/** Record an earlier registration locally without making another remote write. */
export async function runConnectRecordCommand(
  options: ConnectRecordCommandOptions,
): Promise<number> {
  options.out(`url: ${options.access.url}`);
  const exactReceipt = completeReceipt(options);
  const wantedName = text(options.name);
  const receiptProjectId = text(options.projectId);
  const receiptAgentId = text(options.agentId);
  const wantedConnectionId = text(options.connectionId);
  const wantedLiveKitUrl = text(options.livekitUrl);
  const wantedDispatchName = text(options.dispatchName);
  const wantedTokenEndpoint = text(options.tokenEndpoint);
  const wantedModality = text(options.modality);
  const wantedAccessVariant = text(options.accessVariant);
  const wantedMetadata = text(options.metadata);
  const wantedRetellAgentId = text(options.retellAgentId);
  const wantedLaneText = text(options.lanes);
  const wantedPhoneNumber = text(options.phoneNumber);
  const wantedLane = wantedLaneText === "" ? null : laneNamed(wantedLaneText);
  for (const [field, value] of [
    ["name", wantedName],
    ["livekit_url", wantedLiveKitUrl],
    ["dispatch_name", wantedDispatchName],
    ["token_endpoint", wantedTokenEndpoint],
    ["modality", wantedModality],
    ["access_variant", wantedAccessVariant],
    ["retell_agent_id", wantedRetellAgentId],
    ["lanes", wantedLaneText],
    ["phone_number", wantedPhoneNumber],
    ["project_id", receiptProjectId],
    ["agent_id", receiptAgentId],
    ["connection_id", wantedConnectionId],
  ] as const) {
    if (value !== "" && factValueIssue(value) !== null) {
      options.out(`invalid_field: ${field}`);
      options.out("status: invalid-selector");
      options.fail(
        `Every recovery selector value must stay on one line of at most ${String(MAX_FACT_VALUE_LENGTH)} characters, without control characters. Nothing was written.`,
      );
      return LIVEKIT_EXIT.unchosen;
    }
  }
  if (wantedMetadata !== "" && oneLineValueIssue(wantedMetadata) !== null) {
    options.out("invalid_field: metadata");
    options.out("status: invalid-selector");
    options.fail(
      "The recovery metadata must stay on one line without control characters. Nothing was written.",
    );
    return LIVEKIT_EXIT.unchosen;
  }
  const hasPublicSelector =
    wantedName !== "" ||
    wantedLiveKitUrl !== "" ||
    wantedDispatchName !== "" ||
    wantedTokenEndpoint !== "" ||
    wantedModality !== "" ||
    wantedAccessVariant !== "" ||
    wantedMetadata !== "" ||
    wantedRetellAgentId !== "" ||
    wantedLaneText !== "" ||
    wantedPhoneNumber !== "";

  if (exactReceipt !== null && hasPublicSelector) {
    options.out("status: invalid-selector");
    options.fail(
      "Use either every stable receipt id or one provider-public selector, not both. Nothing was written.",
    );
    return LIVEKIT_EXIT.unchosen;
  }
  if (
    exactReceipt === null &&
    (receiptProjectId !== "" || receiptAgentId !== "")
  ) {
    options.out("status: incomplete-receipt");
    options.fail(
      "A receipt selector needs --project-id, --agent-id and --connection-id together. Provider-public recovery may use --connection-id only to choose one listed match. Nothing was written.",
    );
    return LIVEKIT_EXIT.unchosen;
  }
  if (exactReceipt === null && options.platform === "retell") {
    if (wantedRetellAgentId === "") {
      options.out("required_field: retell_agent_id --retell-agent");
    }
    if (wantedLane === null) {
      options.out("lane_option: text");
      options.out("lane_option: web-call");
      options.out("lane_option: phone");
    }
    if (wantedLane === "phone" && wantedPhoneNumber === "") {
      options.out("required_field: phone_number --phone-number");
    }
    const liveKitFieldsPresent =
      wantedLiveKitUrl !== "" ||
      wantedDispatchName !== "" ||
      wantedTokenEndpoint !== "" ||
      wantedModality !== "" ||
      wantedAccessVariant !== "" ||
      wantedMetadata !== "";
    if (
      wantedRetellAgentId === "" ||
      wantedLane === null ||
      (wantedLane === "phone" && wantedPhoneNumber === "") ||
      liveKitFieldsPresent
    ) {
      options.out("status: invalid-selector");
      options.fail(
        liveKitFieldsPresent
          ? "A Retell recovery selector cannot contain LiveKit fields. Nothing was written."
          : "Retell recovery needs --retell-agent and one --lanes value; phone also needs --phone-number. Nothing was written.",
      );
      return LIVEKIT_EXIT.unchosen;
    }
  }
  if (exactReceipt === null && options.platform === "livekit") {
    const oneLiveKitDoor =
      (wantedDispatchName === "") !== (wantedTokenEndpoint === "");
    const retellFieldsPresent =
      wantedRetellAgentId !== "" ||
      wantedLaneText !== "" ||
      wantedPhoneNumber !== "";
    if (wantedLiveKitUrl === "") {
      options.out("required_field: livekit_url --livekit-url");
    }
    if (!oneLiveKitDoor) {
      options.out("required_field: one of dispatch_name --dispatch-name or token_endpoint --token-endpoint");
    }
    if (
      wantedLiveKitUrl === "" ||
      !oneLiveKitDoor ||
      retellFieldsPresent ||
      (wantedDispatchName !== "" &&
        wantedAccessVariant !== "" &&
        wantedAccessVariant !== LIVEKIT_KEY_PAIR_VARIANT) ||
      (wantedTokenEndpoint !== "" &&
        wantedAccessVariant !== "" &&
        wantedAccessVariant !== LIVEKIT_TOKEN_ENDPOINT_VARIANT)
    ) {
      options.out("status: invalid-selector");
      options.fail(
        retellFieldsPresent
          ? "A LiveKit recovery selector cannot contain Retell fields. Nothing was written."
          : "LiveKit recovery needs --livekit-url and exactly one public access door: --dispatch-name or --token-endpoint. Nothing was written.",
      );
      return LIVEKIT_EXIT.unchosen;
    }
  }
  if (
    wantedModality !== "" &&
    wantedModality !== "chat" &&
    wantedModality !== "voice"
  ) {
    options.out("modality_option: chat");
    options.out("modality_option: voice");
    options.out("status: unchosen-modality");
    options.fail(
      `"${wantedModality}" is not a LiveKit modality. Choose one of the modality_option lines. Nothing was written.`,
    );
    return LIVEKIT_EXIT.unchosen;
  }

  const stopped = interrupted(options);
  if (stopped !== null) return stopped;

  const held = await readCredentials(options.access.credentialsFile, options.access.url);
  if (held === null) {
    return recoveryRemoteFailure(
      options,
      "not-signed-in",
      `This machine holds no Egma key for ${options.access.url}. Run egma login, then try again.`,
    );
  }

  const platform: RegisterOptions = {
    url: held.url,
    key: held.key,
    signal: options.signal,
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
  };

  let agentId = exactReceipt?.agentId ?? "";
  let projectId = exactReceipt?.projectId ?? "";
  let selectedConnectionId = wantedConnectionId;
  const matchesSelectedPublicTarget = (
    agent: RegisteredAgent,
    connection: RegisteredConnection,
  ): boolean =>
    options.platform === "retell"
      ? sameRetellTarget(agent, connection, {
          retellAgentId: wantedRetellAgentId,
          lane: wantedLane as Lane,
          phoneNumber: wantedPhoneNumber,
          connectionId: wantedConnectionId,
        })
      : sameLiveKitTarget(connection, {
          url: wantedLiveKitUrl,
          dispatchName: wantedDispatchName,
          tokenEndpoint: wantedTokenEndpoint,
          modality: wantedModality,
          accessVariant: wantedAccessVariant,
          metadata: wantedMetadata,
          connectionId: wantedConnectionId,
        });
  if (exactReceipt === null) {
    const matched = await matchingConnections(matchesSelectedPublicTarget, platform);
    if (matched.kind !== "matches") {
      return recoveryRemoteFailure(
        options,
        matched.kind === "not-authenticated" ? "not-signed-in" : matched.kind,
        matched.kind === "not-authenticated"
          ? `This machine holds no usable Egma key for ${options.access.url}. Run egma login, then try again.`
          : matched.reason,
      );
    }
    const exactNameMatches =
      wantedName === ""
        ? []
        : matched.matches.filter((match) => match.agent.name === wantedName);
    const candidates =
      exactNameMatches.length === 0 ? matched.matches : exactNameMatches;
    if (candidates.length === 0) {
      const identity =
        options.platform === "retell"
          ? `Retell agent ${wantedRetellAgentId} over ${wantedLaneText}`
          : wantedDispatchName !== ""
            ? `LiveKit worker ${wantedDispatchName} on ${wantedLiveKitUrl}`
            : `LiveKit token endpoint ${wantedTokenEndpoint} for ${wantedLiveKitUrl}`;
      return recoveryRemoteFailure(
        options,
        "registration-not-found",
        `Egma has no simulation connection for ${identity}. The earlier registration did not leave an equivalent public target.`,
      );
    }
    if (candidates.length > 1) {
      for (const match of candidates) {
        options.out(
          `connection_option: ${match.connection.id} ${match.agent.id} ${match.connection.name} ${match.connection.connectionType} ${match.connection.accessVariant} ${match.connection.modality}`,
        );
      }
      options.out("status: unchosen-connection");
      options.fail(
        "More than one connection has that provider-public identity. Choose the exact connection_option id with --connection-id. Nothing was recorded.",
      );
      return LIVEKIT_EXIT.unchosen;
    }
    const match = candidates[0]!;
    agentId = match.agent.id;
    projectId = match.agent.projectId;
    selectedConnectionId = match.connection.id;
  }

  const found = await readAgent(agentId, platform);
  if (found.kind !== "agent") {
    if (found.kind === "not-authenticated") {
      return recoveryRemoteFailure(
        options,
        "not-signed-in",
        `This machine holds no usable Egma key for ${options.access.url}. Run egma login, then try again.`,
      );
    }
    const reason =
      found.kind === "not-found"
        ? `Egma has no agent ${agentId}. Nothing was recorded.`
        : found.reason;
    return recoveryRemoteFailure(
      options,
      found.kind === "not-found" ? "receipt-not-found" : found.kind,
      reason,
    );
  }

  if (found.agent.projectId !== projectId) {
    return recoveryRemoteFailure(
      options,
      "receipt-not-found",
      `Agent ${agentId} belongs to project ${found.agent.projectId}, not receipt project ${projectId}. Nothing was recorded.`,
    );
  }
  if (found.agent.agentPlatform !== options.platform) {
    return recoveryRemoteFailure(
      options,
      "receipt-not-found",
      `Agent ${agentId} belongs to ${found.agent.agentPlatform}, not selector platform ${options.platform}. Nothing was recorded.`,
    );
  }

  const platformConnections = found.connections.filter((one) =>
    belongsToPlatform(one, options.platform),
  );
  const candidates =
    selectedConnectionId === ""
      ? platformConnections
      : platformConnections.filter((one) => one.id === selectedConnectionId);
  if (candidates.length === 0) {
    return recoveryRemoteFailure(
      options,
      "receipt-not-found",
      selectedConnectionId === ""
        ? `Agent ${agentId} has no ${options.platform} simulation connection. Nothing was recorded.`
        : `Agent ${agentId} has no ${options.platform} connection ${selectedConnectionId}. Nothing was recorded.`,
    );
  }
  if (candidates.length > 1) {
    for (const connection of candidates) {
      options.out(
        `connection_option: ${connection.id} ${connection.name} ${connection.connectionType} ${connection.accessVariant} ${connection.modality}`,
      );
    }
    options.out("status: unchosen-connection");
    options.fail(
      "More than one recovered connection can run simulations. Choose the exact connection_option id with --connection-id. Nothing was recorded.",
    );
    return LIVEKIT_EXIT.unchosen;
  }
  const connection = candidates[0]!;
  if (
    exactReceipt === null &&
    !matchesSelectedPublicTarget(found.agent, connection)
  ) {
    return recoveryRemoteFailure(
      options,
      "registration-not-found",
      `Connection ${connection.id} no longer matches the provider-public recovery selector. Nothing was recorded. Run recovery again with the current public facts.`,
    );
  }

  let project;
  try {
    project = await readProject(
      { url: held.url, key: held.key },
      projectId,
      options.fetchImpl,
      options.signal,
    );
  } catch (cause) {
    if (cause instanceof PlatformRefusedError || cause instanceof PlatformUnreachableError) {
      return recoveryRemoteFailure(
        options,
        cause instanceof PlatformRefusedError && cause.status === 401
          ? "not-signed-in"
          : cause instanceof PlatformRefusedError
            ? "refused"
            : "unreachable",
        cause.message,
      );
    }
    throw cause;
  }

  try {
    await bindRepositoryPlatform(options.cwd, { origin: options.access.url });
    await recordRegisteredTarget(folderPathsIn(options.cwd).config, {
      project,
      agent: { id: found.agent.id, name: found.agent.name },
      connection: {
        id: connection.id,
        name: connection.name,
        modality: connection.modality,
      },
    });
  } catch (cause) {
    const detail = oneLineFactText(
      cause instanceof Error ? cause.message : String(cause),
      "unknown repository error",
    );
    const reason =
      `Egma proved the earlier remote ${options.platform} registration, but could not record it in ` +
      `this repository: ${detail}`;
    options.out("status: repository-record-failed");
    options.out(`reason: ${reason}`);
    options.fail(reason);
    return LIVEKIT_EXIT.repositoryRecordFailed;
  }

  options.out(`project_id: ${project.id}`);
  options.out(`project_name: ${project.name}`);
  options.out(`agent_id: ${found.agent.id}`);
  options.out(`agent_name: ${found.agent.name}`);
  options.out(`connection_id: ${connection.id}`);
  options.out(`connection_name: ${connection.name}`);
  options.out(`connection_modality: ${connection.modality}`);
  options.out("grounded_in: repository");
  options.out("status: recorded");
  return LIVEKIT_EXIT.connected;
}

function catalogFailure(
  result: Exclude<Awaited<ReturnType<typeof readConnectionOptions>>, { kind: "catalog" }>,
  options: LiveKitConnectCommandOptions,
): number {
  if (result.kind === "not-authenticated") {
    options.out("status: not-signed-in");
    options.fail("This machine is not signed in to Egma. Run egma login, then try again.");
    return LIVEKIT_EXIT.notSignedIn;
  }
  options.out(`status: ${result.kind}`);
  options.out(`reason: ${result.reason}`);
  options.fail(result.reason);
  return LIVEKIT_EXIT.unreachable;
}

function registrationFailure(
  result: Exclude<RegisterResult, { kind: "registered" }>,
  options: LiveKitConnectCommandOptions,
): number {
  switch (result.kind) {
    case "name-taken":
      options.out("status: name-taken");
      options.fail(
        `An Egma agent already uses the name ${result.name}. Choose another --name and try again.`,
      );
      return LIVEKIT_EXIT.unchosen;
    case "not-authenticated":
      options.out("status: not-signed-in");
      options.fail("This machine is not signed in to Egma. Run egma login, then try again.");
      return LIVEKIT_EXIT.notSignedIn;
    case "refused":
    case "unreachable":
      options.out(`status: ${result.kind}`);
      options.out(`reason: ${result.reason}`);
      options.fail(result.reason);
      return LIVEKIT_EXIT.unreachable;
  }
}

function supportedLiveKitOptions(options: readonly ConnectionOption[]): readonly ConnectionOption[] {
  return options.filter(
    (option) =>
      option.simulatorAdapter &&
      (option.accessVariant === LIVEKIT_KEY_PAIR_VARIANT ||
        option.accessVariant === LIVEKIT_TOKEN_ENDPOINT_VARIANT),
  );
}

function valueFor(
  key: keyof typeof PUBLIC_VALUE,
  options: LiveKitConnectCommandOptions,
): string {
  return text(options[PUBLIC_VALUE[key]]);
}

/** Register and record one LiveKit connection without asking a question. */
export async function runLiveKitConnectCommand(
  options: LiveKitConnectCommandOptions,
): Promise<number> {
  options.out(`url: ${options.access.url}`);

  const stopped = interrupted(options);
  if (stopped !== null) return stopped;

  const held = await readCredentials(options.access.credentialsFile, options.access.url);
  if (held === null) {
    options.out("status: not-signed-in");
    options.fail(
      `This machine holds no Egma key for ${options.access.url}. Run egma login, then try again.`,
    );
    return LIVEKIT_EXIT.notSignedIn;
  }

  const registerOptions: RegisterOptions = {
    url: held.url,
    key: held.key,
    signal: options.signal,
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
  };
  const catalog = await readConnectionOptions(registerOptions);
  if (catalog.kind !== "catalog") return catalogFailure(catalog, options);

  const offered = supportedLiveKitOptions(
    connectionOptionsForPlatform(catalog.catalog, "livekit"),
  );
  if (offered.length === 0) {
    options.out("status: refused");
    options.fail("This Egma instance did not describe a LiveKit connection setup.");
    return LIVEKIT_EXIT.unreachable;
  }

  const modalities = [...new Set(offered.map((option) => option.modality))];
  for (const modality of modalities) options.out(`modality_option: ${modality}`);

  const wantedModality = text(options.modality).toLowerCase();
  const modality =
    wantedModality === "" && modalities.length === 1
      ? modalities[0]
      : modalities.find((one) => one === wantedModality);
  if (modality === undefined) {
    options.out("status: unchosen-modality");
    options.fail(
      wantedModality === ""
        ? "Choose one LiveKit modality with --modality. Nothing was written."
        : `This Egma instance does not offer LiveKit modality ${wantedModality}. Choose one of the modality_option lines. Nothing was written.`,
    );
    return LIVEKIT_EXIT.unchosen;
  }

  const forModality = offered.filter((option) => option.modality === modality);
  for (const option of forModality) {
    options.out(
      `access_variant_option: ${option.accessVariant} ${option.accessVariantLabel}`.trimEnd(),
    );
  }

  const wantedVariant = text(options.accessVariant);
  const variant =
    wantedVariant === "" && forModality.length === 1
      ? forModality[0]
      : forModality.find((option) => option.accessVariant === wantedVariant);
  if (variant === undefined) {
    options.out("status: unchosen-access-variant");
    options.fail(
      wantedVariant === ""
        ? "Choose one LiveKit connection method with --access-variant. Nothing was written."
        : `This Egma instance does not offer ${wantedVariant} for LiveKit ${modality}. Choose one of the access_variant_option lines. Nothing was written.`,
    );
    return LIVEKIT_EXIT.unchosen;
  }

  const config: Record<string, string> = {};
  let publicFieldsMissing = false;
  let publicFieldInvalid = false;
  let publicFieldUnsupported = false;
  const egmaName = text(options.name);
  const nameIssue = factValueIssue(egmaName);
  if (nameIssue === "empty") {
    options.out("required_field: name Egma agent name");
    publicFieldsMissing = true;
  } else if (nameIssue !== null) {
    options.out("invalid_field: name Egma agent name");
    options.out("status: invalid-field");
    options.fail(
      `Give --name one line of at most ${String(MAX_FACT_VALUE_LENGTH)} characters, without control characters. Nothing was written.`,
    );
    return LIVEKIT_EXIT.unchosen;
  }
  for (const field of variant.fields) {
    if (!(field.key in PUBLIC_VALUE)) {
      if (field.required) {
        options.out(`unsupported_field: ${field.key} ${field.label}`.trimEnd());
        publicFieldUnsupported = true;
      }
      continue;
    }
    const key = field.key as keyof typeof PUBLIC_VALUE;
    const value = valueFor(key, options);
    const issue = connectionFieldIssue(field, value);
    if (issue === "missing") {
      options.out(`required_field: ${field.key} ${field.label}`.trimEnd());
      publicFieldsMissing = true;
    } else if (issue === "invalid-json") {
      options.out(`invalid_field: ${field.key} ${field.label}`.trimEnd());
      publicFieldInvalid = true;
    } else if (value !== "") {
      config[field.key] = value;
    }
  }
  if (publicFieldUnsupported) {
    options.out("status: refused");
    options.fail(
      "This CLI does not know how to supply a required public field from this Egma instance. Update the CLI and try again. Nothing was written.",
    );
    return LIVEKIT_EXIT.unreachable;
  }
  if (publicFieldsMissing || publicFieldInvalid) {
    options.out(`status: ${publicFieldInvalid ? "invalid-field" : "missing-fields"}`);
    options.fail(
      publicFieldInvalid
        ? "Every JSON field must contain one JSON object. Nothing was written."
        : "Give every required_field in the command, then try again. Nothing was written.",
    );
    return LIVEKIT_EXIT.unchosen;
  }

  const credentials: Record<string, string> = {};
  let credentialsMissing = false;
  let credentialsInvalid = false;
  let credentialsUnsupported = false;
  for (const field of variant.credentialFields) {
    const variable = SECRET_VARIABLE[field.field];
    if (variable === undefined) {
      if (field.required) {
        options.out(`unsupported_credential_field: ${field.field} ${field.label}`.trimEnd());
        credentialsUnsupported = true;
      }
      continue;
    }
    const value = text(options.env[variable]);
    const issue = connectionFieldIssue(field, value);
    if (issue === "missing") {
      options.out(`required_secret: ${variable}`);
      credentialsMissing = true;
    } else if (issue === "invalid-json") {
      options.out(`invalid_secret: ${variable}`);
      credentialsInvalid = true;
    } else if (value !== "") {
      credentials[field.field] = value;
    }
  }
  if (credentialsUnsupported) {
    options.out("status: refused");
    options.fail(
      "This CLI does not know how to supply a required credential field from this Egma instance. Update the CLI and try again. Nothing was written.",
    );
    return LIVEKIT_EXIT.unreachable;
  }
  if (credentialsMissing || credentialsInvalid) {
    options.out(`status: ${credentialsInvalid ? "invalid-credentials" : "no-credentials"}`);
    options.fail(
      credentialsInvalid
        ? "Every JSON credential variable must contain one JSON object. Nothing was written."
        : "Set every required_secret in the environment of this command, then try again. Nothing was written.",
    );
    return LIVEKIT_EXIT.noCredentials;
  }

  let input: LiveKitRegistration;
  if (variant.accessVariant === LIVEKIT_KEY_PAIR_VARIANT) {
    input = {
      variant: LIVEKIT_KEY_PAIR_VARIANT,
      name: egmaName,
      url: config["url"] ?? "",
      agentName: config["agentName"] ?? "",
      modality,
      ...(config["metadata"] === undefined ? {} : { metadata: config["metadata"] }),
      credentials: liveKitKeyPair(
        credentials["apiKey"] ?? "",
        credentials["apiSecret"] ?? "",
      ),
    };
  } else {
    input = {
      variant: LIVEKIT_TOKEN_ENDPOINT_VARIANT,
      name: egmaName,
      url: config["url"] ?? "",
      tokenEndpoint: config["tokenEndpoint"] ?? "",
      modality: "voice",
      credentials: liveKitTokenHeaders(credentials["headers"] ?? ""),
    };
  }

  try {
    await bindRepositoryPlatform(options.cwd, { origin: options.access.url });
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    options.out("status: refused");
    options.out(`reason: ${reason.split("\n")[0] ?? reason}`);
    options.fail(reason);
    return LIVEKIT_EXIT.unreachable;
  }

  options.out(`registration_name: ${input.name}`);
  const result = await connectLiveKit(input, registerOptions);
  if (result.kind !== "registered") return registrationFailure(result, options);

  const registered = result.registered;
  if (!isLiveKitReceipt(registered, input)) {
    const reason =
      "Egma answered without a complete receipt for the requested LiveKit connection. No recovery receipt was printed and nothing was recorded locally.";
    options.out("status: refused");
    options.out(`reason: ${reason}`);
    options.fail(reason);
    return LIVEKIT_EXIT.unreachable;
  }
  sayRegistrationReceipt(registered, options.out);

  try {
    const project = await readProject(
      { url: held.url, key: held.key },
      registered.agent.projectId,
      options.fetchImpl,
      options.signal,
    );
    await recordRegisteredTarget(folderPathsIn(options.cwd).config, {
      project,
      agent: { name: registered.agent.name, id: registered.agent.id },
      connection: {
        name: registered.connection.name,
        id: registered.connection.id,
        modality: registered.connection.modality,
      },
    });
  } catch (cause) {
    return repositoryRecordFailure(cause, registered, options);
  }

  options.out("grounded_in: repository");
  options.out("status: connected");
  return LIVEKIT_EXIT.connected;
}
