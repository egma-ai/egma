import { describe, expect, it, vi } from "vitest";
import { createVoiceFleetReconciler } from "../src/voice-fleet.ts";

describe("voice fleet demand", () => {
  it("creates one sandbox per active or admissible queued voice simulation", async () => {
    const launchTasks = vi.fn(async ({ count }: { count: number }) => ({
      tasks: Array.from({ length: count }, (_, index) => ({ id: `new-${index}` })),
      failures: [],
    }));
    const reconciler = createVoiceFleetReconciler({
      fleet: { listTasks: async () => [{ id: "running" }], launchTasks },
      estimateDemand: async () => ({ active: 2, admissibleQueued: 3 }),
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });

    expect(await reconciler.reconcile()).toMatchObject({ desired: 5, present: 1, launched: 4 });
    expect(launchTasks).toHaveBeenCalledExactlyOnceWith({ count: 4 });
  });
});
