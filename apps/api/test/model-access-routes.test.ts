import {
  listModelProviderCredentials,
  MODEL_PROVIDERS,
  PROVIDER_CATALOG,
} from "@egma/db";
import { afterEach, describe, expect, it } from "vitest";

import {
  MODEL_ACCESS_PATH,
  MODEL_CATALOG_PATH,
  MODEL_PROVIDER_CREDENTIALS_PATH,
} from "../src/routes/model-access.ts";
import { createApi, type TestApi } from "./support/api.ts";
import {
  colleagueOf,
  contextFor,
  request as ask,
  signUp,
  type Customer,
} from "./support/traces.ts";

/**
 * Model providers, over real HTTP against real Postgres.
 *
 * What is asserted here is what a browser and an API client actually observe:
 * that a stored key never comes back out of any of these doors, that only an
 * admin may move any of it, that another organization sees none of it, and that
 * saving reaches no provider and scans nothing for completeness.
 */

let api: TestApi;

afterEach(async () => {
  await api?.close();
});

const OPENAI_KEY = "sk-sentinel-model-provider-A1B2";
const DEEPGRAM_KEY = "dg-sentinel-model-provider-C3D4";

type World = {
  readonly ada: Customer;
  readonly adminKey: string;
};

async function aCustomer(label: string): Promise<World> {
  api = await createApi(label);
  const ada = await signUp(api.app, "ada@acme.example", "Acme");
  // The organization-scoped key the signup comes away with: these doors are
  // the customer's own and name no project.
  return { ada, adminKey: ada.secret };
}

/** A colleague at a named role, holding an organization key of their own. */
async function aMemberOf(host: Customer): Promise<string> {
  const colleague = await colleagueOf(
    api.app,
    host,
    "bob@acme.example",
    "member",
  );
  return colleague.secret;
}

describe("the provider catalog", () => {
  it("is served by the platform, so a browser keeps no second list", async () => {
    const { adminKey } = await aCustomer("model_catalog");

    const read = await ask(api.app, "GET", MODEL_CATALOG_PATH, adminKey);

    expect(read.statusCode, JSON.stringify(read.body)).toBe(200);
    expect(read.body.jobs).toEqual(["llm", "stt", "tts"]);

    const providers = read.body.providers as {
      provider: string;
      job: string;
      recommended_model: string;
      recommended_voice_id?: string;
      model_is_free_text: boolean;
    }[];
    expect(providers.map((one) => `${one.job}:${one.provider}`)).toEqual(
      PROVIDER_CATALOG.map((one) => `${one.job}:${one.provider}`),
    );
  });

  it("recommends a proved default for each job, and lets any id be typed over it", async () => {
    const { adminKey } = await aCustomer("model_catalog_defaults");

    const read = await ask(api.app, "GET", MODEL_CATALOG_PATH, adminKey);
    const providers = read.body.providers as {
      provider: string;
      job: string;
      recommended_model: string;
      recommended_voice_id?: string;
      model_is_free_text: boolean;
    }[];

    const byJob = (job: string) => providers.find((one) => one.job === job);
    expect(byJob("llm")?.provider).toBe("openai");
    expect(byJob("stt")?.provider).toBe("deepgram");
    expect(byJob("tts")?.provider).toBe("cartesia");
    // The speaking entry is the only one that needs a voice, and it has one.
    expect(byJob("tts")?.recommended_voice_id).toBeTruthy();
    expect(byJob("llm")?.recommended_voice_id).toBeUndefined();

    for (const entry of providers) {
      expect(entry.recommended_model).toBeTruthy();
      // Egma never allowlists a model id: a release proves one default and the
      // provider is the authority on the rest.
      expect(entry.model_is_free_text).toBe(true);
    }
  });

  /**
   * The narrowing, read the way a browser reads it.
   *
   * The first catalog was cut to the entries Egma can live-prove with the
   * provider accounts it holds, and **a provider Egma cannot prove is a
   * provider Egma does not mention** — not in the selectable list and not in a
   * roadmap beside it, because a name served to every browser reads as a
   * promise about a date nobody has set. So the reserved list is empty today
   * and the rule it carries still holds: nothing named there is selectable.
   */
  it("promises no provider it cannot yet keep, and makes nothing reserved selectable", async () => {
    const { adminKey } = await aCustomer("model_catalog_reserved");

    const read = await ask(api.app, "GET", MODEL_CATALOG_PATH, adminKey);
    const reserved = read.body.reserved as { provider: string; job: string }[];
    const shipped = (read.body.providers as { provider: string; job: string }[]).map(
      (one) => `${one.job}:${one.provider}`,
    );

    for (const one of reserved) {
      expect(shipped).not.toContain(`${one.job}:${one.provider}`);
    }

    // The four that left this effort's scope, hunted through the whole answer
    // rather than through one field of it.
    const answered = JSON.stringify(read.body).toLowerCase();
    for (const absent of ["anthropic", "gemini", "assemblyai", "elevenlabs"]) {
      expect(answered, `${absent} is still named in the catalog answer`).not.toContain(absent);
    }
  });

  it("does not offer Silero, or any voice-activity choice at all", async () => {
    const { adminKey } = await aCustomer("model_catalog_no_vad");

    const read = await ask(api.app, "GET", MODEL_CATALOG_PATH, adminKey);

    // What tells the persona the agent started and stopped speaking is
    // internal simulator behavior, not a model anybody chooses.
    expect(JSON.stringify(read.body).toLowerCase()).not.toContain("silero");
    expect(JSON.stringify(read.body).toLowerCase()).not.toContain("vad");
    expect(read.body.jobs).not.toContain("vad");
  });
});

