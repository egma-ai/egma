/**
 * LiveKit connection setup for the wizard, drawn from the platform catalog.
 *
 * A connection is how Egma's simulator reaches the agent — on LiveKit that is
 * the customer's server URL and their key pair or token endpoint. The Egma SDK
 * inside the customer's own worker is a separate thing, wired by the mock
 * authoring step after the tests are written.
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
import {
  addConnection,
  type Registered,
  type RegisterOptions,
  type RegisterResult,
} from "../platform/agents.ts";
import {
  connectionOptionsForPlatform,
  readConnectionOptions,
  type ConnectionField,
  type ConnectionOption,
  type CredentialField,
} from "../platform/connection-options.ts";
import { readCredentials } from "../platform/credentials.ts";
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
  /** A name reported by discovery. The developer still confirms it. */
  readonly suggestedName: string;
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
  } | null;
};

const SECRET_CUSTODY =
  "This value goes straight to Egma, which stores it sealed. It is not sent to the coding agent or written to this repository.";

const LIVEKIT_FIELDS_HELP =
  "Egma uses these values to connect each simulation to a LiveKit room.";

const LIVEKIT_CREDENTIAL_NOTICE =
  "Credentials go straight to Egma, which stores them sealed. " +
  "They are not sent to the coding agent or written to this repository.";

function ending(reason: string): LiveKitConnected {
  return { report: { kind: "failed", reason }, connected: null };
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
      return `An Egma agent already uses the name ${result.name}. Choose another name.`;
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

  const variants = connectionOptionsForPlatform(
    catalog.catalog,
    "livekit",
  ).filter(
    (option) =>
      option.simulatorAdapter &&
      (option.accessVariant === LIVEKIT_KEY_PAIR_VARIANT ||
        option.accessVariant === LIVEKIT_TOKEN_ENDPOINT_VARIANT),
  );
  if (variants.length === 0) {
    return ending("This Egma instance did not describe a LiveKit connection setup.");
  }

  let problem: string | null = null;
  let suggestedName = options.suggestedName.trim() || "voice-agent";
  let bound = false;
  const existing = options.existingAgent ?? null;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (existing === null) {
      const name = await ask(options.ui, options.signal, {
        id: askId("agent-name"),
        label: "Agent name on Egma",
        help: "The name people will see for this voice agent in Egma.",
        kind: "text",
        required: true,
        defaultValue: suggestedName,
        problem,
      });
      if (options.signal.aborted) {
        return { report: stopReport(options.signal, null), connected: null };
      }
      if (name === null || name.trim() === "") return ending("No agent name was given.");
      suggestedName = name.trim();
    } else {
      suggestedName = existing.name;
    }

    const selected = await ask(options.ui, options.signal, {
      id: askId("variant"),
      label: "How should Egma get LiveKit room tokens?",
      help:
        "Project credentials (API key and secret) are Recommended and are the " +
        "quickest setup. An Advanced customer token endpoint keeps the signing " +
        "secret with you; Egma calls it for each simulation.",
      kind: "choice",
      required: true,
      defaultValue: variants[0]!.accessVariant,
      choices: variants.map((variant) => ({
        value: variant.accessVariant,
        label: variant.accessVariantLabel,
      })),
    });
    if (options.signal.aborted) {
      return { report: stopReport(options.signal, null), connected: null };
    }
    const variant = variants.find((entry) => entry.accessVariant === selected);
    if (variant === undefined) return ending("No LiveKit connection method was chosen.");

    const ordered = orderedFields(variant);
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
    if (variant.accessVariant === LIVEKIT_KEY_PAIR_VARIANT) {
      input = {
        ...common,
        variant: LIVEKIT_KEY_PAIR_VARIANT,
        ...(config["agentName"] === undefined
          ? {}
          : { agentName: config["agentName"] }),
        ...(config["metadata"] === undefined
          ? {}
          : { metadata: config["metadata"] }),
        credentials: liveKitKeyPair(
          credentials["apiKey"] ?? "",
          credentials["apiSecret"] ?? "",
        ),
      };
    } else {
      input = {
        ...common,
        variant: LIVEKIT_TOKEN_ENDPOINT_VARIANT,
        tokenEndpoint: config["tokenEndpoint"] ?? "",
        credentials: liveKitTokenHeaders(credentials["headers"] ?? ""),
      };
    }

    if (!bound) {
      try {
        await bindRepositoryPlatform(options.cwd, {
          origin: options.platform.url,
        });
        bound = true;
      } catch (cause) {
        return ending(cause instanceof Error ? cause.message : String(cause));
      }
      options.ui.pushStatus(
        `${ACTION_MARK} Bound this repository to Egma platform ${options.platform.url}.`,
      );
    }

    /*
     * An agent that already exists gains a connection; one that does not is
     * written with its first connection in the same request. Registering under
     * a name a living agent already holds would be refused, and answering that
     * refusal by trying the next name would put a second row in the roster for
     * one voice agent — which is the one thing threading the name exists to
     * prevent.
     */
    const result =
      existing === null
        ? await connectLiveKit(input, registerOptions)
        : await attachTo(existing, input, registerOptions);
    if (result.kind === "registered") {
      options.ui.pushStatus(`${ACTION_MARK} LiveKit agent ${result.registered.agent.name}`);
      options.ui.pushStatus(
        `${DETAIL_MARK} Reachable over ${result.registered.connection.name} (LiveKit voice).`,
      );
      return {
        report: {
          kind: "connected",
          agentName: result.registered.agent.name,
          connectionName: result.registered.connection.name,
        },
        connected: {
          registered: result.registered,
          source: { prompt: null, toolCount: null },
        },
      };
    }

    problem = providerReason(result, held.url);
    if (
      attempt === 0 &&
      (result.kind === "name-taken" || result.kind === "refused")
    ) {
      options.ui.pushStatus(problem);
      continue;
    }
    return ending(problem);
  }

  return ending("Egma could not connect this LiveKit agent.");
}
