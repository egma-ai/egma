import { newId } from "@egma/ids";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  listConnections,
  registerAgent,
  type AuthContext,
  type NewAgent,
} from "@egma/db";

import {
  createConnectedDatabase,
  type MigratedDatabase,
} from "./support/database.ts";
import { seedOrganization, seedUser } from "./support/tenancy.ts";

/**
 * Registering the same vendor agent twice, including from two machines at
 * once.
 *
 * `createAgent` is tested next door and is not re-tested here. What is new is
 * the reuse rule and the transaction that carries it: a second registration of
 * one vendor agent must never mint a second identity, and two arriving
 * together must settle to one rather than one of them losing to the name
 * index. Both are Postgres guarantees — an advisory lock and a committed read
 * behind it — so both run against a real database.
 */

let database: MigratedDatabase;

const acme = {
  organization: newId("org"),
  project: newId("prj"),
  secondProject: newId("prj"),
};
const ada = newId("usr");

function actingIn(projectId: string | undefined): AuthContext {
  return {
    userId: ada,
    organizationId: acme.organization,
    projectId,
    role: "member",
    via: "session",
  };
}

/** The registration a developer's connect sends, twice. */
function registration(overrides: {
  readonly name?: string;
  readonly modality?: "chat" | "voice";
  readonly retellAgentId?: string;
  readonly apiKey?: string;
  /** Which Retell vendor-id door this registration takes, chat API by default. */
  readonly lane?: "retell_chat_api" | "retell_text_mode" | "retell_web_call";
}): NewAgent {
  const lane = overrides.lane ?? "retell_chat_api";
  return {
    name: overrides.name ?? "Front desk",
    agentPlatform: "retell",
    connection: {
      agentPlatform: "retell",
      connectionType: lane,
      accessVariant: `${lane}.api_key`,
      modality: overrides.modality ?? "chat",
      config: { retellAgentId: overrides.retellAgentId ?? "agent_in_retell_1" },
      credentials: { apiKey: overrides.apiKey ?? "retell-secret-A1B2C3D4WXYZ" },
    },
  };
}

/**
 * The same registration for a LiveKit worker, whose identity is two things
 * rather than one: the server it stands on and the name it answers to.
 *
 * A builder of its own rather than a wider `registration`, because what makes
 * these tests worth having is the composite — the url and the agent name vary
 * independently, and a builder that hid one of them behind the other would
 * have nothing left to prove.
 */
function livekitRegistration(overrides: {
  readonly name?: string;
  readonly modality?: "chat" | "voice";
  readonly url?: string;
  readonly agentName?: string;
  readonly apiSecret?: string;
}): NewAgent {
  return {
    name: overrides.name ?? "Room worker",
    agentPlatform: "livekit",
    connection: {
      agentPlatform: "livekit",
      connectionType: "livekit_room",
      accessVariant: "livekit_room.project_credentials",
      modality: overrides.modality ?? "voice",
      config: {
        url: overrides.url ?? "wss://acme.livekit.cloud",
        agentName: overrides.agentName ?? "front-desk",
      },
      credentials: {
        apiKey: "livekit-key-A1B2C3D4WXYZ",
        apiSecret: overrides.apiSecret ?? "livekit-secret-E5F6G7H8QRST",
      },
    },
  };
}

/** A worker name nothing else in this shared database answers to. */
function aWorkerName(): string {
  return `worker-${newId("con").slice(-6)}`;
}

beforeAll(async () => {
  database = await createConnectedDatabase("agents_register");

  await seedOrganization(database, acme.organization, [
    { id: acme.project, slug: "default" },
    { id: acme.secondProject, slug: "outbound" },
  ]);
  await seedUser(database, ada, "ada@acme.example");
});

afterAll(async () => {
  await database.drop();
});