describe("choosing who supplies the credentials", () => {
  it("starts customer-owned, with nothing chosen and nothing stored", async () => {
    const { adminKey } = await aCustomer("model_access_default");

    const read = await ask(api.app, "GET", MODEL_ACCESS_PATH, adminKey);

    expect(read.statusCode, JSON.stringify(read.body)).toBe(200);
    expect(read.body.mode).toBe("customer-owned");
    expect(read.body.updated_at).toBeNull();
    expect(read.body.credentials).toEqual([]);
    expect(read.body.modes).toEqual(["managed", "customer-owned"]);
  });

  it("refuses managed by name while nothing is connected, and says so up front", async () => {
    const { adminKey } = await aCustomer("model_access_managed_refused");

    // The read says the choice is unavailable, so a form never offers it.
    const read = await ask(api.app, "GET", MODEL_ACCESS_PATH, adminKey);
    expect(read.body.managed_available).toBe(false);

    const chosen = await ask(api.app, "PUT", MODEL_ACCESS_PATH, adminKey, {
      mode: "managed",
    });
    expect(chosen.statusCode).toBe(422);
    expect(String(chosen.body.message)).toContain("Egma model gateway");
    expect(String(chosen.body.message)).toContain("Customer-owned");

    // And nothing moved.
    const after = await ask(api.app, "GET", MODEL_ACCESS_PATH, adminKey);
    expect(after.body.mode).toBe("customer-owned");
  });

  it("has no third state and no per-provider mixing to ask for", async () => {
    const { adminKey } = await aCustomer("model_access_binary");

    for (const asked of ["mixed", "per-provider", ""]) {
      const chosen = await ask(api.app, "PUT", MODEL_ACCESS_PATH, adminKey, {
        mode: asked,
      });
      expect(chosen.statusCode, asked).toBeGreaterThanOrEqual(400);
    }

    // And a body that tried to name a provider is refused for the key itself.
    const perProvider = await ask(api.app, "PUT", MODEL_ACCESS_PATH, adminKey, {
      mode: "customer-owned",
      provider: "openai",
    });
    expect(perProvider.statusCode).toBe(400);
    expect(String(perProvider.body.message)).toContain("provider");
  });

  it("is an admin's to change and nobody else's", async () => {
    const { ada, adminKey } = await aCustomer("model_access_role");
    const memberKey = await aMemberOf(ada);

    const refused = await ask(api.app, "PUT", MODEL_ACCESS_PATH, memberKey, {
      mode: "customer-owned",
    });
    expect(refused.statusCode).toBe(403);

    // A member can still see which mode the organization is on: it is not a
    // secret, and a persona's Models form has to be able to say who pays.
    const read = await ask(api.app, "GET", MODEL_ACCESS_PATH, memberKey);
    expect(read.statusCode).toBe(200);
    expect(read.body.mode).toBe("customer-owned");

    const chosen = await ask(api.app, "PUT", MODEL_ACCESS_PATH, adminKey, {
      mode: "customer-owned",
    });
    expect(chosen.statusCode, JSON.stringify(chosen.body)).toBe(200);
  });

  it("scans nothing for completeness, however little is configured", async () => {
    const { adminKey } = await aCustomer("model_access_no_scan");

    // Nothing stored at all, which under customer-owned access is an
    // organization that cannot conduct a simulation yet. The setting still
    // lands: readiness is reported per claim, never as a checklist in front of
    // a switch somebody can plainly see.
    const chosen = await ask(api.app, "PUT", MODEL_ACCESS_PATH, adminKey, {
      mode: "customer-owned",
    });

    expect(chosen.statusCode, JSON.stringify(chosen.body)).toBe(200);
    expect(chosen.body.mode).toBe("customer-owned");
  });
});

