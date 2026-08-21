import { newId } from "@egma/ids";
import {
  claimSimulations,
  completeSimulation,
  createPersona,
  startSimulation,
  type AuthContext,
} from "@egma/db";
import { traceIdOfSimulation } from "@egma/simulation-contract";
import type { FastifyInstance } from "fastify";
import { expect } from "vitest";

import { OTLP_TRACES_PATH } from "../../src/routes/traces.ts";
import { mintKey, NEUTRAL_TRAITS, request as ask } from "./traces.ts";

/**
 * A run somebody can hear: a real run, over a real voice connection, with a
 * recording reference on one of its conversations and nothing on the other.
 *
 * It is here rather than in one test file because three seams want the same
 * arrangement and none of them is about building it — the route suite proves
 * the refusals against it, the object-storage suite fetches from a real store
 * with it, and the browser suite opens the results page on it. Building it three
 * ways would be three chances for the three to be proving something slightly
 * different.
 *
 * **Every step of it goes through the product.** The agent is registered, the
 * test is pushed and the run is started over HTTP, exactly as a terminal does
 * it; only the conversations' movement uses the data-access functions a
 * simulator would call, because no simulator exists in these suites and a fake
 * feed would prove nothing. What lands on the row is what a real report lands.
 */

/** A voice connection that needs no live worker in these route-only tests. */
const A_VOICE_AGENT = {
  agentPlatform: "livekit_agents",
  connectionKind: "livekit_room",
  accessVariant: "livekit_room.project_credentials",
  modality: "voice",
  config: { url: "wss://acme.livekit.cloud" },
  credentials: {
    apiKey: "livekit-key-A1B2C3D4WXYZ",
    apiSecret: "livekit-secret-E5F6G7H8QRST",
  },
} as const;

/** The same shape, over chat, for the refusal that a chat has no audio. */
const A_CHAT_AGENT = {
  agentPlatform: "retell",
  connectionKind: "retell_chat_api",
  accessVariant: "retell_chat_api.api_key",
  modality: "chat",
  config: { retellAgentId: "agent_in_retell_2" },
  credentials: { apiKey: "retell-secret-A1B2C3D4WXYZ" },
} as const;

const A_TEST = {
  scenario:
    "Their cleaning is booked for Thursday morning and has to move to any afternoon next week.",
  expectedBehaviors: ["confirms the new time back before finishing"],
} as const;

/** Who moved the conversations, as a simulator names itself. */
const CLAIMANT = "simulator-blue-1";

/**
 * The service token every test instance is built with. A simulator's spans go
 * in at the same door a customer's do, holding this instead of a customer key.
 */
const SERVICE_TOKEN = "egma_st_held-by-this-test-suite-alone";

/** How wide a window a reader asks about, either side of the exchange. */
const AROUND_IT_SECONDS = 30;

export type FiledTranscript = {
  /** Where the spans are filed, which is the address a reader opens. */
  readonly traceId: string;
  /** A window containing it, because the store is filed by time. */
  readonly from: string;
  readonly to: string;
};

/**
 * One conversation's own telemetry, filed the way its simulator files it.
 *
 * The transcript surface reads spans, and a run's results read rows — so a
 * conversation that has been conducted but never emitted anything has results
 * to show and no transcript to open. This is the other half: two turns and the
 * span they happened inside, posted at the real door with the service token and
 * a resource naming the simulation, which is the only way spans are ever filed
 * as egma's own rather than as a customer's production telemetry.
 *
 * **The trace id is derived and never chosen.** A simulation id and the trace
 * its spans are filed under are the same 128 bits written two ways, and the
 * contract's own function is what writes them here — the same one the emitter
 * uses. Picking an id would prove that a page can read spans; deriving it is
 * what proves a transcript and a run's results are looking at one conversation.
 */
