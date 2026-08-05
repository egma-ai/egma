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
  spans: 133,
  humanTurns: 5,
  agentTurns: 8,
  toolSpans: 2,
  erroredSpans: 3,
} as const;

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
