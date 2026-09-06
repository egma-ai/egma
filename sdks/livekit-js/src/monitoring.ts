import { type JobContext } from "@livekit/agents";

import { installExport, type ExportOptions } from "./export.ts";
import { SIMULATION_ROOM_PREFIX } from "./room.ts";

export const MONITOR_VERB = "egma.monitor";

export type MonitorOptions = ExportOptions;

/**
 * Send this LiveKit worker's production spans to Egma.
 *
 * Call this as the first statement of the job entrypoint, before
 * `AgentSession.start`. Repeated calls for the same job reuse one process-wide
 * exporter. Each job gets one final flush callback.
 *
 * In a simulation room this returns having done nothing: `simulation()`
 * exports that conversation instead, and files it under the simulation it
 * belongs to rather than as a second production call.
 */
export function monitor(ctx: JobContext, options: MonitorOptions = {}): void {
  const roomName = ctx?.job?.room?.name;
  if (
    typeof roomName === "string" &&
    roomName.startsWith(SIMULATION_ROOM_PREFIX)
  ) {
    // Said out loud, because a room name is chosen by whoever mints the join
    // token: a production room named to look like a simulation would lose its
    // Monitoring record, and a dropped trace is evidence a customer cannot get
    // back.
    console.warn(
      `Egma: ${JSON.stringify(roomName)} is an Egma simulation room, so its spans are not exported to production Monitoring. egma.simulation exports them under that simulation instead.`,
    );
    return;
  }

  installExport(ctx, options, MONITOR_VERB, "");
}

export {
  projectKey,
  traceEndpoint,
  type ExistingTelemetry,
} from "./export.ts";
