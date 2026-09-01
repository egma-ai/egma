import { EventEmitter } from "node:events";

import {
  initializeLogger,
  llm,
  type JobContext,
  voice,
} from "@livekit/agents";
import { RpcError, type PerformRpcParams } from "@livekit/rtc-node";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { mockable } from "../src/mockable.ts";

class StubRoom extends EventEmitter {
  isConnected = true;
  readonly remoteParticipants = new Map<string, { identity: string }>();
  mockedTools: string[] = [];
  helloErrors: Error[] = [];
  toolError: Error | undefined;
  toolReply: Record<string, unknown> = { answer: "mocked" };
  readonly localParticipant = {
    performRpc: vi.fn(async (call: PerformRpcParams) => {
      if (call.method === "egma.hello") {
        const refused = this.helloErrors.shift();
        if (refused !== undefined) throw refused;
        return JSON.stringify({
          protocol_version: 1,
          mocked_tools: this.mockedTools,
        });
      }
      if (call.method === "egma.tool") {
        if (this.toolError !== undefined) throw this.toolError;
        return JSON.stringify(this.toolReply);
      }
      throw new Error(`unexpected RPC method: ${call.method}`);
    }),
  };
}

type StubContext = {
  job: { room: { name: string } };
  room: StubRoom;
  connectCalls: number;
  shutdownCallbacks: Array<() => Promise<void>>;
  connect(): Promise<void>;
  addShutdownCallback(callback: () => Promise<void>): void;
};

const contexts: StubContext[] = [];

function context(
  roomName: string,
  options: {
    connected?: boolean;
    mockedTools?: string[];
    personaIdentity?: string;
  } = {},
): StubContext {
  const room = new StubRoom();
  room.isConnected = options.connected ?? true;
  room.mockedTools = options.mockedTools ?? [];
  const personaIdentity = options.personaIdentity ?? "egma-persona";
  room.remoteParticipants.set(personaIdentity, { identity: personaIdentity });
  const created: StubContext = {
    job: { room: { name: roomName } },
    room,
    connectCalls: 0,
    shutdownCallbacks: [],
    async connect() {
      this.connectCalls += 1;
      this.room.isConnected = true;
    },
    addShutdownCallback(callback) {
      this.shutdownCallbacks.push(callback);
    },
  };
  contexts.push(created);
  return created;
}

function asJobContext(value: StubContext): JobContext {
  return value as unknown as JobContext;
}

const sessions: voice.AgentSession[] = [];

beforeAll(() => {
  initializeLogger({ pretty: false, level: "silent" });
});

function session(options: ConstructorParameters<typeof voice.AgentSession>[0] = {}): voice.AgentSession {
  const created = new voice.AgentSession(options);
  sessions.push(created);
  return created;
}

function agentWithTool(
  name: string,
  execute: (args: Record<string, unknown>) => Promise<unknown>,
): voice.Agent {
  return new voice.Agent({
    instructions: "Test agent",
    tools: [
      llm.tool({
        name,
        description: `Run ${name}`,
        parameters: z.object({ value: z.string() }),
        execute,
      }),
    ],
  });
}

class CalendarAgent extends voice.Agent {
  constructor(execute: (args: Record<string, unknown>) => Promise<unknown>) {
    super({
      instructions: "Calendar agent",
      tools: [
        llm.tool({
          name: "check_calendar",
          description: "Check the calendar",
          parameters: z.object({ value: z.string() }),
          execute,
        }),
      ],
    });
  }
}

class ConfirmationAgent extends voice.Agent {
  constructor(execute: (args: Record<string, unknown>) => Promise<unknown>) {
    super({
      instructions: "Confirmation agent",
      tools: [
        llm.tool({
          name: "send_confirmation",
          description: "Send a confirmation",
          parameters: z.object({ value: z.string() }),
          execute,
        }),
      ],
    });
  }
}

function fakeLlmCalling(
  input: string,
  name: string,
  args: Record<string, unknown>,
): voice.testing.FakeLLM {
  return new voice.testing.FakeLLM([
    { input, toolCalls: [{ name, args }] },
  ]);
}

