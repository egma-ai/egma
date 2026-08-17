import { afterEach, describe, expect, it } from "vitest";

import { INFERENCE_KEY_HEADER } from "../src/auth/inference-key.ts";
import {
  INFERENCE_KEYS_PATH,
  INFERENCE_KEY_VALIDATION_PATH,
} from "../src/routes/inference-keys.ts";
import { MANAGED_ACCESS_PATH, MODEL_ACCESS_PATH } from "../src/routes/model-access.ts";
import { createApi, type TestApi } from "./support/api.ts";
import { request as ask, signUp, colleagueOf, type Customer } from "./support/traces.ts";

/**
 * Inference keys, over real HTTP against real Postgres.
 *
 * Two claims are asserted here and they are the two the product actually makes
 * about this credential. **It is shown once**: the one response that carries it
 * is the one that minted it, and no later read has a field for it. And **it
 * opens exactly one door**: the validation route answers which organization it
 * belongs to, and every ordinary Egma product interface refuses it — not by a
 * rule anybody wrote, but because a product route looks the credential up in a
 * table this key is not in.
 */

let api: TestApi;

afterEach(async () => {
  await api?.close();
});

const HOSTED = {
  hosted: true,
  gatewayAddress: "https://gateway.egma.example",
  internalGatewayKey: "sentinel-internal-gateway-signing-Xy7Zk2",
} as const;

const SELF_HOSTED = {
  hosted: false,
  gatewayAddress: "https://gateway.egma.example",
  internalGatewayKey: undefined,
} as const;

type World = { readonly ada: Customer; readonly adminKey: string };

async function hostedEgma(label: string): Promise<World> {
  api = await createApi(label, { managedDeployment: HOSTED });
  const ada = await signUp(api.app, "ada@acme.example", "Acme");
  return { ada, adminKey: ada.secret };
}

async function created(
  adminKey: string,
  name: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const answered = await ask(api.app, "POST", INFERENCE_KEYS_PATH, adminKey, {
    name,
  });
  return { status: answered.statusCode, body: answered.body };
}

describe("creating one", () => {
  it("shows the key once, and shows it nowhere again", async () => {
    const { adminKey } = await hostedEgma("inference_keys_shown_once");

    const minted = await created(adminKey, "Lakeside self-hosted");
    expect(minted.status).toBe(201);
    const secret = minted.body["key"] as string;
    expect(secret.startsWith("egma_ik_")).toBe(true);
    expect(minted.body["looks_like"]).toBe(`egma_ik_…${secret.slice(-4)}`);

    const listed = await ask(api.app, "GET", INFERENCE_KEYS_PATH, adminKey);
    expect(listed.statusCode).toBe(200);
    expect(JSON.stringify(listed.body)).not.toContain(secret);
    const keys = listed.body["keys"] as Record<string, unknown>[];
    expect(keys).toHaveLength(1);
    expect(keys[0]).not.toHaveProperty("key");
    expect(keys[0]?.["name"]).toBe("Lakeside self-hosted");
    expect(keys[0]?.["revoked_at"]).toBeNull();
  });

  it("is an admin's, and everybody else is told so by their role", async () => {
    const { ada, adminKey } = await hostedEgma("inference_keys_admin_only");
    const grace = await colleagueOf(api.app, ada, "grace@acme.example", "member");

    const refused = await ask(api.app, "POST", INFERENCE_KEYS_PATH, grace.secret, {
      name: "not mine to make",
    });
    expect(refused.statusCode).toBe(403);
    expect(refused.body["error"]).toBe("not_permitted");

    expect((await created(adminKey, "mine")).status).toBe(201);
  });

  it("needs a name, so a list of several says which one to revoke", async () => {
    const { adminKey } = await hostedEgma("inference_keys_named");

    const refused = await ask(api.app, "POST", INFERENCE_KEYS_PATH, adminKey, {});
    expect(refused.statusCode).toBe(400);
  });

  it("is not a thing a self-hosted deployment does at all", async () => {
    api = await createApi("inference_keys_not_here", {
      managedDeployment: SELF_HOSTED,
    });
    const ada = await signUp(api.app, "ada@acme.example", "Acme");

    const answered = await ask(api.app, "POST", INFERENCE_KEYS_PATH, ada.secret, {
      name: "nope",
    });
    expect(answered.statusCode).toBe(404);
    expect(String(answered.body["message"])).toContain("Egma Cloud");
  });
});

