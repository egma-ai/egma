import type {
  ProductionTraceClaim,
  RetellMonitoringTarget,
} from "@egma/db";
import { describe, expect, it } from "vitest";

import type { RetellCall } from "../src/retell/normalise.ts";
import {
  replayProductionClaim,
  writeRetellCall,
  type RetellProductionWriteStore,
} from "../src/retell/write.ts";

const AUTH = {
  userId: "production-monitoring",
  organizationId: "org_write_test",
  projectId: "prj_write_test",
  role: "member",
  via: "monitoring",
} as const;

const TARGET: RetellMonitoringTarget = {
  setupId: "mns_write_test",
  monitoredAgentId: "rma_write_test",
  platformAgentId: "agent_in_retell_1",
  platformAgentName: "Front desk",
  apiKey: "retell-key-never-logged",
  scanKind: "historical_import",
  scanFrom: new Date("2026-07-20T00:00:00.000Z"),
  scanThrough: new Date("2026-08-19T00:00:00.000Z"),
  paginationKey: null,
  seenPaginationKeys: [],
  setupConsecutiveFailures: 0,
  leaseOwner: "lease_write_test",
  leaseExpiresAt: new Date("2026-08-19T00:01:30.000Z"),
  auth: AUTH,
};

function capturedCall(overrides: Partial<RetellCall> = {}): RetellCall {
  return {
    call_id: "call_a1b2c3d4e5f6",
    call_type: "phone_call",
    agent_id: TARGET.platformAgentId,
    call_status: "ended",
    start_timestamp: 1_786_000_000_000,
    end_timestamp: 1_786_000_074_000,
    transcript_with_tool_calls: [
      { role: "agent", content: "Hello" },
      { role: "user", content: "I need help" },
    ],
    ...overrides,
  };
}

type Recorded = {
  claimed?: Parameters<RetellProductionWriteStore["claimProductionTrace"]>[1];
  appended: number;
  grading: number;
  finished: string[];
  received: number;
  replayedPlatformAgentIds: string[];
};

function writeStore(
  recorded: Recorded,
  claim: ProductionTraceClaim | undefined,
): RetellProductionWriteStore {
  return {
    async claimProductionTrace(_auth, offer) {
      recorded.claimed = offer;
      return claim;
    },
    async appendSpans(_auth, spans) {
      recorded.appended += spans.length;
      return { appended: spans.length, batches: spans.length === 0 ? 0 : 1 };
    },
    async recordProductionTraces(_auth, spans) {
      recorded.grading += spans.length;
    },
    async finishProductionTrace(_auth, finished) {
      recorded.finished.push(finished.traceId);
    },
    async recordRetellCallReceived() {
      recorded.received += 1;
    },
    async recordRetellMonitoringReceived(_auth, input) {
      recorded.received += 1;
      recorded.replayedPlatformAgentIds.push(input.platformAgentId);
    },
  };
}

function recording(): Recorded {
  return {
    appended: 0,
    grading: 0,
    finished: [],
    received: 0,
    replayedPlatformAgentIds: [],
  };
}

