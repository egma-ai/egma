import {
  createPersona,
  listModelProviderCredentials,
  seedPlatformSettings,
  upgradeModelSetup,
  type PersonaTraits,
} from "@egma/db";
import { afterEach, describe, expect, it } from "vitest";

import { JUDGE_CREDENTIALS_PATH } from "../src/routes/judge.ts";
import {
  MODEL_CREDENTIAL_CANDIDATE_PATH,
  MODEL_UPGRADE_PATH,
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
 * What an administrator sees of the upgrade, over real HTTP.
 *
 * **A compatibility path that nobody can see is a trap**, because a persona
 * still on it keeps running until the release that removes it arrives. These
 * doors are what make the outstanding choices visible while there is still time
 * to make them — and the one thing they let somebody do is pick which of two
 * stored keys an organization spends from.
 *
 * The keys are sentinels, and every answer is scanned for all of them: nothing
 * here may hand back a stored key, including the door whose whole job is to
 * make one active.
 */

let api: TestApi;

afterEach(async () => {
  await api?.close();
});

const LEGACY = {
  thinking: "sk-sentinel-upgrade-route-model-key-A1B2",
  listening: "dg-sentinel-upgrade-route-listening-C3D4",
  speaking: "ct-sentinel-upgrade-route-speaking-E5F6",
  judging: "sk-sentinel-upgrade-route-judge-key-G7H8",
} as const;

const CONFIGURED_BEFORE_THE_CATALOG = {
  persona_model_provider: "openai",
  persona_model: "gpt-4o-mini",
  persona_model_key: LEGACY.thinking,
  speech_to_text_provider: "deepgram",
  speech_to_text_model: "nova-3-general",
  speech_to_text_key: LEGACY.listening,
  text_to_speech_provider: "cartesia",
  text_to_speech_model: "sonic-3.5",
  text_to_speech_key: LEGACY.speaking,
} as const;

const NORA: PersonaTraits = {
  personality: "Rings about a boiler service and has no idea what plan she is on.",
  language: "en",
  // A speaking provider this release's catalog does not carry, so this persona
  // cannot receive a guessed successor.
  voice: { provider: "elevenlabs", voiceId: "EXAVITQu4vr4xnSDxMaL", speed: 0.9 },
};

type World = {
  readonly ada: Customer;
  readonly adminKey: string;
};

/**
 * A deployment configured the way the previous release configured one, with a
 * judge key of its own beside the deployment's — so OpenAI has two candidates
 * and nothing activates for it.
 */
async function aDeploymentBeforeTheCatalog(label: string): Promise<World> {
  api = await createApi(label);
  const ada = await signUp(api.app, "ada@acme.example", "Acme");

  await seedPlatformSettings(CONFIGURED_BEFORE_THE_CATALOG);
  // The organization's own judge key, beside the deployment's own platform
  // judge that `createApi` already seeded — so OpenAI ends up with three stored
  // keys from three different places and Egma may activate none of them.
  await ask(api.app, "POST", JUDGE_CREDENTIALS_PATH, ada.secret, {
    label: "Acme's own judge key",
    provider: "openai",
    key: LEGACY.judging,
  });
  await createPersona(contextFor(ada, "member"), {
    name: "Nora",
    traits: NORA,
  });

  await upgradeModelSetup({ singleOrganization: true });
  return { ada, adminKey: ada.secret };
}

describe("what the upgrade left to decide", () => {
  it("is answered as sentences a person can act on, and never a key", async () => {
    const { adminKey } = await aDeploymentBeforeTheCatalog("upgrade_actions");

    const answer = await ask(api.app, "GET", MODEL_UPGRADE_PATH, adminKey);

    expect(answer.statusCode).toBe(200);
    const actions = answer.body.actions as {
      kind: string;
      subject_name: string | null;
    }[];
    const kinds = actions.map((one) => one.kind);
    expect(kinds).toContain("select_model_provider_credential");
    expect(kinds).toContain("select_persona_models");
    // Named, so two blocked personas are two rows a person can tell apart —
    // and this installation really has two: the seeded starter persona and the
    // one authored here, both speaking through a provider this release's
    // catalog does not carry.
    const blocked = actions
      .filter((one) => one.kind === "select_persona_models")
      .map((one) => one.subject_name);
    expect(blocked.length).toBeGreaterThan(1);
    expect(blocked).toContain("Nora");
    for (const key of Object.values(LEGACY)) {
      expect(JSON.stringify(answer.body)).not.toContain(key);
    }
  });

  it("shows an admin the stored keys, with where each one was found", async () => {
    const { adminKey } = await aDeploymentBeforeTheCatalog("upgrade_candidates");

    const answer = await ask(api.app, "GET", MODEL_UPGRADE_PATH, adminKey);
    const candidates = answer.body.candidates as {
      provider: string;
      source: string;
      source_name: string;
      hint: string;
      active: boolean;
      selectable: boolean;
    }[];

    // Every place the previous release kept a key: the three deployment
    // settings, the organization's own judge credential, and the deployment's
    // own key on the project's platform judge — which is a key that project
    // never held and could not see.
    expect(candidates.map((one) => `${one.provider}/${one.source}`)).toEqual([
      "cartesia/platform_setting",
      "deepgram/platform_setting",
      "openai/platform_setting",
      "openai/judge_credential",
      "openai/judge_configuration",
    ]);
    expect(
      candidates
        .filter((one) => one.source === "platform_setting")
        .map((one) => one.source_name),
    ).toEqual([
      "text_to_speech_key",
      "speech_to_text_key",
      "persona_model_key",
    ]);
    expect(
      candidates.find((one) => one.source === "judge_credential")?.source_name,
    ).toBe("Acme's own judge key");
    for (const one of candidates) {
      expect(one.hint).toHaveLength(4);
      expect(one.selectable).toBe(true);
    }
    // Neither OpenAI key is active: two candidates, and Egma will not guess
    // which account they belong to.
    expect(
      candidates.filter((one) => one.active).map((one) => one.provider),
    ).toEqual(["cartesia", "deepgram"]);
  });

  /**
   * A member reads the sentences and not the keys. The rest of the answer is
   * theirs — it is the reason their run reported what it reported — so this is
   * an empty list rather than a refusal.
   */
  it("shows a member what is outstanding and none of the stored keys", async () => {
    const { ada } = await aDeploymentBeforeTheCatalog("upgrade_member");
    const bob = (await colleagueOf(api.app, ada, "bob@acme.example", "member")).secret;

    const answer = await ask(api.app, "GET", MODEL_UPGRADE_PATH, bob);

    expect(answer.statusCode).toBe(200);
    expect((answer.body.actions as unknown[]).length).toBeGreaterThan(0);
    expect(answer.body.candidates).toEqual([]);
  });

  it("says this installation has not finished, and which condition is standing", async () => {
    const { adminKey } = await aDeploymentBeforeTheCatalog("upgrade_completion");

    const answer = await ask(api.app, "GET", MODEL_UPGRADE_PATH, adminKey);

    expect(answer.body.completed).toBe(false);
    expect(answer.body.completed_at).toBeNull();
    // The persona that could not be given a successor is the whole of it.
    expect(answer.body.outstanding).toEqual(["personas"]);
  });
});

describe("choosing which stored key an organization spends", () => {
  it("makes it the credential, and hands back four characters of it", async () => {
    const { ada, adminKey } = await aDeploymentBeforeTheCatalog("upgrade_choose");
    const before = await ask(api.app, "GET", MODEL_UPGRADE_PATH, adminKey);
    const [judges] = (
      before.body.candidates as { id: string; provider: string; source: string }[]
    ).filter((one) => one.source === "judge_credential");

    const chosen = await ask(
      api.app,
      "PUT",
      MODEL_CREDENTIAL_CANDIDATE_PATH.replace(":id", String(judges?.id)),
      adminKey,
    );

    expect(chosen.statusCode).toBe(200);
    expect(chosen.body.provider).toBe("openai");
    expect(String(chosen.body.hint)).toHaveLength(4);
    expect(JSON.stringify(chosen.body)).not.toContain(LEGACY.judging);

    const stored = await listModelProviderCredentials(contextFor(ada, "admin"));
    expect(stored.map((one) => one.provider).sort()).toEqual([
      "cartesia",
      "deepgram",
      "openai",
    ]);
  });

  it("clears the choice it was asked to make, and marks exactly one active", async () => {
    const { adminKey } = await aDeploymentBeforeTheCatalog("upgrade_cleared");
    const before = await ask(api.app, "GET", MODEL_UPGRADE_PATH, adminKey);
    const [judges] = (
      before.body.candidates as { id: string; source: string }[]
    ).filter((one) => one.source === "judge_credential");

    await ask(
      api.app,
      "PUT",
      MODEL_CREDENTIAL_CANDIDATE_PATH.replace(":id", String(judges?.id)),
      adminKey,
    );
    const after = await ask(api.app, "GET", MODEL_UPGRADE_PATH, adminKey);

    expect(
      (after.body.actions as { kind: string }[]).map((one) => one.kind),
    ).not.toContain("select_model_provider_credential");
    const openai = (
      after.body.candidates as { provider: string; active: boolean; id: string }[]
    ).filter((one) => one.provider === "openai");
    expect(openai.filter((one) => one.active).map((one) => one.id)).toEqual([
      judges?.id,
    ]);
  });

  it("is an admin's, and a member is told so by their role", async () => {
    const { ada, adminKey } = await aDeploymentBeforeTheCatalog("upgrade_role");
    const before = await ask(api.app, "GET", MODEL_UPGRADE_PATH, adminKey);
    const [any] = before.body.candidates as { id: string }[];
    const bob = (await colleagueOf(api.app, ada, "bob@acme.example", "member")).secret;

    const refused = await ask(
      api.app,
      "PUT",
      MODEL_CREDENTIAL_CANDIDATE_PATH.replace(":id", String(any?.id)),
      bob,
    );

    expect(refused.statusCode).toBe(403);
    expect(JSON.stringify(refused.body)).toContain("member");
  });

  it("refuses a stored key belonging to another organization, by not finding it", async () => {
    const { adminKey } = await aDeploymentBeforeTheCatalog("upgrade_tenancy");
    const before = await ask(api.app, "GET", MODEL_UPGRADE_PATH, adminKey);
    const [any] = before.body.candidates as { id: string }[];
    const gene = await signUp(api.app, "gene@globex.example", "Globex");

    const refused = await ask(
      api.app,
      "PUT",
      MODEL_CREDENTIAL_CANDIDATE_PATH.replace(":id", String(any?.id)),
      gene.secret,
    );

    expect(refused.statusCode).toBe(422);
    expect(JSON.stringify(refused.body)).toContain("not a stored key");
  });
});
