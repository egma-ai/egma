import { afterEach, describe, expect, it } from "vitest";
import { createPreviewSettlementToken } from "../src/persona-preview-settlement.ts";
import { createApi, type TestApi } from "./support/api.ts";
import { signUp } from "./support/traces.ts";

let api: TestApi;
afterEach(async () => api?.close());

describe("persona Preview usage settlement", () => {
  it("accepts only the signed selected leg and stores an exact retry once", async () => {
    api = await createApi("preview_settlement", { traceStore: true });
    const member = await signUp(api.app, "preview@acme.example", "Preview Acme");
    const token = createPreviewSettlementToken({
      userId: member.userId, organizationId: member.organizationId, projectId: member.projectId,
      role: "admin", previewId: "preview-one", issuedAt: Date.now(), expiresAt: Date.now() + 60_000,
      legs: [{ provider: "openai", model: "gpt-4o-mini", operation: "openai_chat_completions", paymentSource: "platform", credentialRef: "deployment:test" }],
    }, api.config.authSecret);
    const payload = { token, usageIndex: 0, usage: { provider: "openai", model: "gpt-4o-mini", operation: "openai_chat_completions", measurement: "provider_reported", quantities: { input_tokens: 3, output_tokens: 2 }, raw: { usage: "held" } } };
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await api.app.inject({ method: "POST", url: "/internal/persona-preview-usage", headers: { authorization: `Bearer ${api.config.simulatorServiceToken}` }, payload });
      expect(response.statusCode, response.body).toBe(204);
    }
    const rows = await api.traceStore!.rows<{ n: string }>("SELECT toString(count()) AS n FROM spans WHERE kind = 'provider_usage'");
    expect(rows).toEqual([{ n: "1" }]);
    const altered = await api.app.inject({ method: "POST", url: "/internal/persona-preview-usage", headers: { authorization: `Bearer ${api.config.simulatorServiceToken}` }, payload: { ...payload, usage: { ...payload.usage, model: "gpt-4o" } } });
    expect(altered.statusCode).toBe(422);
  });

  it("rejects unauthenticated and expired settlements", async () => {
    api = await createApi("preview_settlement_refusal");
    const token = createPreviewSettlementToken({ userId: "usr_test", organizationId: "org_test", projectId: "prj_test", role: "admin", previewId: "expired", issuedAt: Date.now() - 60_000, expiresAt: Date.now() - 1, legs: [] }, api.config.authSecret);
    expect((await api.app.inject({ method: "POST", url: "/internal/persona-preview-usage", payload: { token, usageIndex: 0, usage: {} } })).statusCode).toBe(401);
    expect((await api.app.inject({ method: "POST", url: "/internal/persona-preview-usage", headers: { authorization: `Bearer ${api.config.simulatorServiceToken}` }, payload: { token, usageIndex: 0, usage: {} } })).statusCode).toBe(422);
  });
});
