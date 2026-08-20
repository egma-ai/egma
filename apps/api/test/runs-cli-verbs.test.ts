import {
  claimSimulations,
  completeSimulation,
  createPersona,
  failSimulation,
  startSimulation,
  type AuthContext,
} from "@egma/db";
import { newId } from "@egma/ids";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";

import type { Fetch } from "../../cli/src/platform/device-flow.ts";
import {
  getRun,
  runEvents,
  startRun,
} from "../../cli/src/platform/runs.ts";
import type { SignedIn } from "../../cli/src/platform/signed-in.ts";
import { createApi, type TestApi } from "./support/api.ts";
import {
  contextFor,
  mintKey,
  NEUTRAL_TRAITS,
  signUp,
  type Customer,
} from "./support/traces.ts";

/**
 * `egma run`'s own seam — the client egma actually ships — against the real
 * API and a real Postgres.
 *
 * The rest of this suite drives the routes directly and asserts what a caller
 * observes. This file asks the other question: whether the code a developer
 * runs can start a run, read it back and follow it through this API with
 * nothing changed but its configuration. It imports the client's run module
 * rather than restating what that module sends and reads, so a client and a
 * server that drift apart fail here rather than in somebody's terminal.
 *
 * The transport is the API's own injection rather than a socket, because what
 * is under test is what the two ends say to each other. Nothing in between is
 * stubbed, and no field is adapted.
 */

let api: TestApi;

afterEach(async () => {
  await api?.close();
});

/**
 * The CLI's `fetch`, answered by the API in this process. Everything the
 * client sends travels — the method, the path, the query, the bearer header
 * and the JSON body — and everything the API answers travels back.
 */
function fetchThrough(app: FastifyInstance): Fetch {
  return (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const address = new URL(
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url,
    );

    const sent = init?.headers;
    const headers: Record<string, string> =
      sent instanceof Headers
        ? Object.fromEntries(sent.entries())
        : ((sent ?? {}) as Record<string, string>);

    const injected = await app.inject({
      method: (init?.method ?? "GET") as "GET",
      url: `${address.pathname}${address.search}`,
      headers,
      ...(init?.body === undefined ? {} : { payload: String(init.body) }),
    });

    return new Response(injected.body, {
      status: injected.statusCode,
      headers: { "content-type": "application/json" },
    });
  }) as Fetch;
}

/** What `egma login` leaves on the machine: one instance, and a key for it. */
async function signedInAs(person: Customer): Promise<SignedIn> {
  const key = await mintKey(
    api.app,
    person.cookie,
    "a terminal",
    person.projectId,
  );
  // Any origin does: the transport above answers from this process whatever
  // address it is given, and the client sends the path it would have sent.
  return { url: "http://egma.test", key };
}

/**
 * A deployment `egma self-host setup` has finished with: somewhere to
 * route a call and a number it comes from. See `phone-readiness.ts`.
 */
const PHONE_IS_SET_UP = {
  carrier_trunk_address: "egma-simulator-106e37f8.pstn.twilio.com",
  carrier_trunk_number: "+18885550123",
} as const;

/** A number egma dials, registered the way the wizard registers one. */
const PHONE_CONNECTION = {
  type: "phone",
  modality: "voice",
  config: { phoneNumber: "+15551234567" },
} as const;

const CLAIMANT = "simulator-blue-1";

/** A signed-in developer with an agent to check and two tests to check it. */
async function readyToRun(
  label: string,
  options: { readonly phoneIsSetUp?: boolean } = {},
): Promise<{
  ada: Customer;
  signedIn: SignedIn;
  fetchImpl: Fetch;
  agentId: string;
  connectionId: string;
  versions: string[];
}> {
  api = await createApi(
    label,
    options.phoneIsSetUp === true
      ? { platformSettings: PHONE_IS_SET_UP }
      : {},
  );
  const ada = await signUp(api.app, "ada@acme.example", "Acme");
  const signedIn = await signedInAs(ada);
  const fetchImpl = fetchThrough(api.app);

  const ask = async (url: string, payload: Record<string, unknown>) => {
    const response = await api.app.inject({
      method: "POST",
      url,
      headers: { authorization: `Bearer ${signedIn.key}` },
      payload,
    });
    expect(response.statusCode, response.body).toBe(201);
    return response.json() as Record<string, unknown>;
  };

  const registered = await ask("/api/agents", {
    name: "Front desk",
    connection: {
      type: "retell",
      modality: "chat",
      config: { retellAgentId: "agent_in_retell_1" },
      credentials: { apiKey: "retell-secret-A1B2C3D4WXYZ" },
    },
  });

  await createPersona(contextFor(ada, "member"), {
    name: "Impatient Rita",
    traits: NEUTRAL_TRAITS,
  });

  const versions: string[] = [];
  for (const name of ["Reschedules", "Cancels"]) {
    const test = await ask("/api/tests", {
      name,
      scenario: "Their cleaning is booked for Thursday and has to move.",
      expected_behaviors: ["confirms the new time back before finishing"],
      personas: ["Impatient Rita"],
    });
    versions.push(String(test.version_id));
  }

  return {
    ada,
    signedIn,
    fetchImpl,
    agentId: String((registered.agent as { id: string }).id),
    connectionId: String((registered.connection as { id: string }).id),
    versions,
  };
}

