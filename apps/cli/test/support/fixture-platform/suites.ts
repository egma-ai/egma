/** Current project-owned test-suite and project-read fixture contract. */

import { given, newId, NOT_AUTHENTICATED, refuse, text } from "./reading.ts";
import type { FixtureAnswer, FixtureRequest, RouteGroup } from "./server.ts";

export type SeededSuite = { readonly id: string; readonly projectId: string; name: string };

export type SuiteControls = {
  add(name: string): SeededSuite;
  rename(id: string, name: string): SeededSuite;
  readonly suites: readonly SeededSuite[];
  byId(id: string): SeededSuite | null;
};

function bearer(request: FixtureRequest): string {
  const value = request.headers.authorization ?? "";
  return value.startsWith("Bearer ") ? value.slice(7) : "";
}

export function suiteRoutes(options: {
  readonly holdsKey: (key: string) => boolean;
  readonly projectId: string;
  readonly projectName: string;
  readonly afterCreate?: (suite: SeededSuite) => void;
}): { readonly group: RouteGroup; readonly controls: SuiteControls } {
  const suites: SeededSuite[] = [];
  const behind = (request: FixtureRequest, action: () => FixtureAnswer): FixtureAnswer =>
    options.holdsKey(bearer(request)) ? action() : { status: 401, body: NOT_AUTHENTICATED };
  const projectGate = (id: string | undefined): FixtureAnswer | null =>
    id === options.projectId
      ? null
      : refuse(403, "not_authorized", `this credential may not act in project ${id ?? ""}`);
  const controls: SuiteControls = {
    add(name) {
      const suite = { id: newId("ste"), projectId: options.projectId, name: name.trim() };
      suites.push(suite);
      return suite;
    },
    rename(id, name) {
      const suite = suites.find((one) => one.id === id);
      if (suite === undefined) throw new Error(`no suite ${id}`);
      suite.name = name.trim();
      return suite;
    },
    get suites() {
      return suites;
    },
    byId(id) {
      return suites.find((one) => one.id === id) ?? null;
    },
  };
  const described = (suite: SeededSuite): Record<string, unknown> => ({
    id: suite.id,
    projectId: suite.projectId,
    name: suite.name,
  });

  return {
    controls,
    group: {
      name: "test-suites",
      routes: [
        {
          method: "GET",
          path: "/v1/projects/:projectId",
          handle: (request) =>
            behind(request, () => {
              const gate = projectGate(request.params.projectId);
              return gate ?? {
                status: 200,
                body: { id: options.projectId, name: options.projectName },
              };
            }),
        },
        {
          method: "GET",
          path: "/v1/test-suites",
          handle: (request) =>
            behind(request, () => {
              const gate = projectGate(given(request.url.searchParams.get("projectId")));
              return gate ?? {
                status: 200,
                body: { testSuites: suites.map(described), nextPageToken: null },
              };
            }),
        },
        {
          method: "POST",
          path: "/v1/test-suites",
          handle: (request) =>
            behind(request, () => {
              const said = request.body ?? {};
              const gate = projectGate(
                given(request.url.searchParams.get("projectId")),
              );
              if (gate !== null) return gate;
              const name = text(said.name);
              if (name === "") return refuse(422, "unprocessable", "a suite name is required");
              const created = controls.add(name);
              options.afterCreate?.(created);
              return { status: 201, body: described(created) };
            }),
        },
        {
          method: "GET",
          path: "/v1/test-suites/:suiteId",
          handle: (request) =>
            behind(request, () => {
              const suite = controls.byId(request.params.suiteId ?? "");
              return suite === null
                ? refuse(404, "not_found", "there is no active test suite with that id")
                : { status: 200, body: described(suite) };
            }),
        },
        {
          method: "PATCH",
          path: "/v1/test-suites/:suiteId",
          handle: (request) =>
            behind(request, () => {
              const suite = controls.byId(request.params.suiteId ?? "");
              if (suite === null) return refuse(404, "not_found", "there is no active test suite with that id");
              const name = text(request.body?.name);
              if (name === "") return refuse(422, "unprocessable", "a suite name is required");
              return { status: 200, body: described(controls.rename(suite.id, name)) };
            }),
        },
        {
          method: "DELETE",
          path: "/v1/test-suites/:suiteId",
          handle: (request) =>
            behind(request, () => {
              const at = suites.findIndex((one) => one.id === request.params.suiteId);
              if (at < 0) return refuse(404, "not_found", "there is no active test suite with that id");
              suites.splice(at, 1);
              return { status: 204 };
            }),
        },
      ],
    },
  };
}