async function run(
  oneSession: voice.AgentSession,
  agent: voice.Agent,
  input: string,
): Promise<voice.testing.RunResult> {
  await oneSession.start({ agent });
  return oneSession.run({ userInput: input }).wait();
}

afterEach(async () => {
  await Promise.allSettled(
    contexts
      .splice(0)
      .flatMap((ctx) => ctx.shutdownCallbacks)
      .map(async (callback) => callback()),
  );
  await Promise.allSettled(sessions.splice(0).map(async (one) => one.close()));
  vi.restoreAllMocks();
});

describe("mockable", () => {
  it("leaves a production room completely inert", async () => {
    const ctx = context("customer-production-room");
    const real = vi.fn(async () => "real");
    const agent = agentWithTool("check_calendar", real);
    const oneSession = session({
      llm: fakeLlmCalling("find it", "check_calendar", { value: "Friday" }),
    });

    await mockable(agent, asJobContext(ctx), oneSession);
    await run(oneSession, agent, "find it");

    expect(real).toHaveBeenCalledOnce();
    expect(ctx.connectCalls).toBe(0);
    expect(ctx.room.localParticipant.performRpc).not.toHaveBeenCalled();
    expect(ctx.shutdownCallbacks).toHaveLength(0);
  });

  it("reports the tools first and routes only covered calls to Egma", async () => {
    const real = vi.fn(async () => "real");
    const agent = agentWithTool("check_calendar", real);
    const ctx = context("egma-sim-sim_123", {
      connected: false,
      mockedTools: ["check_calendar"],
    });
    const oneSession = session({
      llm: fakeLlmCalling("find a slot", "check_calendar", {
        value: "Tuesday",
      }),
    });

    await mockable(agent, asJobContext(ctx), oneSession);
    await run(oneSession, agent, "find a slot");

    expect(ctx.connectCalls).toBe(1);
    expect(real).not.toHaveBeenCalled();
    expect(
      ctx.room.localParticipant.performRpc.mock.calls.map(
        ([call]) => call.method,
      ),
    ).toEqual(["egma.hello", "egma.tool"]);
    const hello = JSON.parse(
      ctx.room.localParticipant.performRpc.mock.calls[0]![0].payload,
    ) as { tools: Array<Record<string, unknown>> };
    expect(hello.tools).toEqual([
      expect.objectContaining({ name: "check_calendar" }),
    ]);
    const called = JSON.parse(
      ctx.room.localParticipant.performRpc.mock.calls[1]![0].payload,
    ) as Record<string, unknown>;
    expect(called).toEqual({
      name: "check_calendar",
      arguments: { value: "Tuesday" },
    });
    expect(
      ctx.room.localParticipant.performRpc.mock.calls.map(
        ([call]) => call.responseTimeout,
      ),
    ).toEqual([15_000, 45_000]);
  });

  it("leaves an uncovered tool on its real implementation", async () => {
    const real = vi.fn(async ({ value }: Record<string, unknown>) =>
      String(value),
    );
    const agent = agentWithTool("read_notice", real);
    const ctx = context("egma-sim-sim_124", { mockedTools: [] });
    const oneSession = session({
      llm: fakeLlmCalling("read it", "read_notice", { value: "real" }),
    });

    await mockable(agent, asJobContext(ctx), oneSession);
    await run(oneSession, agent, "read it");

    expect(real).toHaveBeenCalledWith(
      { value: "real" },
      expect.objectContaining({ toolCallId: expect.any(String) }),
    );
    expect(
      ctx.room.localParticipant.performRpc.mock.calls.map(
        ([call]) => call.method,
      ),
    ).toEqual(["egma.hello"]);
  });

  it("runs the current real tool only when the Egma participant was not reached", async () => {
    const real = vi.fn(async ({ value }: Record<string, unknown>) =>
      `real:${String(value)}`,
    );
    const agent = agentWithTool("check_calendar", real);
    const ctx = context("egma-sim-sim_125", {
      mockedTools: ["check_calendar"],
    });
    ctx.room.toolError = new RpcError(1401, "recipient not found");
    const oneSession = session({
      llm: fakeLlmCalling("find it", "check_calendar", { value: "Friday" }),
    });

    await mockable(agent, asJobContext(ctx), oneSession);
    await run(oneSession, agent, "find it");

    expect(real).toHaveBeenCalledWith(
      { value: "Friday" },
      expect.objectContaining({ toolCallId: expect.any(String) }),
    );
  });

  it("uses the agent's current real tool when its tools changed after setup", async () => {
    const original = vi.fn(async () => "original");
    const current = vi.fn(async () => "current");
    const agent = agentWithTool("check_calendar", original);
    const ctx = context("egma-sim-sim_125b", {
      mockedTools: ["check_calendar"],
    });
    ctx.room.toolError = new RpcError(1401, "recipient not found");
    const oneSession = session({
      llm: fakeLlmCalling("find it", "check_calendar", { value: "Friday" }),
    });

    await mockable(agent, asJobContext(ctx), oneSession);
    await oneSession.start({ agent });
    await agent.updateTools([
      llm.tool({
        name: "check_calendar",
        description: "Current calendar implementation",
        parameters: z.object({ value: z.string() }),
        execute: current,
      }),
    ]);
    await oneSession.run({ userInput: "find it" }).wait();

    expect(original).not.toHaveBeenCalled();
    expect(current).toHaveBeenCalledWith(
      { value: "Friday" },
      expect.objectContaining({ toolCallId: expect.any(String) }),
    );
  });

  it("turns an Egma refusal into a tool error without calling the real tool", async () => {
    const real = vi.fn(async () => "real");
    const agent = agentWithTool("check_calendar", real);
    const ctx = context("egma-sim-sim_126", {
      mockedTools: ["check_calendar"],
    });
    ctx.room.toolError = new RpcError(902, "this simulation has no answer");
    const oneSession = session({
      llm: fakeLlmCalling("find it", "check_calendar", { value: "Friday" }),
    });

    await mockable(agent, asJobContext(ctx), oneSession);
    const result = await run(oneSession, agent, "find it");

    expect(real).not.toHaveBeenCalled();
    const output = result.events.find(
      (event) => event.type === "function_call_output",
    );
    expect(output?.item.isError).toBe(true);
    expect(output?.item.output).toContain("this simulation has no answer");
  });

  it("passes a mock tool's forced error to the agent as a tool error", async () => {
    const real = vi.fn(async () => "real");
    const agent = agentWithTool("check_calendar", real);
    const ctx = context("egma-sim-sim_127", {
      mockedTools: ["check_calendar"],
    });
    ctx.room.toolReply = { error: "the calendar is down" };
    const oneSession = session({
      llm: fakeLlmCalling("find it", "check_calendar", { value: "Friday" }),
    });

    await mockable(agent, asJobContext(ctx), oneSession);
    const result = await run(oneSession, agent, "find it");

    expect(real).not.toHaveBeenCalled();
    const output = result.events.find(
      (event) => event.type === "function_call_output",
    );
    expect(output?.item.isError).toBe(true);
    expect(output?.item.output).toContain("the calendar is down");
  });

  it("retries hello while the Egma participant is present but not listening yet", async () => {
    const agent = agentWithTool("check_calendar", async () => "real");
    const ctx = context("egma-sim-sim_128", {
      mockedTools: ["check_calendar"],
    });
    ctx.room.helloErrors.push(
      new RpcError(1400, "method not supported at destination"),
    );

    await mockable(agent, asJobContext(ctx), session());

    expect(
      ctx.room.localParticipant.performRpc.mock.calls.map(
        ([call]) => call.method,
      ),
    ).toEqual(["egma.hello", "egma.hello"]);
    expect(ctx.shutdownCallbacks).toHaveLength(1);
  });

  it("accepts the token-endpoint persona identity but refuses two claimants", async () => {
    const agent = agentWithTool("check_calendar", async () => "real");
    const accepted = context("egma-sim-sim_129", {
      mockedTools: ["check_calendar"],
      personaIdentity: "egma-persona-sim_129",
    });

    await mockable(agent, asJobContext(accepted), session());

    expect(accepted.room.localParticipant.performRpc).toHaveBeenCalledOnce();
    await accepted.shutdownCallbacks[0]!();

    const refused = context("egma-sim-sim_130", {
      mockedTools: ["check_calendar"],
    });
    refused.room.remoteParticipants.set("egma-persona-sim_130", {
      identity: "egma-persona-sim_130",
    });

    await mockable(agent, asJobContext(refused), session());

    expect(refused.room.localParticipant.performRpc).not.toHaveBeenCalled();
    expect(refused.shutdownCallbacks).toHaveLength(0);
  });

  it("owns process-global LiveKit mocks until close and then releases them", async () => {
    const firstAgent = agentWithTool("check_calendar", async () => "real");
    const firstContext = context("egma-sim-sim_131", {
      mockedTools: ["check_calendar"],
    });
    const firstSession = session();
    await mockable(
      firstAgent,
      asJobContext(firstContext),
      firstSession,
    );
    await firstSession.start({ agent: firstAgent });

    const secondAgent = agentWithTool("check_calendar", async () => "real");
    const secondContext = context("egma-sim-sim_132", {
      mockedTools: ["check_calendar"],
    });
    const secondSession = session();

    await expect(
      mockable(secondAgent, asJobContext(secondContext), secondSession),
    ).rejects.toThrow(/another LiveKit AgentSession/u);

    await firstSession.close();
    await mockable(
      secondAgent,
      asJobContext(secondContext),
      secondSession,
    );
    expect(secondContext.shutdownCallbacks).toHaveLength(1);

    await secondContext.shutdownCallbacks[0]!();
    await firstContext.shutdownCallbacks[0]!();

    const productionReal = vi.fn(async () => "production-real");
    const productionAgent = agentWithTool("check_calendar", productionReal);
    const productionSession = session({
      llm: fakeLlmCalling("find it", "check_calendar", { value: "Monday" }),
    });
    await mockable(
      productionAgent,
      asJobContext(context("customer-production-room-after-close")),
      productionSession,
    );
    await run(productionSession, productionAgent, "find it");
    expect(productionReal).toHaveBeenCalledOnce();
  });

  it("binds a handoff before its first tool call and refreshes one cumulative census", async () => {
    const calendarReal = vi.fn(async () => "real-calendar");
    const confirmationReal = vi.fn(async () => "real-confirmation");
    const initial = new CalendarAgent(calendarReal);
    const next = new ConfirmationAgent(confirmationReal);
    const ctx = context("egma-sim-sim_133", {
      mockedTools: ["check_calendar", "send_confirmation"],
    });
    const oneSession = session({
      llm: fakeLlmCalling("confirm it", "send_confirmation", {
        value: "booking-123",
      }),
    });

    await mockable(initial, asJobContext(ctx), oneSession);
    await oneSession.start({ agent: initial });
    oneSession.updateAgent(next);
    await vi.waitFor(() => expect(oneSession.currentAgent).toBe(next), {
      timeout: 5_000,
    });
    await vi.waitFor(
      () =>
        expect(
          ctx.room.localParticipant.performRpc.mock.calls.filter(
            ([call]) => call.method === "egma.hello",
          ),
        ).toHaveLength(2),
      { timeout: 5_000 },
    );

    await oneSession.run({ userInput: "confirm it" }).wait();

    expect(calendarReal).not.toHaveBeenCalled();
    expect(confirmationReal).not.toHaveBeenCalled();
    const helloCalls = ctx.room.localParticipant.performRpc.mock.calls.filter(
      ([call]) => call.method === "egma.hello",
    );
    const cumulative = JSON.parse(helloCalls[1]![0].payload) as {
      tools: Array<{ name: string }>;
    };
    expect(cumulative.tools.map(({ name }) => name).sort()).toEqual([
      "check_calendar",
      "send_confirmation",
    ]);
    expect(
      ctx.room.localParticipant.performRpc.mock.calls.at(-1)?.[0].method,
    ).toBe("egma.tool");
  });
});
