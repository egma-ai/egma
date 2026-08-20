"use client";

import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Field } from "../../../../../../ui/form.tsx";
import type { ConnectionOption } from "../../../../../../lib/connection-options.ts";

export type LiveKitDispatch = "named" | "automatic";

type LiveKitConfig = Readonly<Record<string, string>>;

export type LiveKitDispatchForm = {
  readonly enabled: boolean;
  readonly mode: LiveKitDispatch;
  readonly agentName: string;
  readonly ready: boolean;
  readonly option: ConnectionOption | undefined;
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
 * drift apart. The returned option omits `agentName`, which this module owns.
 */
export function liveKitDispatchForm({
  connectionKind,
  option,
  config,
  mode,
}: {
  readonly connectionKind: string | undefined;
  readonly option: ConnectionOption | undefined;
  readonly config: LiveKitConfig;
  readonly mode: LiveKitDispatch;
}): LiveKitDispatchForm {
  const enabled =
    connectionKind === "livekit_room" &&
    option?.fields.some((field) => field.key === "agentName") === true;
  const agentName = config.agentName ?? "";

  return {
    enabled,
    mode,
    agentName,
    ready: !enabled || mode === "automatic" || agentName.trim().length > 0,
    option:
      enabled && option !== undefined
        ? {
            ...option,
            fields: option.fields.filter((field) => field.key !== "agentName"),
          }
        : option,
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
        <Select
          id="livekit-dispatch"
          value={mode}
          onChange={(event) =>
            onModeChange(event.target.value as LiveKitDispatch)
          }
        >
          <option value="named">Named agent — Recommended</option>
          <option value="automatic">Automatic dispatch</option>
        </Select>
      </Field>
      {mode === "named" ? (
        <Field
          label="LiveKit agent name"
          htmlFor="livekit-agent-name"
          hint="Enter the exact agent name registered by the deployed LiveKit worker. A different name prevents the agent from joining the room."
        >
          <Input
            id="livekit-agent-name"
            value={agentName}
            required
            placeholder="The deployed agent's exact name"
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => onAgentNameChange(event.target.value)}
          />
        </Field>
      ) : null}
    </>
  );
}
