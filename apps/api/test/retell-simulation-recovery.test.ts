import { newId } from "@egma/ids";
import { beforeEach, expect, it, vi } from "vitest";

const resolved = vi.hoisted(() => vi.fn());
vi.mock("@egma/db", async (original) => ({
  ...await original<typeof import("@egma/db")>(),
  resolveRetellSimulationPull: resolved,
}));

import { createRetellSimulationCollector } from "../src/retell-simulation-ingestion.ts";

const simulationId = newId("sim");
const standing = {
  id: simulationId,
  runId: newId("run"),
  agentId: newId("agt"),
  testVersionId: newId("tstv"),
  personaVersionId: newId("ppr"),
  modality: "voice",
  status: "completed",
  endingReason: "agent_ended",
  executionFailure: null,
  claimedBy: "simulator",
  claimedAt: new Date(1_000),
  cancelRequestedAt: null,
  auth: {
    userId: "simulator",
    organizationId: newId("org"),
    projectId: newId("prj"),
    role: "viewer",
    via: "simulator",
  },
} as const;

const call = {
  call_id: "call_recovery",
  agent_id: "agent_front_desk",
  call_status: "ended",
  start_timestamp: 1_000,
  end_timestamp: 2_000,
  transcript_with_tool_calls: [
    { role: "user", content: "Hello" },
    { role: "agent", content: "Hi" },
  ],
};

beforeEach(() => {
  resolved.mockReset();
  resolved.mockResolvedValue({
    apiKey: "retell-test-key",
    baseUrl: null,
    providerReference: call.call_id,
    completionReceivedAt: new Date(),
    standing,
  });
});

it("retries a final record after durable ingestion refused the first save", async () => {
  const collector = createRetellSimulationCollector();
  const fetchImpl = vi.fn(async () =>
    new Response(JSON.stringify(call), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;
  const fileEvidence = vi.fn()
    .mockResolvedValueOnce({ accepted: 1, refused: [{ reason: "temporary refusal" }] })
    .mockResolvedValueOnce({ accepted: 2, refused: [] })
    .mockResolvedValueOnce({ accepted: 1, refused: [] });
  const warned = vi.fn();
  const log = { warn: warned } as never;

  await collector.pull(standing.auth, simulationId, { fetchImpl }, log, {
    retryWaitsMilliseconds: [],
    fileEvidence,
  });
  await collector.settle();

  const firstFiling = fileEvidence.mock.calls[0]?.[0]?.[0];
  expect(firstFiling?.spans).toHaveLength(2);
  expect(firstFiling?.spans.every((span: { parentSpanId: string }) => span.parentSpanId !== "")).toBe(true);
  expect(fileEvidence).toHaveBeenCalledOnce();

  const restarted = createRetellSimulationCollector();
  await restarted.pull(standing.auth, simulationId, { fetchImpl }, log, {
    retryWaitsMilliseconds: [],
    fileEvidence,
  });
  await restarted.settle();

  expect(fetchImpl).toHaveBeenCalledTimes(2);
  expect(fileEvidence).toHaveBeenCalledTimes(3);
  const finalFiling = fileEvidence.mock.calls[2]?.[0]?.[0];
  expect(finalFiling?.spans).toHaveLength(1);
  expect(finalFiling?.spans[0]?.parentSpanId).toBe("");
});

it("retries after durable ingestion throws before accepting any evidence", async () => {
  const first = createRetellSimulationCollector();
  const fetchImpl = vi.fn(async () =>
    new Response(JSON.stringify(call), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;
  const fileEvidence = vi.fn()
    .mockRejectedValueOnce(new Error("object store unavailable"))
    .mockImplementation(async (filings: readonly { spans: readonly unknown[] }[]) => ({
      accepted: filings[0]?.spans.length ?? 0,
      refused: [],
    }));
  const warned = vi.fn();
  const log = { warn: warned } as never;

  await first.pull(standing.auth, simulationId, { fetchImpl }, log, {
    retryWaitsMilliseconds: [], fileEvidence,
  });
  await first.settle();
  expect(fileEvidence).toHaveBeenCalledOnce();

  const restarted = createRetellSimulationCollector();
  await restarted.pull(standing.auth, simulationId, { fetchImpl }, log, {
    retryWaitsMilliseconds: [], fileEvidence,
  });
  await restarted.settle();

  expect(fetchImpl).toHaveBeenCalledTimes(2);
  expect(fileEvidence).toHaveBeenCalledTimes(3);
  expect(warned).toHaveBeenCalled();
});

it("does not refetch while an accepted segment is waiting for the trace-store drain", async () => {
  const collector = createRetellSimulationCollector();
  const fetchImpl = vi.fn(async () =>
    new Response(JSON.stringify(call), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;
  const fileEvidence = vi.fn(async (filings: readonly { spans: readonly unknown[] }[]) => ({
    accepted: filings[0]?.spans.length ?? 0,
    refused: [],
  }));
  const log = { warn: vi.fn() } as never;

  await collector.pull(standing.auth, simulationId, { fetchImpl }, log, {
    retryWaitsMilliseconds: [], fileEvidence,
  });
  await collector.pull(standing.auth, simulationId, { fetchImpl }, log, {
    retryWaitsMilliseconds: [], fileEvidence,
  });

  expect(fetchImpl).toHaveBeenCalledOnce();
  expect(fileEvidence).toHaveBeenCalledTimes(2);
  await collector.settle();
});