describe("two identical registrations arriving together", () => {
  /**
   * The retry a coding agent makes after an uncertain network failure, in its
   * worst shape: the first request is still in flight when the second starts.
   * Both transactions are real and both run at once — the guarantee under test
   * is the lock and the read behind it, not egma's arithmetic.
   */
  it("settle to one agent, and none of them loses to the name index", async () => {
    const racing = await Promise.all(
      Array.from({ length: 4 }, () =>
        registerAgent(actingIn(acme.project), registration({ name: "Racing" })),
      ),
    );

    expect(new Set(racing.map((one) => one.agent.id)).size).toBe(1);
    expect(new Set(racing.map((one) => one.connection?.id)).size).toBe(1);

    // Exactly one of them created and the rest found it. Which one won is
    // Postgres's business; that exactly one created is the claim.
    const results = racing.map((one) => one.result);
    expect(results.filter((one) => one === "created")).toHaveLength(1);
    expect(results.filter((one) => one === "reused")).toHaveLength(3);

    const { rows } = await database.sql<{ count: string }>(
      "select count(*) as count from agent where project_id = $1 and name = $2",
      [acme.project, "Racing"],
    );
    expect(rows[0]?.count).toBe("1");
  });

  it("settle to one for the text-mode lane too, since it carries the reuse key", async () => {
    // Text mode shares the reuse key the chat API carries — the vendor
    // agent id — so the same advisory lock and committed read behind it settle
    // a racing text mode registration to one agent, not a twin.
    const racing = await Promise.all(
      Array.from({ length: 4 }, () =>
        registerAgent(
          actingIn(acme.project),
          registration({
            name: "Racing text mode",
            lane: "retell_text_mode",
            retellAgentId: "agent_text_mode_race",
          }),
        ),
      ),
    );

    expect(new Set(racing.map((one) => one.agent.id)).size).toBe(1);
    expect(new Set(racing.map((one) => one.connection?.id)).size).toBe(1);
    const results = racing.map((one) => one.result);
    expect(results.filter((one) => one === "created")).toHaveLength(1);
    expect(results.filter((one) => one === "reused")).toHaveLength(3);

    // One agent, and the one connection is text mode.
    const { rows } = await database.sql<{ count: string }>(
      "select count(*) as count from agent where project_id = $1 and name = $2",
      [acme.project, "Racing text mode"],
    );
    expect(rows[0]?.count).toBe("1");
    const connections = await listConnections(
      actingIn(acme.project),
      racing[0]!.agent.id,
    );
    expect(connections).toBeDefined();
    expect((connections ?? []).map((one) => one.connectionType)).toEqual([
      "retell_text_mode",
    ]);
  });
});

