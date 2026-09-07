import type { IngestionStore } from "./object-store.ts";
export type IngestionSettings = {
  readonly role: "all" | "ingest" | "drain";
  readonly store: IngestionStore | undefined;
  readonly logDirectory: string;
  readonly logMaxBytes: number;
  readonly logMaxRecords: number;
  readonly flushMilliseconds: number;
  readonly segmentMaxBytes: number;
  readonly segmentMaxRecords: number;
  readonly requestTimeoutMilliseconds: number;
  readonly scanIntervalMilliseconds: number;
};
export type IngestionLogger = {
  error(fields: unknown, message: string): void;
  warn(fields: unknown, message: string): void;
};
