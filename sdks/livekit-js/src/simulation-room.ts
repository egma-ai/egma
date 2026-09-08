import { type JobContext, llm, voice } from "@livekit/agents";
import { type BatchSpanProcessor } from "@opentelemetry/sdk-trace-node";

import { flushNow, installExport, type ExportOptions } from "./export.ts";
import {
  HELLO_METHOD,
  HELLO_TIMEOUT_SECONDS,
  RESPONSE_TIMEOUT_SECONDS,
  TOOL_METHOD,
  UNSUPPORTED_PROTOCOL_VERSION,
  SeamError,
  fitsOnTheWire,
  helloRequest,
  isEgmaNotReached,
  isEgmaRefusal,
  isTransientHelloFailure,
  mockedToolsIn,
  servedIn,
  toolRequest,
} from "./mock-tool-seam.ts";
import { SIMULATION_ROOM_PREFIX } from "./room.ts";

export const SIMULATION_VERB = "egma.simulation";
const EGMA_PERSONA = "egma-persona";
const HELLO_RETRY_MILLISECONDS = 250;
const PARTICIPANT_CONNECTED = "participantConnected";
const PARTICIPANT_DISCONNECTED = "participantDisconnected";
const ROOM_DISCONNECTED = "disconnected";

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
 * A simulation could not complete the Egma startup exchange.
 * Thrown by {@link simulation} before AgentSession.start so tools cannot run
 * without the required mock setup. Never thrown in a production room.
 */
export class NotReported extends Error {
  override readonly name = "NotReported";
}

export type SimulationOptions = ExportOptions;

/**
 * Set up mock tools and agent POV export for a simulation.
 * Await once after constructing the agent and session, before AgentSession.start.
 * In production rooms this does nothing, including no connection or export setup.
 *
 * Throws {@link NotReported} when the room or Egma exchange fails. Throws Error
 * for invalid configuration, unsupported LiveKit APIs, or unsafe exporter setup.
 * Set endpoint and apiKey in options or through EGMA_URL and EGMA_API_KEY.
 *
 * Use one LiveKit job per process. LiveKit keys mock tools by agent class, and the
 * exporter resource fixes the room name; these settings cannot be isolated per job.
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
    if (!ctx.room.isConnected) {
      try {
        await ctx.connect();
      } catch (error) {
        throw notReported(roomName, "this room could not be connected", error);
      }
    }

    const startup = new Startup(ctx, roomName);
    let identity = "";
    let seat: Seat;
    let mockedTools: string[];
    try {
      identity = await findEgmaPersona(startup, roomName);
      startup.expect(identity);
      seat = { ctx, identity };
      const reply = await helloWhenListening(seat, census, startup);
      mockedTools = mockedToolsIn(reply);
    } catch (error) {
      if (error instanceof NotReported) throw error;
      throw notReported(roomName, whyTheHelloWasRefused(error, identity), error);
    } finally {
      startup.close();
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
 * What a refused census means, in the terms it means it in.
 *
 * Four readings, because they send a developer to four different places: a
 * version neither side shares, a participant that was not there to answer, an
 * Egma that answered by refusing, and a reply this SDK could not read. The
 * Python SDK draws the same four, and a developer moving between the two
 * should get the same diagnosis rather than one summary here and four there.
 */
