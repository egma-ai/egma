import { afterEach, describe, expect, it } from "vitest";

import { createApi, type TestApi } from "./support/api.ts";

/**
 * Which egma this is, asked the way an agent repository asks it.
 *
 * Every claim here is one the binding in `egma/config.yaml` rests on: the
 * answer arrives with no credential, it names the same instance every time it
 * is asked, it names a *different* instance on a different deployment, and it
 * carries nothing that could not be committed to a public repository. A
 * repository that could not tell two platforms apart would send one platform's
 * identifiers to the other. See ADR-0008.
 *
 * That the identifier survives a restart is a claim about the data rather than
 * about the door, and it is made where the data is — `packages/db`.
 */

let api: TestApi;

afterEach(async () => {
  await api?.close();
});

async function identity(of: TestApi): Promise<{ instance_id: string; origin: string }> {
  const response = await of.app.inject({ method: "GET", url: "/api/platform" });
  expect(response.statusCode).toBe(200);
  return response.json() as { instance_id: string; origin: string };
}

describe("the platform's own identity", () => {
  it("is answered to somebody holding no credential at all", async () => {
    api = await createApi("platform_identity");

    const said = await identity(api);

    expect(said.instance_id).toMatch(/^ins_[0-9A-HJKMNP-TV-Z]{26}$/u);
    expect(said.origin).toBe(api.config.baseUrl);
  });

  it("says the same thing every time, because a binding is checked on every command", async () => {
    api = await createApi("platform_identity_stable");

    const first = await identity(api);

    expect((await identity(api)).instance_id).toBe(first.instance_id);
  });

  it("is a different identifier on a different deployment", async () => {
    api = await createApi("platform_identity_one");
    const one = await identity(api);
    await api.close();

    api = await createApi("platform_identity_two");

    expect((await identity(api)).instance_id).not.toBe(one.instance_id);
  });

  it("carries nothing secret", async () => {
    api = await createApi("platform_identity_secrets");

    const response = await api.app.inject({ method: "GET", url: "/api/platform" });

    expect(Object.keys(response.json() as object).sort()).toEqual([
      "instance_id",
      "origin",
    ]);
    for (const secret of [
      api.config.authSecret,
      api.config.encryptionKey,
      api.config.simulatorServiceToken,
    ]) {
      expect(response.body).not.toContain(secret);
    }
    expect(response.headers["cache-control"]).toBe("no-store");
  });
});
