/**
 * LiveKit connection setup for the wizard, drawn from the platform catalog.
 *
 * A connection is how Egma's simulator reaches the agent — on LiveKit that is
 * the customer's server URL and their key pair or token endpoint. The Egma SDK
 * inside the customer's own worker is a separate thing, wired by the mock
 * authoring step after the tests are written.
 *
 * The first question is the one the developer already has an opinion about:
 * chat or voice. It comes before the credentials because it is the choice
 * about what testing this agent is like, and the plumbing under it follows
 * from the answer — chat is offered where Egma dispatches the worker itself,
 * and nowhere else. The catalog is what says which pairs exist; this step
 * never holds a list of its own.
 */

import { bindRepositoryPlatform } from "../folder/egma-folder.ts";
import {
  connectLiveKit,
  LIVEKIT_KEY_PAIR_VARIANT,
  LIVEKIT_TOKEN_ENDPOINT_VARIANT,
  liveKitConnection,
  liveKitKeyPair,
  liveKitTokenHeaders,
  type LiveKitRegistration,
} from "../livekit/connect.ts";
import { localLiveKitWorkerFileIssue } from "../livekit/local-worker.ts";
import {
  addConnection,
  type Registered,
  type RegisterOptions,
  type RegisterResult,
} from "../platform/agents.ts";
import { registrationLine } from "../retell/connect.ts";
import {
  connectionOptionsForPlatform,
  readConnectionOptions,
  type ConnectionField,
  type ConnectionOption,
  type CredentialField,
} from "../platform/connection-options.ts";
import { readCredentials } from "../platform/credentials.ts";
import type { ConnectionCredentials } from "../platform/connection-credentials.ts";
import { connectionFieldIssue } from "../ui/connection-field-validation.ts";
import type {
  ConnectionAsk,
  ConnectionAskId,
  ConnectionFieldsAsk,
  WizardUI,
} from "../ui/wizard-ui.ts";
import type { ExitReport } from "./exit-line.ts";
import type { PlatformAccess } from "./login-step.ts";
import { ACTION_MARK, DETAIL_MARK } from "./status.ts";
import { stopReport, untilAborted } from "./stop.ts";

export type LiveKitConnectionSetupStepOptions = {
  readonly ui: WizardUI;
  readonly platform: PlatformAccess;
  readonly cwd: string;
  readonly signal: AbortSignal;
  /** The voice-agent name reported by repository discovery. */
  readonly suggestedName: string;
  /** The exact worker name LiveKit dispatches, read from the agent source. */
  readonly dispatchName: string;
  /**
   * The same name as the worker-integration task left it, when it ran.
   *
   * Discovery reads committed source, so a worker that registered no name
   * comes back `unknown`. The integration task is the one visit that can have
   * given it a name since, so its answer stands beside discovery's and either
   * one being real is enough.
   */
  readonly integratedDispatchName?: string | undefined;
  /** The repository-relative worker entrypoint read from source. */
  readonly entrypoint: string;
  /** The repository-relative Python manifest reported after integration. */
  readonly dependencyManifest: string;
  /**
   * The agent this sitting is already about, when monitoring created it.
   *
   * One agent row for one voice agent: the both lane sets monitoring up first
   * and the row it wrote is the row this connection attaches to, so the name is
   * settled and its screen is never drawn.
   */
  readonly existingAgent?:
    | { readonly id: string; readonly name: string; readonly projectId: string }
    | null
    | undefined;
  readonly fetchImpl?: RegisterOptions["fetchImpl"];
};

export type LiveKitConnected = {
  readonly report: ExitReport;
  readonly connected: {
    readonly registered: Registered;
    /** LiveKit prompt and tool source stays in the repository and ACP context. */
    readonly source: {
      readonly prompt: null;
      readonly toolCount: null;
    };
    /** Present only when this connection can start the repository's local worker. */
    readonly localWorker: {
      readonly url: string;
      readonly credentials: ConnectionCredentials;
      readonly dispatchName: string;
      readonly entrypoint: string;
      readonly dependencyManifest: string;
    } | null;
  } | null;
};

const SECRET_CUSTODY =
  "This value is not sent to the coding agent or written to this repository. Egma stores it sealed; project credentials also reach the local LiveKit worker only through its process environment.";

