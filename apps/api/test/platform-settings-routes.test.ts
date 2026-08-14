import { seedPlatformSettings } from "@egma/db";
import { afterEach, describe, expect, it } from "vitest";

import { loadConfig } from "../src/config.ts";
import { createApi, type TestApi } from "./support/api.ts";
import {
  colleagueOf,
  request as ask,
  signUp,
  type Answer,
  type Customer,
} from "./support/traces.ts";

/**
 * The platform's own settings, over real HTTP against real Postgres.
 *
 * **What this file is about.** A self-hoster configures their platform once.
 * Every one of those settings used to live in a single file beside the
 * deployment that only the egma CLI read, so starting the platform any other
 * way lost all of them at once — and absent did not fail, because each variable
 * had an empty default. Every container started, every health check passed, the
 * platform reported itself ready, and the failure arrived minutes later as a
 * provider refusal naming nothing about configuration.
 *
 * So the platform owns its settings now, in its own store. What is asserted
 * here is what somebody outside the module can observe: a setting written is a
 * setting the platform holds, what lands in storage is not the plain value, a
 * setting read back has no key in it, and the readiness answer names what is
 * still missing in words a person reads. Nothing below knows the name of a
 * column or the shape of a sealed string.
 *
 * Refusal wording is contract — it is read in a terminal and acted on — so a
 * sentence that changed without somebody deciding to change it fails here.
 */

let api: TestApi;

afterEach(async () => {
  await api?.close();
});

const A_REAL_KEY = "sk-the-operator-pasted-this-one-QRST";
const A_SECOND_KEY = "sk-and-then-replaced-it-with-this-WXYZ";

/** What a fully configured phone half looks like, for the `ready` case. */
const A_CARRIER = {
  trunkAddress: "acme.pstn.twilio.com",
  sourceNumber: "+15550100",
  speechProvider: "openai",
} as const;

function request(
  method: "GET" | "PATCH",
  key: string,
  payload?: Record<string, unknown>,
): Promise<Answer> {
  return ask(api.app, method, "/api/platform/settings", key, payload);
}

/** One setting as the wire describes it, by name. */
function settingsIn(body: Record<string, unknown>): Record<string, unknown> {
  const listed = body.settings as { name: string }[];
  return Object.fromEntries(listed.map((setting) => [setting.name, setting]));
}

/** What the platform says about its own setup, at the door that asks for nothing. */
async function readiness(): Promise<{
  state: string;
  missing: readonly string[];
}> {
  const answered = await api.app.inject({ method: "GET", url: "/api/platform" });
  expect(answered.statusCode).toBe(200);
  return (answered.json() as { setup: { state: string; missing: string[] } })
    .setup;
}

/**
 * An owner, which is what a self-hoster is on the platform they run.
 *
 * **Single-organization, always, and that is a precondition rather than a
 * convenience.** These settings are the deployment's own provider credentials,
 * so they are only anybody's to read or change while that anybody is the whole
 * deployment; on a platform serving several customers the whole group is
 * refused, which the last block in this file is about.
 */
async function owner(label: string): Promise<Customer> {
  api = await createApi(label, { singleOrganization: true });
  return signUp(api.app, "ada@acme.example", "Acme");
}

