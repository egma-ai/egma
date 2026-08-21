/** The carrier-route HTTP surface, against real Postgres. */

import { PLATFORM_SETTINGS } from "@egma/db";
import { afterEach, describe, expect, it } from "vitest";

import { createApi, type TestApi } from "./support/api.ts";
import {
  colleagueOf,
  request as ask,
  signUp,
  type Answer,
  type Customer,
} from "./support/traces.ts";

let api: TestApi;

afterEach(async () => {
  await api?.close();
});

const CARRIER = {
  carrier_trunk_address: "acme.pstn.twilio.com",
  carrier_trunk_number: "+15550100100",
  carrier_trunk_username: "acme-trunk",
  carrier_trunk_password: "the-carrier-issued-this-one",
} as const;

const REPLACEMENT = {
  carrier_trunk_address: "production.pstn.twilio.com",
  carrier_trunk_number: "+15550100200",
  carrier_trunk_username: "egma-production",
  carrier_trunk_password: "the-production-sip-password",
} as const;

const REFUSAL =
  "the carrier route of this platform is read and changed by an " +
  "organization owner, and only while this Egma instance serves one " +
  "organization. It is deployment configuration, not project content; " +
  "where several organizations share a platform it belongs to none of " +
  "them, so Egma refuses everybody rather than picking one.";

function request(
  method: "GET" | "PATCH",
  key: string,
  payload?: Record<string, unknown>,
): Promise<Answer> {
  return ask(api.app, method, "/api/platform/settings", key, payload);
}

type DescribedSetting = {
  readonly name: string;
  readonly label: string;
  readonly secret: boolean;
  readonly hint: string | null;
  readonly updated_at: string | null;
};

function settingsIn(body: Record<string, unknown>): Record<string, DescribedSetting> {
  const settings = body.settings as DescribedSetting[];
  return Object.fromEntries(settings.map((setting) => [setting.name, setting]));
}

async function owner(label: string): Promise<Customer> {
  api = await createApi(label, { singleOrganization: true });
  return signUp(api.app, "ada@acme.example", "Acme");
}

describe("the platform carrier route", () => {
  it("lists only the four carrier settings before setup", async () => {
    const ada = await owner("platform_carrier_empty");

    const read = await request("GET", ada.secret);

    expect(read.statusCode).toBe(200);
    expect((read.body.settings as DescribedSetting[]).map((setting) => setting.name)).toEqual(
      PLATFORM_SETTINGS.map((setting) => setting.name),
    );
    expect((read.body.settings as DescribedSetting[]).map((setting) => setting.hint)).toEqual([
      null,
      null,
      null,
      null,
    ]);
  });

  it("writes one complete route and never returns its SIP password", async () => {
    const ada = await owner("platform_carrier_write");

    const written = await request("PATCH", ada.secret, CARRIER);

    expect(written.statusCode, JSON.stringify(written.body)).toBe(200);
    const held = settingsIn(written.body);
    expect(held.carrier_trunk_address).toMatchObject({
      label: "the carrier trunk",
      secret: false,
      hint: CARRIER.carrier_trunk_address,
      updated_at: expect.any(String),
    });
    expect(held.carrier_trunk_password).toMatchObject({
      label: "the carrier trunk password",
      secret: true,
      hint: CARRIER.carrier_trunk_password.slice(-4),
      updated_at: expect.any(String),
    });
    expect(JSON.stringify(written.body)).not.toContain(CARRIER.carrier_trunk_password);

  });

  it("seals the SIP password in storage", async () => {
    const ada = await owner("platform_carrier_sealed");
    await request("PATCH", ada.secret, CARRIER);

    const { rows } = await api.database.sql<{ value: string }>(
      "select value from platform_setting where name = $1",
      ["carrier_trunk_password"],
    );

    expect(rows[0]?.value).not.toContain(CARRIER.carrier_trunk_password);
    expect(rows[0]?.value.startsWith("v1.")).toBe(true);
  });

  it("replaces the complete route together", async () => {
    const ada = await owner("platform_carrier_replace");
    await request("PATCH", ada.secret, CARRIER);

    const edited = await request("PATCH", ada.secret, REPLACEMENT);
    const held = settingsIn(edited.body);

    expect(held.carrier_trunk_address).toMatchObject({
      hint: REPLACEMENT.carrier_trunk_address,
    });
    expect(held.carrier_trunk_number).toMatchObject({
      hint: REPLACEMENT.carrier_trunk_number,
    });
    expect(held.carrier_trunk_username).toMatchObject({
      hint: REPLACEMENT.carrier_trunk_username,
    });
    expect(held.carrier_trunk_password).toMatchObject({
      hint: REPLACEMENT.carrier_trunk_password.slice(-4),
    });
  });

  it("replaces a credential route with a source-IP route", async () => {
    const ada = await owner("platform_carrier_source_ip");
    await request("PATCH", ada.secret, CARRIER);

    const edited = await request("PATCH", ada.secret, {
      carrier_trunk_address: "source-ip.example.com",
      carrier_trunk_number: "+15550100300",
    });
    const held = settingsIn(edited.body);

    expect(held.carrier_trunk_address).toMatchObject({
      hint: "source-ip.example.com",
    });
    expect(held.carrier_trunk_number).toMatchObject({ hint: "+15550100300" });
    expect(held.carrier_trunk_username).toMatchObject({ hint: null });
    expect(held.carrier_trunk_password).toMatchObject({ hint: null });
  });

  it("stores deployment rows with no customer ownership columns", async () => {
    const ada = await owner("platform_carrier_scope");
    await request("PATCH", ada.secret, CARRIER);

    const { rows } = await api.database.sql<{ column_name: string }>(
      `select column_name from information_schema.columns
        where table_name = 'platform_setting'`,
    );
    const columns = rows.map((row) => row.column_name);
    expect(columns).not.toContain("organization_id");
    expect(columns).not.toContain("project_id");
  });
});

