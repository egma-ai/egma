"use client";

import { Input } from "@/components/ui/input";
import { Field } from "../../../../../../ui/form.tsx";
import type { ConnectionOption } from "../../../../../../lib/connection-options.ts";

type LiveKitConfig = Readonly<Record<string, string>>;

export type LiveKitAgentNameForm = {
  /** Whether this connection is one whose config holds a worker name at all. */
  readonly enabled: boolean;
  readonly agentName: string;
  /** The registry's help line for the name, or empty when it has none. */
  readonly agentNameHelp: string;
  /** Whether the edit can be saved: a LiveKit room needs the name. */
  readonly ready: boolean;
  /** The option with the name taken out, because it is drawn on its own. */
  readonly option: ConnectionOption | undefined;
};

/**
 * Show the LiveKit worker name separately because simulations dispatch that
 * named worker. An incorrect name can leave the room without the agent under test.
 */
export function liveKitAgentNameForm({
  connectionType,
  option,
  config,
}: {
  readonly connectionType: string | undefined;
  readonly option: ConnectionOption | undefined;
  readonly config: LiveKitConfig;
}): LiveKitAgentNameForm {
  const enabled =
    connectionType === "livekit_room" &&
    option?.fields.some((field) => field.key === "agentName") === true;
  const agentName = config.agentName ?? "";

  return {
    enabled,
    agentName,
    agentNameHelp: enabled
      ? (option?.fields.find((field) => field.key === "agentName")?.help ?? "")
      : "",
    ready: !enabled || agentName.trim().length > 0,
    option:
      enabled && option !== undefined
        ? {
            ...option,
            fields: option.fields.filter((field) => field.key !== "agentName"),
          }
        : option,
  };
}

/** The one LiveKit field an edit owns. */
export function LiveKitAgentName({
  agentName,
  help,
  onAgentNameChange,
}: {
  readonly agentName: string;
  /** The registry's one help line for the name; empty draws none. */
  readonly help: string;
  readonly onAgentNameChange: (name: string) => void;
}) {
  return (
    <Field
      label="LiveKit agent name*"
      htmlFor="livekit-agent-name"
      {...(help === "" ? {} : { hint: help })}
    >
      <Input
        id="livekit-agent-name"
        aria-required="true"
        value={agentName}
        required
        placeholder="The deployed agent's exact name"
        autoComplete="off"
        spellCheck={false}
        onChange={(event) => onAgentNameChange(event.target.value)}
      />
    </Field>
  );
}
