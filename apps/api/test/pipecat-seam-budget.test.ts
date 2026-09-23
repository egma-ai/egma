import { afterAll, beforeAll, expect, it } from "vitest";

import type { RateLimit } from "../src/http/rate-limit.ts";
import { SDK_HELLO_PATH } from "../src/routes/sdk-seam.ts";
import { OTLP_TRACES_PATH } from "../src/routes/traces.ts";
import { createApi, type TestApi } from "./support/api.ts";
import { projectKeyFor, signUp, type Customer } from "./support/traces.ts";

/**
 * The SDK seam spends from the organization budget the OTLP door spends
 * from: one bot's hello, tool calls and trace exports are one customer's
 * traffic.
 */

let api: TestApi;
let ada: Customer;
let key: string;

/** A budget this test counts and closes by hand. */
const asked: string[] = [];
let open = true;
const rateLimit: RateLimit = {
  reached(organizationId) {
    asked.push(organizationId);
    return open
      ? { allowed: true, retryAfterSeconds: 0 }
      : { allowed: false, retryAfterSeconds: 17 };
  },
};

beforeAll(async () => {
  api = await createApi("pipecat_seam_budget", { rateLimit });
  ada = await signUp(api.app, "ada@lakeside.example", "Lakeside");
  key = await projectKeyFor(api.app, ada);
}, 60_000);

afterAll(async () => {
  await api?.close();
});

function hello() {
  return api.app.inject({
    method: "POST",
    url: SDK_HELLO_PATH,
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    payload: { provider_reference: "sim_nobody", protocol_version: 1, tools: [] },
  });
}

it("asks the organization's budget, and answers 429 with Retry-After once it is spent", async () => {
  asked.length = 0;
  const answered = await hello();
  expect(answered.statusCode).toBe(404);
  expect(asked).toEqual([ada.organizationId]);

  open = false;
  const refused = await hello();
  expect(refused.statusCode).toBe(429);
  expect(refused.headers["retry-after"]).toBe("17");
  expect(refused.json()).toMatchObject({ error: "too_many_requests" });

  // The trace door the same SDK exports to is closed by the same budget.
  const exported = await api.app.inject({
    method: "POST",
    url: OTLP_TRACES_PATH,
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    payload: JSON.stringify({ resourceSpans: [] }),
  });
  expect(exported.statusCode).toBe(429);
  open = true;
});