describe("the one door an inference key opens", () => {
  it("answers which organization it acts for, and nothing else", async () => {
    const { ada, adminKey } = await hostedEgma("inference_keys_validation");
    const minted = await created(adminKey, "Lakeside");
    const secret = minted.body["key"] as string;

    const answered = await api.app.inject({
      method: "POST",
      url: INFERENCE_KEY_VALIDATION_PATH,
      headers: { [INFERENCE_KEY_HEADER]: secret },
    });

    expect(answered.statusCode).toBe(200);
    const said = JSON.parse(answered.body) as Record<string, unknown>;
    expect(said["organization_id"]).toBe(ada.organizationId);
    expect(said["inference_key_id"]).toBe(minted.body["id"]);
    // Nothing about the customer beyond which one it is: no project, no role,
    // no person, and no provider credential.
    expect(Object.keys(said).sort()).toEqual([
      "inference_key_id",
      "organization_id",
    ]);
  });

  it("marks the key used, so a key nobody needs is visible as one", async () => {
    const { adminKey } = await hostedEgma("inference_keys_last_used");
    const secret = (await created(adminKey, "Lakeside")).body["key"] as string;

    await api.app.inject({
      method: "POST",
      url: INFERENCE_KEY_VALIDATION_PATH,
      headers: { [INFERENCE_KEY_HEADER]: secret },
    });

    const listed = (await ask(api.app, "GET", INFERENCE_KEYS_PATH, adminKey))
      .body["keys"] as Record<string, unknown>[];
    expect(listed[0]?.["last_used_at"]).not.toBeNull();
  });

  it("refuses a revoked key on the very next ask", async () => {
    const { adminKey } = await hostedEgma("inference_keys_revoked");
    const minted = await created(adminKey, "Retired");
    const secret = minted.body["key"] as string;

    const revoked = await ask(
      api.app,
      "DELETE",
      `${INFERENCE_KEYS_PATH}/${String(minted.body["id"])}`,
      adminKey,
    );
    expect(revoked.statusCode).toBe(200);
    expect(revoked.body["revoked_at"]).not.toBeNull();

    const answered = await api.app.inject({
      method: "POST",
      url: INFERENCE_KEY_VALIDATION_PATH,
      headers: { [INFERENCE_KEY_HEADER]: secret },
    });
    expect(answered.statusCode).toBe(401);
  });

  it("leaves a replacement working, which is what makes rotation overlap", async () => {
    const { adminKey } = await hostedEgma("inference_keys_rotation");
    const older = await created(adminKey, "Before rotation");
    const newer = await created(adminKey, "After rotation");

    await ask(
      api.app,
      "DELETE",
      `${INFERENCE_KEYS_PATH}/${String(older.body["id"])}`,
      adminKey,
    );

    const stillGood = await api.app.inject({
      method: "POST",
      url: INFERENCE_KEY_VALIDATION_PATH,
      headers: { [INFERENCE_KEY_HEADER]: newer.body["key"] as string },
    });
    expect(stillGood.statusCode).toBe(200);
  });

  it("refuses an ordinary Egma product key, which is not one of these", async () => {
    const { ada } = await hostedEgma("inference_keys_not_a_product_key");

    const answered = await api.app.inject({
      method: "POST",
      url: INFERENCE_KEY_VALIDATION_PATH,
      headers: { [INFERENCE_KEY_HEADER]: ada.secret },
    });
    expect(answered.statusCode).toBe(401);
  });
});

describe("an inference key at an ordinary product door", () => {
  it("is nobody, whichever slot it is offered in", async () => {
    const { adminKey } = await hostedEgma("inference_keys_refused_by_product");
    const secret = (await created(adminKey, "Lakeside")).body["key"] as string;

    // The product's own slot: `Authorization: Bearer`, which is where every
    // real Egma credential goes. There is no table this resolves in.
    for (const path of [MODEL_ACCESS_PATH, INFERENCE_KEYS_PATH, "/api/me"]) {
      const answered = await api.app.inject({
        method: "GET",
        url: path,
        headers: { authorization: `Bearer ${secret}` },
      });
      expect(answered.statusCode, path).toBe(401);
    }

    // And the gateway's own slot, which product doors do not read at all.
    const other = await api.app.inject({
      method: "GET",
      url: MODEL_ACCESS_PATH,
      headers: { [INFERENCE_KEY_HEADER]: secret },
    });
    expect(other.statusCode).toBe(401);
  });

  it("cannot write anything either, so a leaked one changes nothing in the product", async () => {
    const { adminKey } = await hostedEgma("inference_keys_cannot_write");
    const secret = (await created(adminKey, "Lakeside")).body["key"] as string;

    const answered = await api.app.inject({
      method: "PUT",
      url: MODEL_ACCESS_PATH,
      headers: {
        authorization: `Bearer ${secret}`,
        "content-type": "application/json",
      },
      payload: { mode: "managed" },
    });
    expect(answered.statusCode).toBe(401);
  });
});

