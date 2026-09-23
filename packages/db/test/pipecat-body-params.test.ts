import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createTest,
  editTest,
  getTestVersion,
  LARGEST_PIPECAT_BODY_PARAMS_BYTES,
  type TestEnv,
} from "@egma/db";

import { type MigratedDatabase } from "./support/database.ts";
import {
  actingAsAcme,
  rescheduling,
  rowCounts,
  seedTestFactory,
} from "./support/test-factory.ts";

/**
 * `pipecat_body_params` is the test's own start data for a Pipecat bot: egma
 * merges it into the start request's `body`, beside its own `egma` key. It is
 * refused at save for anything the start request could not carry whole.
 */

let database: MigratedDatabase;
let rita: string;

beforeAll(async () => {
  ({ database, rita } = await seedTestFactory("pipecat_body_params"));
});

afterAll(async () => {
  await database.drop();
});

function authored(env: unknown) {
  return { ...rescheduling, personaIds: [rita], env: env as TestEnv };
}

async function refused(env: unknown): Promise<string> {
  const before = await rowCounts();
  let message = "";
  try {
    await createTest(actingAsAcme(), authored(env));
  } catch (error) {
    message = (error as Error).message;
  }
  expect(await rowCounts()).toEqual(before);
  return message;
}

describe("a test's Pipecat body params", () => {
  it("are kept whole beside the other platforms' keys", async () => {
    const env: TestEnv = {
      retell_dynamic_variables: { caller_name: "Margaret" },
      job_dispatch_metadata: { tenant: "acme" },
      pipecat_body_params: { tenant: "acme", caller: { plan: "gold", seats: [1, 2] } },
    };
    const created = await createTest(actingAsAcme(), authored(env));
    const frozen = await getTestVersion(actingAsAcme(), created.versionId);
    expect(created.env).toEqual(env);
    expect(frozen?.env).toEqual(env);
  });

  it("are dropped when empty, like the other keys", async () => {
    const created = await createTest(
      actingAsAcme(),
      authored({ pipecat_body_params: {} }),
    );
    expect(created.env).toBeNull();
  });

  it("mint a new version when only they change", async () => {
    const created = await createTest(
      actingAsAcme(),
      authored({ pipecat_body_params: { tenant: "acme" } }),
    );
    const edited = await editTest(actingAsAcme(), created.id, {
      env: { pipecat_body_params: { tenant: "globex" } },
      expectedVersionId: created.versionId,
    });
    expect(edited?.version).toBe(created.version + 1);
    expect(edited?.env).toEqual({ pipecat_body_params: { tenant: "globex" } });
  });

  it("are refused when they are not an object", async () => {
    for (const value of [[1, 2], "acme", 7, true]) {
      expect(await refused({ pipecat_body_params: value })).toBe(
        'env.pipecat_body_params is a JSON object merged into the body of the start request, which your Pipecat bot reads at runner_args.body, and looks like {"tenant": "acme"}',
      );
    }
  });

  it("are refused when they hold egma's own key", async () => {
    expect(
      await refused({ pipecat_body_params: { egma: { simulation_id: "sim_x" }, tenant: "acme" } }),
    ).toBe(
      'env.pipecat_body_params holds the key "egma", which Egma keeps for its own simulation marker in the start request. Name the key something else.',
    );
  });

  it("are refused over 512 KiB once serialized, measured in UTF-8 bytes", async () => {
    expect(LARGEST_PIPECAT_BODY_PARAMS_BYTES).toBe(524288);
    const multibyte = { note: "€".repeat(200_000) };
    const bytes = Buffer.byteLength(JSON.stringify(multibyte), "utf8");
    expect(bytes).toBeGreaterThan(LARGEST_PIPECAT_BODY_PARAMS_BYTES);
    expect(await refused({ pipecat_body_params: multibyte })).toBe(
      `env.pipecat_body_params is ${String(bytes)} bytes once serialized, and Egma sends at most 524288 in the start request; hold a large value in your own store and put its id here instead.`,
    );
  });

  it("are refused holding a lone surrogate", async () => {
    expect(await refused({ pipecat_body_params: { caller: "\ud83d" } })).toBe(
      "env.pipecat_body_params holds a lone surrogate, which is valid JSON but has no UTF-8 form, so the start request could not carry it. Send well-formed text.",
    );
  });

  it("are named among the keys an env carries", async () => {
    expect(await refused({ livekit_room_metadata: {} })).toBe(
      'env has no "livekit_room_metadata" in it. An env carries retell_dynamic_variables, job_dispatch_metadata and pipecat_body_params, and nothing else.',
    );
    expect(await refused(["pipecat_body_params"])).toBe(
      "env is an object with at most retell_dynamic_variables, job_dispatch_metadata and pipecat_body_params in it",
    );
  });
});
