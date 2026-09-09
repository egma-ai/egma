import { randomUUID } from "node:crypto";
import type { DaytonaVoiceFleetSettings, VoiceFleet, VoiceFleetLog, VoiceFleetTask } from "./voice-fleet.ts";
import {
  awsRecordingRole,
  issueVoiceSandboxCredentials,
  type AssumeRecordingRole,
} from "./voice-fleet-credentials.ts";

type DaytonaSandbox = {
  readonly id: string;
  readonly state?: string;
  readonly errorReason?: string;
  readonly process: {
    getEntrypointSession(): Promise<{ commands?: readonly { exitCode?: number }[] }>;
  };
};

export type DaytonaClient = {
  create(params: {
    readonly name: string;
    readonly snapshot: string;
    readonly envVars: Record<string, string>;
    readonly labels: Record<string, string>;
    readonly ttlMinutes: number;
    readonly autoStopInterval: number;
    readonly autoPauseInterval: number;
    readonly secrets: Record<string, string>;
  }, options: { readonly timeout: number }): Promise<DaytonaSandbox>;
  list(query: { readonly labels: Record<string, string> }): AsyncIterable<DaytonaSandbox>;
  get(sandboxId: string): Promise<DaytonaSandbox>;
  delete(sandbox: DaytonaSandbox, timeout?: number, wait?: boolean): Promise<void>;
};

const FLEET_LABELS = { "egma.runtime": "voice-simulator" };
const TERMINAL_STATES = new Set([
  "stopped",
  "paused",
  "archived",
  "error",
  "build_failed",
  "destroying",
  "destroyed",
]);

export function daytonaVoiceFleet(
  settings: DaytonaVoiceFleetSettings,
  options: {
    readonly client: DaytonaClient;
    readonly log: VoiceFleetLog;
    readonly assumeRole?: AssumeRecordingRole;
    readonly onFreed?: () => void;
    readonly id?: () => string;
    readonly pollMilliseconds?: number;
  },
): VoiceFleet {
  const watching = new Set<string>();
  const assumeRole = options.assumeRole ?? awsRecordingRole();
  const id = options.id ?? randomUUID;
  const pollMilliseconds = options.pollMilliseconds ?? 1_000;

  const completion = async (sandboxId: string): Promise<{ sandbox: DaytonaSandbox; exitCode?: number } | undefined> => {
    const sandbox = await options.client.get(sandboxId);
    if (TERMINAL_STATES.has(sandbox.state ?? "")) return { sandbox };
    const session = await sandbox.process.getEntrypointSession();
    const exitCode = session.commands?.find((command) => command.exitCode !== undefined)?.exitCode;
    return exitCode === undefined ? undefined : { sandbox, exitCode };
  };

  const watch = (sandbox: DaytonaSandbox): void => {
    if (watching.has(sandbox.id)) return;
    watching.add(sandbox.id);
    void (async () => {
      try {
        let result = await completion(sandbox.id);
        while (result === undefined) {
          await new Promise<void>((resolve) => setTimeout(resolve, pollMilliseconds));
          result = await completion(sandbox.id);
        }
        options.log.info(
          { sandboxId: sandbox.id, state: result.sandbox.state, exitCode: result.exitCode },
          "Daytona voice simulator process ended",
        );
        await options.client.delete(result.sandbox, 60, true);
      } catch (err) {
        options.log.error(
          { err, sandboxId: sandbox.id, state: sandbox.state, errorReason: sandbox.errorReason },
          "Daytona voice simulator lifecycle could not be reconciled",
        );
      } finally {
        watching.delete(sandbox.id);
        options.onFreed?.();
      }
    })();
  };

  const launchOne = async (): Promise<VoiceFleetTask> => {
    const runtimeId = id();
    const name = `egma-voice-${runtimeId}`.slice(0, 63);
    const roomName = `egma-sim-${runtimeId}`;
    const credentials = await issueVoiceSandboxCredentials({
      settings,
      runtimeId,
      roomName,
      assumeRole,
    });
    const sandbox = await options.client.create({
      name,
      snapshot: settings.snapshot,
      ttlMinutes: settings.ttlMinutes,
      autoStopInterval: 0,
      autoPauseInterval: 0,
      labels: {
        ...FLEET_LABELS,
        "egma.release_sha": settings.releaseSha,
        "egma.snapshot_id": settings.snapshot,
        "egma.runtime_id": runtimeId,
      },
      envVars: {
        EGMA_RELEASE_SHA: settings.releaseSha,
        EGMA_SIMULATOR_RUNTIME: "daytona",
        EGMA_SIMULATOR_MODE: "one-shot",
        EGMA_SIMULATOR_MODALITIES: "voice",
        EGMA_SIMULATOR_CAPACITY: "1",
        EGMA_SIMULATOR_CLAIMANT: name,
        EGMA_SIMULATOR_CONTROL_PLANE_URL: settings.controlPlaneUrl,
        EGMA_SIMULATOR_MEDIA_BACKEND: "livekit",
        EGMA_SIMULATOR_VAD_PROVIDER: "silero",
        EGMA_SIMULATOR_LIVEKIT_URL: settings.livekitUrl,
        EGMA_SIMULATOR_LIVEKIT_ROOM_NAME: credentials.roomName,
        EGMA_SIMULATOR_LIVEKIT_ROOM_TOKEN: credentials.roomToken,
        EGMA_SIMULATOR_LIVEKIT_API_TOKEN: credentials.apiToken,
        EGMA_SIMULATOR_S3_ENDPOINT: settings.s3Endpoint,
        EGMA_SIMULATOR_S3_BUCKET: settings.s3Bucket,
        EGMA_SIMULATOR_S3_REGION: settings.s3Region,
        EGMA_SIMULATOR_S3_ACCESS_KEY_ID: credentials.s3AccessKeyId,
        EGMA_SIMULATOR_S3_SECRET_ACCESS_KEY: credentials.s3SecretAccessKey,
        EGMA_SIMULATOR_S3_SESSION_TOKEN: credentials.s3SessionToken,
      },
      secrets: {
        EGMA_SIMULATOR_SERVICE_TOKEN: settings.serviceTokenSecret,
        ...settings.providerSecrets,
      },
    }, { timeout: 120 });
    watch(sandbox);
    return { id: sandbox.id };
  };

  return {
    async listTasks() {
      const tasks = new Map<string, VoiceFleetTask>();
      for await (const sandbox of options.client.list({ labels: FLEET_LABELS })) {
        watch(sandbox);
        if (!TERMINAL_STATES.has(sandbox.state ?? "")) tasks.set(sandbox.id, { id: sandbox.id });
      }
      // A just-created sandbox can precede Daytona's list index. The watcher
      // owns it until completion, so a second reconcile cannot duplicate it.
      for (const sandboxId of watching) tasks.set(sandboxId, { id: sandboxId });
      return [...tasks.values()];
    },
    async launchTasks({ count }) {
      const settled = await Promise.allSettled(Array.from({ length: count }, () => launchOne()));
      return {
        tasks: settled.flatMap((result) => result.status === "fulfilled" ? [result.value] : []),
        failures: settled.flatMap((result) => result.status === "rejected"
          ? [{ reason: "sandbox_create_failed", detail: result.reason instanceof Error ? result.reason.message : String(result.reason) }]
          : []),
      };
    },
  };
}