describe("one provider's key", () => {
  it("is stored and comes back as a provider and four characters, never the key", async () => {
    const { adminKey } = await aCustomer("model_credentials_stored");

    const stored = await ask(
      api.app,
      "PUT",
      MODEL_PROVIDER_CREDENTIALS_PATH,
      adminKey,
      { provider: "openai", key: OPENAI_KEY },
    );

    expect(stored.statusCode, JSON.stringify(stored.body)).toBe(200);
    expect(stored.body.provider).toBe("openai");
    expect(stored.body.hint).toBe("A1B2");
    expect(JSON.stringify(stored.body)).not.toContain(OPENAI_KEY);

    const listed = await ask(
      api.app,
      "GET",
      MODEL_PROVIDER_CREDENTIALS_PATH,
      adminKey,
    );
    expect(JSON.stringify(listed.body)).not.toContain(OPENAI_KEY);
    expect((listed.body.items as { provider: string }[])[0]?.provider).toBe(
      "openai",
    );
  });

  it("is replaced by the same door, and there is still only one", async () => {
    const { ada, adminKey } = await aCustomer("model_credentials_replaced");

    await ask(api.app, "PUT", MODEL_PROVIDER_CREDENTIALS_PATH, adminKey, {
      provider: "openai",
      key: OPENAI_KEY,
    });
    const replaced = await ask(
      api.app,
      "PUT",
      MODEL_PROVIDER_CREDENTIALS_PATH,
      adminKey,
      { provider: "openai", key: "sk-sentinel-model-provider-Z9Y8" },
    );

    expect(replaced.statusCode, JSON.stringify(replaced.body)).toBe(200);
    expect(replaced.body.hint).toBe("Z9Y8");

    const held = await listModelProviderCredentials(contextFor(ada, "admin"));
    expect(held.filter((one) => one.provider === "openai")).toHaveLength(1);
  });

  it("is removed, and removing one that was never there says so plainly", async () => {
    const { adminKey } = await aCustomer("model_credentials_removed");

    await ask(api.app, "PUT", MODEL_PROVIDER_CREDENTIALS_PATH, adminKey, {
      provider: "deepgram",
      key: DEEPGRAM_KEY,
    });

    const removed = await ask(
      api.app,
      "DELETE",
      `${MODEL_PROVIDER_CREDENTIALS_PATH}/deepgram`,
      adminKey,
    );
    expect(removed.statusCode, JSON.stringify(removed.body)).toBe(200);
    expect(removed.body.removed).toBe(true);

    const again = await ask(
      api.app,
      "DELETE",
      `${MODEL_PROVIDER_CREDENTIALS_PATH}/deepgram`,
      adminKey,
    );
    expect(again.statusCode).toBe(200);
    expect(again.body.removed).toBe(false);
  });

  it("is refused for a provider Egma ships no adapter for", async () => {
    const { adminKey } = await aCustomer("model_credentials_unknown_provider");

    const refused = await ask(
      api.app,
      "PUT",
      MODEL_PROVIDER_CREDENTIALS_PATH,
      adminKey,
      { provider: "elevenlabs", key: OPENAI_KEY },
    );

    expect(refused.statusCode).toBe(422);
    for (const shipped of MODEL_PROVIDERS) {
      expect(String(refused.body.message)).toContain(shipped);
    }
  });

  it("is an admin's to manage and nobody else's", async () => {
    const { ada, adminKey } = await aCustomer("model_credentials_role");
    const memberKey = await aMemberOf(ada);

    const refusedStore = await ask(
      api.app,
      "PUT",
      MODEL_PROVIDER_CREDENTIALS_PATH,
      memberKey,
      { provider: "openai", key: OPENAI_KEY },
    );
    expect(refusedStore.statusCode).toBe(403);

    await ask(api.app, "PUT", MODEL_PROVIDER_CREDENTIALS_PATH, adminKey, {
      provider: "openai",
      key: OPENAI_KEY,
    });

    const refusedRemove = await ask(
      api.app,
      "DELETE",
      `${MODEL_PROVIDER_CREDENTIALS_PATH}/openai`,
      memberKey,
    );
    expect(refusedRemove.statusCode).toBe(403);

    // A member still sees which providers are configured, by hint alone: it is
    // what a Models form reads to say what is set up.
    const listed = await ask(
      api.app,
      "GET",
      MODEL_PROVIDER_CREDENTIALS_PATH,
      memberKey,
    );
    expect(listed.statusCode).toBe(200);
    expect((listed.body.items as { hint: string }[])[0]?.hint).toBe("A1B2");
    expect(JSON.stringify(listed.body)).not.toContain(OPENAI_KEY);
  });

  it("belongs to one organization, and another sees and reaches none of it", async () => {
    const { adminKey } = await aCustomer("model_credentials_isolation");
    await ask(api.app, "PUT", MODEL_PROVIDER_CREDENTIALS_PATH, adminKey, {
      provider: "openai",
      key: OPENAI_KEY,
    });

    const grace = await signUp(api.app, "grace@globex.example", "Globex");
    const globexKey = grace.secret;

    const listed = await ask(
      api.app,
      "GET",
      MODEL_PROVIDER_CREDENTIALS_PATH,
      globexKey,
    );
    expect(listed.statusCode).toBe(200);
    expect(listed.body.items).toEqual([]);

    const removed = await ask(
      api.app,
      "DELETE",
      `${MODEL_PROVIDER_CREDENTIALS_PATH}/openai`,
      globexKey,
    );
    expect(removed.body.removed).toBe(false);

    // Acme still holds what Globex was just told nothing about.
    const acme = await ask(
      api.app,
      "GET",
      MODEL_PROVIDER_CREDENTIALS_PATH,
      adminKey,
    );
    expect((acme.body.items as { provider: string }[])[0]?.provider).toBe(
      "openai",
    );
  });

  it("reaches no provider when it is saved", async () => {
    const { adminKey } = await aCustomer("model_credentials_no_provider_call");

    // A key that could not possibly authenticate anywhere. Saving it succeeds,
    // because saving seals a value and stops: a validation request would make
    // saving depend on the provider being up, would spend on the customer's
    // account to answer a question nobody asked, and would still not be true a
    // minute later.
    const stored = await ask(
      api.app,
      "PUT",
      MODEL_PROVIDER_CREDENTIALS_PATH,
      adminKey,
      { provider: "openai", key: "sk-this-key-was-revoked-yesterday" },
    );

    expect(stored.statusCode, JSON.stringify(stored.body)).toBe(200);
    expect(stored.body.hint).toBe("rday");
  });
});
