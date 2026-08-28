"use client";

import { Input } from "@/components/ui/input";
import { Field } from "../../../../../../ui/form.tsx";
import type { ConnectionOption } from "../../../../../../lib/connection-options.ts";

type LiveKitConfig = Readonly<Record<string, string>>;

export type LiveKitAgentNameForm = {
  /** Whether this connection is one whose config holds a worker name at all. */
  readonly enabled: boolean;
  readonly agentName: string;
  /** Whether the edit can be saved: a LiveKit room needs the name. */
  readonly ready: boolean;
  /** The option with the name taken out, because it is drawn on its own. */
  readonly option: ConnectionOption | undefined;
};

/**
 * The LiveKit part of an existing connection's form: the worker's name, and
 * whether it is there.
 *
 * There is nothing else left to decide here. Egma dispatches the named worker
 * for every simulation, because the dispatch metadata is the only channel that
 * carries the modality and the mock-tool address — so a connection without a
 * name reached the agent with neither, and the name is not a preference.
 *
 * The field is lifted out of the generic field list and drawn on its own so
 * the panel can say what a wrong name costs, which is that the agent never
 * joins the room.
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
  onAgentNameChange,
}: {
  readonly agentName: string;
  readonly onAgentNameChange: (name: string) => void;
}) {
  return (
    <Field
      label="LiveKit agent name*"
      htmlFor="livekit-agent-name"
      hint="Enter the exact agent name registered by the deployed LiveKit worker. A different name prevents the agent from joining the room."
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