function whyTheHelloWasRefused(error: unknown, identity: string): string {
  if (error instanceof SeamError) {
    return `Egma answered ${HELLO_METHOD} in a shape this SDK cannot read (${messageOf(error)})`;
  }
  const code = rpcCode(error);
  if (code === UNSUPPORTED_PROTOCOL_VERSION) {
    // The one refusal a customer can act on alone. Egma's own sentence
    // carries the two version numbers; the sentence around this one carries
    // the package they belong to.
    return `Egma here speaks a version of the mock-tool exchange this SDK does not: ${messageOf(error)}`;
  }
  if (code !== undefined && isEgmaNotReached(code)) {
    return `no Egma participant answered at ${JSON.stringify(identity)} in this room (${messageOf(error)})`;
  }
  if (code !== undefined) {
    return `Egma refused this agent's census with code ${String(code)}: ${messageOf(error)}`;
  }
  return `Egma did not accept the tool census (${messageOf(error)})`;
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

class Startup {
  readonly ctx: JobContext;
  readonly roomName: string;
  revision = 0;

  private active = true;
  private identity: string | undefined;
  private ended: NotReported | undefined;
  private readonly changed = new Set<() => void>();
  private readonly endings = new Set<(error: NotReported) => void>();
  private readonly listeners: Array<[
    string,
    (...arguments_: never[]) => void,
  ]> = [];

  private readonly participantConnected = (participant: {
    identity: string;
  }): void => {
    if (
      this.identity !== undefined &&
      answersToEgma(participant.identity) &&
      participant.identity !== this.identity
    ) {
      this.end("another participant answering to Egma's name joined");
    }
    this.signalChange();
  };

  private readonly participantDisconnected = (participant: {
    identity: string;
  }): void => {
    if (participant.identity === this.identity) {
      this.end(`Egma's participant ${JSON.stringify(this.identity)} disconnected`);
    }
    this.signalChange();
  };

  private readonly roomDisconnected = (): void => {
    this.end("the LiveKit room disconnected during startup");
  };

  constructor(ctx: JobContext, roomName: string) {
    this.ctx = ctx;
    this.roomName = roomName;

    try {
      this.listen(PARTICIPANT_CONNECTED, this.participantConnected);
      this.listen(PARTICIPANT_DISCONNECTED, this.participantDisconnected);
      this.listen(ROOM_DISCONNECTED, this.roomDisconnected);
    } catch (error) {
      this.active = false;
      this.removeListeners();
      throw notReported(
        roomName,
        "this LiveKit room could not expose its startup lifecycle",
        error,
      );
    }

    if (!ctx.room.isConnected) {
      this.roomDisconnected();
    }
  }

  candidates(): string[] {
    return [...this.ctx.room.remoteParticipants.values()]
      .map(({ identity }) => identity)
      .filter(answersToEgma)
      .sort();
  }

  expect(identity: string): void {
    this.identity = identity;
    const candidates = this.candidates();
    if (candidates.length > 1 && candidates.includes(identity)) {
      this.end("another participant answering to Egma's name joined");
    } else if (candidates.length !== 1 || candidates[0] !== identity) {
      this.end(`Egma's participant ${JSON.stringify(identity)} disconnected`);
    }
    this.raiseIfEnded();
  }

  raiseIfEnded(): void {
    if (this.ended !== undefined) throw this.ended;
  }

  async waitForChange(revision: number): Promise<void> {
    this.raiseIfEnded();
    if (this.revision !== revision) return;

    let wake!: () => void;
    const change = new Promise<void>((resolve) => {
      wake = resolve;
      this.changed.add(wake);
    });
    try {
      const ending = this.ending<void>();
      try {
        await Promise.race([change, ending.promise]);
      } finally {
        ending.stop();
      }
      this.raiseIfEnded();
    } finally {
      this.changed.delete(wake);
    }
  }

  async run<T>(operation: () => Promise<T>): Promise<T> {
    this.raiseIfEnded();
    const ending = this.ending<T>();
    try {
      const value = await Promise.race([operation(), ending.promise]);
      this.raiseIfEnded();
      return value;
    } finally {
      ending.stop();
    }
  }

  async pause(): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await this.run(
        () => new Promise<void>((resolve) => {
          timer = setTimeout(resolve, HELLO_RETRY_MILLISECONDS);
        }),
      );
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  close(): void {
    this.active = false;
    this.removeListeners();
    this.changed.clear();
  }

  private signalChange(): void {
    if (!this.active) return;
    this.revision += 1;
    for (const wake of this.changed) wake();
    this.changed.clear();
  }

  private end(why: string): void {
    if (!this.active || this.ended !== undefined) return;
    this.ended = notReported(this.roomName, why, new Error(why));
    for (const reject of this.endings) reject(this.ended);
    this.endings.clear();
    this.signalChange();
  }

  private ending<T>(): { promise: Promise<T>; stop: () => void } {
    this.raiseIfEnded();
    let reject!: (error: NotReported) => void;
    const promise = new Promise<T>((_resolve, rejectPromise) => {
      reject = rejectPromise;
      this.endings.add(reject);
    });
    return { promise, stop: () => this.endings.delete(reject) };
  }

  private listen(
    event: string,
    callback: (...arguments_: never[]) => void,
  ): void {
    const room = this.ctx.room as unknown as {
      on(name: string, listener: (...arguments_: never[]) => void): void;
    };
    room.on(event, callback);
    this.listeners.push([event, callback]);
  }

  private removeListeners(): void {
    for (const [event, callback] of this.listeners.splice(0).reverse()) {
      try {
        const room = this.ctx.room as unknown as {
          off(name: string, listener: (...arguments_: never[]) => void): void;
        };
        room.off(event, callback);
      } catch {
        // Cleanup must not replace the startup result.
      }
    }
  }
}

async function findEgmaPersona(
  startup: Startup,
  roomName: string,
): Promise<string> {
  while (true) {
    startup.raiseIfEnded();
    const revision = startup.revision;
    const found = startup.candidates();

    const only = found[0];
    if (found.length === 1 && only !== undefined) {
      return only;
    }
    if (found.length > 1) {
      throw notReported(
        roomName,
        `${found.length} participants in this room answer to Egma's name (${found.join(", ")}), so which one is Egma is not knowable`,
        new Error("and this SDK will hand a tool inventory to neither"),
      );
    }

    await startup.waitForChange(revision);
  }
}

/**
 * Accept egma-persona or egma-persona- followed by a nonempty simulation ID.
 * Exact matching avoids sending the tool inventory to unrelated prefix matches.
 *
 * @internal Exported for this package's tests; not exported from the root.
 */
export function answersToEgma(identity: string): boolean {
  return (
    identity === EGMA_PERSONA ||
    (identity.startsWith(`${EGMA_PERSONA}-`) &&
      identity.length > EGMA_PERSONA.length + 1)
  );
}

async function helloWhenListening(
  seat: Seat,
  census: string,
  startup: Startup,
): Promise<string> {
  while (true) {
    try {
      return await startup.run(
        () => ask(seat, HELLO_METHOD, census, HELLO_TIMEOUT_SECONDS),
      );
    } catch (error) {
      const code = rpcCode(error);
      if (code === undefined || !isTransientHelloFailure(code)) {
        throw error;
      }
      await startup.pause();
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
      // Mock failures and transport failures both stop the tool call; neither runs the
      // real tool. Distinguish them in the error so the developer can locate the fault.
      const code = rpcCode(error);
      console.warn(
        `Egma: ${
          code === undefined
            ? "the call could not be made for"
            : isEgmaRefusal(code)
              ? "Egma refused"
              : "the room could not carry"
        } the call to ${JSON.stringify(name)}${
          code === undefined ? "" : ` with code ${String(code)}`
        }. ${messageOf(error)}`,
      );
      throw new llm.ToolError(
        `Egma could not answer ${name}: ${messageOf(error)}`,
      );
    }

    try {
      const served = servedIn(reply);
      if (served.failed) {
        // The branch a test forces on purpose. It is the mock tool author's
        // own sentence that reaches the model, never this side's words.
        throw new llm.ToolError(served.message);
      }
      return served.value;
    } catch (error) {
      if (error instanceof llm.ToolError) throw error;
      console.warn(
        `Egma: it answered the call to ${JSON.stringify(name)} unreadably. ${messageOf(error)}`,
      );
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