describe("writing the platform's settings", () => {
  it("answers every setting it knows about, with a hint and never a key", async () => {
    const ada = await owner("platform_settings_write");

    const written = await request("PATCH", ada.secret, {
      persona_model_provider: "openai",
      persona_model: "gpt-4o",
      persona_model_key: A_REAL_KEY,
    });

    expect(written.statusCode, JSON.stringify(written.body)).toBe(200);
    const held = settingsIn(written.body);
    expect(held.persona_model_provider).toEqual({
      name: "persona_model_provider",
      label: "the persona's model provider",
      secret: false,
      hint: "openai",
      updated_at: expect.any(String),
    });
    // Enough to tell two keys apart, and nothing anybody could spend with.
    expect(held.persona_model_key).toMatchObject({
      label: "the persona's model key",
      secret: true,
      hint: "QRST",
    });
    expect(JSON.stringify(written.body)).not.toContain(A_REAL_KEY);
  });

  it("seals what it stores, so a copy of the database is not a copy of the account", async () => {
    const ada = await owner("platform_settings_sealed");
    await request("PATCH", ada.secret, { persona_model_key: A_REAL_KEY });

    // The one read in this file that goes around the API, on purpose: the claim
    // is that what is stored is ciphertext, and only a read the API cannot
    // dress up can say so.
    const { rows } = await api.database.sql<{ value: string }>(
      "select value from platform_setting where name = $1",
      ["persona_model_key"],
    );
    expect(rows[0]?.value).not.toContain(A_REAL_KEY);
    expect(rows[0]?.value.startsWith("v1.")).toBe(true);
  });

  it("changes what it names and leaves the rest alone", async () => {
    const ada = await owner("platform_settings_partial");
    await request("PATCH", ada.secret, {
      persona_model_provider: "openai",
      persona_model: "gpt-4o",
      persona_model_key: A_REAL_KEY,
    });

    // A settings form changes one field at a time, which is the whole reason
    // there is a row for each setting rather than one sealed document.
    const edited = await request("PATCH", ada.secret, {
      persona_model_key: A_SECOND_KEY,
    });

    const held = settingsIn(edited.body);
    expect(held.persona_model_key).toMatchObject({ hint: "WXYZ" });
    expect(held.persona_model).toMatchObject({ hint: "gpt-4o" });
  });

  it("reads back what a restart would read, because the platform holds it", async () => {
    const ada = await owner("platform_settings_read");
    await request("PATCH", ada.secret, {
      persona_model_provider: "openai",
      persona_model: "gpt-4o",
      persona_model_key: A_REAL_KEY,
    });

    const read = await request("GET", ada.secret);

    expect(read.statusCode).toBe(200);
    expect(settingsIn(read.body).persona_model).toMatchObject({
      hint: "gpt-4o",
    });
    expect(JSON.stringify(read.body)).not.toContain(A_REAL_KEY);
  });

  it("belongs to the deployment, so the stored row names no customer", async () => {
    const ada = await owner("platform_settings_deployment_scoped");
    await request("PATCH", ada.secret, { persona_model: "gpt-4o" });

    const { rows } = await api.database.sql<{ column_name: string }>(
      `select column_name from information_schema.columns
        where table_name = 'platform_setting'`,
    );
    const columns = rows.map((row) => row.column_name);

    expect(columns).not.toContain("organization_id");
    expect(columns).not.toContain("project_id");
  });
});

describe("who may read and change them", () => {
  it("refuses a member both, and says why in a sentence", async () => {
    const ada = await owner("platform_settings_member");
    const bruno = await colleagueOf(
      api.app,
      ada,
      "bruno@acme.example",
      "member",
    );

    const read = await request("GET", bruno.secret);
    const write = await request("PATCH", bruno.secret, {
      persona_model: "gpt-4o",
    });

    for (const refused of [read, write]) {
      expect(refused.statusCode).toBe(403);
      expect(refused.body.message).toBe(
        "the settings of this platform are read and changed by an " +
          "organization owner, and only while this egma serves one " +
          "organization. They are the deployment's own provider credentials — " +
          "whose account every simulation is conducted on — which is a " +
          "decision of the same kind as billing rather than of the same kind " +
          "as writing a test; and where several organizations share a platform " +
          "they belong to none of them, so egma refuses everybody rather than " +
          "picking one.",
      );
    }
  });

  it("refuses a viewer the same two", async () => {
    const ada = await owner("platform_settings_viewer");
    const cleo = await colleagueOf(api.app, ada, "cleo@acme.example", "viewer");

    expect((await request("GET", cleo.secret)).statusCode).toBe(403);
    expect(
      (await request("PATCH", cleo.secret, { persona_model: "gpt-4o" }))
        .statusCode,
    ).toBe(403);
  });

  it("tells a refused member nothing about what the platform holds", async () => {
    const ada = await owner("platform_settings_refusal_says_nothing");
    await request("PATCH", ada.secret, { persona_model_key: A_REAL_KEY });
    const bruno = await colleagueOf(
      api.app,
      ada,
      "bruno@acme.example",
      "member",
    );

    const refused = await request("GET", bruno.secret);

    expect(JSON.stringify(refused.body)).not.toContain("QRST");
    expect(JSON.stringify(refused.body)).not.toContain(A_REAL_KEY);

    // Not the names of the settings either, which the unknown-key refusal
    // recites: somebody who may not read them must not learn what they are by
    // misspelling one, so the role is answered before the body is looked at.
    const guessed = await request("PATCH", bruno.secret, {
      persona_moddel: "gpt-4o",
    });
    expect(guessed.statusCode).toBe(403);
    expect(JSON.stringify(guessed.body)).not.toContain("persona_model_key");
  });
});