describe("starting a run from the terminal's own code", () => {
  it("reads back every field the terminal draws a run from", async () => {
    const { signedIn, fetchImpl, agentId, connectionId, versions } =
      await readyToRun("runs_cli_start");

    const answer = await startRun(
      signedIn,
      { agentId, connectionId, testVersionIds: versions, label: "the folder" },
      fetchImpl,
    );

    expect(answer.kind).toBe("started");
    if (answer.kind !== "started") return;

    // Every one of these is a field the client reads off the wire by name. An
    // API that renamed any of them would leave a terminal printing blanks, and
    // this is where that is caught rather than in somebody's session.
    expect(answer.run.id).toMatch(/^run_/u);
    expect(answer.run.status).toBe("pending");
    expect(answer.run.agentId).toBe(agentId);
    expect(answer.run.connectionId).toBe(connectionId);
    expect(answer.run.connectionType).toBe("retell");
    expect(answer.run.modality).toBe("chat");
    expect(answer.run.testVersionIds).toEqual(versions);
    expect(answer.run.expectedSimulationCount).toBe(2);
    expect(answer.run.resultsUrl).toBe(
      `${api.config.baseUrl}/runs/${answer.run.id}`,
    );

    expect(answer.run.simulations).toHaveLength(2);
    for (const [index, one] of answer.run.simulations.entries()) {
      expect(one.id).toMatch(/^sim_/u);
      expect(one.position).toBe(index + 1);
      expect(one.testName).not.toBe("");
      expect(one.personaName).toBe("Impatient Rita");
      expect(one.testVersionId).toBe(versions[index]);
      expect(one.status).toBe("queued");
      expect(one.verdict).toBeNull();
    }

    // And reading it back the way a follower that did not start it would.
    const read = await getRun(signedIn, answer.run.id, fetchImpl);
    expect(read).toEqual(answer.run);
  });

  it("starts a run over a phone connection, because the phone adapter has shipped and this platform can dial", async () => {
    const { signedIn, fetchImpl, versions } = await readyToRun(
      "runs_cli_over_phone",
      { phoneIsSetUp: true },
    );

    const registered = await api.app.inject({
      method: "POST",
      url: "/api/agents",
      headers: { authorization: `Bearer ${signedIn.key}` },
      payload: {
        name: "Front desk line",
        connection: {
          type: "phone",
          modality: "voice",
          config: { phoneNumber: "+15551234567" },
        },
      },
    });
    const listed = registered.json() as {
      agent: { id: string };
      connection: { id: string };
    };
    const dialled = listed.connection;

    // The test was authored before this agent existed, so nothing yet says it
    // is worth running against it — and a run may only pair the two once
    // somebody has.
    const version = await api.app.inject({
      method: "GET",
      url: `/api/test-versions/${versions[0] ?? ""}`,
      headers: { authorization: `Bearer ${signedIn.key}` },
    });
    await api.app.inject({
      method: "POST",
      url: `/api/tests/${String((version.json() as { test_id: string }).test_id)}/agents`,
      headers: { authorization: `Bearer ${signedIn.key}` },
      payload: { agents: [listed.agent.id] },
    });

    const answer = await startRun(
      signedIn,
      {
        agentId: "",
        connectionId: dialled.id,
        testVersionIds: [versions[0] ?? ""],
      },
      fetchImpl,
    );

    // This was the `no_adapter` refusal until the phone adapter shipped. The
    // terminal's own code now gets a run back over a number, the same way it
    // does over any other type egma conducts.
    expect(answer.kind).toBe("started");
    if (answer.kind !== "started") return;
    expect(answer.run.connectionType).toBe("phone");
    expect(answer.run.modality).toBe("voice");
  });

  /**
   * The other half of the same door, from the terminal's side.
   *
   * The refusal a platform with no carrier answers with is not a shape this
   * client knows about — it is a 422 like any other, and the client's whole
   * job is to carry the sentence up unread. That is worth pinning here rather
   * than only at the route: a client that started branching on codes would
   * pass the route's test and still leave a developer with egma's paraphrase
   * of somebody else's decision.
   */
  it("carries a platform-with-no-carrier's refusal up as an answer, word for word", async () => {
    const { signedIn, fetchImpl, versions } = await readyToRun(
      "runs_cli_phone_unset",
    );

    const registered = await api.app.inject({
      method: "POST",
      url: "/api/agents",
      headers: { authorization: `Bearer ${signedIn.key}` },
      payload: { name: "Front desk line", connection: PHONE_CONNECTION },
    });
    const listed = registered.json() as {
      agent: { id: string };
      connection: { id: string };
    };
    const dialled = listed.connection;

    // The test was authored before this agent existed, so nothing yet says it
    // is worth running against it — and a run may only pair the two once
    // somebody has.
    const version = await api.app.inject({
      method: "GET",
      url: `/api/test-versions/${versions[0] ?? ""}`,
      headers: { authorization: `Bearer ${signedIn.key}` },
    });
    await api.app.inject({
      method: "POST",
      url: `/api/tests/${String((version.json() as { test_id: string }).test_id)}/agents`,
      headers: { authorization: `Bearer ${signedIn.key}` },
      payload: { agents: [listed.agent.id] },
    });

    const answer = await startRun(
      signedIn,
      {
        agentId: "",
        connectionId: dialled.id,
        testVersionIds: [versions[0] ?? ""],
      },
      fetchImpl,
    );

    expect(answer.kind).toBe("refused");
    if (answer.kind !== "refused") return;
    expect(answer.reason).toBe(
      "this Egma instance has not been set up to place phone calls, so " +
        "nothing was " +
        "dialled and nothing was charged. It is missing the carrier trunk " +
        "and the source number. Whoever runs " +
        "this platform makes it ready with one command in the platform " +
        "workspace: " +
        "egma self-host setup.",
    );
  });

  it("hands the platform's own refusal back as an answer, word for word", async () => {
    const { signedIn, fetchImpl, connectionId } = await readyToRun(
      "runs_cli_refusal",
    );

    const missing = newId("tstv");
    const answer = await startRun(
      signedIn,
      { agentId: "", connectionId, testVersionIds: [missing] },
      fetchImpl,
    );

    // A refusal, not an exception: the terminal prints the sentence as it
    // stands, because paraphrasing a decision it did not make would be egma
    // inventing an explanation.
    expect(answer).toEqual({
      kind: "refused",
      reason:
        `there is no test version ${missing} on this Egma instance. Push the test ` +
        `first, or read the test and pin the version_id it names now.`,
    });
  });
});