describe("the same Retell agent through two doors of its reuse family", () => {
  /**
   * One Retell agent's text mode (chat) and its web call (voice) both key on
   * the vendor agent id, so registering the second lands on the first's Egma
   * agent — a connection added, never a twin — whichever order they arrive in.
   * This is the whole of one-agent-two-connections on the **web's fresh connect
   * flow**, which submits a plain registration with no name-clash fallback of
   * its own and so relies entirely on the server settling it here.
   */
  async function twoDoors(
    label: string,
    vendor: string,
    firstLane: "retell_text_mode" | "retell_web_call",
    secondLane: "retell_text_mode" | "retell_web_call",
  ): Promise<void> {
    const modalityOf = (lane: string) =>
      lane === "retell_web_call" ? ("voice" as const) : ("chat" as const);

    const first = await registerAgent(
      actingIn(acme.project),
      registration({
        name: label,
        lane: firstLane,
        modality: modalityOf(firstLane),
        retellAgentId: vendor,
      }),
    );
    const second = await registerAgent(
      actingIn(acme.project),
      registration({
        name: label,
        lane: secondLane,
        modality: modalityOf(secondLane),
        retellAgentId: vendor,
      }),
    );

    expect(first.result).toBe("created");
    // The second door is added to the first door's agent, not a new one.
    expect(second.result).toBe("connection_added");
    expect(second.agent.id).toBe(first.agent.id);

    const connections = await listConnections(actingIn(acme.project), first.agent.id);
    expect(connections).toBeDefined();
    expect((connections ?? []).map((one) => one.connectionType).sort()).toEqual(
      [firstLane, secondLane].sort(),
    );

    // Exactly one Egma agent carries this label; there is no twin.
    const { rows } = await database.sql<{ count: string }>(
      "select count(*) as count from agent where project_id = $1 and name = $2",
      [acme.project, label],
    );
    expect(rows[0]?.count).toBe("1");
  }

  it("attaches the web call after text mode, on one agent", async () => {
    await twoDoors("Two doors A", "vendor_two_doors_a", "retell_text_mode", "retell_web_call");
  });

  it("attaches text mode after the web call, on one agent", async () => {
    await twoDoors("Two doors B", "vendor_two_doors_b", "retell_web_call", "retell_text_mode");
  });

  it("settles a race across two doors of one agent to a single agent", async () => {
    // The lock is on the vendor agent under its reuse key, not on the door, so
    // text mode and a web call for one agent racing on different doors still
    // wait behind one lock and settle to one agent — one created, one added.
    const vendor = "vendor_two_doors_race";
    const racing = await Promise.all([
      registerAgent(
        actingIn(acme.project),
        registration({
          name: "Two doors race",
          lane: "retell_text_mode",
          modality: "chat",
          retellAgentId: vendor,
        }),
      ),
      registerAgent(
        actingIn(acme.project),
        registration({
          name: "Two doors race",
          lane: "retell_web_call",
          modality: "voice",
          retellAgentId: vendor,
        }),
      ),
    ]);

    expect(new Set(racing.map((one) => one.agent.id)).size).toBe(1);
    const results = racing.map((one) => one.result).sort();
    expect(results).toEqual(["connection_added", "created"]);

    const { rows } = await database.sql<{ count: string }>(
      "select count(*) as count from agent where project_id = $1 and name = $2",
      [acme.project, "Two doors race"],
    );
    expect(rows[0]?.count).toBe("1");
  });
});

describe("a vendor agent already registered in another project", () => {
  /**
   * The reuse rule reads inside the project the write lands in. Two product
   * areas of one customer may legitimately register the same vendor agent —
   * and a project is a filter rather than a wall, so this has to be stated by
   * the query rather than left to a table nobody scoped.
   */
  it("does not decide what a write into a different project does", async () => {
    const shared = `agent_in_retell_${newId("con").slice(-6)}`;

    const first = await registerAgent(
      actingIn(acme.project),
      registration({ name: "Default's copy", retellAgentId: shared }),
    );
    const second = await registerAgent(
      actingIn(acme.secondProject),
      registration({ name: "Outbound's copy", retellAgentId: shared }),
    );

    expect(first.result).toBe("created");
    expect(second.result).toBe("created");
    expect(second.agent.id).not.toBe(first.agent.id);
    expect(second.agent.projectId).toBe(acme.secondProject);
  });
});

describe("a registration naming no connection", () => {
  it("creates, because there is nothing to match a registration on", async () => {
    const claimed = await registerAgent(actingIn(acme.project), {
      agentPlatform: "retell",
      name: "Identity only",
    });

    expect(claimed.result).toBe("created");
    expect(claimed.connection).toBeUndefined();
    expect(
      await listConnections(actingIn(acme.project), claimed.agent.id),
    ).toEqual([]);
  });
});

describe("a connection type with no reuse key", () => {
  /**
   * A phone number is where egma dials, not who answers, and two agents may
   * share one — so the type declares no reuse key and registering the same
   * number twice registers twice. The name check is what catches the duplicate
   * that was a mistake.
   */
  it("creates every time, and the name is what stops a mistake", async () => {
    const dialled = await registerAgent(actingIn(acme.project), {
      agentPlatform: "retell",
      name: "Reception line",
      connection: {
        agentPlatform: null,
        connectionType: "phone_number",
        accessVariant: "phone_number.public_e164",
        modality: "voice",
        config: { phoneNumber: "+15551234567" },
      },
    });
    expect(dialled.result).toBe("created");

    const again = await registerAgent(actingIn(acme.project), {
      agentPlatform: "retell",
      name: "Reception line, second team",
      connection: {
        agentPlatform: null,
        connectionType: "phone_number",
        accessVariant: "phone_number.public_e164",
        modality: "voice",
        config: { phoneNumber: "+15551234567" },
      },
    });
    expect(again.result).toBe("created");
    expect(again.agent.id).not.toBe(dialled.agent.id);
  });
});

