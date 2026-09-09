import { randomUUID } from "node:crypto";
import type { DaytonaVoiceFleetSettings, VoiceFleet, VoiceFleetLog, VoiceFleetTask } from "./voice-fleet.ts";
import {
  awsRecordingRole,
  issueDaytonaVoiceRuntime,
  type AssumeRecordingRole,
  type DaytonaVoiceRuntime,
} from "./voice-fleet-credentials.ts";

type DaytonaSandbox = {
  readonly id: string;
  readonly labels?: Record<string, string>;
  readonly state?: string;
  readonly errorReason?: string;
  readonly process: {
    getEntrypointSession(): Promise<{ commands?: readonly { exitCode?: number }[] }>;
  };
  setLabels(labels: Record<string, string>): Promise<Record<string, string>>;
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

export type DaytonaClaimRuntime = (
  claimant: string,
  simulationId: string,
) => Promise<DaytonaVoiceRuntime>;

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
const ABSENCE_CONFIRMATIONS = 3;

function isNotFound(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const value = err as { readonly status?: number; readonly statusCode?: number; readonly response?: { readonly status?: number } };
  return value.status === 404 || value.statusCode === 404 || value.response?.status === 404;
}

export function daytonaVoiceFleet(
  settings: DaytonaVoiceFleetSettings,
  options: {
    readonly client: DaytonaClient;
    readonly log: VoiceFleetLog;
    readonly onFreed?: () => void;
    readonly id?: () => string;
    readonly pollMilliseconds?: number;
  },
): VoiceFleet {
  const watching = new Set<string>();
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
      let missingConfirmations = 0;
      while (true) {
        try {
          const result = await completion(sandbox.id);
          missingConfirmations = 0;
          if (result === undefined) {
            await new Promise<void>((resolve) => setTimeout(resolve, pollMilliseconds));
            continue;
          }
          options.log.info(
            { sandboxId: sandbox.id, state: result.sandbox.state, exitCode: result.exitCode },
            "Daytona voice simulator process ended",
          );
          await options.client.delete(result.sandbox, 60, true);
          break;
        } catch (err) {
          missingConfirmations = isNotFound(err) ? missingConfirmations + 1 : 0;
          options.log.error(
            { err, sandboxId: sandbox.id, state: sandbox.state, errorReason: sandbox.errorReason },
            "Daytona voice simulator lifecycle could not be reconciled",
          );
          if (missingConfirmations >= ABSENCE_CONFIRMATIONS) break;
          await new Promise<void>((resolve) => setTimeout(resolve, pollMilliseconds));
        }
      }
      watching.delete(sandbox.id);
      options.onFreed?.();
    })();
  };

  const launchOne = async (): Promise<VoiceFleetTask> => {
    const runtimeId = id();
    const name = `egma-voice-${runtimeId}`.slice(0, 63);
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
        EGMA_SIMULATOR_VAD_PROVIDER: "silero",
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

export function daytonaClaimRuntime(
  settings: DaytonaVoiceFleetSettings,
  options: {
    readonly client: DaytonaClient;
    readonly assumeRole?: AssumeRecordingRole;
  },
): DaytonaClaimRuntime {
  const assumeRole = options.assumeRole ?? awsRecordingRole();
  return async (claimant, simulationId) => {
    const sandbox = await options.client.get(claimant);
    const labels = sandbox.labels ?? {};
    const runtimeId = labels["egma.runtime_id"];
    const expectedName = runtimeId === undefined ? undefined : `egma-voice-${runtimeId}`.slice(0, 63);
    if (
      labels["egma.runtime"] !== FLEET_LABELS["egma.runtime"]
      || labels["egma.release_sha"] !== settings.releaseSha
      || labels["egma.snapshot_id"] !== settings.snapshot
      || runtimeId === undefined
      || runtimeId.length === 0
      || claimant !== expectedName
    ) {
      throw new Error("Daytona claimant does not belong to the active voice fleet");
    }
    const assignedSimulation = labels["egma.simulation_id"];
    if (assignedSimulation !== undefined && assignedSimulation !== simulationId) {
      throw new Error("Daytona claimant is already assigned to another simulation");
    }
    const runtime = await issueDaytonaVoiceRuntime({ settings, simulationId, assumeRole });
    await sandbox.setLabels({
      ...labels,
      "egma.simulation_id": simulationId,
    });
    return runtime;
  };
}
