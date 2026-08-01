import { randomUUID } from "node:crypto";

import { newId } from "@egma/ids";
import * as dataAccess from "@egma/db";
import {
  ACTIONS,
  authorize,
  createApiKey,
  membershipsOf,
  NotPermittedError,
  permits,
  permitsApiKeyMintedBy,
  provisionOrganization,
  ROLES,
  type Action,
  type ActionScope,
  type ApiKey,
  type AuthContext,
  type Role,
} from "@egma/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createConnectedDatabase,
  type MigratedDatabase,
} from "./support/database.ts";

/**
 * What each role may do, asserted a cell at a time and in both directions,
 * because a permission table tested only where it says yes is a table nobody
 * has checked.
 *
 * The table below is written out here rather than imported from the code. A
 * test that reads the map and then asks the map whether the map is right proves
 * nothing; this one states what the product promises, and would still be the
 * question to ask if everything underneath it were rewritten.
 */
const THE_TABLE: Readonly<Record<string, readonly Role[]>> = {
  "read": ["viewer", "member", "admin"],
  "author_definitions": ["member", "admin"],
  "configure_agents": ["member", "admin"],
  "start_and_cancel_runs": ["member", "admin"],
  "delete_run_data": ["member", "admin"],
  "mint_own_api_key": ["viewer", "member", "admin"],
  "manage_any_api_key": ["admin"],
  "manage_members": ["admin"],
  "manage_organization": ["admin"],
  "manage_projects": ["admin"],
  "delete_organization": ["admin"],
};

function rowFor(action: Action): readonly Role[] {
  return THE_TABLE[action] ?? [];
}

/**
 * Two customers, because a permission answered without the organization it was
 * asked about is not an answer. Acme has a second project so that the project
 * being ignored can be shown rather than assumed.
 */
const acme = {
  organizationId: newId("org"),
  projectId: newId("prj"),
  outboundProjectId: newId("prj"),
  userId: newId("usr"),
  colleagueUserId: newId("usr"),
};
const globex = {
  organizationId: newId("org"),
  projectId: newId("prj"),
  userId: newId("usr"),
};

type Customer = { organizationId: string; projectId: string; userId: string };

function at(role: Role, customer: Customer = acme): AuthContext {
  return {
    userId: customer.userId,
    organizationId: customer.organizationId,
    projectId: customer.projectId,
    role,
    via: "session",
  };
}

function inside(customer: Customer): ActionScope {
  return {
    organizationId: customer.organizationId,
    projectId: customer.projectId,
  };
}

describe("the action list", () => {
  it("is one name per row of the permission table, and no other", () => {
    expect([...ACTIONS].sort()).toEqual(Object.keys(THE_TABLE).sort());
  });
});

describe("the three roles", () => {
  it("are admin, member and viewer", () => {
    expect([...ROLES].sort()).toEqual(["admin", "member", "viewer"]);
  });

  it("are a named set and not an ordered scale, because a custom role has no place on one", () => {
    // The three happen to nest, so `role >= admin` would answer every question
    // in the table above. Nothing exposes an ordering, so nothing can come to
    // depend on one before the first non-hierarchical role arrives.
    for (const ordering of [
      "rank",
      "roleRank",
      "ROLE_RANK",
      "ROLE_ORDER",
      "level",
      "atLeast",
      "isAtLeast",
      "compareRoles",
      "outranks",
    ]) {
      expect(Object.keys(dataAccess)).not.toContain(ordering);
    }
  });
});

describe("every cell of the permission table, in both directions", () => {
  for (const action of ACTIONS) {
    for (const role of ROLES) {
      const mayThey = rowFor(action).includes(role);
      const said = action.replace(/_/g, " ");

      it(`${mayThey ? "lets" : "refuses"} a ${role} ${said}`, () => {
        const auth = at(role);

        expect(permits(auth, action, inside(acme))).toBe(mayThey);

        if (mayThey) {
          expect(authorize(auth, action, inside(acme))).toBeUndefined();
        } else {
          expect(() => authorize(auth, action, inside(acme))).toThrow(
            NotPermittedError,
          );
        }
      });
    }
  }
});