describe("a credential rotated by a reused registration", () => {
  it("replaces the sealed envelope whole rather than merging into it", async () => {
    const vendor = `agent_in_retell_${newId("con").slice(-6)}`;

    const first = await registerAgent(
      actingIn(acme.project),
      registration({
        name: "Rotating",
        retellAgentId: vendor,
        apiKey: "retell-secret-first-0000AAAA",
      }),
    );
    const before = await database.sql<{ credentials: string }>(
      "select credentials from connection where id = $1",
      [first.connection?.id ?? ""],
    );

    const second = await registerAgent(
      actingIn(acme.project),
      registration({
        name: "Rotating",
        retellAgentId: vendor,
        apiKey: "retell-secret-second-1111ZZZZ",
      }),
    );

    expect(second.result).toBe("reused");
    expect(second.connection?.id).toBe(first.connection?.id);
    expect(second.connection?.credentialsHint).toBe("ZZZZ");

    const after = await database.sql<{ credentials: string }>(
      "select credentials from connection where id = $1",
      [first.connection?.id ?? ""],
    );
    const sealed = after.rows[0]?.credentials ?? "";
    expect(sealed).not.toBe(before.rows[0]?.credentials);
    expect(sealed.startsWith("v1.")).toBe(true);
    // Ciphertext, and nothing anybody could read the old key back out of.
    expect(sealed).not.toContain("0000AAAA");
    expect(sealed).not.toContain("1111ZZZZ");
  });

});

/**
 * The composite reuse rule, against a real database.
 *
 * Retell's rule is one config value compared as it was stored, and Postgres
 * can decide it on its own. LiveKit's cannot be decided in SQL at all: the
 * identity is a normalized server origin and a worker name, and
 * `wss://acme.livekit.cloud`, `https://acme.livekit.cloud:443` and
 * `ws://acme.livekit.cloud` are one server that no `=` will ever match. So the query narrows on the name and the
 * rule settles the rest, and these are the cases that tell the two apart.
 */