const LIVEKIT_FIELDS_HELP =
  "For project credentials, get the WebSocket URL, API key, and API secret from LiveKit Cloud. Egma uses them to connect each simulation to a room.";

const LIVEKIT_CREDENTIAL_NOTICE =
  "Credentials are not sent to the coding agent or written to this repository. " +
  "Egma stores them sealed; project credentials also reach the local worker only through its process environment.";

function ending(reason: string): LiveKitConnected {
  return { report: { kind: "failed", reason }, connected: null };
}

/** Discovery uses the literal `unknown` when committed source proves no value. */
function discoveredValue(value: string): string | null {
  const held = value.trim();
  return held === "" || held.toLowerCase() === "unknown" ? null : held;
}

async function ask(
  ui: WizardUI,
  signal: AbortSignal,
  question: ConnectionAsk,
): Promise<string | null> {
  ui.setConnectionAsk(question);
  try {
    return (await untilAborted(ui.waitForAnswer(question.id), signal)) ?? null;
  } finally {
    ui.setConnectionAsk(null);
  }
}

function askId(part: string): ConnectionAskId {
  return `connection:${part}`;
}

function fieldAsk(
  scope: "config" | "credentials",
  field: ConnectionField | CredentialField,
  option: ConnectionOption,
  problem: string | null = null,
): ConnectionAsk {
  const key = "key" in field ? field.key : field.field;
  return {
    id: askId(`${scope}:${key}`),
    label: field.label,
    help: field.help,
    kind: field.kind === "e164" ? "text" : field.kind,
    required: field.required,
    problem,
    ...(scope === "credentials" ? { custody: option.credentialHelp || SECRET_CUSTODY } : {}),
  };
}

type Collected =
  | {
      readonly kind: "values";
      readonly config: Readonly<Record<string, string>>;
      readonly credentials: Readonly<Record<string, string>>;
    }
  | {
      readonly kind: "stopped";
      readonly field: string;
      readonly reason: "missing" | "invalid-json";
    }
  | { readonly kind: "interrupted" };

type ScopedField =
  | { readonly scope: "config"; readonly field: ConnectionField }
  | { readonly scope: "credentials"; readonly field: CredentialField };

/** Server order around the credential boundary: config before, credentials, config after. */
function orderedFields(option: ConnectionOption): readonly ScopedField[] {
  return [
    ...option.fields
      .filter((field) => !field.afterCredentials)
      .map((field): ScopedField => ({ scope: "config", field })),
    ...option.credentialFields.map(
      (field): ScopedField => ({ scope: "credentials", field }),
    ),
    ...option.fields
      .filter((field) => field.afterCredentials)
      .map((field): ScopedField => ({ scope: "config", field })),
  ];
}

/**
 * Fields the onboarding walk owns.
 *
 * The worker's name is read out of the repository — by discovery, or by the
 * task that put it there — so asking for it would be asking a developer to
 * retype something Egma has already seen. Metadata is not asked for at all.
 */
function wizardFields(option: ConnectionOption): readonly ScopedField[] {
  return orderedFields(option).filter(({ field }) => {
    const key = "key" in field ? field.key : field.field;
    return key !== "agentName" && key !== "metadata";
  });
}

function valuesFrom(
  fields: readonly ScopedField[],
  answers: Readonly<Partial<Record<ConnectionAskId, string>>>,
): Collected {
  const config: Record<string, string> = {};
  const credentials: Record<string, string> = {};
  for (const { scope, field } of fields) {
    const key = "key" in field ? field.key : field.field;
    const value = answers[askId(`${scope}:${key}`)]?.trim() ?? "";
    const issue = connectionFieldIssue(field, value);
    if (issue !== null) return { kind: "stopped", field: field.label, reason: issue };
    if (value !== "") {
      (scope === "config" ? config : credentials)[key] = value;
    }
  }
  return { kind: "values", config, credentials };
}

