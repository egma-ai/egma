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
  readonly lane?: "retell_chat_api" | "retell_playground" | "retell_web_call";
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

  it("settle to one for the playground lane too, since it carries the reuse key", async () => {
    // The playground shares the reuse key the chat API carries — the vendor
    // agent id — so the same advisory lock and committed read behind it settle
    // a racing playground registration to one agent, not a twin.
    const racing = await Promise.all(
      Array.from({ length: 4 }, () =>
        registerAgent(
          actingIn(acme.project),
          registration({
            name: "Racing playground",
            lane: "retell_playground",
            retellAgentId: "agent_playground_race",
          }),
        ),
      ),
    );

    expect(new Set(racing.map((one) => one.agent.id)).size).toBe(1);
    expect(new Set(racing.map((one) => one.connection?.id)).size).toBe(1);
    const results = racing.map((one) => one.result);
    expect(results.filter((one) => one === "created")).toHaveLength(1);
    expect(results.filter((one) => one === "reused")).toHaveLength(3);

    // One agent, and the one connection is the playground.
    const { rows } = await database.sql<{ count: string }>(
      "select count(*) as count from agent where project_id = $1 and name = $2",
      [acme.project, "Racing playground"],
    );
    expect(rows[0]?.count).toBe("1");
    const connections = await listConnections(
      actingIn(acme.project),
      racing[0]!.agent.id,
    );
    expect(connections).toBeDefined();
    expect((connections ?? []).map((one) => one.connectionType)).toEqual([
      "retell_playground",
    ]);
  });
});

describe("the same Retell agent through two doors of its reuse family", () => {
  /**
   * One Retell agent's playground (chat) and its web call (voice) both key on
   * the vendor agent id, so registering the second lands on the first's Egma
   * agent — a connection added, never a twin — whichever order they arrive in.
   * This is the whole of one-agent-two-connections on the **web's fresh connect
   * flow**, which submits a plain registration with no name-clash fallback of
   * its own and so relies entirely on the server settling it here.
   */
  async function twoDoors(
    label: string,
    vendor: string,
    firstLane: "retell_playground" | "retell_web_call",
    secondLane: "retell_playground" | "retell_web_call",
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

  it("attaches the web call after the playground, on one agent", async () => {
    await twoDoors("Two doors A", "vendor_two_doors_a", "retell_playground", "retell_web_call");
  });

  it("attaches the playground after the web call, on one agent", async () => {
    await twoDoors("Two doors B", "vendor_two_doors_b", "retell_web_call", "retell_playground");
  });

  it("settles a race across two doors of one agent to a single agent", async () => {
    // The lock is on the vendor agent under its reuse key, not on the door, so
    // a playground and a web call for one agent racing on different doors still
    // wait behind one lock and settle to one agent — one created, one added.
    const vendor = "vendor_two_doors_race";
    const racing = await Promise.all([
      registerAgent(
        actingIn(acme.project),
        registration({
          name: "Two doors race",
          lane: "retell_playground",
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
