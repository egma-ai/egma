import {
  getPersonaVersion,
  PREDEFINED_GRADERS,
  RECOMMENDED_GRADER_MODEL,
  RECOMMENDED_PERSONA_MODELS,
} from "@egma/db";
import { afterEach, describe, expect, it } from "vitest";

import { createApi, type TestApi } from "./support/api.ts";
import {
  contextFor,
  NEUTRAL_TRAITS,
  projectKeyFor,
  request as ask,
  signUp,
  type Customer,
} from "./support/traces.ts";

/**
 * The two authoring surfaces that select a model, over real HTTP.
 *
 * What is asserted is what an author observes: that the selections are theirs
 * to make and independent of each other, that neither form has anywhere to put
 * a secret, that a model edit mints a version so an old run keeps its meaning,
 * and that a persona or grader authored before any of this existed still reads
 * and still writes.
 */

let api: TestApi;

afterEach(async () => {
  await api?.close();
});

type World = {
  readonly ada: Customer;
  readonly key: string;
};

async function aCustomer(label: string): Promise<World> {
  api = await createApi(label);
  const ada = await signUp(api.app, "ada@acme.example", "Acme");
  return { ada, key: await projectKeyFor(api.app, ada) };
}

const RITA = {
  name: "Impatient Rita",
  traits: NEUTRAL_TRAITS,
} as const;

/** The three selections as a body writes them. */
const SELECTIONS = {
  llm: { provider: "openai", model: "gpt-4o-mini" },
  stt: { provider: "deepgram", model: "nova-3-general" },
  tts: {
    provider: "cartesia",
    model: "sonic-3.5",
    voiceId: "5ee9feff-1265-424a-9d7f-8e4d431a12c7",
    speed: 1,
  },
} as const;

describe("the persona editor's shape", () => {
  it("offers the catalog and a proved default for each job, filled in", async () => {
    const { key } = await aCustomer("persona_form_models");

    const form = await ask(api.app, "GET", "/api/persona-form", key);

    expect(form.statusCode, JSON.stringify(form.body)).toBe(200);
    const recommended = form.body.recommended_models as Record<
      string,
      { provider: string; model: string }
    >;
    expect(recommended.llm).toEqual(RECOMMENDED_PERSONA_MODELS.llm);
    expect(recommended.stt).toEqual(RECOMMENDED_PERSONA_MODELS.stt);
    expect(recommended.tts).toEqual(RECOMMENDED_PERSONA_MODELS.tts);

    const catalog = form.body.model_catalog as { job: string }[];
    expect(new Set(catalog.map((one) => one.job))).toEqual(
      new Set(["llm", "stt", "tts"]),
    );
    // Speech only stays intelligible so far from natural pace, and the form is
    // told the bounds rather than inventing them.
    expect(form.body.speed_range).toEqual({ slowest: 0.5, fastest: 2 });
  });

  it("has no credential field and no voice-activity choice", async () => {
    const { key } = await aCustomer("persona_form_no_secrets");

    const form = await ask(api.app, "GET", "/api/persona-form", key);
    const written = JSON.stringify(form.body).toLowerCase();

    for (const absent of ["key", "credential", "silero", "vad"]) {
      expect(written, `the persona form offered ${absent}`).not.toContain(
        absent,
      );
    }
  });
});

