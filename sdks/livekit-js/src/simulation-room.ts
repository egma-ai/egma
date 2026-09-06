import { type JobContext, llm, voice } from "@livekit/agents";
import { type BatchSpanProcessor } from "@opentelemetry/sdk-trace-node";

import { flushNow, installExport, type ExportOptions } from "./export.ts";
import {
  HELLO_METHOD,
  HELLO_TIMEOUT_SECONDS,
  RESPONSE_TIMEOUT_SECONDS,
  TOOL_METHOD,
  SeamError,
  fitsOnTheWire,
  helloRequest,
  isEgmaNotListeningYet,
  mockedToolsIn,
  servedIn,
  toolRequest,
} from "./mock-tool-seam.ts";
import { SIMULATION_ROOM_PREFIX } from "./room.ts";

export const SIMULATION_VERB = "egma.simulation";
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
 * This agent could not report to Egma, so this simulation must not run.
 *
 * Thrown out of {@link simulation}, in a simulation room only, whenever the
 * exchange did not end with a hello Egma answered. It stops the session from
 * starting, which is the point: an agent that runs anyway calls its real
 * backends where a mock tool was meant to answer, and Egma's record of the
 * simulation would claim nothing about tools that in fact ran.
 *
 * Never thrown in a production room. There is nothing there to report to, and
 * nothing there to stop.
 */
export class NotReported extends Error {
  override readonly name = "NotReported";
}

export type SimulationOptions = ExportOptions;

/**
 * Report this simulation to Egma, and let Egma answer for its tools.
 *
 * Await it once after constructing the agent and session, and before
 * `AgentSession.start`.
 *
 * In a production room it returns having touched nothing: no wrapping, no
 * exporter, not one message on the wire, and no connect the agent was not
 * already making.
 *
 * In a simulation room it fails closed. Every way this call can end without a
 * hello Egma answered throws {@link NotReported}, so the session never starts
 * and Egma ends the simulation with the same finding from its own side. The
 * endpoint and key are `EGMA_URL` and `EGMA_API_KEY`, or the matching options;
 * a setting that is missing or malformed throws before anything is sent.
 *
 * **One LiveKit job per process.** Two things in this package are process-wide
 * and cannot be made per-job: the mock-tool table, which LiveKit keys by agent
 * class, and the exporter's resource, which is fixed when the provider is
 * built and carries the room this process files spans under. So a second job
 * in this process is refused rather than served wrongly. LiveKit runs one job
 * per process by default; keep it that way.
 */
export async function simulation(
  agent: voice.Agent,
  ctx: JobContext,
  session: voice.AgentSession,
  options: SimulationOptions = {},
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
    // First, because this is the part Egma cannot do without. The agent's
    // spans are this simulation's record of what the agent did, and they are
    // arranged for before anything that can fail.
    const processor = installExport(ctx, options, SIMULATION_VERB, roomName);
    flushWhenTheSessionCloses(session, processor);

    const census = censusMessage([agent]);
    try {
      fitsOnTheWire("this agent's census of tools", census);
    } catch (error) {
      throw notReported(
        roomName,
        "this agent's tools do not fit in one message",
        error,
      );
    }
    const deadline = Date.now() + STARTUP_SECONDS * 1_000;

    if (!ctx.room.isConnected) {
      try {
        await ctx.connect();
      } catch (error) {
        throw notReported(roomName, "this room could not be connected", error);
      }
    }

    const identity = await findEgmaPersona(ctx, deadline, roomName);

    const seat: Seat = { ctx, identity };
    let mockedTools: string[];
    try {
      const reply = await helloWhenListening(seat, census, deadline);
      mockedTools = mockedToolsIn(reply);
    } catch (error) {
      throw notReported(roomName, "Egma did not accept the tool census", error);
    }

    installLifecycle({ agent, ctx, mockedTools, roomName, seat, session });
    lifecycleInstalled = true;
  } finally {
    if (!lifecycleInstalled) {
      releaseProcess(session);
    }
  }
}

/**
 * The one sentence every unreported simulation ends on.
 *
 * One wording for every branch, with that branch's own finding inside it,
 * because what a developer has to do about all of them is the same: look at
 * the room, then look at the installation. The two halves are named in the
 * order they can be checked.
 */
function notReported(
  roomName: string,
  why: string,
  cause: unknown,
): NotReported {
  return new NotReported(
    `simulation ${roomName}: this agent did not report to Egma (${why}: ${messageOf(cause)}), so its session was not started. A LiveKit simulation needs ${SIMULATION_VERB} to reach Egma's participant in the room: check that this worker can reach the LiveKit room and that Egma's own side of this simulation is running, and check that the @egma/livekit package installed here is the one that shipped with this Egma deployment.`,
    { cause },
  );
}

/**
 * Send the tail of the conversation the moment the session ends.
 *
 * The job's own shutdown flush is the backstop and runs later; this one is
 * what puts the last turn in front of a grader that is already waiting on it.
 */
function flushWhenTheSessionCloses(
  session: voice.AgentSession,
  processor: BatchSpanProcessor,
): void {
  session.once(voice.AgentSessionEventTypes.Close, () => {
    void flushNow(processor, "session close");
  });
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
): Promise<string> {
  let wake: (() => void) | undefined;
  const participantConnected = () => wake?.();
  ctx.room.on(PARTICIPANT_CONNECTED, participantConnected);
  try {
    while (true) {
      const found = [...ctx.room.remoteParticipants.values()]
        .map(({ identity }) => identity)
        .filter(answersToEgma)
        .sort();

      const only = found[0];
      if (found.length === 1 && only !== undefined) {
        return only;
      }
      if (found.length > 1) {
        // Refused rather than resolved. Whichever this side picked would
        // receive every tool name and schema this agent has.
        throw notReported(
          roomName,
          `${found.length} participants in this room answer to Egma's name (${found.join(", ")}), so which one is Egma is not knowable`,
          new Error("and this SDK will hand a tool inventory to neither"),
        );
      }

      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw notReported(
          roomName,
          `no Egma participant joined this room within ${STARTUP_SECONDS} seconds`,
          new Error(
            `Egma joins as ${EGMA_PERSONA}, or as that name with the simulation after it`,
          ),
        );
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
      couriers[name] = courier(name, seat);
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

function courier(name: string, seat: Seat): MockTool {
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
      // Every refusal ends the call, and none of them runs the real tool.
      // This courier only exists in a simulation room, and a real backend
      // that runs there books a real appointment and charges a real card —
      // so an Egma this side cannot reach mid-conversation is the one moment
      // a real tool must not be touched, not the moment to touch it. The
      // five transport codes that used to mean "run the real one" are read
      // the same way as every other refusal here.
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

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