async function collectRequiredFields(
  ui: WizardUI,
  signal: AbortSignal,
  fields: readonly ScopedField[],
  option: ConnectionOption,
): Promise<Collected> {
  const questions = fields.map(({ scope, field }) => fieldAsk(scope, field, option));
  const form: ConnectionFieldsAsk = {
    title: "LiveKit connection details",
    help: LIVEKIT_FIELDS_HELP,
    notice: LIVEKIT_CREDENTIAL_NOTICE,
    fields: questions,
  };
  ui.setConnectionFieldsAsk(form);
  try {
    const answer = await untilAborted(ui.waitForConnectionFields(), signal);
    if (signal.aborted) return { kind: "interrupted" };
    if (answer === null || answer === undefined) {
      return {
        kind: "stopped",
        field: questions[0]?.label ?? "LiveKit connection details",
        reason: "missing",
      };
    }
    return valuesFrom(fields, answer.values);
  } finally {
    ui.setConnectionFieldsAsk(null);
  }
}

async function collectOptionalFields(
  ui: WizardUI,
  signal: AbortSignal,
  fields: readonly ScopedField[],
  option: ConnectionOption,
): Promise<Collected> {
  const config: Record<string, string> = {};
  const credentials: Record<string, string> = {};

  for (const { scope, field } of fields) {
    const key = "key" in field ? field.key : field.field;
    let problem: string | null = null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const value = await ask(ui, signal, fieldAsk(scope, field, option, problem));
      if (signal.aborted) return { kind: "interrupted" };
      if (value === null || value.trim() === "") {
        break;
      }
      if (connectionFieldIssue(field, value.trim()) === "invalid-json") {
        if (attempt === 0) {
          problem = `${field.label} must be one JSON object. Correct it and try again.`;
          continue;
        }
        return { kind: "stopped", field: field.label, reason: "invalid-json" };
      }
      (scope === "config" ? config : credentials)[key] = value.trim();
      break;
    }
  }
  return { kind: "values", config, credentials };
}

function stoppedReason(stopped: Extract<Collected, { readonly kind: "stopped" }>): string {
  return stopped.reason === "invalid-json"
    ? `${stopped.field} must be one JSON object. Correct it and run Egma again.`
    : `No value was given for ${stopped.field}, so nothing was created.`;
}

function providerReason(
  result: Exclude<Awaited<ReturnType<typeof connectLiveKit>>, { kind: "registered" }>,
  platformUrl: string,
): string {
  switch (result.kind) {
    case "name-taken":
      return `An Egma agent already uses the name ${result.name}. Rename this voice agent in its source, then run Egma again.`;
    case "not-authenticated":
      return "This machine is not signed in to Egma. Run egma login, then try again.";
    case "refused":
    case "unreachable":
      return result.reason;
    default:
      return `Egma at ${platformUrl} did not accept the LiveKit connection.`;
  }
}

/**
 * Another way of reaching an agent that already exists, in the shape the whole
 * step reads its answers in.
 *
 * `connectLiveKit` builds the connection payload and registers an agent under
 * it. Here the agent is settled, so the same payload is added to it — and the
 * answer is dressed as a registration so the caller has one shape to read
 * rather than two.
 */
async function attachTo(
  existing: {
    readonly id: string;
    readonly name: string;
    readonly projectId: string;
  },
  input: LiveKitRegistration,
  options: RegisterOptions,
): Promise<RegisterResult> {
  const added = await addConnection(existing.id, liveKitConnection(input), options);
  switch (added.kind) {
    case "added":
      return {
        kind: "registered",
        registered: {
          result: "connection_added",
          agent: existing,
          connection: added.connection,
        },
      };
    case "not-found":
      return {
        kind: "refused",
        reason:
          `Egma no longer has the agent ${existing.name} this walk created. ` +
          "Run egma again to start over.",
      };
    case "name-taken":
      return { kind: "name-taken", name: added.name };
    case "not-authenticated":
    case "refused":
    case "unreachable":
      return added;
  }
}

