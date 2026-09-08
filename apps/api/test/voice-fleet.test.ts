import { describe, expect, it } from "vitest";

import {
  createVoiceFleetReconciler,
  type VoiceFleet,
  type VoiceFleetTask,
} from "../src/voice-fleet.ts";

function fakeFleet(initial: readonly VoiceFleetTask[] = []): VoiceFleet & {
  tasks: VoiceFleetTask[];
  launches: { count: number; mode: VoiceFleetTask["mode"] }[];
  fail: boolean;
} {
  const tasks = [...initial];
  const launches: { count: number; mode: VoiceFleetTask["mode"] }[] = [];
  let sequence = 0;
  return {
    tasks,
    launches,
    fail: false,
    async listTasks() {
      return this.tasks;
    },
    async launchTasks(request) {
      launches.push(request);
      if (this.fail) return { tasks: [], failures: [{ reason: "RESOURCE:CPU" }] };
      const started = Array.from({ length: request.count }, () => ({
        id: `task-${++sequence}`,
        mode: request.mode,
      }));
      return { tasks: started, failures: [] };
    },
  };
}

const log = { info() {}, warn() {}, error() {} };

describe("the voice fleet reconciler", () => {
  it("keeps two standbys beside one hundred admissible simulations", async () => {
    const fleet = fakeFleet();
    const launcher = createVoiceFleetReconciler({
      fleet,
      estimateDemand: async () => ({ active: 0, admissibleQueued: 100 }),
      log,
    });

    const result = await launcher.reconcile();

    expect(result.desired).toEqual({ "one-shot": 100, standby: 2 });
    expect(fleet.launches).toEqual([
      { count: 100, mode: "one-shot" },
      { count: 2, mode: "standby" },
    ]);
  });

  it("turns forty Cartesia rows admitted under cap two into four tasks", async () => {
    const fleet = fakeFleet();
    const launcher = createVoiceFleetReconciler({
      fleet,
      estimateDemand: async () => ({ active: 0, admissibleQueued: 2 }),
      log,
    });

    await launcher.reconcile();

    expect(fleet.launches).toEqual([
      { count: 2, mode: "one-shot" },
      { count: 2, mode: "standby" },
    ]);
  });

  it("counts a pending task and its recent ledger entry once", async () => {
    const fleet = fakeFleet();
    const launcher = createVoiceFleetReconciler({
      fleet,
      estimateDemand: async () => ({ active: 0, admissibleQueued: 1 }),
      log,
    });
    await launcher.reconcile();
    fleet.tasks.push(
      { id: "task-1", mode: "one-shot" },
      { id: "task-2", mode: "standby" },
      { id: "task-3", mode: "standby" },
    );

    const second = await launcher.reconcile();

    expect(second.present).toEqual({ "one-shot": 1, standby: 2 });
    expect(fleet.launches).toHaveLength(2);
  });

  it("replaces standbys that are conducting active simulations", async () => {
    const fleet = fakeFleet([
      { id: "standby-1", mode: "standby" },
      { id: "standby-2", mode: "standby" },
    ]);
    const launcher = createVoiceFleetReconciler({
      fleet,
      estimateDemand: async () => ({ active: 2, admissibleQueued: 0 }),
      log,
    });

    await launcher.reconcile();

    expect(fleet.launches).toEqual([{ count: 2, mode: "standby" }]);
  });

  it("launches nothing when all desired tasks already exist, whatever their modes", async () => {
    const fleet = fakeFleet(
      Array.from({ length: 102 }, (_, index) => ({
        id: `task-${index}`,
        mode: "one-shot" as const,
      })),
    );
    const launcher = createVoiceFleetReconciler({
      fleet,
      estimateDemand: async () => ({ active: 0, admissibleQueued: 100 }),
      log,
    });

    await launcher.reconcile();

    expect(fleet.launches).toEqual([]);
  });

  it("retries failed launches after a capped backoff and leaves demand untouched", async () => {
    let now = 1_000;
    const fleet = fakeFleet();
    fleet.fail = true;
    const launcher = createVoiceFleetReconciler({
      fleet,
      estimateDemand: async () => ({ active: 0, admissibleQueued: 1 }),
      log,
      now: () => now,
      initialBackoffMilliseconds: 100,
      maximumBackoffMilliseconds: 200,
    });

    await launcher.reconcile();
    expect((await launcher.reconcile()).skipped).toBe("backoff");
    now += 100;
    fleet.fail = false;
    const retry = await launcher.reconcile();

    expect(retry.launched).toEqual({ "one-shot": 1, standby: 2 });
  });

  it("keeps successful task identities when a later launch chunk fails", async () => {
    let now = 1_000;
    const launches: number[] = [];
    let first = true;
    const fleet: VoiceFleet = {
      async listTasks() { return []; },
      async launchTasks({ count, mode }) {
        launches.push(count);
        if (first && mode === "one-shot") {
          first = false;
          return {
            tasks: Array.from({ length: 10 }, (_, index) => ({
              id: `arn:successful:${index}`,
              mode,
            })),
            failures: [{ reason: "run_task_failed", detail: "throttled" }],
          };
        }
        return {
          tasks: Array.from({ length: count }, (_, index) => ({
            id: `arn:retry:${mode}:${index}`,
            mode,
          })),
          failures: [],
        };
      },
    };
    const launcher = createVoiceFleetReconciler({
      fleet,
      estimateDemand: async () => ({ active: 0, admissibleQueued: 20 }),
      log,
      now: () => now,
      initialBackoffMilliseconds: 100,
    });

    await launcher.reconcile();
    now += 100;
    await launcher.reconcile();

    expect(launches).toEqual([20, 2, 10]);
  });

  it("skips an overlapping trigger while the first reconciliation is reading demand", async () => {
    let release!: (value: { active: number; admissibleQueued: number }) => void;
    const demand = new Promise<{ active: number; admissibleQueued: number }>(
      (resolve) => { release = resolve; },
    );
    const fleet = fakeFleet();
    const launcher = createVoiceFleetReconciler({
      fleet,
      estimateDemand: () => demand,
      log,
    });

    const first = launcher.reconcile();
    expect((await launcher.reconcile()).skipped).toBe("overlap");
    release({ active: 0, admissibleQueued: 0 });
    await first;

    expect(fleet.launches).toEqual([{ count: 2, mode: "standby" }]);
  });

  it("replaces tasks after the recent-launch window when the fleet never listed them", async () => {
    let now = 1_000;
    const fleet = fakeFleet();
    const launcher = createVoiceFleetReconciler({
      fleet,
      estimateDemand: async () => ({ active: 0, admissibleQueued: 0 }),
      log,
      now: () => now,
      recentLaunchMilliseconds: 60_000,
    });
    await launcher.reconcile();
    now += 59_999;
    await launcher.reconcile();
    now += 1;
    await launcher.reconcile();

    expect(fleet.launches).toEqual([
      { count: 2, mode: "standby" },
      { count: 2, mode: "standby" },
    ]);
  });
});
