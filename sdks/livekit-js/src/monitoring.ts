import { type JobContext } from "@livekit/agents";

import { installExport, type ExportOptions } from "./export.ts";
import { SIMULATION_ROOM_PREFIX } from "./room.ts";

export const MONITOR_VERB = "egma.monitor";

export type MonitorOptions = ExportOptions;

/**
 * Export production spans to Egma. Call first in the job entrypoint, before
 * AgentSession.start. Repeated calls reuse the exporter; each job gets a final flush.
 *
 * Throws Error for invalid settings, unsupported LiveKit telemetry APIs, an unsafe
 * tracer provider, or different settings in a second job. Export failures do not
 * stop the agent. In simulation rooms, simulation() handles export instead.
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
