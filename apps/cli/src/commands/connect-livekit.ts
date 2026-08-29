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
import type { RegisterOptions, RegisterResult } from "../platform/agents.ts";
import {
  connectionOptionsForPlatform,
  readConnectionOptions,
  type ConnectionOption,
} from "../platform/connection-options.ts";
import { readCredentials, type PlatformAccess } from "../platform/credentials.ts";
import { readProject } from "../platform/projects.ts";
import { registrationLine } from "../retell/connect.ts";
import { connectionFieldIssue } from "../ui/connection-field-validation.ts";

export const LIVEKIT_API_KEY_VARIABLE = "EGMA_LIVEKIT_API_KEY";
export const LIVEKIT_API_SECRET_VARIABLE = "EGMA_LIVEKIT_API_SECRET";
export const LIVEKIT_TOKEN_HEADERS_VARIABLE = "EGMA_LIVEKIT_TOKEN_HEADERS";

const LIVEKIT_EXIT = {
  connected: 0,
  unreachable: 4,
  unchosen: 5,
  noCredentials: 6,
  notSignedIn: 7,
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

function interrupted(options: LiveKitConnectCommandOptions): number | null {
  if (!options.signal.aborted) return null;
  options.out("status: interrupted");
  options.fail("The egma connect command was stopped before it finished. Nothing was written.");
  return LIVEKIT_EXIT.interrupted;
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
  if (egmaName === "") {
    options.out("required_field: name Egma agent name");
    publicFieldsMissing = true;
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

  const result = await connectLiveKit(input, registerOptions);
  if (result.kind !== "registered") return registrationFailure(result, options);

  const registered = result.registered;
  const project = await readProject(
    { url: held.url, key: held.key },
    registered.agent.projectId,
    options.fetchImpl,
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

  options.out(`agent_id: ${registered.agent.id}`);
  options.out(`agent_name: ${registered.agent.name}`);
  options.out(`connection_id: ${registered.connection.id}`);
  options.out(`connection_name: ${registered.connection.name}`);
  options.out(`agent_platform: ${registered.connection.agentPlatform ?? "unknown"}`);
  options.out(`connection_type: ${registered.connection.connectionType}`);
  options.out(`access_variant: ${registered.connection.accessVariant}`);
  options.out(`product_label: ${registered.connection.productLabel}`);
  options.out(`connection_modality: ${registered.connection.modality}`);
  options.out(`registration: ${registered.result}`);
  options.out(
    `agent_registration: ${registered.result === "created" ? "created" : "reused"}`,
  );
  options.out(
    `connection_registration: ${registered.result === "reused" ? "reused" : "created"}`,
  );
  const already = registrationLine(registered);
  if (already !== null) options.out(`note: ${already}`);
  options.out("grounded_in: repository");
  options.out("status: connected");
  return LIVEKIT_EXIT.connected;
}