describe("a persona that selects its own models", () => {
  it("stores three independent selections, each changeable on its own", async () => {
    const { key } = await aCustomer("persona_models_independent");

    const created = await ask(api.app, "POST", "/api/personas", key, {
      ...RITA,
      models: SELECTIONS,
    });
    expect(created.statusCode, JSON.stringify(created.body)).toBe(201);
    expect(created.body.models).toEqual(SELECTIONS);

    // Changing what the persona listens with leaves what it thinks and speaks
    // with exactly where they were. That independence is the whole decision.
    const edited = await ask(
      api.app,
      "PATCH",
      `/api/personas/${String(created.body.id)}`,
      key,
      {
        expected_revision: String(created.body.revision),
        expected_version_id: String(created.body.version_id),
        models: {
          ...SELECTIONS,
          stt: { provider: "deepgram", model: "nova-2-phonecall" },
        },
      },
    );

    expect(edited.statusCode, JSON.stringify(edited.body)).toBe(200);
    const models = edited.body.models as typeof SELECTIONS;
    expect(models.stt.model).toBe("nova-2-phonecall");
    expect(models.llm).toEqual(SELECTIONS.llm);
    expect(models.tts).toEqual(SELECTIONS.tts);
  });

  it("mints a new version, and the old one still says what it said", async () => {
    const { ada, key } = await aCustomer("persona_models_version");

    const created = await ask(api.app, "POST", "/api/personas", key, {
      ...RITA,
      models: SELECTIONS,
    });
    const firstVersionId = String(created.body.version_id);

    const edited = await ask(
      api.app,
      "PATCH",
      `/api/personas/${String(created.body.id)}`,
      key,
      {
        expected_revision: String(created.body.revision),
        expected_version_id: firstVersionId,
        models: { ...SELECTIONS, llm: { provider: "openai", model: "gpt-4o" } },
      },
    );

    expect(edited.body.version).toBe(2);
    expect(edited.body.version_id).not.toBe(firstVersionId);

    // The version a run would have pinned still names the model it named.
    const frozen = await getPersonaVersion(
      contextFor(ada, "member"),
      firstVersionId,
    );
    expect(frozen?.models?.llm.model).toBe("gpt-4o-mini");
  });

  it("mints nothing when the same selections are sent again", async () => {
    const { key } = await aCustomer("persona_models_idempotent");

    const created = await ask(api.app, "POST", "/api/personas", key, {
      ...RITA,
      models: SELECTIONS,
    });

    const resaved = await ask(
      api.app,
      "PATCH",
      `/api/personas/${String(created.body.id)}`,
      key,
      {
        expected_revision: String(created.body.revision),
        expected_version_id: String(created.body.version_id),
        models: SELECTIONS,
      },
    );

    expect(resaved.body.version).toBe(1);
    expect(resaved.body.version_id).toBe(created.body.version_id);
  });

  it("refuses a provider Egma ships nothing for, naming the ones it does", async () => {
    const { key } = await aCustomer("persona_models_unknown_provider");

    const refused = await ask(api.app, "POST", "/api/personas", key, {
      ...RITA,
      models: { ...SELECTIONS, stt: { provider: "assemblyai", model: "best" } },
    });

    expect(refused.statusCode).toBe(422);
    expect(String(refused.body.message)).toContain("deepgram");
  });

  it("refuses a body that tried to put a key beside the selections", async () => {
    const { key } = await aCustomer("persona_models_no_secret");

    for (const smuggled of [
      { ...SELECTIONS, key: "sk-not-here" },
      { ...SELECTIONS, credential_id: "mpc_01K3XQ7M4E8YB2FVN0H9TZQWER" },
    ]) {
      const refused = await ask(api.app, "POST", "/api/personas", key, {
        ...RITA,
        models: smuggled,
      });

      expect(refused.statusCode).toBe(422);
      expect(String(refused.body.message)).toContain("Model providers");
    }
  });

  it("takes any model id, because Egma allowlists none", async () => {
    const { key } = await aCustomer("persona_models_free_text");

    const created = await ask(api.app, "POST", "/api/personas", key, {
      ...RITA,
      models: {
        ...SELECTIONS,
        llm: { provider: "openai", model: "a-model-released-this-morning" },
      },
    });

    expect(created.statusCode, JSON.stringify(created.body)).toBe(201);
    expect(
      (created.body.models as typeof SELECTIONS).llm.model,
    ).toBe("a-model-released-this-morning");
  });
});

describe("a persona authored before any of this", () => {
  it("reads back with no selections, which is a state and not a fault", async () => {
    const { key } = await aCustomer("persona_models_legacy");

    const created = await ask(api.app, "POST", "/api/personas", key, RITA);

    expect(created.statusCode, JSON.stringify(created.body)).toBe(201);
    expect(created.body.models).toBeNull();
  });

  it("can still be edited without being made to choose", async () => {
    const { key } = await aCustomer("persona_models_legacy_edit");

    const created = await ask(api.app, "POST", "/api/personas", key, RITA);
    const renamed = await ask(
      api.app,
      "PATCH",
      `/api/personas/${String(created.body.id)}`,
      key,
      { expected_revision: String(created.body.revision), name: "Rita" },
    );

    expect(renamed.statusCode, JSON.stringify(renamed.body)).toBe(200);
    expect(renamed.body.name).toBe("Rita");
    expect(renamed.body.models).toBeNull();
  });
});