describe("a self-hosted deployment connecting one", () => {
  /**
   * Two real instances: one hosted Egma that mints the key, one self-hosted
   * deployment that pastes it. The validation between them is the real route on
   * the real hosted API, reached through the seam rather than over a network —
   * which is exactly what the deterministic suite is allowed to do and exactly
   * what makes this the real path rather than a stand-in for it.
   */
  /**
   * Two deployments, one at a time.
   *
   * A process holds one database connection and one deployment identity, so
   * hosted Egma and a self-hosted installation cannot both be up here — which
   * is also true in the world. So the key is minted on the real hosted API and
   * its real validation route is asked the real question; that answer is
   * carried across, and the self-hosted instance connects on it. The route that
   * answered is the shipped one, above and again here.
   */
  it("reaches Connected only after Egma Cloud confirms the organization", async () => {
    api = await createApi("inference_keys_cloud", { managedDeployment: HOSTED });
    const cloudAda = await signUp(api.app, "ada@acme.example", "Acme");
    const secret = (
      await ask(api.app, "POST", INFERENCE_KEYS_PATH, cloudAda.secret, {
        name: "Lakeside self-hosted",
      })
    ).body["key"] as string;

    const confirmed = await api.app.inject({
      method: "POST",
      url: INFERENCE_KEY_VALIDATION_PATH,
      headers: { [INFERENCE_KEY_HEADER]: secret },
    });
    expect(confirmed.statusCode).toBe(200);
    const cloudOrganizationId = (
      JSON.parse(confirmed.body) as { organization_id: string }
    ).organization_id;
    expect(cloudOrganizationId).toBe(cloudAda.organizationId);

    await api.close();

    api = await createApi("inference_keys_self_hosted", {
      managedDeployment: SELF_HOSTED,
      validateInferenceKey: async (key) =>
        key === secret
          ? { outcome: "valid", organizationId: cloudOrganizationId }
          : { outcome: "refused" },
    });
    const local = await signUp(api.app, "grace@lakeside.example", "Lakeside");

    // Before anything is connected: not connected, and managed access cannot
    // even be chosen.
    const before = (await ask(api.app, "GET", MODEL_ACCESS_PATH, local.secret))
      .body;
    expect(before["managed_available"]).toBe(false);
    expect((before["managed"] as Record<string, unknown>)["connected"]).toBe(false);
    expect(
      (await ask(api.app, "PUT", MODEL_ACCESS_PATH, local.secret, { mode: "managed" }))
        .statusCode,
    ).toBe(422);

    const connected = await ask(api.app, "PUT", MANAGED_ACCESS_PATH, local.secret, {
      key: secret,
    });
    expect(connected.statusCode).toBe(200);
    expect(connected.body["connected"]).toBe(true);
    expect(connected.body["hint"]).toBe(secret.slice(-4));
    expect(connected.body["cloud_organization_id"]).toBe(cloudOrganizationId);
    expect(JSON.stringify(connected.body)).not.toContain(secret);

    const after = (await ask(api.app, "GET", MODEL_ACCESS_PATH, local.secret)).body;
    expect(after["managed_available"]).toBe(true);
    expect(after["hosted"]).toBe(false);
    // The read carries Connected and a hint and no key at all.
    expect(JSON.stringify(after)).not.toContain(secret);

    // And now managed access is a choice the server accepts.
    const chosen = await ask(api.app, "PUT", MODEL_ACCESS_PATH, local.secret, {
      mode: "managed",
    });
    expect(chosen.statusCode).toBe(200);
    expect(chosen.body["mode"]).toBe("managed");
  });

  it("refuses a key Egma Cloud does not recognise, and connects nothing", async () => {
    api = await createApi("inference_keys_refused_paste", {
      managedDeployment: SELF_HOSTED,
      validateInferenceKey: async () => ({ outcome: "refused" }),
    });
    const local = await signUp(api.app, "grace@lakeside.example", "Lakeside");

    const answered = await ask(api.app, "PUT", MANAGED_ACCESS_PATH, local.secret, {
      key: "egma_ik_sentinel-never-issued-Qq4Rt8",
    });
    expect(answered.statusCode).toBe(422);
    expect(String(answered.body["message"])).toContain("does not recognise");

    const read = (await ask(api.app, "GET", MODEL_ACCESS_PATH, local.secret)).body;
    expect((read["managed"] as Record<string, unknown>)["connected"]).toBe(false);
  });

  it("says Egma Cloud could not be asked, rather than blaming the key", async () => {
    api = await createApi("inference_keys_cloud_down", {
      managedDeployment: SELF_HOSTED,
      validateInferenceKey: async () => ({ outcome: "unreachable" }),
    });
    const local = await signUp(api.app, "grace@lakeside.example", "Lakeside");

    const answered = await ask(api.app, "PUT", MANAGED_ACCESS_PATH, local.secret, {
      key: "egma_ik_sentinel-fine-key-cloud-down-Vv6Ww1",
    });
    expect(answered.statusCode).toBe(422);
    expect(String(answered.body["message"])).toContain("could not be reached");
    expect(String(answered.body["message"])).toContain("Nothing has changed");
  });

  it("refuses a key from another Egma Cloud organization while the binding stands", async () => {
    let whose = "org_01K3XQ7M4E8YB2FVN0H9TZQWER";
    api = await createApi("inference_keys_bound", {
      managedDeployment: SELF_HOSTED,
      validateInferenceKey: async () => ({ outcome: "valid", organizationId: whose }),
    });
    const local = await signUp(api.app, "grace@lakeside.example", "Lakeside");

    expect(
      (
        await ask(api.app, "PUT", MANAGED_ACCESS_PATH, local.secret, {
          key: "egma_ik_sentinel-first-binding-Aa1Bb2",
        })
      ).statusCode,
    ).toBe(200);

    whose = "org_01K3XQ7M4E8YB2FVN0H9TZQZZZ";
    const refused = await ask(api.app, "PUT", MANAGED_ACCESS_PATH, local.secret, {
      key: "egma_ik_sentinel-somebody-elses-Cc3Dd4",
    });
    expect(refused.statusCode).toBe(409);
    expect(String(refused.body["message"])).toContain("Disconnect managed access");

    // Disconnect deliberately, and the other organization's key is accepted.
    expect(
      (await ask(api.app, "DELETE", MANAGED_ACCESS_PATH, local.secret)).statusCode,
    ).toBe(200);
    expect(
      (
        await ask(api.app, "PUT", MANAGED_ACCESS_PATH, local.secret, {
          key: "egma_ik_sentinel-somebody-elses-Cc3Dd4",
        })
      ).statusCode,
    ).toBe(200);
  });

  it("is an admin's to connect and to disconnect", async () => {
    api = await createApi("inference_keys_connect_admin", {
      managedDeployment: SELF_HOSTED,
      validateInferenceKey: async () => ({
        outcome: "valid",
        organizationId: "org_01K3XQ7M4E8YB2FVN0H9TZQWER",
      }),
    });
    const ada = await signUp(api.app, "ada@lakeside.example", "Lakeside");
    const grace = await colleagueOf(api.app, ada, "grace@lakeside.example", "member");

    expect(
      (
        await ask(api.app, "PUT", MANAGED_ACCESS_PATH, grace.secret, {
          key: "egma_ik_sentinel-not-mine-Ee5Ff6",
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (await ask(api.app, "DELETE", MANAGED_ACCESS_PATH, grace.secret)).statusCode,
    ).toBe(403);
  });

  it("is not a thing hosted Egma does, because it connects nothing", async () => {
    const { adminKey } = await hostedEgma("inference_keys_hosted_connects_nothing");

    const answered = await ask(api.app, "PUT", MANAGED_ACCESS_PATH, adminKey, {
      key: "egma_ik_sentinel-nothing-to-connect-Gg7Hh8",
    });
    expect(answered.statusCode).toBe(404);

    const read = (await ask(api.app, "GET", MODEL_ACCESS_PATH, adminKey)).body;
    expect(read["hosted"]).toBe(true);
    // Available with nothing connected, because there is nothing to connect.
    expect(read["managed_available"]).toBe(true);
    expect((read["managed"] as Record<string, unknown>)["connected"]).toBe(false);
  });
});