describe("a write that cannot be acted on", () => {
  it("refuses a key this platform has no setting for, by name", async () => {
    const ada = await owner("platform_settings_unknown_key");

    const refused = await request("PATCH", ada.secret, {
      persona_moddel: "gpt-4o",
    });

    // One condition, one answer. The factory owns this refusal and the door
    // does not check the same thing a second time — two answers for one
    // condition would be a contract with two faces.
    expect(refused.statusCode).toBe(422);
    expect(refused.body.message).toBe(
      '"persona_moddel" is not a platform setting egma knows; it holds ' +
        "persona_model_provider, persona_model, persona_model_key",
    );
  });

  it("refuses a secret too short for any provider to have issued it", async () => {
    const ada = await owner("platform_settings_short_key");

    const refused = await request("PATCH", ada.secret, {
      persona_model_key: "sk-abc",
    });

    expect(refused.statusCode).toBe(422);
    expect(refused.body.message).toBe(
      "the persona's model key is at least 8 characters, and this one is " +
        "shorter than any provider issues",
    );
  });

  it("refuses an empty value, because clearing a setting is not writing one", async () => {
    const ada = await owner("platform_settings_empty_value");

    const refused = await request("PATCH", ada.secret, { persona_model: "  " });

    expect(refused.statusCode).toBe(422);
    expect(refused.body.message).toContain("the persona's model needs a value");
  });
});

describe("what the platform says about its own setup", () => {
  it("names every absent setting while any are absent", async () => {
    api = await createApi("platform_settings_readiness_missing");

    expect(await readiness()).toEqual({
      state: "setup_required",
      missing: [
        "the persona's model provider",
        "the persona's model",
        "the persona's model key",
        "the carrier trunk",
        "the source number",
        "the speech provider",
      ],
    });
  });

  it("stops naming a setting the moment somebody supplies it", async () => {
    api = await createApi("platform_settings_readiness_narrows", {
      singleOrganization: true,
      phone: { ...A_CARRIER },
    });
    const ada = await signUp(api.app, "ada@acme.example", "Acme");

    await request("PATCH", ada.secret, {
      persona_model_provider: "openai",
      persona_model: "gpt-4o",
    });

    // No restart between the write and this read: the answer is built from the
    // store on every request, which is the whole point of the store.
    expect(await readiness()).toEqual({
      state: "setup_required",
      missing: ["the persona's model key"],
    });
  });

  it("answers ready once nothing is missing", async () => {
    api = await createApi("platform_settings_readiness_ready", {
      singleOrganization: true,
      phone: { ...A_CARRIER },
    });
    const ada = await signUp(api.app, "ada@acme.example", "Acme");

    await request("PATCH", ada.secret, {
      persona_model_provider: "openai",
      persona_model: "gpt-4o",
      persona_model_key: A_REAL_KEY,
    });

    expect(await readiness()).toEqual({ state: "ready", missing: [] });
  });

  it("carries no secret, at a door that asks for no credential", async () => {
    api = await createApi("platform_settings_readiness_is_public", {
      singleOrganization: true,
      phone: { ...A_CARRIER },
    });
    const ada = await signUp(api.app, "ada@acme.example", "Acme");
    await request("PATCH", ada.secret, {
      persona_model_provider: "openai",
      persona_model: "gpt-4o",
      persona_model_key: A_REAL_KEY,
    });

    const answered = await api.app.inject({
      method: "GET",
      url: "/api/platform",
    });

    // Not the key, and not the hint of one either: this answer is read by
    // anybody who can reach the platform, before login and before a repository
    // identifier is ever sent.
    expect(answered.body).not.toContain(A_REAL_KEY);
    expect(answered.body).not.toContain("QRST");
  });
});

/** The variables a container must have whatever else it was started with. */
const A_CONTAINERS_ENVIRONMENT = {
  DATABASE_URL: "postgres://unused/unused",
  CLICKHOUSE_URL: "http://unused/unused",
  EGMA_AUTH_SECRET: "a-secret-only-this-test-uses",
  EGMA_ENCRYPTION_KEY: "0123456789abcdef".repeat(4),
  EGMA_SIMULATOR_SERVICE_TOKEN: "egma_st_held-by-this-test-suite-alone",
  EGMA_BASE_URL: "http://localhost:3101",
} as const;

