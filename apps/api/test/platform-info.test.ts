import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createApi, type TestApi } from "./support/api.ts";

/**
 * The public identity of one Egma platform.
 *
 * The CLI reads this before it has a credential and before it sends one
 * repository identifier. A real database is part of this seam because the
 * instance identity must survive an API restart instead of changing with the
 * process that happened to answer.
 */
describe("the public platform identity", () => {
  let api: TestApi;

  beforeAll(async () => {
    api = await createApi("platform_info");
  });

  afterAll(async () => {
    await api.close();
  });

  it("returns one stable, non-secret identity and the canonical origin without a credential", async () => {
    const first = await api.app.inject({ method: "GET", url: "/api/platform" });
    const second = await api.app.inject({ method: "GET", url: "/api/platform" });

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);

    const identity = first.json<Record<string, unknown>>();
    expect(Object.keys(identity).sort()).toEqual(["instance_id", "origin"]);
    expect(identity).toEqual({
      instance_id: expect.stringMatching(/^pf_[0-9A-HJKMNP-TV-Z]{26}$/u),
      origin: api.config.baseUrl,
    });
    expect(second.json()).toEqual(identity);

    const shown = JSON.stringify(identity);
    expect(shown).not.toMatch(/secret|token|credential|cloud/iu);
  });
});
