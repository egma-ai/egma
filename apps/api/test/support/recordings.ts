import {
  claimSimulations,
  completeSimulation,
  createPersona,
  startSimulation,
  type AuthContext,
} from "@egma/db";
import type { FastifyInstance } from "fastify";
import { expect } from "vitest";

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

/** A voice connection that needs no carrier, so a run over it starts anywhere. */
const A_VOICE_AGENT = {
  type: "retell",
  modality: "voice",
  config: { retellAgentId: "agent_in_retell_1" },
  credentials: { apiKey: "retell-secret-A1B2C3D4WXYZ" },
} as const;

/** The same shape, over chat, for the refusal that a chat has no audio. */
const A_CHAT_AGENT = {
  type: "retell",
  modality: "chat",
  config: { retellAgentId: "agent_in_retell_2" },
  credentials: { apiKey: "retell-secret-A1B2C3D4WXYZ" },
} as const;

const A_TEST = {
  scenario:
    "Their cleaning is booked for Thursday morning and has to move to any afternoon next week.",
  expected_behaviors: ["confirms the new time back before finishing"],
} as const;

/** Who moved the conversations, as a simulator names itself. */
const CLAIMANT = "simulator-blue-1";

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

export type ConductedRunOptions = {
  /** What the recorded conversation reports as its recording. */
  readonly reference: string;
  /** What band it says it heard. Telephony's narrow one by default. */
  readonly measuredAudioBandHertz?: number;
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

  const registered = await ask(app, "POST", "/api/agents", who.key, {
    name: `Front desk ${modality}`,
    connection: modality === "voice" ? A_VOICE_AGENT : A_CHAT_AGENT,
  });
  expect(registered.statusCode, JSON.stringify(registered.body)).toBe(201);
  const connectionId = (registered.body.connection as { id: string }).id;

  // Two people to call about the one test, which is what makes a run of two
  // conversations rather than a run of one.
  for (const name of ["Impatient Rita", "Deliberate Sam"]) {
    await createPersona(who.auth, { name, traits: NEUTRAL_TRAITS });
  }

  const pushed = await ask(app, "POST", "/api/tests", who.key, {
    ...A_TEST,
    name: "Reschedules a booked appointment",
    personas: ["Impatient Rita", "Deliberate Sam"],
  });
  expect(pushed.statusCode, JSON.stringify(pushed.body)).toBe(201);

  const started = await ask(app, "POST", "/api/runs", who.key, {
    connection: connectionId,
    test_versions: [String(pushed.body.version_id)],
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
          measuredAudioBandHertz: options.measuredAudioBandHertz ?? 8000,
        }),
  });

  await startSimulation(who.auth, silent.id, CLAIMANT);
  await completeSimulation(who.auth, silent.id, CLAIMANT, {
    endingReason: "agent_ended",
    turnCount: 4,
  });

  return { runId, heard: heard.id, silent: silent.id };
}
