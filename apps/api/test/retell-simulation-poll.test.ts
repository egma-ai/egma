import { afterEach, describe, expect, it, vi } from "vitest";

import { pollRetellSimulationCall } from "../src/retell/poll.ts";
import type { RetrievedCall } from "../src/retell/api.ts";

const PENDING_CALL = {
  call_id: "call_waiting",
  call_status: "ongoing",
  start_timestamp: 1_786_000_000_000,
};
const FINAL_CALL = {
  ...PENDING_CALL,
  call_status: "ended",
  end_timestamp: 1_786_000_074_000,
  transcript_object: [{ role: "agent", content: "Goodbye." }],
};

afterEach(() => vi.useRealTimers());

async function collect(
  results: AsyncIterable<RetrievedCall>,
): Promise<readonly RetrievedCall[]> {
  const collected: RetrievedCall[] = [];
  for await (const result of results) collected.push(result);
  return collected;
}

describe("waiting for Retell's final simulation record", () => {
  it("polls every five seconds for a minute, then backs off through four minutes", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const requestedAt: number[] = [];
    const fetchImpl = (async () => {
      requestedAt.push(Date.now());
      return new Response(JSON.stringify(PENDING_CALL));
    }) as typeof fetch;

    const done = collect(pollRetellSimulationCall("retell-key", "call_waiting", { fetchImpl }, { completionReceivedAtMilliseconds: 0 }));
    await vi.advanceTimersByTimeAsync(245_000);
    await done;

    expect(requestedAt).toEqual([
      0, 5_000, 10_000, 15_000, 20_000, 25_000, 30_000,
      35_000, 40_000, 45_000, 50_000, 55_000, 60_000,
      70_000, 90_000, 130_000, 190_000, 240_000,
    ]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("waits for both the final status and readable transcript, then stops", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const requestedAt: number[] = [];
    const documents = [
      { ...FINAL_CALL, transcript_object: undefined },
      { ...FINAL_CALL, call_status: "ongoing" },
      { ...FINAL_CALL, transcript_object: [{ role: "agent", content: " " }] },
      FINAL_CALL,
    ];
    const fetchImpl = (async () => {
      requestedAt.push(Date.now());
      return new Response(JSON.stringify(documents.shift()));
    }) as typeof fetch;

    const done = collect(pollRetellSimulationCall("retell-key", "call_waiting", { fetchImpl }, { completionReceivedAtMilliseconds: 0 }));
    await vi.advanceTimersByTimeAsync(245_000);
    const results = await done;

    expect(requestedAt).toEqual([0, 5_000, 10_000, 15_000]);
    expect(results.at(-1)).toEqual({ kind: "call", call: FINAL_CALL });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("ends a stalled request after five seconds without overlapping requests", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    let active = 0;
    let maximumActive = 0;
    let requests = 0;
    const fetchImpl = ((_input: unknown, init?: RequestInit) => {
      requests += 1;
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          active -= 1;
          reject(new DOMException("request aborted", "AbortError"));
        }, { once: true });
      });
    }) as typeof fetch;

    const done = collect(pollRetellSimulationCall("retell-key", "call_waiting", { fetchImpl }, { completionReceivedAtMilliseconds: 0 }))
      .then((results) => ({ results, finishedAt: Date.now() }));
    await vi.advanceTimersByTimeAsync(245_000);
    const result = await done;

    expect(requests).toBe(18);
    expect(maximumActive).toBe(1);
    expect(active).toBe(0);
    expect(result.finishedAt).toBe(245_000);
    expect(result.results).toHaveLength(18);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps the planned schedule when each response takes three seconds", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const requestedAt: number[] = [];
    const fetchImpl = (async () => {
      requestedAt.push(Date.now());
      await new Promise((resolve) => setTimeout(resolve, 3_000));
      return new Response(JSON.stringify(requestedAt.length === 3 ? FINAL_CALL : PENDING_CALL));
    }) as typeof fetch;

    const done = collect(pollRetellSimulationCall("retell-key", "call_waiting", { fetchImpl }, { completionReceivedAtMilliseconds: 0 }));
    await vi.advanceTimersByTimeAsync(13_000);
    await done;

    expect(requestedAt).toEqual([0, 5_000, 10_000]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("bounds response-body reads and does not expose the provider's error", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const fetchImpl = (async (_input: unknown, init?: RequestInit) => {
      const response = new Response("");
      Object.defineProperty(response, "text", {
        value: () => new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("SENTINEL-provider-secret")), { once: true });
        }),
      });
      return response;
    }) as typeof fetch;

    const done = collect(pollRetellSimulationCall("retell-key", "call_waiting", { fetchImpl }, { completionReceivedAtMilliseconds: 0, retryWaitsMilliseconds: [] }));
    await vi.advanceTimersByTimeAsync(5_000);
    const results = await done;

    expect(results).toEqual([{ kind: "unreachable", reason: "Retell at https://api.retellai.com did not answer" }]);
    expect(JSON.stringify(results)).not.toContain("SENTINEL");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not retry a refused credential", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const fetchImpl = vi.fn(async () => new Response("", { status: 401 })) as unknown as typeof fetch;

    const results = await collect(pollRetellSimulationCall("retell-key", "call_waiting", { fetchImpl }, { completionReceivedAtMilliseconds: 0 }));

    expect(results).toEqual([{ kind: "invalid-key" }]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not ask again before Retell's rate-limit retry time", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const requestedAt: number[] = [];
    const fetchImpl = (async () => {
      requestedAt.push(Date.now());
      return requestedAt.length === 1
        ? new Response("", { status: 429, headers: { "retry-after": "60" } })
        : new Response(JSON.stringify(FINAL_CALL));
    }) as typeof fetch;

    const done = collect(pollRetellSimulationCall("retell-key", "call_waiting", { fetchImpl }, { completionReceivedAtMilliseconds: 0 }));
    await vi.advanceTimersByTimeAsync(245_000);
    await done;

    expect(requestedAt).toEqual([0, 60_000]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("stops after cancellation while waiting for the next request", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const controller = new AbortController();
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(PENDING_CALL))) as unknown as typeof fetch;
    const done = collect(pollRetellSimulationCall("retell-key", "call_waiting", {
      fetchImpl,
      signal: controller.signal,
    }, { completionReceivedAtMilliseconds: 0 }));
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    await vi.advanceTimersByTimeAsync(5_000);
    await done;

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("anchors a delayed start to the completion receipt and skips missed slots", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(16_000);
    const requestedAt: number[] = [];
    const fetchImpl = (async () => {
      requestedAt.push(Date.now());
      return new Response(JSON.stringify(PENDING_CALL));
    }) as typeof fetch;

    const done = collect(pollRetellSimulationCall("retell-key", "call_waiting", {
      fetchImpl,
    }, { completionReceivedAtMilliseconds: 0 }));
    await vi.runAllTimersAsync();
    await done;

    expect(requestedAt).toEqual([
      16_000, 20_000, 25_000, 30_000, 35_000, 40_000, 45_000,
      50_000, 55_000, 60_000, 70_000, 90_000, 130_000, 190_000, 240_000,
    ]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("shortens the last request to the completion receipt's remaining budget", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(244_000);
    const requestedAt: number[] = [];
    const fetchImpl = ((_input: unknown, init?: RequestInit) => {
      requestedAt.push(Date.now());
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("request aborted", "AbortError"));
        }, { once: true });
      });
    }) as typeof fetch;

    const done = collect(pollRetellSimulationCall("retell-key", "call_waiting", {
      fetchImpl,
    }, { completionReceivedAtMilliseconds: 0 }))
      .then(() => Date.now());
    await vi.runAllTimersAsync();

    expect(await done).toBe(245_000);
    expect(requestedAt).toEqual([244_000]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not request a record after the stored completion deadline", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(245_000);
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(FINAL_CALL))) as unknown as typeof fetch;

    const results = await collect(pollRetellSimulationCall("retell-key", "call_waiting", {
      fetchImpl,
    }, { completionReceivedAtMilliseconds: 0 }));

    expect(results).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not burst through missed slots when a retry timer wakes late", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const requestedAt: number[] = [];
    const fetchImpl = (async () => {
      requestedAt.push(Date.now());
      return new Response(JSON.stringify(PENDING_CALL));
    }) as typeof fetch;
    let delayed = false;
    const sleep = async (milliseconds: number): Promise<void> => {
      vi.setSystemTime(Date.now() + milliseconds + (delayed ? 0 : 185_000));
      delayed = true;
    };

    await collect(pollRetellSimulationCall("retell-key", "call_waiting", {
      fetchImpl,
    }, { completionReceivedAtMilliseconds: 0, sleep }));

    expect(requestedAt).toEqual([0, 190_000, 240_000]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("stops a collector while it is waiting for its next retry", async () => {
    const controller = new AbortController();
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify(PENDING_CALL))) as unknown as typeof fetch;
    const done = collect(pollRetellSimulationCall("retell-key", "call_waiting", {
      fetchImpl,
      signal: controller.signal,
    }, {
      completionReceivedAtMilliseconds: Date.now(),
      retryWaitsMilliseconds: [60_000],
      sleep: async () => new Promise<void>(() => undefined),
    }));

    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledOnce());
    controller.abort();

    await expect(done).resolves.toHaveLength(1);
  });

});
