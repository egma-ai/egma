import {
  BILLING_WEBHOOK_PATH,
  CREDIT_PATH,
  DOWNGRADE_PATH,
  PORTAL_PATH,
  UPGRADE_PATH,
  billingRoutes,
  billingWebhookRoutes,
  cloudBillingPlugIn,
  seedCloudPlans,
  activateBilling,
  stripeGateway,
} from "@egma/ee";
import { afterEach, describe, expect, it } from "vitest";

import { createApi, type TestApi } from "../../apps/api/test/support/api.ts";
import {
  request as ask,
  signUp,
  type Customer,
} from "../../apps/api/test/support/traces.ts";

/**
 * Stripe's own door, and the four things only an admin does.
 *
 * **Nothing here reaches Stripe, and nothing pretends to be it.** The adapter
 * is built from a test key that is never used against an account: what is
 * under test is the door in front of it — whether a delivery with no signature
 * is refused, whether a body that was not signed by this deployment's secret
 * is refused, and whether a member is turned away before a Stripe call is ever
 * attempted. Everything past those gates is the Stripe lane's, against the
 * real sandbox, on real payloads.
 *
 * **A deployment with no signing secret has no door at all**, which is the
 * first thing below: a webhook's signature is its only credential, so an
 * endpoint that could not check one would be an endpoint anybody could post a
 * payment to.
 */

let api: TestApi;

afterEach(async () => {
  await api?.close();
});

/**
 * A Stripe adapter for a deployment that named a key and a signing secret.
 *
 * The key is a Stripe test key by its own prefix and reaches no account: a
 * signature check is the same cryptography whether the key was ever used or
 * not, and every route below is refused before it would call anything.
 */
function anAdapter(withSigningSecret = true): ReturnType<typeof stripeGateway> {
  return stripeGateway({
    secretKey: "sk_test_never-used-against-an-account",
    webhookSecret: withSigningSecret
      ? "whsec_signs-nothing-but-this-test"
      : undefined,
    baseUrl: "https://egma.test",
  });
}

/** An instance standing in for a deployment that named a Stripe secret. */
async function aBillingDeployment(
  label: string,
  options: { readonly withWebhookDoor: boolean },
): Promise<void> {
  const stripe = anAdapter(options.withWebhookDoor);
  api = await createApi(label, {
    billing: cloudBillingPlugIn(),
    installBilling: true,
    billingRoutes: (app, routeOptions) =>
      billingRoutes(app, { ...routeOptions, stripe }),
    ...(options.withWebhookDoor
      ? {
          billingWebhookRoutes: (app) => billingWebhookRoutes(app, { stripe }),
        }
      : {}),
  });
  await seedCloudPlans();
  await activateBilling();
  if (options.withWebhookDoor)
    await api.database.sql(
      "update cloud_plan set stripe_payments_ready = true where code = 'hobby'",
    );
}

async function anAdmin(email: string, name: string): Promise<Customer> {
  return signUp(api.app, email, name);
}

describe("Stripe's own door", () => {
  it("is not there at all on a deployment that named no signing secret", async () => {
    await aBillingDeployment("stripe-no-door", { withWebhookDoor: false });

    const answer = await api.app.inject({
      method: "POST",
      url: BILLING_WEBHOOK_PATH,
      headers: { "content-type": "application/json" },
      payload: '{"id":"evt_1","type":"checkout.session.completed"}',
    });

    expect(answer.statusCode).toBe(404);
  });

  it("refuses a request that carries no Stripe signature", async () => {
    await aBillingDeployment("stripe-unsigned", { withWebhookDoor: true });

    const answer = await api.app.inject({
      method: "POST",
      url: BILLING_WEBHOOK_PATH,
      headers: { "content-type": "application/json" },
      payload: '{"id":"evt_1","type":"checkout.session.completed"}',
    });

    expect(answer.statusCode).toBe(400);
    expect(answer.json()).toMatchObject({ error: "invalid_request" });
    expect((answer.json() as { message: string }).message).toContain(
      "stripe-signature",
    );
  });

  it("refuses a body this deployment's secret did not sign", async () => {
    await aBillingDeployment("stripe-badly-signed", { withWebhookDoor: true });

    const answer = await api.app.inject({
      method: "POST",
      url: BILLING_WEBHOOK_PATH,
      headers: {
        "content-type": "application/json",
        "stripe-signature": "t=1757000000,v1=notasignatureanybodyproduced",
      },
      payload: '{"id":"evt_1","type":"checkout.session.completed"}',
    });

    expect(answer.statusCode).toBe(400);
    expect((answer.json() as { message: string }).message).toContain(
      "signature",
    );
  });

  it("does not let an unauthenticated bad signature change billing health", async () => {
    await aBillingDeployment("stripe-untrusted-health", {
      withWebhookDoor: true,
    });
    const admin = await anAdmin("untrusted-health@example.test", "Acme");
    const response = await api.app.inject({
      method: "POST",
      url: BILLING_WEBHOOK_PATH,
      headers: {
        "content-type": "application/json",
        "stripe-signature": "t=1757000000,v1=bad",
      },
      payload: JSON.stringify({
        id: "evt_untrusted",
        type: "checkout.session.completed",
        data: { object: { customer: "cus_untrusted" } },
      }),
    });
    expect(response.statusCode).toBe(400);
    const { rows } = await api.database.sql(
      "select stripe_failed_at, stripe_failure_version from cloud_billing_account where organization_id = $1",
      [admin.organizationId],
    );
    expect(rows[0]).toEqual({
      stripe_failed_at: null,
      stripe_failure_version: "0",
    });
    const readiness = await api.database.sql(
      "select stripe_payments_ready from cloud_plan where code = 'hobby'",
    );
    expect(readiness.rows[0]?.stripe_payments_ready).toBe(true);
  });

  it("takes no session cookie and no key, because the signature is the gate", async () => {
    await aBillingDeployment("stripe-no-credential", { withWebhookDoor: true });

    // No `authorization` header and no cookie: the refusal is about the
    // signature and never about a credential, which is what proves the door is
    // outside the credentialed scope.
    const answer = await api.app.inject({
      method: "POST",
      url: BILLING_WEBHOOK_PATH,
      headers: { "content-type": "application/json" },
      payload: "{}",
    });

    expect(answer.statusCode).not.toBe(401);
    expect(answer.json()).toMatchObject({ error: "invalid_request" });
  });
});