/** Ask from server-owned metadata, then register through the platform API. */
export async function liveKitConnectionSetupStep(
  options: LiveKitConnectionSetupStepOptions,
): Promise<LiveKitConnected> {
  const held = await readCredentials(options.platform.credentialsFile, options.platform.url);
  if (held === null) {
    return ending("This machine is not signed in to Egma. Run egma login, then try again.");
  }

  const registerOptions: RegisterOptions = {
    url: held.url,
    key: held.key,
    signal: options.signal,
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
  };
  const catalog = await readConnectionOptions(registerOptions);
  if (catalog.kind !== "catalog") {
    if (catalog.kind === "not-authenticated") {
      return ending("This machine is not signed in to Egma. Run egma login, then try again.");
    }
    return ending(catalog.reason);
  }

  const offered = connectionOptionsForPlatform(
    catalog.catalog,
    "livekit",
  ).filter(
    (option) =>
      option.simulatorAdapter &&
      (option.accessVariant === LIVEKIT_KEY_PAIR_VARIANT ||
        option.accessVariant === LIVEKIT_TOKEN_ENDPOINT_VARIANT),
  );
  if (offered.length === 0) {
    return ending("This Egma instance did not describe a LiveKit connection setup.");
  }

  const discoveredName = options.suggestedName.trim() || "voice-agent";
  const suggestedName = options.existingAgent?.name ?? discoveredName;
  const dispatchName =
    discoveredValue(options.integratedDispatchName ?? "") ??
    discoveredValue(options.dispatchName);
  if (dispatchName === null) {
    return ending(
      "Egma could not find the LiveKit dispatch name in this repository, so it did not create a connection. Set the worker's agent name in code and run Egma again.",
    );
  }
  const entrypoint = discoveredValue(options.entrypoint);
  if (entrypoint === null) {
    return ending(
      "Egma could not find the LiveKit worker entrypoint in this repository, so it did not create a connection. Make the worker startup path clear and run Egma again.",
    );
  }
  const existing = options.existingAgent ?? null;

  /*
   * The modality first, and only when the catalog offers a choice.
   *
   * This is the question the developer has an opinion about — what testing
   * this agent is like — and the plumbing under it follows from the answer.
   * The choices are the modalities this instance actually offers on this
   * connection type: an instance whose registry cannot conduct a chat
   * simulation must not be asked a question one of whose answers it would then
   * refuse, and a question with one answer is not a question.
   */
  const modalities = [...new Set(offered.map((option) => option.modality))];
  let modality = modalities[0]!;
  if (modalities.length > 1) {
    const said = await ask(options.ui, options.signal, {
      id: askId("modality"),
      label: "How do you want to test this agent?",
      help:
        "Chat types to the agent and reads its words back, so a suite finishes " +
        "in seconds and nothing is spoken. Voice reaches the agent through the " +
        "room's audio, the way a person does. Chat also needs the chat setup in " +
        "the worker, which the worker task already asked for.",
      kind: "choice",
      required: true,
      defaultValue: modality,
      choices: modalities.map((one) => ({
        value: one,
        label: `${one.charAt(0).toUpperCase()}${one.slice(1)}`,
      })),
    });
    if (options.signal.aborted) {
      return { report: stopReport(options.signal, null), connected: null };
    }
    const chosen = modalities.find((one) => one === said);
    if (chosen === undefined) return ending("No LiveKit modality was chosen.");
    modality = chosen;
  }

  /*
   * The pair is the key, not the access variant.
   *
   * Two catalog rows share `livekit_room.project_credentials` and differ only
   * in modality, so matching the variant alone would answer with whichever row
   * the server listed first — a voice connection saved out of a chat walk,
   * with nothing anywhere saying so.
   */
  const forModality = offered.filter((option) => option.modality === modality);
  let variant = forModality[0];
  if (forModality.length > 1) {
    const selected = await ask(options.ui, options.signal, {
      id: askId("variant"),
      label: "How should Egma get LiveKit room tokens?",
      help:
        "Project credentials (API key and secret) are Recommended and let Egma " +
        "run this repository's worker locally. An Advanced customer token endpoint " +
        "keeps the signing secret with you and requires an already-running worker.",
      kind: "choice",
      required: true,
      defaultValue: forModality[0]!.accessVariant,
      choices: forModality.map((one) => ({
        value: one.accessVariant,
        label: one.accessVariantLabel,
      })),
    });
    if (options.signal.aborted) {
      return { report: stopReport(options.signal, null), connected: null };
    }
    variant = forModality.find((entry) => entry.accessVariant === selected);
  }
  if (variant === undefined) return ending("No LiveKit connection method was chosen.");
  if (
    modality === "chat" &&
    variant.accessVariant === LIVEKIT_TOKEN_ENDPOINT_VARIANT
  ) {
    return ending(
      "A token-endpoint LiveKit connection speaks voice, so Egma did not create a " +
        "chat connection. Egma asks your endpoint for a token and never dispatches " +
        "the worker itself, so it has no way to tell the agent to answer in text. " +
        "Connect with LiveKit project credentials to test this agent over chat.",
    );
  }
  if (variant.accessVariant === LIVEKIT_KEY_PAIR_VARIANT) {
    const issue = localLiveKitWorkerFileIssue(
      entrypoint,
      options.dependencyManifest,
    );
    if (issue !== null) {
      return ending(`${issue} Egma did not create a connection or write tests.`);
    }
  }

  const ordered = wizardFields(variant);
  const required = await collectRequiredFields(
    options.ui,
    options.signal,
    ordered.filter(({ field }) => field.required),
    variant,
  );
  if (required.kind === "interrupted") {
    return { report: stopReport(options.signal, null), connected: null };
  }
  if (required.kind === "stopped") {
    return ending(stoppedReason(required));
  }
  const optional = await collectOptionalFields(
    options.ui,
    options.signal,
    ordered.filter(({ field }) => !field.required),
    variant,
  );
  if (optional.kind === "interrupted") {
    return { report: stopReport(options.signal, null), connected: null };
  }
  if (optional.kind === "stopped") {
    return ending(stoppedReason(optional));
  }

  const config = { ...required.config, ...optional.config };
  const credentials = { ...required.credentials, ...optional.credentials };

  const common = { name: suggestedName, url: config["url"] ?? "" };
  let input: LiveKitRegistration;
  let localWorker: NonNullable<LiveKitConnected["connected"]>["localWorker"];
  if (variant.accessVariant === LIVEKIT_KEY_PAIR_VARIANT) {
    const heldCredentials = liveKitKeyPair(
      credentials["apiKey"] ?? "",
      credentials["apiSecret"] ?? "",
    );
    input = {
      ...common,
      variant: LIVEKIT_KEY_PAIR_VARIANT,
      agentName: dispatchName,
      modality,
      credentials: heldCredentials,
    };
    localWorker = {
      url: common.url,
      credentials: heldCredentials,
      dispatchName,
      entrypoint,
      dependencyManifest: options.dependencyManifest,
    };
  } else {
    input = {
      ...common,
      variant: LIVEKIT_TOKEN_ENDPOINT_VARIANT,
      tokenEndpoint: config["tokenEndpoint"] ?? "",
      // Written as the word rather than passed through: chat on this variant
      // was refused above, and the type says so here.
      modality: "voice",
      credentials: liveKitTokenHeaders(credentials["headers"] ?? ""),
    };
    localWorker = null;
  }

  try {
    await bindRepositoryPlatform(options.cwd, {
      origin: options.platform.url,
    });
  } catch (cause) {
    return ending(cause instanceof Error ? cause.message : String(cause));
  }
  options.ui.pushStatus(
    `${ACTION_MARK} Bound this repository to Egma platform ${options.platform.url}.`,
  );

  /*
   * An agent that already exists gains a connection; one that does not is
   * written with its first connection in the same request. Discovery owns both
   * names, so a refusal is shown as-is and never turns into another name prompt.
   */
  const result =
    existing === null
      ? await connectLiveKit(input, registerOptions)
      : await attachTo(existing, input, registerOptions);
  if (result.kind === "registered") {
    options.ui.pushStatus(`${ACTION_MARK} LiveKit agent ${result.registered.agent.name}`);
    options.ui.pushStatus(`${DETAIL_MARK} Dispatch name ${dispatchName}.`);
    options.ui.pushStatus(
      `${DETAIL_MARK} Reachable over ${result.registered.connection.name} (LiveKit ${result.registered.connection.modality}).`,
    );
    // One worker is one agent, so the second modality on a server and name
    // Egma already holds is a connection added rather than a new agent. Saying
    // so is what keeps that line from reading like a fresh registration.
    const already = registrationLine(result.registered);
    if (already !== null) options.ui.pushStatus(`${DETAIL_MARK} ${already}`);
    return {
      report: {
        kind: "connected",
        agentName: result.registered.agent.name,
        connectionName: result.registered.connection.name,
      },
      connected: {
        registered: result.registered,
        source: { prompt: null, toolCount: null },
        localWorker,
      },
    };
  }

  return ending(providerReason(result, held.url));
}