describe("the shared Retell production writer", () => {
  it("claims one provider conversation without a simulation connection and writes its spans", async () => {
    const recorded = recording();
    const call = capturedCall({
      agent_version: 7,
      access_token: "provider-access-token-must-not-be-stored",
    });
    const claim = {
      id: "ptc_write_test",
      traceId: "unused-by-the-write-result",
      providerCallId: String(call["call_id"]),
      platformAgentId: TARGET.platformAgentId,
      platformAgentName: TARGET.platformAgentName,
      platformAgentVersion: "7",
      payload: "{}",
      endedAt: new Date("2026-08-19T00:00:00.000Z"),
      degraded: false,
      auth: AUTH,
    } satisfies ProductionTraceClaim;

    const outcome = await writeRetellCall(
      TARGET,
      call,
      new Date("2026-08-19T00:00:05.000Z"),
      writeStore(recorded, claim),
    );

    expect(outcome.kind).toBe("written");
    expect(recorded.claimed).toMatchObject({
      providerCallId: call["call_id"],
      platformAgentId: TARGET.platformAgentId,
      platformAgentName: TARGET.platformAgentName,
      platformAgentVersion: "7",
    });
    expect(recorded.claimed).not.toHaveProperty("connectionId");
    expect(recorded.claimed?.payload).not.toContain("access_token");
    expect(recorded.claimed?.payload).not.toContain(
      "provider-access-token-must-not-be-stored",
    );
    expect(recorded.claimed?.payload).not.toContain("REDACTED");
    expect(recorded.appended).toBeGreaterThan(1);
    expect(recorded.grading).toBe(recorded.appended);
    expect(recorded.finished).toHaveLength(1);
    expect(recorded.received).toBe(1);
  });

  it("does not append a conversation that another worker already claimed", async () => {
    const recorded = recording();

    const outcome = await writeRetellCall(
      TARGET,
      capturedCall(),
      new Date("2026-08-19T00:00:05.000Z"),
      writeStore(recorded, undefined),
    );

    expect(outcome.kind).toBe("already");
    expect(recorded.appended).toBe(0);
    expect(recorded.grading).toBe(0);
    expect(recorded.finished).toEqual([]);
    expect(recorded.received).toBe(0);
  });

  it("stores a transcript-free terminal call without offering it for grading", async () => {
    const recorded = recording();
    const call = capturedCall({
      call_status: "not_connected",
      transcript_with_tool_calls: undefined,
    });
    const claim = {
      id: "ptc_transcript_free",
      traceId: "unused-by-the-write-result",
      providerCallId: String(call["call_id"]),
      platformAgentId: TARGET.platformAgentId,
      platformAgentName: TARGET.platformAgentName,
      payload: "{}",
      endedAt: new Date(Number(call["end_timestamp"])),
      degraded: false,
      auth: AUTH,
    } satisfies ProductionTraceClaim;

    const outcome = await writeRetellCall(
      TARGET,
      call,
      new Date("2026-08-19T00:00:05.000Z"),
      writeStore(recorded, claim),
    );

    expect(outcome.kind).toBe("written");
    expect(recorded.appended).toBe(1);
    expect(recorded.grading).toBe(0);
    expect(recorded.finished).toEqual([outcome.traceId]);
  });

  it("keeps the historical platform agent reference and refuses a different agent id", async () => {
    const historical = recording();
    const call = capturedCall({
      agent_name: "Historical Retell name",
      agent_version: 4,
    });
    const claim = {
      id: "ptc_historical_identity",
      traceId: "unused",
      providerCallId: String(call["call_id"]),
      platformAgentId: TARGET.platformAgentId,
      platformAgentName: "Historical Retell name",
      platformAgentVersion: "4",
      payload: "{}",
      endedAt: new Date(Number(call["end_timestamp"])),
      degraded: false,
      auth: AUTH,
    } satisfies ProductionTraceClaim;

    await writeRetellCall(
      TARGET,
      call,
      new Date("2026-08-19T00:00:05.000Z"),
      writeStore(historical, claim),
    );
    expect(historical.claimed).toMatchObject({
      platformAgentId: TARGET.platformAgentId,
      platformAgentName: "Historical Retell name",
      platformAgentVersion: "4",
    });

    const mismatch = recording();
    await expect(
      writeRetellCall(
        TARGET,
        capturedCall({ agent_id: "another_retell_agent" }),
        new Date("2026-08-19T00:00:05.000Z"),
        writeStore(mismatch, claim),
      ),
    ).rejects.toThrow("different selected agent");
    expect(mismatch.claimed).toBeUndefined();
  });

  it("replays a stale claim from its safe payload with the same trace identity", async () => {
    const recorded = recording();
    const call = capturedCall({ agent_version: 7 });
    const first = recording();
    const firstStore = writeStore(first, {
      id: "ptc_replay_test",
      traceId: "unused",
      providerCallId: String(call["call_id"]),
      platformAgentId: TARGET.platformAgentId,
      platformAgentName: TARGET.platformAgentName,
      platformAgentVersion: "7",
      payload: "{}",
      endedAt: new Date(Number(call["end_timestamp"])),
      degraded: false,
      auth: AUTH,
    });
    await writeRetellCall(
      TARGET,
      call,
      new Date("2026-08-19T00:00:05.000Z"),
      firstStore,
    );
    if (first.claimed === undefined) throw new Error("the claim was not offered");

    const stale: ProductionTraceClaim = {
      id: "ptc_replay_test",
      ...first.claimed,
      degraded: false,
      auth: AUTH,
    };
    await replayProductionClaim(stale, writeStore(recorded, undefined));

    expect(recorded.appended).toBeGreaterThan(1);
    expect(recorded.grading).toBe(recorded.appended);
    expect(recorded.finished).toEqual([stale.traceId]);
    expect(recorded.received).toBe(1);
    expect(recorded.replayedPlatformAgentIds).toEqual([
      stale.platformAgentId,
    ]);
  });

  it("replays a transcript-free stale claim without offering it for grading", async () => {
    const call = capturedCall({
      call_status: "error",
      transcript_with_tool_calls: undefined,
    });
    const first = recording();
    await writeRetellCall(
      TARGET,
      call,
      new Date("2026-08-19T00:00:05.000Z"),
      writeStore(first, {
        id: "ptc_transcript_free_replay",
        traceId: "unused",
        providerCallId: String(call["call_id"]),
        platformAgentId: TARGET.platformAgentId,
        platformAgentName: TARGET.platformAgentName,
        payload: "{}",
        endedAt: new Date(Number(call["end_timestamp"])),
        degraded: false,
        auth: AUTH,
      }),
    );
    if (first.claimed === undefined) throw new Error("the claim was not offered");

    const recorded = recording();
    const stale: ProductionTraceClaim = {
      id: "ptc_transcript_free_replay",
      ...first.claimed,
      degraded: false,
      auth: AUTH,
    };
    await replayProductionClaim(stale, writeStore(recorded, undefined));

    expect(recorded.appended).toBe(1);
    expect(recorded.grading).toBe(0);
    expect(recorded.finished).toEqual([stale.traceId]);
  });
});
