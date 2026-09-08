import { afterEach, beforeEach, expect, it, vi } from "vitest";

const access = vi.hoisted(() => ({
  seedCloudPlans: vi.fn(),
  activateBilling: vi.fn(),
  settleInference: vi.fn(),
  markInferenceSettlementFailed: vi.fn(),
}));
vi.mock("../src/access/index.ts", () => access);
vi.mock("../src/plans.ts", () => ({
  readPlanCatalog: async () => ({ chargingIntervalSeconds: 300 }),
}));
import { startInferenceSettlementJob } from "../src/settlement.ts";

let job: ReturnType<typeof startInferenceSettlementJob> | undefined;
const log = { info: vi.fn(), error: vi.fn() };

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-07T12:00:00Z"));
  vi.resetAllMocks();
  access.settleInference.mockResolvedValue({ charged: 0, amountMicros: 0 });
});

afterEach(() => {
  job?.stop();
  job = undefined;
  vi.useRealTimers();
});

it("continues collecting usage without rewriting plans after startup", async () => {
  job = startInferenceSettlementJob(log);
  await vi.advanceTimersByTimeAsync(0);
  expect(access.settleInference).toHaveBeenCalledTimes(1);
  // A plan write permission failure after initialization must not interrupt
  // the unrelated collection of usage in subsequent intervals.
  access.seedCloudPlans.mockRejectedValue(new Error("plan writes unavailable"));
  await vi.advanceTimersByTimeAsync(600_000);
  expect(access.settleInference).toHaveBeenCalledTimes(3);
  expect(access.seedCloudPlans).toHaveBeenCalledTimes(1);
  expect(access.markInferenceSettlementFailed).not.toHaveBeenCalled();
});

it("marks failed initialization as unavailable and retries before collecting usage", async () => {
  access.seedCloudPlans.mockRejectedValueOnce(
    new Error("database unavailable"),
  );
  job = startInferenceSettlementJob(log);
  await vi.advanceTimersByTimeAsync(0);
  expect(access.markInferenceSettlementFailed).toHaveBeenCalledOnce();
  expect(access.settleInference).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(300_000);
  expect(access.settleInference).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(300_000);
  expect(access.seedCloudPlans).toHaveBeenCalledTimes(2);
  expect(access.settleInference).toHaveBeenCalledTimes(2);
});