describe("carrier-route refusals", () => {
  it("refuses model settings because they have another owner", async () => {
    const ada = await owner("platform_carrier_unknown");

    const refused = await request("PATCH", ada.secret, {
      persona_model: "gpt-4o-mini",
    });

    expect(refused.statusCode).toBe(422);
    expect(refused.body.message).toBe(
      '"persona_model" is not a platform setting Egma knows; it holds ' +
        PLATFORM_SETTINGS.map((setting) => setting.name).join(", "),
    );
  });

  it("refuses partial, malformed and empty carrier routes", async () => {
    const ada = await owner("platform_carrier_invalid");

    const partial = await request("PATCH", ada.secret, {
      carrier_trunk_password: "a-complete-looking-password",
    });
    expect(partial.statusCode).toBe(422);
    expect(partial.body.message).toContain("a carrier write");

    const badNumber = await request("PATCH", ada.secret, {
      carrier_trunk_address: "carrier.example.com",
      carrier_trunk_number: "555-0100",
    });
    expect(badNumber.statusCode).toBe(422);
    expect(badNumber.body.message).toContain("E.164");

    const shortPassword = await request("PATCH", ada.secret, {
      ...CARRIER,
      carrier_trunk_password: "short",
    });
    expect(shortPassword.statusCode).toBe(422);
    expect(shortPassword.body.message).toContain("at least 8 characters");

    const empty = await request("PATCH", ada.secret, {});
    expect(empty.statusCode).toBe(422);
    expect(empty.body.message).toContain("a write names at least one setting");
  });

  it("refuses members and viewers before reading the body", async () => {
    const ada = await owner("platform_carrier_roles");
    const member = await colleagueOf(api.app, ada, "member@acme.example", "member");
    const viewer = await colleagueOf(api.app, ada, "viewer@acme.example", "viewer");

    for (const customer of [member, viewer]) {
      const read = await request("GET", customer.secret);
      const write = await request("PATCH", customer.secret, {
        persona_model: "gpt-4o-mini",
      });
      for (const refused of [read, write]) {
        expect(refused.statusCode).toBe(403);
        expect(refused.body.message).toBe(REFUSAL);
        expect(JSON.stringify(refused.body)).not.toContain("carrier_trunk_password");
      }
    }
  });

  it("refuses every organization on a multi-organization deployment", async () => {
    api = await createApi("platform_carrier_multi_org", {
      singleOrganization: false,
    });
    const ada = await signUp(api.app, "ada@acme.example", "Acme");

    for (const refused of [
      await request("GET", ada.secret),
      await request("PATCH", ada.secret, CARRIER),
    ]) {
      expect(refused.statusCode).toBe(403);
      expect(refused.body.message).toBe(REFUSAL);
    }
  });
});
