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
import type { TestApi } from "./api.ts";

/**
 * A running Egma, however this tree spells it.
 *
 * Two arrangements answer for one: the in-process test API calls its Fastify
 * instance `app`, and the listening browser instance calls it `api`. Asking for
 * either rather than picking one keeps a helper both of them use from forcing a
 * rename through a suite that has nothing to do with it.
 */
export type RunningEgma =
  | Pick<TestApi, "app" | "drainEvidence">
  | {
      readonly api: FastifyInstance;
      drainEvidence(): Promise<number>;
    };

function doorOf(egma: RunningEgma): FastifyInstance {
  return "app" in egma ? egma.app : egma.api;
}
import { mintKey, NEUTRAL_PERSON, request as ask } from "./traces.ts";

/**
 * Create an agent, suite, tests, and run through HTTP. Move simulations through
 * data-access calls and attach a recording reference to one, leaving the other
 * without audio. No simulator or live voice agent runs in this fixture.
 */

/**
 * A voice connection that needs no live worker in these route-only tests.
 *
 * The worker name is per-arrangement rather than fixed, because a server and a
 * worker name together are what say two registrations are one agent. Every
 * arrangement here wants an agent of its own, so each names its own worker;
 * a shared name would quietly fold them into one and the second registration
 * would answer `reused` where the suite expects a new agent.
 */
function aVoiceAgent(worker: number) {
  return {
    agentPlatform: "livekit",
    connectionType: "livekit_room",
    accessVariant: "livekit_room.project_credentials",
    modality: "voice",
    config: {
      url: "wss://acme.livekit.cloud",
      agentName: `front-desk-${String(worker)}`,
    },
    credentials: {
      apiKey: "livekit-key-A1B2C3D4WXYZ",
      apiSecret: "livekit-secret-E5F6G7H8QRST",
    },
  } as const;
}

/** The same shape, over chat, for the refusal that a chat has no audio. */
const A_CHAT_AGENT = {
  agentPlatform: "retell",
  connectionType: "retell_chat_api",
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
 * Post synthetic simulation spans through OTLP with the service token. Derive
 * the trace ID from the simulation ID so transcript and recording lookups refer
 * to the same simulation.
 */
export async function fileTranscriptOf(
  egma: RunningEgma,
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

  const posted = await doorOf(egma).inject({
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
  // The door answers on object-store durability; a transcript is read from
  // rows, so the evidence is carried the rest of the way here.
  await egma.drainEvidence();

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
 * Advance one simulation for a run the caller has already started and return
 * its ID. This uses data-access operations without running a simulator.
 *
 * Claim capacity is one because claims read the deployment-wide queue. The
 * helper cannot select a run: assert the claimed run matches instead of silently
 * claiming and abandoning another run's work.
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
    agentPlatform: "retell",
    name: `Front desk ${modality} ${String(runs)}`,
    connection: modality === "voice" ? aVoiceAgent(runs) : A_CHAT_AGENT,
  });
  expect(registered.statusCode, JSON.stringify(registered.body)).toBe(201);
  const agentId = (registered.body.agent as { id: string }).id;
  const connectionId = (registered.body.connection as { id: string }).id;

  const createdSuite = await ask(app, "POST", "/v1/test-suites", who.key, {
    name: `Recording evidence ${String(runs)}`,
  });
  expect(
    createdSuite.statusCode,
    JSON.stringify(createdSuite.body),
  ).toBe(201);
  const suiteId = String(createdSuite.body.id);

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
      ...NEUTRAL_PERSON,
    });
  }

  const pushed = await ask(app, "POST", "/v1/tests", who.key, {
    ...A_TEST,
    suiteId,
    name: `Reschedules a booked appointment ${runs}`,
    personas: callers,
  });
  expect(pushed.statusCode, JSON.stringify(pushed.body)).toBe(201);

  const started = await ask(app, "POST", "/v1/runs", who.key, {
    suiteId,
    agentId,
    connectionId,
    name: options.label ?? "the whole folder",
  });
  expect(started.statusCode, JSON.stringify(started.body)).toBe(201);
  const runId = String(started.body.id);

  const page = await ask(
    app,
    "GET",
    `/v1/runs/${runId}/simulations?pageSize=2`,
    who.key,
  );
  expect(page.statusCode, JSON.stringify(page.body)).toBe(200);
  expect(page.body.nextPageToken).toBeNull();
  const simulations = page.body.simulations as readonly { id: string }[];
  expect(simulations, "the two personas wrote two simulations").toHaveLength(2);
  const simulationIds = new Set(simulations.map((simulation) => simulation.id));

  // Moved the way a simulator moves them: claimed, started, landed. The two
  // land differently on purpose — one reports audio and one reports none.
  const claimed = (await claimSimulations({ claimant: CLAIMANT, capacity: 50 }))
    .filter((claim) => claim.runId === runId);
  expect(claimed.length, "both conversations of this run were claimed").toBe(2);
  expect(new Set(claimed.map((claim) => claim.id))).toEqual(simulationIds);

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
