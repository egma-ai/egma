import { EventEmitter } from "node:events";
import { createServer, type Server } from "node:http";
import { type AddressInfo } from "node:net";

import {
  initializeLogger,
  llm,
  telemetry,
  type JobContext,
  voice,
} from "@livekit/agents";
import {
  ProxyTracerProvider,
  context as otelContext,
  trace,
} from "@opentelemetry/api";
import {
  InMemorySpanExporter,
  NodeTracerProvider,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-node";
import { RpcError, type PerformRpcParams } from "@livekit/rtc-node";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { z } from "zod";

import {
  PROVIDER_REFERENCE,
  exportStateForTests,
  resetExportForTests,
} from "../src/export.ts";
import {
  NotReported,
  answersToEgma,
  simulation,
} from "../src/simulation-room.ts";

const PROJECT_KEY = `egma_sk_${"a".repeat(43)}`;

/**
 * Somewhere for the exporter to post to.
 *
 * The verb builds a real OTLP exporter, and a flush with nowhere to go
 * would retry on a timer while a test waits on it. One local server that
 * answers 200 to everything keeps the exporter real and the tests quick.
 */
let collector: Server;
let collectorUrl = "";

class StubRoom extends EventEmitter {
  isConnected = true;
  readonly remoteParticipants = new Map<string, { identity: string }>();
  mockedTools: string[] = [];
  helloErrors: Error[] = [];
  helloWaiter: Promise<void> | undefined;
  pendingHellos = 0;
  /** What Egma answers a census with, where a test wants a shape of its own. */
  helloReply: string | undefined = undefined;
  toolError: Error | undefined;
  toolReply: Record<string, unknown> = { answer: "mocked" };
  readonly localParticipant = {
    performRpc: vi.fn(async (call: PerformRpcParams) => {
      if (call.method === "egma.hello") {
        if (this.helloWaiter !== undefined) {
          this.pendingHellos += 1;
          try {
            await this.helloWaiter;
          } finally {
            this.pendingHellos -= 1;
          }
        }
        const refused = this.helloErrors.shift();
        if (refused !== undefined) throw refused;
        if (this.helloReply !== undefined) return this.helloReply;
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

  arrive(identity: string): void {
    const participant = { identity };
    this.remoteParticipants.set(identity, participant);
    this.emit("participantConnected", participant);
  }

  depart(identity: string): void {
    const participant = this.remoteParticipants.get(identity);
    if (participant === undefined) return;
    this.remoteParticipants.delete(identity);
    this.emit("participantDisconnected", participant);
  }

  disconnect(): void {
    this.isConnected = false;
    this.emit("disconnected");
  }
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
    personaIdentity?: string | null;
  } = {},
): StubContext {
  const room = new StubRoom();
  room.isConnected = options.connected ?? true;
  room.mockedTools = options.mockedTools ?? [];
  const personaIdentity =
    options.personaIdentity === undefined
      ? "egma-persona"
      : options.personaIdentity;
  if (personaIdentity !== null) {
    room.remoteParticipants.set(personaIdentity, { identity: personaIdentity });
  }
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

beforeAll(async () => {
  initializeLogger({ pretty: false, level: "silent" });
  collector = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/x-protobuf" });
    response.end();
  });
  await new Promise<void>((resolve) => collector.listen(0, "127.0.0.1", resolve));
  collectorUrl = `http://127.0.0.1:${(collector.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => collector.close(() => resolve()));
});

beforeEach(() => {
  vi.stubEnv("EGMA_URL", collectorUrl);
  vi.stubEnv("EGMA_API_KEY", PROJECT_KEY);
  telemetry.setTracerProvider(new ProxyTracerProvider());
  vi.spyOn(trace, "getTracerProvider").mockReturnValue(
    new ProxyTracerProvider(),
  );
  // Egma builds its own provider in these rooms. Registering it globally
  // would leak one test's telemetry into the next.
  vi.spyOn(NodeTracerProvider.prototype, "register").mockImplementation(
    () => undefined,
  );
});

/** What Egma's own provider is exporting, for a test that wants to read it. */
function whatEgmaExports(): InMemorySpanExporter {
  const exported = new InMemorySpanExporter();
  exportStateForTests()!.registerSpanProcessor(new SimpleSpanProcessor(exported));
  return exported;
}

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
  vi.useRealTimers();
  await Promise.allSettled(
    contexts
      .splice(0)
      .flatMap((ctx) => ctx.shutdownCallbacks)
      .map(async (callback) => callback()),
  );
  await Promise.allSettled(sessions.splice(0).map(async (one) => one.close()));
  resetExportForTests();
  telemetry.setTracerProvider(new ProxyTracerProvider());
  otelContext.disable();
  trace.disable();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("egma.simulation", () => {
  it("exports committed startup say speech under the simulation room before its completion root", async () => {
    const agent = new voice.Agent({ instructions: "Book appointments." });
    const ctx = context("egma-sim-sim_132_greeting");
    const oneSession = session();
    await simulation(agent, asJobContext(ctx), oneSession);
    const exported = whatEgmaExports();
    await oneSession.start({ agent });
    await oneSession.say("Hello, I can help you schedule an appointment!").waitForPlayout();
    await oneSession.close();
    const spans = exported.getFinishedSpans();
    const greeting = spans.find((span) => span.name === "conversation_item")!;
    const root = spans.find((span) => span.name === "agent_session")!;
    expect(greeting.attributes).toMatchObject({
      [PROVIDER_REFERENCE]: "egma-sim-sim_132_greeting",
      "lk.pii.response.text": "Hello, I can help you schedule an appointment!",
    });
    expect(greeting.spanContext().traceId).toBe(root.spanContext().traceId);
    expect(spans.indexOf(greeting)).toBeLessThan(spans.indexOf(root));
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

    await simulation(agent, asJobContext(ctx), oneSession);
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

  it.each([1401])(
    "errors the call and never runs the real tool when Egma is not reached (%i)",
    async (code) => {
      const real = vi.fn(async ({ value }: Record<string, unknown>) =>
        `real:${String(value)}`,
      );
      const agent = agentWithTool("check_calendar", real);
      const ctx = context(`egma-sim-sim_125_${code}`, {
        mockedTools: ["check_calendar"],
      });
      ctx.room.toolError = new RpcError(code, "recipient not found");
      const oneSession = session({
        llm: fakeLlmCalling("find it", "check_calendar", { value: "Friday" }),
      });

      await simulation(agent, asJobContext(ctx), oneSession);
      const result = await run(oneSession, agent, "find it");

      // A mocked tool exists because this test answers for it, so running
      // its real implementation books the real appointment and charges the
      // real card. An unreachable Egma is the one moment that must not
      // happen, not the moment to make it happen.
      expect(real).not.toHaveBeenCalled();
      const output = result.events.find(
        (event) => event.type === "function_call_output",
      );
      expect(output?.item.isError).toBe(true);
      expect(output?.item.output).toContain("recipient not found");
    },
  );

  it("does not reach for a tool attached after setup when Egma is not reached", async () => {
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

    await simulation(agent, asJobContext(ctx), oneSession);
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
    expect(current).not.toHaveBeenCalled();
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

    await simulation(agent, asJobContext(ctx), oneSession);
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

    await simulation(agent, asJobContext(ctx), oneSession);
    const result = await run(oneSession, agent, "find it");

    expect(real).not.toHaveBeenCalled();
    const output = result.events.find(
      (event) => event.type === "function_call_output",
    );
    expect(output?.item.isError).toBe(true);
    expect(output?.item.output).toContain("the calendar is down");
  });

  it("waits for Egma after the old startup deadline", async () => {
    vi.useFakeTimers();
    const agent = agentWithTool("check_calendar", async () => "real");
    const ctx = context("egma-sim-sim_128_late", {
      mockedTools: ["check_calendar"],
      personaIdentity: null,
    });
    const settled = simulation(agent, asJobContext(ctx), session()).then(
      () => "completed" as const,
      (error: unknown) => error,
    );

    await vi.advanceTimersByTimeAsync(45_001);
    ctx.room.arrive("egma-persona");
    await vi.advanceTimersByTimeAsync(1);

    await expect(settled).resolves.toBe("completed");
  });

  it("ends the participant wait when the room disconnects", async () => {
    const agent = agentWithTool("check_calendar", async () => "real");
    const ctx = context("egma-sim-sim_128_disconnect", {
      personaIdentity: null,
    });
    const waiting = simulation(agent, asJobContext(ctx), session());
    await new Promise((resolve) => setTimeout(resolve, 0));

    ctx.room.disconnect();

    await expect(waiting).rejects.toThrow(/room disconnected/u);
    expect(ctx.room.eventNames()).toEqual([]);
  });

  it.each([1400, 1502])(
    "retries the same census after transient hello failure %i",
    async (code) => {
      const agent = agentWithTool("check_calendar", async () => "real");
      const ctx = context(`egma-sim-sim_128_retry_${code}`, {
        mockedTools: ["check_calendar"],
      });
      ctx.room.helloErrors.push(
        new RpcError(code, "one hello attempt was lost"),
      );

      await simulation(agent, asJobContext(ctx), session());

      const calls = ctx.room.localParticipant.performRpc.mock.calls;
      expect(calls.map(([call]) => call.method)).toEqual([
        "egma.hello",
        "egma.hello",
      ]);
      expect(calls[0]![0].payload).toBe(calls[1]![0].payload);
    },
  );

  it("accepts the token-endpoint persona identity but refuses two claimants", async () => {
    const agent = agentWithTool("check_calendar", async () => "real");
    const accepted = context("egma-sim-sim_129", {
      mockedTools: ["check_calendar"],
      personaIdentity: "egma-persona-sim_129",
    });

    await simulation(agent, asJobContext(accepted), session());

    expect(accepted.room.localParticipant.performRpc).toHaveBeenCalledOnce();
    for (const callback of accepted.shutdownCallbacks) await callback();

    // A second job in one process is refused on its own account, and this
    // test is about the two claimants rather than about that, so the
    // process is put back the way a fresh one starts.
    resetExportForTests();
    telemetry.setTracerProvider(new ProxyTracerProvider());
    const refused = context("egma-sim-sim_130", {
      mockedTools: ["check_calendar"],
    });
    refused.room.remoteParticipants.set("egma-persona-sim_130", {
      identity: "egma-persona-sim_130",
    });

    await expect(
      simulation(agent, asJobContext(refused), session()),
    ).rejects.toThrow(NotReported);

    // Not one word on the wire: the census is this agent's whole tool
    // inventory, and it is never sent to somebody who might not be Egma.
    expect(refused.room.localParticipant.performRpc).not.toHaveBeenCalled();
  });

  it("closes the session only when the exact Egma persona departs", async () => {
    const agent = agentWithTool("check_calendar", async () => "real");
    const ctx = context("egma-sim-sim_129_departure", {
      personaIdentity: "egma-persona-sim_129_departure",
    });
    ctx.room.remoteParticipants.set("somebody-else", {
      identity: "somebody-else",
    });
    const oneSession = session();
    const shutdown = vi.spyOn(oneSession, "shutdown");

    await simulation(agent, asJobContext(ctx), oneSession);
    ctx.room.depart("somebody-else");
    await Promise.resolve();
    expect(shutdown).not.toHaveBeenCalled();

    ctx.room.depart("egma-persona-sim_129_departure");
    expect(shutdown).toHaveBeenCalledOnce();
    expect(shutdown).toHaveBeenCalledWith({ drain: true });

    await ctx.shutdownCallbacks.at(-1)!();
    expect(ctx.room.eventNames()).toEqual([]);
  });

  it("closes the simulation session when the room is lost", async () => {
    const agent = agentWithTool("check_calendar", async () => "real");
    const ctx = context("egma-sim-sim_129_room_loss");
    const oneSession = session();
    const shutdown = vi.spyOn(oneSession, "shutdown");

    await simulation(agent, asJobContext(ctx), oneSession);
    ctx.room.disconnect();

    expect(shutdown).toHaveBeenCalledOnce();
    expect(shutdown).toHaveBeenCalledWith({ drain: true });
    await ctx.shutdownCallbacks.at(-1)!();
    expect(ctx.room.eventNames()).toEqual([]);
  });

  it("shares LiveKit's guarded shutdown when the caller departure reaches both listeners", async () => {
    const agent = agentWithTool("check_calendar", async () => "real");
    const ctx = context("egma-sim-sim_129_native_close");
    const oneSession = session();
    const closed: unknown[] = [];

    await simulation(agent, asJobContext(ctx), oneSession);
    const exported = whatEgmaExports();
    await oneSession.start({ agent });
    oneSession.on(voice.AgentSessionEventTypes.Close, (event) => {
      closed.push(event);
    });
    ctx.room.on("participantDisconnected", () => {
      (oneSession as unknown as {
        _closeSoon(options: { reason: string }): void;
      })._closeSoon({ reason: "participant_disconnected" });
    });

    ctx.room.depart("egma-persona");

    await vi.waitFor(() => expect(closed).toHaveLength(1), { timeout: 5_000 });
    expect(
      exported.getFinishedSpans().filter(({ name }) => name === "agent_session"),
    ).toHaveLength(1);
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

    await simulation(initial, asJobContext(ctx), oneSession);
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

  it("stamps the room's name on the resource and on every span", async () => {
    // Two copies, because a customer who already runs OpenTelemetry hands
    // this SDK a provider whose resource was fixed before it ran. The
    // resource copy is read first by Egma's door; the span copy is what
    // covers the provider this SDK did not build.
    const agent = agentWithTool("check_calendar", async () => "real");
    const ctx = context("egma-sim-sim_141", {
      mockedTools: ["check_calendar"],
    });

    await simulation(agent, asJobContext(ctx), session());
    const exported = whatEgmaExports();
    exportStateForTests()!
      .provider.getTracer("livekit-agents")
      .startSpan("agent turn")
      .end();

    const [span] = exported.getFinishedSpans();
    expect(span!.resource.attributes[PROVIDER_REFERENCE]).toBe(
      "egma-sim-sim_141",
    );
    expect(span!.attributes[PROVIDER_REFERENCE]).toBe("egma-sim-sim_141");
  });

  it("finishes the session-close flush before the job shutdown flush returns", async () => {
    const agent = agentWithTool("check_calendar", async () => "real");
    const ctx = context("egma-sim-sim_143", {
      mockedTools: ["check_calendar"],
    });
    const oneSession = session();

    await simulation(agent, asJobContext(ctx), oneSession);
    const processor = exportStateForTests()!.processor;
    let finishCloseFlush: (() => void) | undefined;
    const closeFlush = new Promise<void>((resolve) => {
      finishCloseFlush = resolve;
    });
    const flushed = vi
      .spyOn(processor, "forceFlush")
      .mockImplementationOnce(() => closeFlush)
      .mockResolvedValue(undefined);

    await oneSession.start({ agent });
    await oneSession.close();
    await vi.waitFor(() => expect(flushed).toHaveBeenCalledTimes(1), {
      timeout: 5_000,
    });

    // The job's own flush is the backstop, and it is the first callback
    // the export registered. It must wait for the HTTP export started at
    // session close instead of letting the worker exit underneath it.
    let shutdownFinished = false;
    const shutdown = ctx.shutdownCallbacks[0]!().then(() => {
      shutdownFinished = true;
    });
    await Promise.resolve();
    expect(shutdownFinished).toBe(false);
    expect(flushed).toHaveBeenCalledTimes(1);

    finishCloseFlush?.();
    await shutdown;

    expect(flushed).toHaveBeenCalledTimes(2);
  });

  it.each(["EGMA_API_KEY"])(
    "refuses a simulation with nowhere to report when %s is missing",
    async (missing) => {
      // The SDK is required for a LiveKit simulation, so its settings are
      // required with it. It stops before the room is connected and before
      // a word is sent.
      vi.stubEnv(missing, "");
      const agent = agentWithTool("check_calendar", async () => "real");
      const ctx = context("egma-sim-sim_144", {
        connected: false,
        mockedTools: ["check_calendar"],
      });

      await expect(
        simulation(agent, asJobContext(ctx), session()),
      ).rejects.toThrow(new RegExp(missing, "u"));

      expect(ctx.connectCalls).toBe(0);
      expect(ctx.room.localParticipant.performRpc).not.toHaveBeenCalled();
    },
  );

  it.each([
    // The separator with nothing after it names no simulation, so it is a
    // prefix rather than an identity. The census is this agent's whole
    // tool inventory, so a name that is merely alike may never receive it.
    ["egma-persona-", false],
    ["egma-personality-quiz", false],
    ["caller-8871", false],
  ] as const)("answers to Egma's name: %s → %s", (identity, expected) => {
    expect(answersToEgma(identity)).toBe(expected);
  });
});