export async function fileTranscriptOf(
  app: FastifyInstance,
  simulationId: string,
  said: { readonly human: string; readonly agent: string },
  openedAt: Date,
): Promise<FiledTranscript> {
  const traceId = traceIdOfSimulation(simulationId);
  expect(traceId, `${simulationId} names a trace`).toBeDefined();
  const trace = traceId ?? "";

  const at = (offsetSeconds: number): string =>
    String(BigInt(openedAt.getTime() + offsetSeconds * 1000) * 1_000_000n);
  const root = `${trace.slice(0, 14)}01`;
  const span = (
    suffix: string,
    name: string,
    parentSpanId: string,
    from: number,
    to: number,
    text?: string,
  ) => ({
    traceId: trace,
    spanId: `${trace.slice(0, 14)}${suffix}`,
    parentSpanId,
    name,
    kind: "SPAN_KIND_INTERNAL",
    startTimeUnixNano: at(from),
    endTimeUnixNano: at(to),
    attributes:
      text === undefined
        ? []
        : [{ key: "egma.turn.text", value: { stringValue: text } }],
  });

  const posted = await app.inject({
    method: "POST",
    url: OTLP_TRACES_PATH,
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${SERVICE_TOKEN}`,
    },
    payload: JSON.stringify({
      resourceSpans: [
        {
          resource: {
            attributes: [
              {
                key: "service.name",
                value: { stringValue: "egma-simulator" },
              },
              {
                key: "egma.simulation_id",
                value: { stringValue: simulationId },
              },
            ],
          },
          scopeSpans: [
            {
              scope: { name: "egma-simulator", version: "1" },
              spans: [
                span("01", "simulation", "", 0, 4),
                span("02", "human_turn", root, 1, 2, said.human),
                span("03", "agent_turn", root, 2, 3, said.agent),
              ],
            },
          ],
        },
      ],
    }),
  });
  expect(posted.statusCode, posted.body).toBe(200);

  return {
    traceId: trace,
    from: new Date(
      openedAt.getTime() - AROUND_IT_SECONDS * 1000,
    ).toISOString(),
    to: new Date(openedAt.getTime() + AROUND_IT_SECONDS * 1000).toISOString(),
  };
}

/**
 * How many runs this file has built, which is what keeps the people calling in
 * one run distinct from the people calling in the next. Two personas of one
 * name in one project make naming a persona in a test ambiguous, and the
 * product refuses that rather than guessing.
 */
let conducted = 0;

export type ConductedRun = {
  readonly runId: string;
  /** The conversation that has audio, and the reference it reported. */
  readonly heard: string;
  /**
   * The conversation that has none — a call that never connected, which is
   * exactly what a failed upload leaves behind too.
   */
  readonly silent: string;
};

/**
 * Where somebody stands: the key their terminal holds, and the context the
 * data-access functions take.
 *
 * Both, because a run is started over HTTP with a key and moved at the seam
 * with a context, and they have to be the same person for the run to be one
 * run.
 */
export type Standing = {
  readonly key: string;
  readonly auth: AuthContext;
};

/**
 * Where the browser's own session stands, worked out from the session itself.
 *
 * The browser suite has a signed-in cookie and nothing else — no ids, no key —
 * so this asks the product the two questions that turn a cookie into both
 * halves above. It is the same answer the pages read, which is what makes the
 * run it then builds a run that browser can actually open.
 */
export async function standingOf(
  app: FastifyInstance,
  cookie: string,
  keyName: string,
): Promise<Standing> {
  const me = await app.inject({ method: "GET", url: "/api/me", headers: { cookie } });
  expect(me.statusCode, me.body).toBe(200);
  const who = me.json() as {
    user: { id: string };
    organizations: { id: string }[];
    projects: { id: string }[];
  };
  const organizationId = who.organizations[0]?.id ?? "";
  const projectId = who.projects[0]?.id ?? "";
  expect(organizationId, "the session names an organization").not.toBe("");
  expect(projectId, "the session names a project").not.toBe("");

  return {
    key: await mintKey(app, cookie, keyName, projectId),
    auth: {
      userId: who.user.id,
      organizationId,
      projectId,
      role: "admin",
      via: "session",
    },
  };
}

/**
 * One conversation of a run somebody already started, moved the way a simulator
 * moves it: claimed, started, landed.
 *
 * `aConductedRun` below builds the whole arrangement — agent, test, run — for a
 * caller who only wants the finished state. This is the other half of that, for
 * a caller who started the run *itself* and now needs it to have happened: the
 * browser journey plans and starts a run through the product's own screens, and
 * then has to land a conversation to have any evidence to open.
 *
 * **Only the movement is at this seam, and deliberately.** No simulator runs in
 * these suites, so the alternative is not a real conversation — it is a fake
 * feed, which would prove that a page can render invented rows. What lands here
 * is what a real report lands, through the same data-access functions the
 * simulator calls.
 *
 * Answers the conversation it conducted, which is the address a caller then
 * opens the evidence at.
 *
 * **One conversation is claimed, and only one.** `claimSimulations` is the
 * simulator's own drain: it takes the oldest queued conversations *across the
 * whole instance*, with no way to ask for one run's — deliberately, because a
 * simulator has no business caring whose work it picks up. This helper used to
 * ask for fifty of them and then filter by run, which claimed every other
 * pending run's conversations and never completed one of them. Nothing noticed,
 * because no suite here has ever had two runs in flight at once; the first one
 * to try would have found its own conversations already claimed by a claimant
 * that had walked away, and would have had to work out why from a page that
 * simply never moved.
 *
 * So the capacity is one, which is all this helper ever needed. What it still
 * cannot do is *choose* — if some other run left a conversation queued and
 * older, that is the one that comes back. It is asserted rather than filtered,
 * so the arrangement fails at this line, naming the run it got instead, rather
 * than at whatever the caller went on to assert.
 */
export async function landOneConversationOf(
  auth: AuthContext,
  runId: string,
  options: { readonly reference?: string } = {},
): Promise<string> {
  const [first] = await claimSimulations({ claimant: CLAIMANT, capacity: 1 });
  expect(first, "this run wrote a conversation to claim").toBeDefined();
  expect(
    first?.runId,
    "the oldest queued conversation on this instance belongs to another run, " +
      "so this arrangement has two runs in flight; land the earlier one first " +
      "or start this one in an instance of its own",
  ).toBe(runId);
  const conversation = first?.id ?? "";

  await startSimulation(auth, conversation, CLAIMANT);
  await completeSimulation(auth, conversation, CLAIMANT, {
    endingReason: "agent_ended",
    turnCount: 6,
    ...(options.reference === undefined
      ? {}
      : {
          recordingReference: options.reference,
        }),
  });

  return conversation;
}

export type ConductedRunOptions = {
  /** What the recorded conversation reports as its recording. */
  readonly reference: string;
  /** Chat rather than voice, for the refusal a chat earns. */
  readonly modality?: "voice" | "chat";
  readonly label?: string;
};

/**
 * Two conversations of one run, conducted and landed: the first carrying a
 * recording, the second carrying none.
 *
 * Two rather than one because "no player at all" is as much of this ticket as
 * "a player" is, and the two have to be observable side by side — a page that
 * offered a control for the second would be offering a broken feature, and
 * only a run holding both can catch it.
 */
export async function aConductedRun(
  app: FastifyInstance,
  who: Standing,
  options: ConductedRunOptions,
): Promise<ConductedRun> {
  const modality = options.modality ?? "voice";
  const runs = (conducted += 1);

  const registered = await ask(app, "POST", "/v1/agents", who.key, {
    name: `Front desk ${modality} ${String(runs)}`,
    connection: modality === "voice" ? A_VOICE_AGENT : A_CHAT_AGENT,
  });
  expect(registered.statusCode, JSON.stringify(registered.body)).toBe(201);
  const connectionId = (registered.body.connection as { id: string }).id;

  // Two people to call about the one test, which is what makes a run of two
  // conversations rather than a run of one.
  //
  // Named apart per run rather than reused, because a project holding two
  // people of one name is a project where naming a persona in a test is
  // ambiguous — which the product refuses, correctly, and which a caller
  // wanting a second run has no reason to meet.
  const callers = [`Impatient Rita ${runs}`, `Deliberate Sam ${runs}`];
  for (const name of callers) {
    await createPersona(who.auth, {
      name,
      traits: NEUTRAL_TRAITS,
    });
  }

  const pushed = await ask(app, "POST", "/v1/tests", who.key, {
    ...A_TEST,
    name: `Reschedules a booked appointment ${runs}`,
    personas: callers,
  });
  expect(pushed.statusCode, JSON.stringify(pushed.body)).toBe(201);

  const started = await ask(app, "POST", "/v1/runs", who.key, {
    connectionId: connectionId,
    testVersionIds: [String(pushed.body.versionId)],
    idempotencyKey: newId("run"),
    label: options.label ?? "the whole folder",
  });
  expect(started.statusCode, JSON.stringify(started.body)).toBe(201);
  const runId = String(started.body.id);

  // Moved the way a simulator moves them: claimed, started, landed. The two
  // land differently on purpose — one reports audio and one reports none.
  const claimed = (await claimSimulations({ claimant: CLAIMANT, capacity: 50 }))
    .filter((claim) => claim.runId === runId);
  expect(claimed.length, "both conversations of this run were claimed").toBe(2);

  const [heard, silent] = claimed as [
    (typeof claimed)[number],
    (typeof claimed)[number],
  ];

  await startSimulation(who.auth, heard.id, CLAIMANT);
  await completeSimulation(who.auth, heard.id, CLAIMANT, {
    endingReason: "agent_ended",
    turnCount: 6,
    ...(modality === "chat"
      ? {}
      : {
          recordingReference: options.reference,
        }),
  });

  await startSimulation(who.auth, silent.id, CLAIMANT);
  await completeSimulation(who.auth, silent.id, CLAIMANT, {
    endingReason: "agent_ended",
    turnCount: 4,
  });

  return { runId, heard: heard.id, silent: silent.id };
}