describe("a deployment that answers no questions", () => {
  it("reads what its environment named as the settings to seed", async () => {
    const config = loadConfig({
      ...A_CONTAINERS_ENVIRONMENT,
      EGMA_PERSONA_MODEL_PROVIDER: "openai",
      EGMA_PERSONA_MODEL: "gpt-4o",
      EGMA_PERSONA_MODEL_API_KEY: A_REAL_KEY,
    });

    expect(config.platformSettings).toEqual({
      persona_model_provider: "openai",
      persona_model: "gpt-4o",
      persona_model_key: A_REAL_KEY,
    });
  });

  it("treats an empty variable as one nobody set", async () => {
    // This is the original failure's own shape, met at the door it used to come
    // through: compose passes an unset optional as an empty string, and a blank
    // seeded as a value would be a platform reporting itself configured with
    // nothing to speak to.
    const config = loadConfig({
      ...A_CONTAINERS_ENVIRONMENT,
      EGMA_PERSONA_MODEL_PROVIDER: "openai",
      EGMA_PERSONA_MODEL: "",
      EGMA_PERSONA_MODEL_API_KEY: "   ",
    });

    expect(config.platformSettings).toEqual({ persona_model_provider: "openai" });
  });

  it("holds nothing to seed on a deployment that named none", async () => {
    expect(loadConfig({ ...A_CONTAINERS_ENVIRONMENT }).platformSettings).toEqual(
      {},
    );
  });

  it("writes what its environment named, and reads it back through the API", async () => {
    // What `index.ts` does at start, with the values `loadConfig` read out of
    // the environment: an automated deployment configures itself and nobody
    // types anything.
    api = await createApi("platform_settings_seeded_from_environment", {
      singleOrganization: true,
    });
    const written = await seedPlatformSettings(
      loadConfig({
        ...A_CONTAINERS_ENVIRONMENT,
        EGMA_PERSONA_MODEL_PROVIDER: "openai",
        EGMA_PERSONA_MODEL: "gpt-4o",
        EGMA_PERSONA_MODEL_API_KEY: A_REAL_KEY,
      }).platformSettings,
    );
    expect([...written].sort()).toEqual([
      "persona_model",
      "persona_model_key",
      "persona_model_provider",
    ]);

    const ada = await signUp(api.app, "ada@acme.example", "Acme");
    const read = await request("GET", ada.secret);

    expect(settingsIn(read.body).persona_model_key).toMatchObject({
      hint: "QRST",
    });
    expect(JSON.stringify(read.body)).not.toContain(A_REAL_KEY);
  });

  it("leaves a setting somebody changed exactly as they left it", async () => {
    api = await createApi("platform_settings_seed_never_replaces", {
      singleOrganization: true,
    });
    const ada = await signUp(api.app, "ada@acme.example", "Acme");
    await request("PATCH", ada.secret, { persona_model_key: A_SECOND_KEY });

    // The next start, with the old key still in the deployment script.
    expect(
      await seedPlatformSettings({
        persona_model: "gpt-4o",
        persona_model_key: A_REAL_KEY,
      }),
    ).toEqual(["persona_model"]);

    const read = await request("GET", ada.secret);
    expect(settingsIn(read.body).persona_model_key).toMatchObject({
      hint: "WXYZ",
    });
  });
});

describe("a platform that serves more than one organization", () => {
  /**
   * **Nobody's, rather than everybody's.** These settings are the deployment's
   * own provider credentials. On a platform holding several customers, one
   * organization's owner reading them would be reading the hints of a key the
   * others depend on, and writing them would point everybody else's simulations
   * at an account nobody else agreed to. Whose they are there is a real
   * question and is deliberately unanswered, so egma refuses everybody rather
   * than picking one — the guard the platform's own judge already stands
   * behind, which is only ever given away on a single-organization deployment.
   */
  it("refuses every owner both doors", async () => {
    api = await createApi("platform_settings_several_customers", {
      singleOrganization: false,
    });
    const ada = await signUp(api.app, "ada@acme.example", "Acme");
    const grace = await signUp(api.app, "grace@globex.example", "Globex");

    for (const person of [ada, grace]) {
      const read = await request("GET", person.secret);
      const write = await request("PATCH", person.secret, {
        persona_model: "gpt-4o",
      });

      expect(read.statusCode).toBe(403);
      expect(write.statusCode).toBe(403);
      expect(read.body.message).toContain(
        "only while this egma serves one organization",
      );
    }
  });

  it("still says what it is missing, because that answer carries nothing", async () => {
    api = await createApi("platform_settings_several_customers_readiness", {
      singleOrganization: false,
    });

    // Readiness is not a permission question: it names absent settings in the
    // words a person would use and carries no value that any secret holds, so
    // the door that asks for no credential answers here exactly as it does on
    // a deployment that is one team.
    expect((await readiness()).state).toBe("setup_required");
  });
});