describe("a viewer", () => {
  it("can start nothing, because a run spends money and creates data", () => {
    const viewer = at("viewer");

    expect(permits(viewer, "start_and_cancel_runs", inside(acme))).toBe(false);
    expect(() =>
      authorize(viewer, "start_and_cancel_runs", inside(acme)),
    ).toThrow(NotPermittedError);
  });

  it("reads anything in the organization and writes none of it", () => {
    const viewer = at("viewer");

    expect(permits(viewer, "read", inside(acme))).toBe(true);
    for (const action of [
      "author_definitions",
      "configure_agents",
      "delete_run_data",
    ] as const) {
      expect(permits(viewer, action, inside(acme))).toBe(false);
    }
  });
});

describe("a member", () => {
  it("uses the whole product", () => {
    const member = at("member");

    for (const action of [
      "read",
      "author_definitions",
      "configure_agents",
      "start_and_cancel_runs",
      "delete_run_data",
      "mint_own_api_key",
    ] as const) {
      expect(permits(member, action, inside(acme))).toBe(true);
    }
  });

  it("touches no membership, no invitation, no organization setting and no project", () => {
    const member = at("member");

    for (const action of [
      "manage_members",
      "manage_any_api_key",
      "manage_organization",
      "manage_projects",
      "delete_organization",
    ] as const) {
      expect(permits(member, action, inside(acme))).toBe(false);
    }
  });
});

describe("minting an API key", () => {
  it.each([...ROLES])(
    "is something a %s may do for themselves, because login mints one as its last step",
    (role) => {
      expect(permits(at(role), "mint_own_api_key", inside(acme))).toBe(true);
    },
  );

  it.each([...ROLES])("leaves a %s their own key to see and revoke", (role) => {
    const auth = at(role);
    expect(permitsApiKeyMintedBy(auth, auth.userId, inside(acme))).toBe(true);
  });

  it.each(["viewer", "member"] as const)(
    "puts somebody else's key out of a %s's reach",
    (role) => {
      expect(
        permitsApiKeyMintedBy(at(role), acme.colleagueUserId, inside(acme)),
      ).toBe(false);
    },
  );

  it("leaves every key in the organization to an admin, so a leak needs nobody's help", () => {
    expect(
      permitsApiKeyMintedBy(at("admin"), acme.colleagueUserId, inside(acme)),
    ).toBe(true);
  });

  it("reaches no key of another customer's, whatever the role", () => {
    for (const role of ROLES) {
      expect(
        permitsApiKeyMintedBy(at(role, acme), globex.userId, inside(globex)),
      ).toBe(false);
    }
  });
});

describe("the organization an action names", () => {
  it("must be the one the credential is for, whatever the role says", () => {
    for (const role of ROLES) {
      for (const action of ACTIONS) {
        expect(permits(at(role, acme), action, inside(globex))).toBe(false);
      }
    }
  });

  it("is refused in the caller's own vocabulary, carrying what was asked", () => {
    let refusal: NotPermittedError | undefined;
    try {
      authorize(at("admin", acme), "read", inside(globex));
    } catch (error) {
      refusal = error as NotPermittedError;
    }

    expect(refusal).toBeInstanceOf(NotPermittedError);
    expect(refusal?.organizationId).toBe(globex.organizationId);
    expect(refusal?.action).toBe("read");
    expect(refusal?.role).toBe("admin");
    expect(refusal?.userId).toBe(acme.userId);
  });
});

describe("the project an action names", () => {
  it("is accepted and changes no answer, because every member holds their role on every project", () => {
    for (const role of ROLES) {
      for (const action of ACTIONS) {
        const here = permits(at(role), action, {
          organizationId: acme.organizationId,
          projectId: acme.projectId,
        });
        const elsewhere = permits(at(role), action, {
          organizationId: acme.organizationId,
          projectId: acme.outboundProjectId,
        });

        expect(elsewhere, `${role} ${action}`).toBe(here);
      }
    }
  });

  it("is not consulted at all, which is what a project-level grant will change", () => {
    // Naming a project of another customer's alongside the caller's own
    // organization changes nothing, because the project is read by nothing.
    // Whether that pairing is real is the database's question, answered by the
    // composite foreign key and by the predicates the data-access module
    // injects — not by a permission.
    //
    // The argument being on the call from the first commit is what keeps
    // project-level grants a change to one function body rather than an audit
    // of every call site in the product.
    for (const role of ROLES) {
      for (const action of ACTIONS) {
        expect(
          permits(at(role), action, {
            organizationId: acme.organizationId,
            projectId: globex.projectId,
          }),
          `${role} ${action}`,
        ).toBe(rowFor(action).includes(role));
      }
    }
  });
});