describe("one LiveKit worker registered twice", () => {
  it("answers reused, and replaces the sealed pair whole", async () => {
    const worker = aWorkerName();

    const first = await registerAgent(
      actingIn(acme.project),
      livekitRegistration({
        name: "Rotating worker",
        agentName: worker,
        apiSecret: "livekit-secret-first-0000AAAA",
      }),
    );
    const before = await database.sql<{ credentials: string }>(
      "select credentials from connection where id = $1",
      [first.connection?.id ?? ""],
    );

    const second = await registerAgent(
      actingIn(acme.project),
      livekitRegistration({
        name: "Rotating worker",
        agentName: worker,
        apiSecret: "livekit-secret-second-1111ZZZZ",
      }),
    );

    expect(first.result).toBe("created");
    expect(second.result).toBe("reused");
    expect(second.agent.id).toBe(first.agent.id);
    expect(second.connection?.id).toBe(first.connection?.id);

    const after = await database.sql<{ credentials: string }>(
      "select credentials from connection where id = $1",
      [first.connection?.id ?? ""],
    );
    const sealed = after.rows[0]?.credentials ?? "";
    expect(sealed).not.toBe(before.rows[0]?.credentials);
    expect(sealed.startsWith("v1.")).toBe(true);
    expect(sealed).not.toContain("0000AAAA");
    expect(sealed).not.toContain("1111ZZZZ");
  });

  /**
   * The spellings a customer meets in one afternoon: the websocket url their
   * dashboard shows, the https one their SDK docs show, and either with the
   * port written out. They reach one server, so they must land on one agent.
   */
  it("is one worker however the server url is spelled", async () => {
    const worker = aWorkerName();

    const first = await registerAgent(
      actingIn(acme.project),
      livekitRegistration({
        name: "Spelled worker",
        agentName: worker,
        url: "wss://acme.livekit.cloud",
      }),
    );
    expect(first.result).toBe("created");

    for (const url of [
      "https://acme.livekit.cloud",
      "wss://acme.livekit.cloud:443",
      "https://ACME.livekit.cloud:443/",
      // The other scheme pair too: one host reached over ws is the same
      // server as one reached over wss, and must not become a second agent.
      "ws://acme.livekit.cloud",
      "http://acme.livekit.cloud:80",
    ]) {
      const again = await registerAgent(
        actingIn(acme.project),
        livekitRegistration({
          name: "Spelled worker",
          agentName: worker,
          url,
        }),
      );
      expect(again.result).toBe("reused");
      expect(again.agent.id).toBe(first.agent.id);
      expect(again.connection?.id).toBe(first.connection?.id);
    }

    // And the url the first registration wrote is the one still stored: reuse
    // rotates the credential and leaves the config it found alone.
    const { rows } = await database.sql<{ config: Record<string, string> }>(
      "select config from connection where id = $1",
      [first.connection?.id ?? ""],
    );
    expect(rows[0]?.config["url"]).toBe("wss://acme.livekit.cloud");
  });

  /**
   * A staging project and a production one commonly run a worker of the same
   * name, and their results must never be read as one agent's.
   *
   * The two registrations carry different *agent* names on purpose. With one
   * name the second would find no match, fall through to a create, and lose to
   * the agent name index — which would fail this test for a reason that has
   * nothing to do with the reuse rule.
   */
  it("stays two agents when one worker name answers on two servers", async () => {
    const worker = aWorkerName();

    const staging = await registerAgent(
      actingIn(acme.project),
      livekitRegistration({
        name: "Staging's worker",
        agentName: worker,
        url: "wss://staging.livekit.cloud",
      }),
    );
    const production = await registerAgent(
      actingIn(acme.project),
      livekitRegistration({
        name: "Production's worker",
        agentName: worker,
        url: "wss://production.livekit.cloud",
      }),
    );

    expect(staging.result).toBe("created");
    expect(production.result).toBe("created");
    expect(production.agent.id).not.toBe(staging.agent.id);
  });

  /**
   * The retry a coding agent makes after an uncertain network failure, on the
   * composite rule: the lock is taken on the normalized identity, so four
   * registrations spelling one server four ways still queue behind each other.
   */
  it("settles four racing registrations onto one agent", async () => {
    const worker = aWorkerName();

    const racing = await Promise.all(
      [
        "wss://racing.livekit.cloud",
        "https://racing.livekit.cloud",
        "wss://racing.livekit.cloud:443",
        "https://RACING.livekit.cloud:443",
      ].map((url) =>
        registerAgent(
          actingIn(acme.project),
          livekitRegistration({
            name: "Racing worker",
            agentName: worker,
            url,
          }),
        ),
      ),
    );

    expect(new Set(racing.map((one) => one.agent.id)).size).toBe(1);
    expect(new Set(racing.map((one) => one.connection?.id)).size).toBe(1);

    const results = racing.map((one) => one.result);
    expect(results.filter((one) => one === "created")).toHaveLength(1);
    expect(results.filter((one) => one === "reused")).toHaveLength(3);

    const { rows } = await database.sql<{ count: string }>(
      "select count(*) as count from agent where project_id = $1 and name = $2",
      [acme.project, "Racing worker"],
    );
    expect(rows[0]?.count).toBe("1");
  });
});

/**
 * The branch the chat lane exists for: one worker, tested both ways, with one
 * results history to read the two scores against each other in.
 *
 * Proven in both orders, because which modality a team reaches for first is
 * their business and neither may be the one that gets the agent.
 */
