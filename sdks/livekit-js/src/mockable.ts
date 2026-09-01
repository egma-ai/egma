import { type JobContext, llm, voice } from "@livekit/agents";

import {
  HELLO_METHOD,
  HELLO_TIMEOUT_SECONDS,
  RESPONSE_TIMEOUT_SECONDS,
  TOOL_METHOD,
  SeamError,
  fitsOnTheWire,
  helloRequest,
  isEgmaNotListeningYet,
  isEgmaNotReached,
  mockedToolsIn,
  servedIn,
  toolRequest,
} from "./mock-tool-seam.ts";

const SIMULATION_ROOM_PREFIX = "egma-sim-";
const EGMA_PERSONA = "egma-persona";
const STARTUP_SECONDS = 45;
const POLL_MILLISECONDS = 250;
const PARTICIPANT_CONNECTED = "participantConnected";

type MockTool = Parameters<typeof voice.testing.withMockTools>[1][string];
type AgentConstructor = Parameters<
  typeof voice.testing.withMockTools
>[0];
type MockBinding = ReturnType<typeof voice.testing.withMockTools>;
type CensusEntry = {
  readonly name: string;
  readonly schema: Record<string, unknown>;
};
type Seat = {
  readonly ctx: JobContext;
  readonly identity: string;
};

let processOwner: voice.AgentSession | undefined;

/**
 * Let Egma answer selected tool calls during one simulation.
 *
 * Call this once after constructing the agent and session, and before
 * `AgentSession.start`. Production rooms return without any side effect.
 */
export async function mockable(
  agent: voice.Agent,
  ctx: JobContext,
  session: voice.AgentSession,
): Promise<void> {
  const roomName = ctx?.job?.room?.name;
  if (
    typeof roomName !== "string" ||
    !roomName.startsWith(SIMULATION_ROOM_PREFIX)
  ) {
    return;
  }

  claimProcess(session);
  let lifecycleInstalled = false;
  try {
    const census = censusMessage([agent]);
    fitsOnTheWire("this agent's census of tools", census);
    const deadline = Date.now() + STARTUP_SECONDS * 1_000;

    if (!ctx.room.isConnected) {
      try {
        await ctx.connect();
      } catch (error) {
        warnFailOpen(roomName, "the room could not be connected", error);
        return;
      }
    }

    const identity = await findEgmaPersona(ctx, deadline, roomName);
    if (identity === undefined) {
      return;
    }

    const seat: Seat = { ctx, identity };
    let mockedTools: string[];
    try {
      const reply = await helloWhenListening(seat, census, deadline);
      mockedTools = mockedToolsIn(reply);
    } catch (error) {
      warnFailOpen(roomName, "Egma did not accept the tool census", error);
      return;
    }

    installLifecycle({ agent, ctx, mockedTools, roomName, seat, session });
    lifecycleInstalled = true;
  } catch (error) {
    if (error instanceof SeamError) {
      warnFailOpen(roomName, "the tool census could not be sent", error);
      return;
    }
    throw error;
  } finally {
    if (!lifecycleInstalled) {
      releaseProcess(session);
    }
  }
}

function claimProcess(session: voice.AgentSession): void {
  if (processOwner !== undefined) {
    throw new Error(
      "Egma mock tools already belong to another LiveKit AgentSession in this process. LiveKit must run one job per process, or the first session must close before another simulation starts.",
    );
  }
  processOwner = session;
}

function releaseProcess(session: voice.AgentSession): void {
  if (processOwner === session) {
    processOwner = undefined;
  }
}

function censusEntries(agent: voice.Agent): CensusEntry[] {
  return Object.entries(agent.toolCtx.functionTools)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, tool]) => ({ name, schema: schemaOf(name, tool) }));
}

function censusMessage(agents: readonly voice.Agent[]): string {
  const cumulative = new Map<string, CensusEntry>();
  for (const agent of agents) {
    for (const entry of censusEntries(agent)) {
      cumulative.set(entry.name, entry);
    }
  }
  return helloRequest([...cumulative.values()]);
}

function schemaOf(
  name: string,
  tool: NonNullable<ReturnType<voice.Agent["toolCtx"]["getFunctionTool"]>>,
): Record<string, unknown> {
  try {
    return {
      name,
      description: tool.description,
      parameters: llm.toJsonSchema(tool.parameters),
    };
  } catch {
    return { name, description: tool.description };
  }
}

