import { readFile } from "node:fs/promises";
import path from "node:path";

/**
 * The captured LiveKit trace, as the fourteen requests an exporter actually
 * sent.
 *
 * Bodies are read as bytes and posted unchanged, because the whole worth of a
 * capture is that it is evidence: re-encoding one would turn a test about real
 * telemetry into a test about what egma believes real telemetry looks like.
 */

export const FIXTURE_DIRECTORY = path.join(
  import.meta.dirname,
  "../../../../fixtures/livekit-otlp-trace",
);

/** The absolute window the capture's own timestamps fall inside. */
export const FIXTURE_WINDOW = {
  from: "2026-08-02 18:04:40",
  to: "2026-08-02 18:05:54",
} as const;

/** The room the capture was made in, on every span as `session.id`. */
export const FIXTURE_PROVIDER_CALL_ID = "egma-fixture-capture-1";

export const FIXTURE_TRACE = {
  started_at: "2026-08-02T18:04:40.281989Z",
  spans: 133,
  humanTurns: 5,
  agentTurns: 8,
  toolSpans: 2,
  erroredSpans: 3,
} as const;

/**
 * The other capture: a LiveKit agent taking a booking, with three tool calls.
 *
 * The run this one came from is what opened the agent-POV effort — two of its
 * three tool calls were missing from Egma's own record of it, because an
 * unmocked call ran unobserved. It is here so that the fix keeps being proved
 * against the conversation that found the hole rather than against one written
 * to fit it.
 *
 * One OTLP/JSON body rather than fourteen protobuf ones, which is the encoding
 * it arrived in. `fixtures/livekit-appointment-trace/README.md` has the rest.
 */
export const APPOINTMENT_FIXTURE_FILE = path.join(
  import.meta.dirname,
  "../../../../fixtures/livekit-appointment-trace/export.json",
);

/** The room the booking happened in, on the resource as `room_id`. */
export const APPOINTMENT_ROOM = "RM_7gxYsTDmP9ZY";

export const APPOINTMENT_TRACE = {
  /** The id every one of its spans arrived filed under. */
  wireTraceId: "4126ef5a2cfb0c71da235771e1be4ec4",
  spans: 104,
  humanTurns: 5,
  agentTurns: 11,
  toolSpans: 3,
  /** The three calls, in the order the conversation made them. */
  tools: ["list_providers", "check_availability", "book_appointment"],
} as const;

/** A window containing the booking, as the read endpoints take one. */
export const APPOINTMENT_WINDOW = {
  from: "2026-09-04 17:52:00",
  to: "2026-09-04 17:55:00",
} as const;

/** The captured booking, as the one request body an exporter would send. */
export async function appointmentExport(): Promise<string> {
  return readFile(APPOINTMENT_FIXTURE_FILE, "utf8");
}

type ManifestEntry = {
  readonly file: string;
  readonly path: string;
  readonly headers: Record<string, string>;
};

export type CapturedRequest = {
  readonly file: string;
  readonly path: string;
  readonly contentType: string;
  readonly body: Buffer;
};

/** Every captured request, in the order the exporter sent them. */
export async function capturedRequests(): Promise<CapturedRequest[]> {
  const manifest = JSON.parse(
    await readFile(path.join(FIXTURE_DIRECTORY, "manifest.json"), "utf8"),
  ) as { requests: ManifestEntry[] };

  return Promise.all(
    manifest.requests.map(async (entry) => ({
      file: entry.file,
      path: entry.path,
      contentType: entry.headers["Content-Type"] ?? "application/x-protobuf",
      body: await readFile(path.join(FIXTURE_DIRECTORY, entry.file)),
    })),
  );
}
