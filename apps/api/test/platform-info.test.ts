import { platformOperations } from "@egma/platform-api/contract";
import { afterEach, expect, it } from "vitest";

import { fastifyPath } from "../src/http/platform-operation.ts";
import { createApi, type TestApi } from "./support/api.ts";

let api: TestApi;

afterEach(async () => {
  await api?.close();
});

it("does not expose the retired platform identity route", async () => {
  api = await createApi("platform_identity_retired");

  const response = await api.app.inject({ method: "GET", url: "/api/platform" });

  expect(response.statusCode).toBe(404);
});

it("publishes the platform API contract without account or system routes", async () => {
  api = await createApi("platform_openapi");

  const response = await api.app.inject({ method: "GET", url: "/openapi.json" });

  expect(response.statusCode).toBe(200);
  expect(response.headers["content-type"]).toMatch(/^application\/json/);

  const document = response.json() as {
    openapi: string;
    paths: Record<string, unknown>;
  };
  expect(document.openapi).toBe("3.1.0");
  expect(Object.keys(document.paths).length).toBeGreaterThan(0);
  expect(Object.keys(document.paths).every((path) => path.startsWith("/v1/"))).toBe(
    true,
  );
  expect(document.paths).toHaveProperty("/v1/projects");
  expect(document.paths).not.toHaveProperty("/api/signup");
  expect(document.paths).not.toHaveProperty("/api/platform/settings");
  expect(document.paths).not.toHaveProperty("/health");
  expect(document.paths).not.toHaveProperty("/v1/claims");
});

it("registers every contract operation only at its v1 Fastify route", async () => {
  api = await createApi("platform_route_closure");

  const operations = Object.values(platformOperations);
  expect(operations).toHaveLength(76);

  for (const operation of operations) {
    const v1Route = fastifyPath(operation.path);
    const retiredRoute = v1Route.replace(/^\/v1/u, "/api");

    expect(
      api.app.hasRoute({ method: operation.method, url: v1Route }),
      `${operation.method} ${v1Route}`,
    ).toBe(true);
    expect(
      api.app.hasRoute({ method: operation.method, url: retiredRoute }),
      `${operation.method} ${retiredRoute}`,
    ).toBe(false);
  }
});