async function findEgmaPersona(
  ctx: JobContext,
  deadline: number,
  roomName: string,
): Promise<string | undefined> {
  let wake: (() => void) | undefined;
  const participantConnected = () => wake?.();
  ctx.room.on(PARTICIPANT_CONNECTED, participantConnected);
  try {
    while (true) {
      const found = [...ctx.room.remoteParticipants.values()]
        .map(({ identity }) => identity)
        .filter(answersToEgma)
        .sort();

      if (found.length === 1) {
        return found[0];
      }
      if (found.length > 1) {
        console.error(
          `Egma: ${JSON.stringify(roomName)} has more than one participant using Egma's reserved persona identity, so no tools were wrapped.`,
        );
        return undefined;
      }

      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        console.error(
          `Egma: no ${EGMA_PERSONA} participant joined simulation ${JSON.stringify(roomName)} within ${STARTUP_SECONDS} seconds, so no tools were wrapped.`,
        );
        return undefined;
      }

      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, Math.min(remaining, POLL_MILLISECONDS));
        wake = () => {
          clearTimeout(timer);
          resolve();
        };
      });
      wake = undefined;
    }
  } finally {
    wake = undefined;
    ctx.room.off(PARTICIPANT_CONNECTED, participantConnected);
  }
}

function answersToEgma(identity: string): boolean {
  return (
    identity === EGMA_PERSONA ||
    (identity.startsWith(`${EGMA_PERSONA}-`) &&
      identity.length > EGMA_PERSONA.length + 1)
  );
}

async function helloWhenListening(
  seat: Seat,
  census: string,
  deadline: number,
): Promise<string> {
  while (true) {
    try {
      return await ask(
        seat,
        HELLO_METHOD,
        census,
        HELLO_TIMEOUT_SECONDS,
      );
    } catch (error) {
      const code = rpcCode(error);
      if (
        code === undefined ||
        !isEgmaNotListeningYet(code) ||
        Date.now() + POLL_MILLISECONDS >= deadline
      ) {
        throw error;
      }
      await delay(POLL_MILLISECONDS);
    }
  }
}

async function ask(
  seat: Seat,
  method: string,
  payload: string,
  timeoutSeconds: number,
): Promise<string> {
  const participant = seat.ctx.room.localParticipant;
  if (participant === undefined) {
    throw new Error("the LiveKit room has no local participant");
  }
  return participant.performRpc({
    destinationIdentity: seat.identity,
    method,
    payload,
    responseTimeout: timeoutSeconds * 1_000,
  });
}

