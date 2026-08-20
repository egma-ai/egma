import { newId } from "@egma/ids";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  IdentityConflictError,
  listConnections,
  registerAgent,
  updateConnection,
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
}): NewAgent {
  return {
    name: overrides.name ?? "Front desk",
    connection: {
      agentPlatform: "retell",
      connectionKind: "retell_chat_api",
      accessVariant: "retell_chat_api.api_key",
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
      name: "Identity only",
    });

    expect(claimed.result).toBe("created");
    expect(claimed.connection).toBeUndefined();
    expect(
      await listConnections(actingIn(acme.project), claimed.agent.id),
    ).toEqual([]);
  });
});

describe("a connection kind with no reuse key", () => {
  /**
   * A phone number is where egma dials, not who answers, and two agents may
   * share one — so the type declares no reuse key and registering the same
   * number twice registers twice. The name check is what catches the duplicate
   * that was a mistake.
   */
  it("creates every time, and the name is what stops a mistake", async () => {
    const dialled = await registerAgent(actingIn(acme.project), {
      name: "Reception line",
      connection: {
        agentPlatform: null,
        connectionKind: "phone_number",
        accessVariant: "phone_number.public_e164",
        modality: "voice",
        config: { phoneNumber: "+15551234567" },
      },
    });
    expect(dialled.result).toBe("created");

    const again = await registerAgent(actingIn(acme.project), {
      name: "Reception line, second team",
      connection: {
        agentPlatform: null,
        connectionKind: "phone_number",
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

  it("moves the revision, so a browser holding the old one is refused", async () => {
    // A deploy re-running `register` is the one writer that reaches a
    // connection from outside the browser. Somebody with the connection open
    // is showing the credential hint as it was; if the revision stayed put,
    // their Rename or Archive would land against a credential they never saw.
    const vendor = `agent_in_retell_${newId("con").slice(-6)}`;
    const opened = await registerAgent(
      actingIn(acme.project),
      registration({
        name: "Open in a tab",
        retellAgentId: vendor,
        apiKey: "retell-secret-first-0000AAAA",
      }),
    );
    const agentId = opened.agent.id;
    const connectionId = opened.connection?.id ?? "";
    // What the open page is holding.
    const staleRevision = opened.connection?.revision ?? "";

    const rotated = await registerAgent(
      actingIn(acme.project),
      registration({
        name: "Open in a tab",
        retellAgentId: vendor,
        apiKey: "retell-secret-second-1111ZZZZ",
      }),
    );

    expect(rotated.result).toBe("reused");
    expect(rotated.connection?.id).toBe(connectionId);
    expect(rotated.connection?.revision).not.toBe(staleRevision);

    await expect(
      updateConnection(actingIn(acme.project), agentId, connectionId, {
        name: "Renamed from the stale tab",
        expectedRevision: staleRevision,
      }),
    ).rejects.toBeInstanceOf(IdentityConflictError);

    // Naming the revision the rotation left behind is how the edit lands, and
    // reading it again is what puts the new credential hint in front of them.
    const current = rotated.connection?.revision ?? "";
    const renamed = await updateConnection(
      actingIn(acme.project),
      agentId,
      connectionId,
      { name: "Renamed after reading again", expectedRevision: current },
    );
    expect(renamed?.name).toBe("Renamed after reading again");
    expect(renamed?.credentialsHint).toBe("ZZZZ");
  });
});