describe("following a run from the terminal's own code", () => {
  it("takes each change once, in order, and stops when the run is done", async () => {
    const { ada, signedIn, fetchImpl, connectionId, versions } =
      await readyToRun("runs_cli_follow");
    const auth = contextFor(ada, "member");

    const answer = await startRun(
      signedIn,
      { agentId: "", connectionId, testVersionIds: versions },
      fetchImpl,
    );
    if (answer.kind !== "started") throw new Error("the run was refused");
    const runId = answer.run.id;

    const applied: number[] = [];
    let after = 0;
    const follow = async () => {
      const page = await runEvents(signedIn, runId, after, { fetchImpl });
      for (const event of page.events) applied.push(event.seq);
      after = page.next;
      return page;
    };

    expect((await follow()).done).toBe(false);

    const claimed = (
      await claimSimulations({ claimant: CLAIMANT, capacity: 50 })
    ).filter((one) => one.runId === runId);
    const [first, second] = claimed;
    if (first === undefined || second === undefined) {
      throw new Error("the claim missed the run under test");
    }

    const picked = await follow();
    expect(picked.events.map((event) => event.kind)).toEqual([
      "simulation",
      "simulation",
      "run",
    ]);
    expect(picked.events[0]).toMatchObject({
      kind: "simulation",
      status: "claimed",
      personaName: "Impatient Rita",
      verdict: null,
    });

    await startSimulation(auth, first.id, CLAIMANT);
    await completeSimulation(auth, first.id, CLAIMANT, {
      endingReason: "agent_ended",
    });
    await failSimulation(auth, second.id, CLAIMANT, {
      reason: "not_answered",
    });

    const last = await follow();
    expect(last.done).toBe(true);

    // A conversation that never ran reads as failed with its own reason, and
    // is never dressed up as one that ran and was judged.
    const ended = last.events.find(
      (event) => event.kind === "simulation" && event.status === "failed",
    );
    expect(ended).toMatchObject({ status: "failed", reason: "not_answered" });

    // Dense, in order, and each number exactly once — the client's whole
    // resume story, read through the client's own reader.
    expect(applied).toEqual(
      Array.from({ length: applied.length }, (_, index) => index + 1),
    );
  });
});
