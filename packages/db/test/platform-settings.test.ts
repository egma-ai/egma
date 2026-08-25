import { newId } from "@egma/ids";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  NotPermittedError,
  platformFacts,
  PLATFORM_SETTINGS,
  readPlatformSettings,
  reconcileDeploymentCarrierSettings,
  resolvePlatformSettings,
  seedPlatformSettings,
  writePlatformSettings,
  type AuthContext,
  type PlatformSettingValues,
} from "@egma/db";

import {
  createConnectedDatabase,
  type MigratedDatabase,
} from "./support/database.ts";
import { seedOrganization, seedUser } from "./support/tenancy.ts";

/**
 * The platform store has one job: hold the active phone-carrier route.
 *
 * Model choices belong to immutable persona and grader versions. Provider
 * credentials come from deployment custody. This suite writes out the four
 * carrier names so adding either kind of model data here is a failing change.
 */

let database: MigratedDatabase;

const acme = { organization: newId("org"), project: newId("prj") };
const globex = { organization: newId("org"), project: newId("prj") };
const ada = newId("usr");
const bruno = newId("usr");

const ONE_TEAM = { singleOrganization: true } as const;
const SEVERAL_CUSTOMERS = { singleOrganization: false } as const;

const FIRST_ROUTE = {
  carrier_trunk_address: "first.pstn.twilio.com",
  carrier_trunk_number: "+15550100100",
  carrier_trunk_username: "egma-ada",
  carrier_trunk_password: "first-carrier-password",
} as const;

const SECOND_ROUTE = {
  carrier_trunk_address: "second.pstn.twilio.com",
  carrier_trunk_number: "+15550100200",
  carrier_trunk_username: "egma-production",
  carrier_trunk_password: "second-carrier-password",
} as const;

const IP_ROUTE = {
  carrier_trunk_address: "ip-auth.example.com",
  carrier_trunk_number: "+15550100300",
} as const;

// Built at runtime so a validator sees the real SID shape without publishing
// a token-shaped literal that GitHub push protection must treat as a secret.
const TWILIO_ACCOUNT_SID = [
  "AC",
  "0123456789abcdef",
  "0123456789abcdef",
].join("");

function owner(): AuthContext {
  return {
    userId: ada,
    organizationId: acme.organization,
    projectId: acme.project,
    role: "admin",
    via: "session",
  };
}

function member(role: "member" | "viewer"): AuthContext {
  return {
    userId: bruno,
    organizationId: acme.organization,
    projectId: acme.project,
    role,
    via: "session",
  };
}

function claimedBySimulator(): AuthContext {
  return {
    userId: "simulator",
    organizationId: acme.organization,
    projectId: acme.project,
    role: "member",
    via: "simulator",
  };
}

async function settingsByName(): Promise<
  Record<string, { hint: string | null; secret: boolean }>
> {
  const held = await readPlatformSettings(owner(), ONE_TEAM);
  return Object.fromEntries(
    held.map((setting) => [
      setting.name,
      { hint: setting.hint, secret: setting.secret },
    ]),
  );
}

beforeAll(async () => {
  database = await createConnectedDatabase("platform_settings");
  await seedOrganization(database, acme.organization, [
    { id: acme.project, slug: "default" },
  ]);
  await seedOrganization(database, globex.organization, [
    { id: globex.project, slug: "default" },
  ]);
  await seedUser(database, ada, "ada@acme.example");
  await seedUser(database, bruno, "bruno@acme.example");
});

beforeEach(async () => {
  await database.sql("delete from platform_setting");
});

afterAll(async () => {
  await database.drop();
});

describe("the carrier-only platform catalog", () => {
  it("contains exactly the four phone-route fields", () => {
    expect(
      PLATFORM_SETTINGS.map((setting) => [setting.name, setting.secret]),
    ).toEqual([
      ["carrier_trunk_address", false],
      ["carrier_trunk_number", false],
      ["carrier_trunk_username", false],
      ["carrier_trunk_password", true],
    ]);
  });

  it("answers every known field as absent before setup", async () => {
    const held = await settingsByName();
    expect(Object.keys(held)).toEqual(
      PLATFORM_SETTINGS.map((setting) => setting.name),
    );
    for (const setting of PLATFORM_SETTINGS) {
      expect(held[setting.name]).toEqual({
        hint: null,
        secret: setting.secret,
      });
    }
    expect(await platformFacts()).toEqual({});
  });
});