describe("what the four billing actions ask before they ask Stripe anything", () => {
  it("refuses a member every one of them", async () => {
    await aBillingDeployment("stripe-member", { withWebhookDoor: false });
    const admin = await anAdmin("owner@example.test", "Acme");
    const key = admin.secret;
    // The organization's own key resolves to whoever holds it; the role on the
    // membership is what decides, so the person is demoted to a member.
    await api.database.sql(
      "update membership set role = 'member' where organization_id = $1",
      [admin.organizationId],
    );

    for (const path of [
      CREDIT_PATH,
      UPGRADE_PATH,
      DOWNGRADE_PATH,
      PORTAL_PATH,
    ]) {
      const answer = await ask(api.app, "POST", path, key, {
        amountMicros: 25_000_000,
      });
      expect(answer.statusCode, `${path} answered ${answer.statusCode}`).toBe(
        403,
      );
      expect(answer.body).toMatchObject({ error: "not_permitted" });
    }
  });

  it("refuses paid actions until webhook signing is configured", async () => {
    await aBillingDeployment("stripe-signing-missing", {
      withWebhookDoor: false,
    });
    const admin = await anAdmin("signing-missing@example.test", "Acme");
    for (const path of [
      CREDIT_PATH,
      UPGRADE_PATH,
      DOWNGRADE_PATH,
      PORTAL_PATH,
    ]) {
      const answer = await ask(api.app, "POST", path, admin.secret, {
        amountMicros: 25000000,
      });
      expect(answer.statusCode).toBe(422);
      expect(String(answer.body["message"])).toContain("webhook");
    }
  });

  it("refuses an amount of credit nobody could buy, before any Stripe call", async () => {
    await aBillingDeployment("stripe-bad-amount", { withWebhookDoor: false });
    const admin = await anAdmin("buyer@example.test", "Acme");
    const key = admin.secret;

    const tooSmall = await ask(api.app, "POST", CREDIT_PATH, key, {
      amountMicros: 1_000_000,
    });
    expect(tooSmall.statusCode).toBe(400);
    expect(tooSmall.body).toMatchObject({ error: "invalid_request" });
    const subCent = await ask(api.app, "POST", CREDIT_PATH, key, {
      amountMicros: 5_000_001,
    });
    expect(subCent.statusCode).toBe(400);
    expect(String(subCent.body["message"])).toContain("whole cents");

    const missing = await ask(api.app, "POST", CREDIT_PATH, key, {});
    expect(missing.statusCode).toBe(400);
    expect(String(missing.body["message"])).toContain("amountMicros");
  });

  it("refuses a downgrade for an organization that is not on Pro", async () => {
    await aBillingDeployment("stripe-not-pro", { withWebhookDoor: true });
    const admin = await anAdmin("hobbyist@example.test", "Acme");
    const key = admin.secret;

    const answer = await ask(api.app, "POST", DOWNGRADE_PATH, key, {});

    expect(answer.statusCode).toBe(422);
    expect(answer.body).toMatchObject({ error: "unprocessable" });
    expect(String(answer.body["message"])).toContain("Hobby");
  });

  it("refuses the portal for an organization that has never paid anything", async () => {
    await aBillingDeployment("stripe-no-customer", { withWebhookDoor: true });
    const admin = await anAdmin("newcomer@example.test", "Acme");
    const key = admin.secret;

    const answer = await ask(api.app, "POST", PORTAL_PATH, key, {});

    expect(answer.statusCode).toBe(422);
    expect(String(answer.body["message"])).toContain("no card");
  });

  it("refuses an upgrade while this deployment's Stripe has no Pro product", async () => {
    await aBillingDeployment("stripe-no-product", { withWebhookDoor: true });
    const admin = await anAdmin("upgrader@example.test", "Acme");
    const key = admin.secret;

    // The plan rows are seeded, and the six Stripe ids on them are null until
    // `stripe:setup` has run against this deployment's own account.
    const answer = await ask(api.app, "POST", UPGRADE_PATH, key, {});

    expect(answer.statusCode).toBe(422);
    expect(String(answer.body["message"])).toContain("Stripe setup");
  });
});

describe("what the Billing section is told it may do", () => {
  it("names the amounts the picker offers and the bounds it enforces", async () => {
    await aBillingDeployment("stripe-actions-offered", {
      withWebhookDoor: false,
    });
    const admin = await anAdmin("reader@example.test", "Acme");
    const key = admin.secret;

    const answer = await ask(api.app, "GET", "/api/organization/billing", key);

    expect(answer.statusCode).toBe(200);
    expect(answer.body["actions"]).toEqual({
      available: false,
      creditAmountsMicros: [10_000_000, 25_000_000, 50_000_000, 100_000_000],
      smallestCreditMicros: 5_000_000,
      largestCreditMicros: 1_000_000_000,
    });
  });
});