describe("a refusal", () => {
  it("says which role was refused which action", () => {
    let refusal: NotPermittedError | undefined;
    try {
      authorize(at("viewer"), "manage_members", inside(acme));
    } catch (error) {
      refusal = error as NotPermittedError;
    }

    expect(refusal?.name).toBe("NotPermittedError");
    expect(refusal?.message).toContain("viewer");
    expect(refusal?.message).toContain("manage_members");
    expect(refusal?.projectId).toBe(acme.projectId);
  });
});

/**
 * The rest of this file runs against a real Postgres, because what it is about
 * is where a role comes from rather than what a role may do.
 */

let database: MigratedDatabase;

type Person = {
  readonly userId: string;
  readonly organizationId: string;
  readonly projectId: string;
};

let ada: Person; // the admin who signed up, and owns the organization
let mia: Person; // a member of it
let vic: Person; // a viewer in it
let grace: Person; // another customer entirely

function secret(): { hash: string; prefix: string; displaySuffix: string } {
  return {
    hash: randomUUID(),
    prefix: "egma_sk_",
    displaySuffix: randomUUID().slice(0, 4),
  };
}

async function addUser(email: string): Promise<string> {
  const userId = newId("usr");
  await database.sql('insert into "user" (id, email) values ($1, $2)', [
    userId,
    email,
  ]);
  return userId;
}

async function signUp(slug: string, email: string): Promise<Person> {
  const userId = await addUser(email);
  const provisioned = await provisionOrganization({
    ownerUserId: userId,
    organizationName: slug,
    organizationSlug: slug,
    projectName: "Default",
    projectSlug: "default",
  });
  return {
    userId,
    organizationId: provisioned.organizationId,
    projectId: provisioned.projectId,
  };
}

/**
 * A colleague joining at a role that is not the default. Written straight to
 * the table on purpose: nothing in the product invites anybody yet, and what
 * these tests are about is what happens once somebody holds a role.
 */
async function join(host: Person, email: string, role: Role): Promise<Person> {
  const userId = await addUser(email);
  await database.sql(
    `insert into membership (id, organization_id, user_id, role, created_by)
     values ($1, $2, $3, $4, $5)`,
    [newId("mbr"), host.organizationId, userId, role, host.userId],
  );
  return {
    userId,
    organizationId: host.organizationId,
    projectId: host.projectId,
  };
}

/**
 * The path an API-key request takes to a role.
 *
 * The key row names who minted it and nothing about what they may do, so the
 * only way to reach a role from a key is to read that person's membership — and
 * that read happens here, on this request, rather than at the moment the key
 * was minted.
 */
async function contextForKey(key: ApiKey): Promise<AuthContext> {
  const holding = (await membershipsOf(key.createdByUserId)).find(
    (membership) => membership.organizationId === key.organizationId,
  );
  if (holding === undefined) {
    throw new Error("the key's creator is in no such organization");
  }

  return {
    userId: key.createdByUserId,
    organizationId: key.organizationId,
    // Whatever the key row says, and nothing filled in for it: a key for the
    // whole organization is acting in no project.
    projectId: key.projectId ?? undefined,
    role: holding.role,
    via: "api_key",
  };
}

async function apiKeyRow(id: string): Promise<Record<string, unknown>> {
  const { rows } = await database.sql("select * from api_key where id = $1", [
    id,
  ]);
  const row = rows[0];
  if (row === undefined) throw new Error(`no api key ${id}`);
  return row;
}

async function roleOf(person: Person): Promise<Role | undefined> {
  return (await membershipsOf(person.userId)).find(
    (membership) => membership.organizationId === person.organizationId,
  )?.role;
}

beforeAll(async () => {
  database = await createConnectedDatabase("permissions");

  ada = await signUp("acme", "ada@acme.example");
  mia = await join(ada, "mia@acme.example", "member");
  vic = await join(ada, "vic@acme.example", "viewer");
  grace = await signUp("globex", "grace@globex.example");
});

afterAll(async () => {
  await database.drop();
});