describe("writing one complete route", () => {
  it("seals the password and shows only its hint", async () => {
    await writePlatformSettings(owner(), ONE_TEAM, FIRST_ROUTE);

    const stored = await database.sql<{ value: string; hint: string }>(
      "select value, hint from platform_setting where name = $1",
      ["carrier_trunk_password"],
    );
    expect(stored.rows[0]?.value).not.toContain(
      FIRST_ROUTE.carrier_trunk_password,
    );
    expect(stored.rows[0]?.value.startsWith("v1.")).toBe(true);
    expect(stored.rows[0]?.hint).toBe("word");

    const shown = await settingsByName();
    expect(shown.carrier_trunk_address?.hint).toBe(
      FIRST_ROUTE.carrier_trunk_address,
    );
    expect(shown.carrier_trunk_password).toEqual({
      hint: "word",
      secret: true,
    });
    expect(
      JSON.stringify(await readPlatformSettings(owner(), ONE_TEAM)),
    ).not.toContain(FIRST_ROUTE.carrier_trunk_password);
  });

  it("shows non-secret route facts and never any password bytes", async () => {
    await writePlatformSettings(owner(), ONE_TEAM, FIRST_ROUTE);

    expect(await platformFacts()).toEqual({
      carrier_trunk_address: FIRST_ROUTE.carrier_trunk_address,
      carrier_trunk_number: FIRST_ROUTE.carrier_trunk_number,
      carrier_trunk_username: FIRST_ROUTE.carrier_trunk_username,
      carrier_trunk_password: null,
    });
  });

  it("switches from credential auth to IP auth as one write", async () => {
    await writePlatformSettings(owner(), ONE_TEAM, FIRST_ROUTE);
    await writePlatformSettings(owner(), ONE_TEAM, IP_ROUTE);

    expect(await resolvePlatformSettings(claimedBySimulator())).toEqual(
      IP_ROUTE,
    );
  });

  it("stores no customer ownership columns", async () => {
    const { rows } = await database.sql<{ column_name: string }>(
      `select column_name from information_schema.columns
        where table_name = 'platform_setting'`,
    );
    expect(rows.map((row) => row.column_name).sort()).toEqual([
      "created_at",
      "hint",
      "id",
      "name",
      "updated_at",
      "value",
    ]);
  });
});

describe("carrier write validation", () => {
  it("refuses an unknown setting", async () => {
    await expect(
      writePlatformSettings(
        owner(),
        ONE_TEAM,
        { model_provider: "openai" } as unknown as PlatformSettingValues,
      ),
    ).rejects.toThrow(/not a platform setting Egma knows/u);
  });

  it("refuses a partial carrier route", async () => {
    await expect(
      writePlatformSettings(owner(), ONE_TEAM, {
        carrier_trunk_password: "one-new-password",
      }),
    ).rejects.toThrow(/carrier write.*missing/u);
  });

  it("refuses invalid trunk and phone-number values", async () => {
    await expect(
      writePlatformSettings(owner(), ONE_TEAM, {
        carrier_trunk_address: "https://trunk.example.com/a/path",
        carrier_trunk_number: "+15550100100",
      }),
    ).rejects.toThrow(/SIP hostname/u);
    await expect(
      writePlatformSettings(owner(), ONE_TEAM, {
        carrier_trunk_address: "trunk.example.com",
        carrier_trunk_number: "555-0100",
      }),
    ).rejects.toThrow(/E\.164/u);
  });

  it("refuses an empty value and a short password", async () => {
    await expect(
      writePlatformSettings(owner(), ONE_TEAM, {
        carrier_trunk_address: "   ",
        carrier_trunk_number: "+15550100100",
      }),
    ).rejects.toThrow(/needs a value/u);
    await expect(
      writePlatformSettings(owner(), ONE_TEAM, {
        ...FIRST_ROUTE,
        carrier_trunk_password: "short",
      }),
    ).rejects.toThrow(/shorter than a valid SIP credential/u);
  });

  it("refuses a Twilio Account SID where a SIP username belongs", async () => {
    await expect(
      writePlatformSettings(owner(), ONE_TEAM, {
        ...FIRST_ROUTE,
        carrier_trunk_username: TWILIO_ACCOUNT_SID,
      }),
    ).rejects.toThrow(
      /Account SID.*Credential List.*not.*Account SID.*Auth Token/iu,
    );
    expect(await platformFacts()).toEqual({});
  });
});

