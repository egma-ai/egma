import { describe, expect, it, vi } from "vitest";
import { createVoiceFleetReadiness } from "../src/voice-fleet-readiness.ts";
import { createVoiceFleetReconciler, type VoiceFleetTask } from "../src/voice-fleet.ts";
const prefix = "arn:aws:ecs:us-east-1:123456789012";
const taskDefinition = `${prefix}:task-definition/egma-voice:2`;
const identity = (id: string, revision = 2) => ({taskArn: `${prefix}:task/egma/${id}`, taskDefinition: `${prefix}:task-definition/egma-voice:${revision}`});
const task = (id: string, revision = 2, createdAt = 0): VoiceFleetTask => ({id: identity(id).taskArn, taskDefinition: identity(id, revision).taskDefinition, mode: "standby", createdAt});

describe("voice worker readiness", () => {
  it("counts observed ready standbys, excluding starting, busy, one-shot, and old revisions", () => {
    const fleet = createVoiceFleetReadiness({taskDefinition, now: () => 1000});
    const tasks = [task("ready"), task("starting"), task("busy"), task("old", 1), {...task("one"), mode: "one-shot" as const}];
    fleet.observeTasks(tasks);
    for (const id of ["ready", "busy", "one"]) fleet.waiting(identity(id));
    fleet.waiting(identity("old", 1));
    fleet.busy(identity("busy"));
    fleet.waiting(identity("busy"));
    expect(fleet.snapshot()).toMatchObject({readyStandbys: 1, starting: 1});
    expect(fleet.shouldRetire(identity("busy"))).toBe(false);
  });
  it("warms replacements before expiry and retires old idle workers only after two replacements are ready", () => {
    let now = 28 * 60_000;
    const fleet = createVoiceFleetReadiness({taskDefinition, now: () => now});
    const tasks = [task("aging"), task("old", 1, now), task("new1", 2, now), task("new2", 2, now)];
    fleet.waiting(identity("aging"));
    fleet.waiting(identity("old", 1));
    expect(fleet.observeTasks(tasks).filter((item) => item.retiring)).toHaveLength(2);
    expect(fleet.shouldRetire(identity("old", 1))).toBe(false);
    fleet.waiting(identity("new1"));
    fleet.waiting(identity("new2"));
    expect(fleet.shouldRetire(identity("old", 1))).toBe(true);
    expect(fleet.shouldRetire(identity("aging"))).toBe(true);
    fleet.busy(identity("old", 1));
    expect(fleet.shouldRetire(identity("old", 1))).toBe(false);
    now += 41_000;
    expect(fleet.snapshot().readyStandbys).toBe(0);
  });
  it("keeps a readiness report that precedes ECS listing and rejects unrelated identities", () => {
    const fleet = createVoiceFleetReadiness({taskDefinition, now: () => 1000});
    fleet.waiting(identity("new"));
    fleet.observeTasks([]);
    fleet.observeTasks([task("new")]);
    expect(fleet.snapshot().readyStandbys).toBe(1);
    expect(fleet.identity(identity("new"))).toEqual(identity("new"));
    expect(fleet.identity({...identity("new"), taskDefinition: "unrelated"})).toBeUndefined();
    expect(fleet.identity({taskArn: 1})).toBeUndefined();
  });
  it("replenishes a consumed standby while counting pending launches once", async () => {
    const observations = createVoiceFleetReadiness({taskDefinition, now: () => 1000});
    let active = 0;
    const tasks = [task("a"), task("b")];
    tasks.forEach((item) => observations.waiting({taskArn: item.id, taskDefinition}));
    const launchTasks = vi.fn(async ({count, mode}: {count: number; mode: "one-shot" | "standby"}) => ({tasks: Array.from({length:count}, (_, index) => ({id:`new-${index}`, mode})), failures: []}));
    const reconciler = createVoiceFleetReconciler({
      fleet: {listTasks: async () => observations.observeTasks(tasks), launchTasks},
      estimateDemand: async () => ({active, admissibleQueued:0}),
      log: {info:vi.fn(),warn:vi.fn(),error:vi.fn()}, now: () => 1000,
    });
    await reconciler.reconcile();
    expect(launchTasks).not.toHaveBeenCalled();
    observations.busy(identity("a")); active = 1;
    await reconciler.reconcile();
    expect(launchTasks).toHaveBeenCalledExactlyOnceWith({count:1, mode:"standby"});
    await reconciler.reconcile();
    expect(launchTasks).toHaveBeenCalledTimes(1);
  });
  it("does not replace active old workers after an API restart loses their observations", async () => {
    const observations = createVoiceFleetReadiness({taskDefinition, now: () => 1000});
    const oldWorkers = Array.from({length: 102}, (_, index) => ({
      ...task(`old-${index}`, 1, 0),
      mode: index < 100 ? "one-shot" as const : "standby" as const,
    }));
    const listed = [...oldWorkers];
    const launchTasks = vi.fn(async ({count, mode}: {count: number; mode: "one-shot" | "standby"}) => {
      const launched = Array.from({length: count}, (_, index) => task(`new-${index}`));
      listed.push(...launched);
      return {tasks: launched.map((item) => ({...item, mode})), failures: []};
    });
    const reconciler = createVoiceFleetReconciler({
      fleet: {listTasks: async () => observations.observeTasks(listed), launchTasks},
      estimateDemand: async () => ({active:100, admissibleQueued:0}),
      log: {info:vi.fn(),warn:vi.fn(),error:vi.fn()}, now: () => 1000,
    });

    await reconciler.reconcile();
    await reconciler.reconcile();

    expect(launchTasks).toHaveBeenCalledExactlyOnceWith({count:2, mode:"standby"});
  });
});