describe("a new person", () => {
  it("arrives as an admin, so a team of three does no access administration to start", async () => {
    const hedy = await signUp("initech", "hedy@initech.example");

    expect(await roleOf(hedy)).toBe("admin");

    const auth: AuthContext = {
      userId: hedy.userId,
      organizationId: hedy.organizationId,
      projectId: hedy.projectId,
      role: "admin",
      via: "session",
    };
    for (const action of ACTIONS) {
      expect(permits(auth, action, inside(hedy)), action).toBe(true);
    }
  });
});

describe("an API key", () => {
  it("carries no role of its own, so there is none to go stale", async () => {
    const { rows } = await database.sql<{ column_name: string }>(
      `select column_name from information_schema.columns
        where table_schema = 'public' and table_name = 'api_key'`,
    );
    const names = rows.map((row) => row.column_name);

    expect(names).toContain("created_by_user_id");
    expect(names.filter((name) => /role|permission|grant/.test(name))).toEqual(
      [],
    );
  });

  it("acts at the role its creator holds now, not the one they held when they minted it", async () => {
    const mine = await createApiKey(
      {
        userId: mia.userId,
        organizationId: mia.organizationId,
        projectId: mia.projectId,
        role: "member",
        via: "session",
      },
      { ...secret(), name: "mia's terminal" },
    );

    const asMinted = await contextForKey(mine);
    expect(asMinted.role).toBe("member");
    expect(permits(asMinted, "author_definitions", inside(mia))).toBe(true);
    expect(permits(asMinted, "start_and_cancel_runs", inside(mia))).toBe(true);

    const before = await apiKeyRow(mine.id);

    // The demotion, and nothing else. No key is touched, and nobody goes
    // looking for one.
    await database.sql("update membership set role = $1 where user_id = $2", [
      "viewer",
      mia.userId,
    ]);

    const onTheNextRequest = await contextForKey(mine);
    expect(onTheNextRequest.role).toBe("viewer");
    expect(permits(onTheNextRequest, "author_definitions", inside(mia))).toBe(
      false,
    );
    expect(permits(onTheNextRequest, "start_and_cancel_runs", inside(mia))).toBe(
      false,
    );
    expect(permits(onTheNextRequest, "read", inside(mia))).toBe(true);
    expect(permits(onTheNextRequest, "mint_own_api_key", inside(mia))).toBe(
      true,
    );

    expect(await apiKeyRow(mine.id)).toEqual(before);
  });

  it("is something a viewer can still mint, or the product would be closed to them", async () => {
    const viewer: AuthContext = {
      userId: vic.userId,
      organizationId: vic.organizationId,
      projectId: vic.projectId,
      role: "viewer",
      via: "session",
    };
    expect(await roleOf(vic)).toBe("viewer");

    authorize(viewer, "mint_own_api_key", inside(vic));
    const theirs = await createApiKey(viewer, {
      ...secret(),
      name: "vic's terminal",
    });

    expect(theirs.createdByUserId).toBe(vic.userId);
    expect(permitsApiKeyMintedBy(viewer, theirs.createdByUserId, inside(vic))).toBe(
      true,
    );
  });

  it("belongs to whoever minted it, and only an admin reaches somebody else's", async () => {
    const theirs = await createApiKey(
      {
        userId: ada.userId,
        organizationId: ada.organizationId,
        projectId: ada.projectId,
        role: "admin",
        via: "session",
      },
      { ...secret(), name: "ada's terminal" },
    );

    const viewer: AuthContext = {
      userId: vic.userId,
      organizationId: vic.organizationId,
      projectId: vic.projectId,
      role: "viewer",
      via: "session",
    };
    const owner: AuthContext = {
      userId: ada.userId,
      organizationId: ada.organizationId,
      projectId: ada.projectId,
      role: "admin",
      via: "session",
    };

    expect(
      permitsApiKeyMintedBy(viewer, theirs.createdByUserId, inside(vic)),
    ).toBe(false);
    expect(
      permitsApiKeyMintedBy(owner, theirs.createdByUserId, inside(ada)),
    ).toBe(true);

    // And not across the boundary, however senior the person asking is.
    expect(
      permitsApiKeyMintedBy(owner, grace.userId, inside(grace)),
    ).toBe(false);
  });
});

