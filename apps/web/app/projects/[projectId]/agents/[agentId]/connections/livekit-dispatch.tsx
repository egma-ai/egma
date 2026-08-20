"use client";

import { Select, TextInput } from "../../../../../../ui/controls.tsx";
import { Field } from "../../../../../../ui/form.tsx";
import type { ConnectionVariant } from "../../../../../../lib/connection-types.ts";

export type LiveKitDispatch = "named" | "automatic";

type LiveKitConfig = Readonly<Record<string, string>>;

export type LiveKitDispatchForm = {
  readonly enabled: boolean;
  readonly mode: LiveKitDispatch;
  readonly agentName: string;
  readonly ready: boolean;
  readonly variant: ConnectionVariant | undefined;
};

/** A new LiveKit connection uses the safest, deterministic dispatch contract. */
export function newLiveKitDispatch(): LiveKitDispatch {
  return "named";
}

/** Recover the dispatch contract represented by a saved connection. */
export function savedLiveKitDispatch(
  config: LiveKitConfig,
): LiveKitDispatch {
  return (config.agentName?.trim() ?? "") === "" ? "automatic" : "named";
}

/**
 * Describe the LiveKit-specific part of a connection form.
 *
 * Both create and edit use this model so field extraction and readiness cannot
 * drift apart. The returned variant omits `agentName`, which this module owns.
 */
export function liveKitDispatchForm({
  type,
  variant,
  config,
  mode,
}: {
  readonly type: string | undefined;
  readonly variant: ConnectionVariant | undefined;
  readonly config: LiveKitConfig;
  readonly mode: LiveKitDispatch;
}): LiveKitDispatchForm {
  const enabled =
    type === "livekit" &&
    variant?.fields.some((field) => field.key === "agentName") === true;
  const agentName = config.agentName ?? "";

  return {
    enabled,
    mode,
    agentName,
    ready: !enabled || mode === "automatic" || agentName.trim().length > 0,
    variant:
      enabled && variant !== undefined
        ? {
            ...variant,
            fields: variant.fields.filter((field) => field.key !== "agentName"),
          }
        : variant,
  };
}

/** Apply a dispatch transition to the stored config representation. */
export function configForLiveKitDispatch(
  config: LiveKitConfig,
  mode: LiveKitDispatch,
): LiveKitConfig {
  if (mode === "named") {
    return config;
  }

  const next = { ...config };
  delete next.agentName;
  return next;
}

/** The two valid LiveKit dispatch contracts, shown the same way on create and edit. */
export function LiveKitDispatchSetup({
  mode,
  agentName,
  onModeChange,
  onAgentNameChange,
}: {
  readonly mode: LiveKitDispatch;
  readonly agentName: string;
  readonly onModeChange: (mode: LiveKitDispatch) => void;
  readonly onAgentNameChange: (name: string) => void;
}) {
  return (
    <>
      <Field
        label="Dispatch method"
        htmlFor="livekit-dispatch"
        hint={
          mode === "named"
            ? "Egma asks LiveKit for one deployed agent by name."
            : "LiveKit sends the room to any available agent that accepts automatic dispatch. Egma stores no agent name."
        }
      >
        <Select<LiveKitDispatch>
          id="livekit-dispatch"
          value={mode}
          options={[
            { value: "named", label: "Named agent — Recommended" },
            { value: "automatic", label: "Automatic dispatch" },
          ]}
          onChange={onModeChange}
        />
      </Field>
      {mode === "named" ? (
        <Field
          label="LiveKit agent name"
          htmlFor="livekit-agent-name"
          hint="Enter the exact agent name registered by the deployed LiveKit worker. A different name prevents the agent from joining the room."
        >
          <TextInput
            id="livekit-agent-name"
            value={agentName}
            required
            placeholder="The deployed agent's exact name"
            onChange={onAgentNameChange}
          />
        </Field>
      ) : null}
    </>
  );
}