function installLifecycle({
  agent,
  ctx,
  mockedTools,
  roomName,
  seat,
  session,
}: {
  readonly agent: voice.Agent;
  readonly ctx: JobContext;
  readonly mockedTools: readonly string[];
  readonly roomName: string;
  readonly seat: Seat;
  readonly session: voice.AgentSession;
}): void {
  const bindings: MockBinding[] = [];
  const discovered = new Map(
    censusEntries(agent).map((entry) => [entry.name, entry] as const),
  );
  const refreshes = new Set<Promise<void>>();
  let refreshTail = Promise.resolve();
  let lastSelected = agent;
  let closed = false;
  let cleanupPromise: Promise<void> | undefined;

  const bind = (selected: voice.Agent): void => {
    const couriers: Record<string, MockTool> = {};
    for (const name of mockedTools) {
      couriers[name] = courier(name, selected, seat);
    }
    bindings.push(
      voice.testing.withMockTools(
        selected.constructor as AgentConstructor,
        couriers,
      ),
    );
  };

  const refreshCensus = (snapshot: readonly CensusEntry[]): void => {
    const previous = refreshTail;
    const refresh = (async () => {
      await previous;
      if (closed) return;
      try {
        const message = helloRequest(snapshot);
        fitsOnTheWire("the cumulative handoff census", message);
        const reply = await ask(
          seat,
          HELLO_METHOD,
          message,
          HELLO_TIMEOUT_SECONDS,
        );
        mockedToolsIn(reply);
      } catch (error) {
        console.warn(
          `Egma: the cumulative tool census for simulation ${JSON.stringify(roomName)} could not be refreshed; existing mock tools remain active. ${messageOf(error)}`,
        );
      }
    })();
    refreshTail = refresh;
    refreshes.add(refresh);
    void refresh.finally(() => refreshes.delete(refresh));
  };

  const conversationItemAdded = (): void => {
    if (closed) return;
    try {
      const selected = session.currentAgent;
      if (selected === lastSelected) return;

      bind(selected);
      lastSelected = selected;

      let changed = false;
      for (const entry of censusEntries(selected)) {
        const existing = discovered.get(entry.name);
        if (JSON.stringify(existing) !== JSON.stringify(entry)) {
          discovered.set(entry.name, entry);
          changed = true;
        }
      }
      if (changed) {
        refreshCensus([...discovered.values()]);
      }
    } catch (error) {
      console.warn(
        `Egma: LiveKit handed off inside simulation ${JSON.stringify(roomName)}, but its mock tools could not be prepared. ${messageOf(error)}`,
      );
    }
  };

  const sessionClosed = (): void => {
    void cleanup();
  };

  const cleanup = (): Promise<void> => {
    if (cleanupPromise !== undefined) return cleanupPromise;
    cleanupPromise = (async () => {
      closed = true;
      session.off(
        voice.AgentSessionEventTypes.ConversationItemAdded,
        conversationItemAdded,
      );
      session.off(voice.AgentSessionEventTypes.Close, sessionClosed);
      for (let index = bindings.length - 1; index >= 0; index -= 1) {
        try {
          bindings[index]?.[Symbol.dispose]();
        } catch (error) {
          console.warn(
            `Egma: a LiveKit mock binding could not close. ${messageOf(error)}`,
          );
        }
      }
      bindings.length = 0;
      releaseProcess(session);
      await Promise.allSettled([...refreshes]);
    })();
    return cleanupPromise;
  };

  try {
    bind(agent);
    session.on(
      voice.AgentSessionEventTypes.ConversationItemAdded,
      conversationItemAdded,
    );
    session.on(voice.AgentSessionEventTypes.Close, sessionClosed);
    ctx.addShutdownCallback(cleanup);
  } catch (error) {
    session.off(
      voice.AgentSessionEventTypes.ConversationItemAdded,
      conversationItemAdded,
    );
    session.off(voice.AgentSessionEventTypes.Close, sessionClosed);
    for (let index = bindings.length - 1; index >= 0; index -= 1) {
      bindings[index]?.[Symbol.dispose]();
    }
    throw error;
  }
}

function courier(name: string, agent: voice.Agent, seat: Seat): MockTool {
  return async (...invocation: unknown[]): Promise<unknown> => {
    const arguments_ = recordOrUndefined(invocation[0]);
    let asking: string;
    try {
      asking = toolRequest(name, arguments_);
      fitsOnTheWire(`the call to ${JSON.stringify(name)}`, asking);
    } catch (error) {
      throw new llm.ToolError(
        `Egma could not answer ${name}: ${messageOf(error)}`,
      );
    }

    let reply: string;
    try {
      reply = await ask(
        seat,
        TOOL_METHOD,
        asking,
        RESPONSE_TIMEOUT_SECONDS,
      );
    } catch (error) {
      const code = rpcCode(error);
      if (code !== undefined && isEgmaNotReached(code)) {
        return runRealTool(name, agent, invocation, error);
      }
      throw new llm.ToolError(
        `Egma could not answer ${name}: ${messageOf(error)}`,
      );
    }

    try {
      const served = servedIn(reply);
      if (served.failed) {
        throw new llm.ToolError(served.message);
      }
      return served.value;
    } catch (error) {
      if (error instanceof llm.ToolError) throw error;
      throw new llm.ToolError(
        `Egma could not answer ${name}: ${messageOf(error)}`,
      );
    }
  };
}

async function runRealTool(
  name: string,
  agent: voice.Agent,
  invocation: readonly unknown[],
  refused: unknown,
): Promise<unknown> {
  const real = agent.toolCtx.getFunctionTool(name);
  if (real === undefined) {
    throw new llm.ToolError(`${name} could not be run`);
  }
  console.warn(
    `Egma: its participant was not reached for ${JSON.stringify(name)}, so the agent's own tool ran. ${messageOf(refused)}`,
  );
  return real.execute(invocation[0] as never, invocation[1] as never);
}

function recordOrUndefined(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function rpcCode(error: unknown): number | undefined {
  if (error === null || typeof error !== "object" || !("code" in error)) {
    return undefined;
  }
  const code = error.code;
  return typeof code === "number" && Number.isInteger(code) ? code : undefined;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function warnFailOpen(roomName: string, reason: string, error: unknown): void {
  console.warn(
    `Egma: ${reason} for simulation ${JSON.stringify(roomName)}, so no tools were wrapped and the agent's own tools will run. ${messageOf(error)}`,
  );
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