describe("one LiveKit worker tested over chat and over voice", () => {
  it.each([
    { first: "voice", second: "chat" },
    { first: "chat", second: "voice" },
  ] as const)(
    "adds a connection to the agent it already has, $first then $second",
    async ({ first, second }) => {
      const worker = aWorkerName();
      const name = `Both ways, ${first} first`;

      const opened = await registerAgent(
        actingIn(acme.project),
        livekitRegistration({ name, agentName: worker, modality: first }),
      );
      const added = await registerAgent(
        actingIn(acme.project),
        livekitRegistration({ name, agentName: worker, modality: second }),
      );

      expect(opened.result).toBe("created");
      expect(added.result).toBe("connection_added");
      expect(added.agent.id).toBe(opened.agent.id);
      expect(added.connection?.id).not.toBe(opened.connection?.id);
      expect(added.connection?.modality).toBe(second);
      expect(added.connection?.productLabel).toBe(
        second === "chat" ? "LiveKit chat" : "LiveKit project credentials",
      );

      const reached =
        (await listConnections(actingIn(acme.project), opened.agent.id)) ?? [];
      expect(reached.map((one) => one.modality).sort()).toEqual([
        "chat",
        "voice",
      ]);
    },
  );
});

/**
 * The token-endpoint shape holds no server url, so the endpoint stands in for
 * the server in the identity: one worker behind one endpoint is one agent,
 * however many times it is registered, and a different worker behind the same
 * endpoint is another. The whole route is the endpoint, not its origin: one
 * gateway commonly mints for a staging project on one path and a production
 * project on another, and the same worker name behind each is two workers.
 */
describe("a LiveKit connection that names a worker behind a token endpoint", () => {
  const endpoint = (
    agentName: string,
    tokenEndpoint = "https://acme.example/egma/livekit-token",
  ) =>
    ({
      agentPlatform: "livekit",
      connectionType: "livekit_room",
      accessVariant: "livekit_room.customer_token_endpoint",
      modality: "voice",
      config: { tokenEndpoint, agentName },
      credentials: { headers: '{"Authorization":"Bearer not-a-real-token"}' },
    }) as const;

  it("lands on one agent when the same worker is registered twice", async () => {
    const first = await registerAgent(actingIn(acme.project), {
      agentPlatform: "livekit",
      name: "Endpoint worker",
      connection: endpoint("front-desk"),
    });
    const again = await registerAgent(actingIn(acme.project), {
      agentPlatform: "livekit",
      name: "Endpoint worker, second team",
      connection: endpoint("front-desk"),
    });

    expect(first.result).toBe("created");
    expect(again.result).toBe("reused");
    expect(again.agent.id).toBe(first.agent.id);
  });

  it("creates for the same worker behind another route of one gateway", async () => {
    const staging = await registerAgent(actingIn(acme.project), {
      agentPlatform: "livekit",
      name: "Front desk, staging",
      connection: endpoint("front-desk", "https://acme.example/staging/token"),
    });
    const production = await registerAgent(actingIn(acme.project), {
      agentPlatform: "livekit",
      name: "Front desk, production",
      connection: endpoint("front-desk", "https://acme.example/production/token"),
    });

    expect(staging.result).toBe("created");
    expect(production.result).toBe("created");
    expect(production.agent.id).not.toBe(staging.agent.id);
  });

  it("creates for another worker behind the same endpoint", async () => {
    const first = await registerAgent(actingIn(acme.project), {
      agentPlatform: "livekit",
      name: "Endpoint day shift",
      connection: endpoint("day-shift"),
    });
    const other = await registerAgent(actingIn(acme.project), {
      agentPlatform: "livekit",
      name: "Endpoint night shift",
      connection: endpoint("night-shift"),
    });

    expect(first.result).toBe("created");
    expect(other.result).toBe("created");
    expect(other.agent.id).not.toBe(first.agent.id);
  });
});