describe("who may manage the route", () => {
  it("allows the owner of a single-organization deployment", async () => {
    await writePlatformSettings(owner(), ONE_TEAM, FIRST_ROUTE);
    expect(
      (await readPlatformSettings(owner(), ONE_TEAM)).find(
        (setting) => setting.name === "carrier_trunk_number",
      )?.hint,
    ).toBe(FIRST_ROUTE.carrier_trunk_number);
  });

  it("refuses members and viewers", async () => {
    for (const auth of [member("member"), member("viewer")]) {
      await expect(readPlatformSettings(auth, ONE_TEAM)).rejects.toThrow(
        NotPermittedError,
      );
      await expect(
        writePlatformSettings(auth, ONE_TEAM, FIRST_ROUTE),
      ).rejects.toThrow(NotPermittedError);
    }
  });

  it("refuses every customer owner on a multi-organization deployment", async () => {
    const globexOwner: AuthContext = {
      userId: newId("usr"),
      organizationId: globex.organization,
      projectId: globex.project,
      role: "admin",
      via: "session",
    };
    await expect(
      readPlatformSettings(owner(), SEVERAL_CUSTOMERS),
    ).rejects.toThrow(NotPermittedError);
    await expect(
      writePlatformSettings(globexOwner, SEVERAL_CUSTOMERS, FIRST_ROUTE),
    ).rejects.toThrow(NotPermittedError);
  });
});

describe("boot seeding", () => {
  it("writes a complete credential route into an empty store", async () => {
    expect([...(await seedPlatformSettings(FIRST_ROUTE))].sort()).toEqual(
      Object.keys(FIRST_ROUTE).sort(),
    );
    expect(await resolvePlatformSettings(claimedBySimulator())).toEqual(
      FIRST_ROUTE,
    );
  });

  it("writes a complete IP-authenticated route", async () => {
    expect([...(await seedPlatformSettings(IP_ROUTE))].sort()).toEqual(
      Object.keys(IP_ROUTE).sort(),
    );
    expect(await resolvePlatformSettings(claimedBySimulator())).toEqual(
      IP_ROUTE,
    );
  });

  it("does not replace either complete stored route", async () => {
    await seedPlatformSettings(FIRST_ROUTE);
    expect(await seedPlatformSettings(SECOND_ROUTE)).toEqual([]);
    expect(await resolvePlatformSettings(claimedBySimulator())).toEqual(
      FIRST_ROUTE,
    );

    await database.sql("delete from platform_setting");
    await seedPlatformSettings(IP_ROUTE);
    expect(await seedPlatformSettings(FIRST_ROUTE)).toEqual([]);
    expect(await resolvePlatformSettings(claimedBySimulator())).toEqual(
      IP_ROUTE,
    );
  });

  it("refuses a stored partial route instead of repairing it at boot", async () => {
    await writePlatformSettings(owner(), ONE_TEAM, SECOND_ROUTE);
    await database.sql(
      "delete from platform_setting where name <> 'carrier_trunk_username'",
    );

    await expect(seedPlatformSettings({})).rejects.toThrow(
      /stored carrier route is incomplete/u,
    );
    await expect(seedPlatformSettings(FIRST_ROUTE)).rejects.toThrow(
      /stored carrier route is incomplete/u,
    );
    expect(await resolvePlatformSettings(claimedBySimulator())).toEqual({
      carrier_trunk_username: SECOND_ROUTE.carrier_trunk_username,
    });
  });

  it("refuses a partial environment route before writing any part", async () => {
    await expect(
      seedPlatformSettings({
        carrier_trunk_address: "trunk.example.com",
        carrier_trunk_username: "egma-ada",
      }),
    ).rejects.toThrow(/carrier seed.*missing/u);
    expect(await platformFacts()).toEqual({});
  });
});

