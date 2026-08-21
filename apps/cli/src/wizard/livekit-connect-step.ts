/** LiveKit connection setup for the wizard, drawn from the platform catalog. */

import { bindRepositoryPlatform } from "../folder/egma-folder.ts";
import {
  connectLiveKit,
  LIVEKIT_KEY_PAIR_VARIANT,
  LIVEKIT_TOKEN_ENDPOINT_VARIANT,
  liveKitKeyPair,
  liveKitTokenHeaders,
  type LiveKitRegistration,
} from "../livekit/connect.ts";
import type { Registered, RegisterOptions } from "../platform/agents.ts";
import {
  connectionOptionsForPlatform,
  readConnectionOptions,
  type ConnectionField,
  type ConnectionOption,
  type CredentialField,
} from "../platform/connection-options.ts";
import { readCredentials } from "../platform/credentials.ts";
import type { ConnectionAsk, ConnectionAskId, WizardUI } from "../ui/wizard-ui.ts";
import type { ExitReport } from "./exit-line.ts";
import type { PlatformAccess } from "./login-step.ts";
import { ACTION_MARK, DETAIL_MARK } from "./status.ts";
import { stopReport, untilAborted } from "./stop.ts";

export type LiveKitConnectStepOptions = {
  readonly ui: WizardUI;
  readonly platform: PlatformAccess;
  readonly cwd: string;
  readonly signal: AbortSignal;
  /** A name reported by discovery. The developer still confirms it. */
  readonly suggestedName: string;
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

function isJsonObject(text: string): boolean {
  try {
    const value = JSON.parse(text) as unknown;
    return typeof value === "object" && value !== null && !Array.isArray(value);
  } catch {
    return false;
  }
}

type Collected =
  | { readonly kind: "values"; readonly values: Readonly<Record<string, string>> }
  | { readonly kind: "stopped"; readonly field: string }
  | { readonly kind: "interrupted" };

async function collectFields(
  ui: WizardUI,
  signal: AbortSignal,
  scope: "config" | "credentials",
  fields: readonly (ConnectionField | CredentialField)[],
  option: ConnectionOption,
): Promise<Collected> {
  const values: Record<string, string> = {};

  for (const field of fields) {
    const key = "key" in field ? field.key : field.field;
    let problem: string | null = null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const value = await ask(ui, signal, fieldAsk(scope, field, option, problem));
      if (signal.aborted) return { kind: "interrupted" };
      if (value === null || value.trim() === "") {
        if (field.required) return { kind: "stopped", field: field.label };
        break;
      }
      if (field.kind === "json" && !isJsonObject(value)) {
        if (attempt === 0) {
          problem = `${field.label} must be one JSON object. Correct it and try again.`;
          continue;
        }
        return { kind: "stopped", field: field.label };
      }
      values[key] = value.trim();
      break;
    }
  }
  return { kind: "values", values };
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

/** Ask from server-owned metadata, then register through the platform API. */
export async function connectLiveKitStep(
  options: LiveKitConnectStepOptions,
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
    "livekit_agents",
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

  for (let attempt = 0; attempt < 2; attempt += 1) {
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

    const config = await collectFields(
      options.ui,
      options.signal,
      "config",
      variant.fields,
      variant,
    );
    if (config.kind === "interrupted") {
      return { report: stopReport(options.signal, null), connected: null };
    }
    if (config.kind === "stopped") {
      return ending(`No value was given for ${config.field}, so nothing was created.`);
    }
    const credentials = await collectFields(
      options.ui,
      options.signal,
      "credentials",
      variant.credentialFields,
      variant,
    );
    if (credentials.kind === "interrupted") {
      return { report: stopReport(options.signal, null), connected: null };
    }
    if (credentials.kind === "stopped") {
      return ending(`No value was given for ${credentials.field}, so nothing was created.`);
    }

    const common = { name: suggestedName, url: config.values["url"] ?? "" };
    let input: LiveKitRegistration;
    if (variant.accessVariant === LIVEKIT_KEY_PAIR_VARIANT) {
      input = {
        ...common,
        variant: LIVEKIT_KEY_PAIR_VARIANT,
        ...(config.values["agentName"] === undefined
          ? {}
          : { agentName: config.values["agentName"] }),
        ...(config.values["metadata"] === undefined
          ? {}
          : { metadata: config.values["metadata"] }),
        credentials: liveKitKeyPair(
          credentials.values["apiKey"] ?? "",
          credentials.values["apiSecret"] ?? "",
        ),
      };
    } else {
      input = {
        ...common,
        variant: LIVEKIT_TOKEN_ENDPOINT_VARIANT,
        tokenEndpoint: config.values["tokenEndpoint"] ?? "",
        credentials: liveKitTokenHeaders(credentials.values["headers"] ?? ""),
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

    const result = await connectLiveKit(input, registerOptions);
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