describe("a grader's own model", () => {
  it("is selected per copy, independently of every persona", async () => {
    const { key } = await aCustomer("grader_model_independent");

    const library = await ask(api.app, "GET", "/api/grader-library", key);
    const entry = (library.body.items as { id: string }[]).find(
      (one) => one.id === PREDEFINED_GRADERS.expectedBehaviors,
    );
    expect(entry, "the predefined entry is missing").toBeDefined();

    const used = await ask(api.app, "POST", "/api/graders", key, {
      library_id: entry?.id,
      project: (await ask(api.app, "GET", "/api/me", key)).body.project_id,
      model: RECOMMENDED_GRADER_MODEL,
    });

    expect(used.statusCode, JSON.stringify(used.body)).toBe(201);
    expect(used.body.model).toEqual(RECOMMENDED_GRADER_MODEL);
  });

  it("mints a version when it changes, and stays null on the copy that never chose", async () => {
    const { key } = await aCustomer("grader_model_version");

    const graders = await ask(api.app, "GET", "/api/graders", key);
    const seeded = (
      graders.body.items as { id: string; version: number; model: unknown }[]
    )[0];
    expect(seeded, "the seeded copy is missing").toBeDefined();

    // Every project is created with the expected-behaviors copy, and it is on
    // the compatibility path: the project's judge decides, exactly as before.
    expect(seeded?.model).toBeNull();

    const edited = await ask(
      api.app,
      "PATCH",
      `/api/graders/${String(seeded?.id)}`,
      key,
      { model: { provider: "openai", model: "gpt-4o" } },
    );

    expect(edited.statusCode, JSON.stringify(edited.body)).toBe(200);
    expect(edited.body.model).toEqual({ provider: "openai", model: "gpt-4o" });
    expect(edited.body.version).toBe((seeded?.version ?? 0) + 1);
  });

  it("goes back to the project's judge when it is cleared", async () => {
    const { key } = await aCustomer("grader_model_cleared");

    const graders = await ask(api.app, "GET", "/api/graders", key);
    const seeded = (graders.body.items as { id: string }[])[0];

    await ask(api.app, "PATCH", `/api/graders/${String(seeded?.id)}`, key, {
      model: { provider: "openai", model: "gpt-4o" },
    });
    const cleared = await ask(
      api.app,
      "PATCH",
      `/api/graders/${String(seeded?.id)}`,
      key,
      { model: null },
    );

    expect(cleared.statusCode, JSON.stringify(cleared.body)).toBe(200);
    expect(cleared.body.model).toBeNull();
  });

  it("has no credential field, and refuses a body that tried to give it one", async () => {
    const { key } = await aCustomer("grader_model_no_secret");

    const graders = await ask(api.app, "GET", "/api/graders", key);
    const seeded = (graders.body.items as { id: string }[])[0];

    const refused = await ask(
      api.app,
      "PATCH",
      `/api/graders/${String(seeded?.id)}`,
      key,
      { model: { provider: "openai", model: "gpt-4o", key: "sk-not-here" } },
    );

    expect(refused.statusCode).toBe(422);
    expect(String(refused.body.message)).toContain("Model providers");
  });

  it("refuses a provider that does no LLM work in this catalog", async () => {
    const { key } = await aCustomer("grader_model_unknown_provider");

    const graders = await ask(api.app, "GET", "/api/graders", key);
    const seeded = (graders.body.items as { id: string }[])[0];

    const refused = await ask(
      api.app,
      "PATCH",
      `/api/graders/${String(seeded?.id)}`,
      key,
      { model: { provider: "deepgram", model: "nova-3-general" } },
    );

    expect(refused.statusCode).toBe(422);
    expect(String(refused.body.message)).toContain("openai");
  });
});