describe("environment-owned carrier reconciliation", () => {
  it("atomically replaces a different complete route", async () => {
    await writePlatformSettings(owner(), ONE_TEAM, FIRST_ROUTE);

    expect(
      [...(await reconcileDeploymentCarrierSettings(SECOND_ROUTE))].sort(),
    ).toEqual(Object.keys(SECOND_ROUTE).sort());
    expect(await resolvePlatformSettings(claimedBySimulator())).toEqual(
      SECOND_ROUTE,
    );
  });

  it("does nothing when the route already matches", async () => {
    await writePlatformSettings(owner(), ONE_TEAM, SECOND_ROUTE);
    expect(await reconcileDeploymentCarrierSettings(SECOND_ROUTE)).toEqual([]);
  });

  it("refuses a partial replacement and preserves the working route", async () => {
    await writePlatformSettings(owner(), ONE_TEAM, FIRST_ROUTE);
    await expect(
      reconcileDeploymentCarrierSettings({
        carrier_trunk_address: "partial.pstn.twilio.com",
        carrier_trunk_number: "+15550100400",
        carrier_trunk_username: "egma-partial",
      }),
    ).rejects.toThrow(/carrier reconciliation.*missing/u);
    expect(await resolvePlatformSettings(claimedBySimulator())).toEqual(
      FIRST_ROUTE,
    );
  });

  it("switches to IP authentication and removes the credentials", async () => {
    await writePlatformSettings(owner(), ONE_TEAM, FIRST_ROUTE);
    await reconcileDeploymentCarrierSettings(IP_ROUTE);
    expect(await resolvePlatformSettings(claimedBySimulator())).toEqual(
      IP_ROUTE,
    );
  });

  it("preserves a legacy stored route when the environment offers none", async () => {
    await writePlatformSettings(owner(), ONE_TEAM, FIRST_ROUTE);
    expect(await reconcileDeploymentCarrierSettings({})).toEqual([]);
    expect(await resolvePlatformSettings(claimedBySimulator())).toEqual(
      FIRST_ROUTE,
    );
  });

  it("clears a retained route only when the deployment says so explicitly", async () => {
    await writePlatformSettings(owner(), ONE_TEAM, FIRST_ROUTE);
    expect(
      [...(
        await reconcileDeploymentCarrierSettings({}, { clear: true })
      )].sort(),
    ).toEqual(Object.keys(FIRST_ROUTE).sort());
    expect(await resolvePlatformSettings(claimedBySimulator())).toEqual({});
  });
});

describe("the simulator-only cleartext door", () => {
  it("returns the exact route to a simulation claim", async () => {
    await writePlatformSettings(owner(), ONE_TEAM, FIRST_ROUTE);
    expect(await resolvePlatformSettings(claimedBySimulator())).toEqual(
      FIRST_ROUTE,
    );
  });

  it("refuses every context that a simulation claim did not mint", async () => {
    for (const auth of [
      owner(),
      member("member"),
      { ...claimedBySimulator(), via: "api_key" } as AuthContext,
      { ...claimedBySimulator(), via: "engine" } as AuthContext,
    ]) {
      await expect(resolvePlatformSettings(auth)).rejects.toThrow(
        /Egma's own simulator/u,
      );
    }
  });

  it("refuses a damaged envelope instead of sending it to the carrier", async () => {
    await seedPlatformSettings(IP_ROUTE);
    await database.sql(
      "update platform_setting set value = 'not-an-envelope' where name = $1",
      ["carrier_trunk_address"],
    );
    await expect(
      resolvePlatformSettings(claimedBySimulator()),
    ).rejects.toThrow();
  });
});
