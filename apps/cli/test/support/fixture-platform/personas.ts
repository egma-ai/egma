/** The personas a project can name, as `/v1/personas` answers them. */

import { given, NOT_AUTHENTICATED, refuse } from "./reading.ts";
import type { FixtureAnswer, FixtureRequest, RouteGroup } from "./server.ts";

export type SeededPersona = {
  readonly id: string;
  readonly name: string;
};

export type PersonaControls = {
  add(name: string): SeededPersona;
  /** Take them all away, for the case a project answers with none. */
  clear(): void;
  readonly personas: readonly SeededPersona[];
};

/**
 * Every project can name Egma's own Predefined persona.
 *
 * This is the tenancy rule rather than a convenience for the fixture: a
 * Predefined persona belongs to no organization and no project, so it is
 * readable from every one of them. A fixture project that answered with none
 * would be a project the real platform cannot produce — which is exactly the
 * shape a test must not teach. `clear()` exists so a test can ask for the
 * impossible on purpose and prove validation stops rather than writes a folder
 * that cannot be pushed.
 *
 * **Nothing here says which persona is the project's default.** There is no
 * default persona: the pointer and everything that guarded it were removed with
 * the persona rework, and a test naming no persona is refused rather than given
 * one.
 */
const EGMA_PREDEFINED = "Everyday caller";

function bearer(request: FixtureRequest): string {
  const value = request.headers.authorization ?? "";
  return value.startsWith("Bearer ") ? value.slice(7) : "";
}

export function personaRoutes(options: {
  readonly holdsKey: (key: string) => boolean;
  readonly projectId: string;
}): { readonly group: RouteGroup; readonly controls: PersonaControls } {
  let next = 1;
  const personas: SeededPersona[] = [
    { id: "prs_egma_default", name: EGMA_PREDEFINED },
  ];
  const behind = (request: FixtureRequest, action: () => FixtureAnswer): FixtureAnswer =>
    options.holdsKey(bearer(request)) ? action() : { status: 401, body: NOT_AUTHENTICATED };
  const projectGate = (id: string | undefined): FixtureAnswer | null =>
    id === options.projectId
      ? null
      : refuse(403, "not_authorized", `this credential may not act in project ${id ?? ""}`);

  const controls: PersonaControls = {
    add(name) {
      next += 1;
      const made = {
        id: `prs_fixture_${String(next)}`,
        name: name.trim(),
      };
      personas.push(made);
      return made;
    },
    clear() {
      personas.length = 0;
    },
    get personas() {
      return personas;
    },
  };

  return {
    controls,
    group: {
      name: "personas",
      routes: [
        {
          method: "GET",
          path: "/v1/personas",
          handle: (request) =>
            behind(request, () => {
              const gate = projectGate(given(request.url.searchParams.get("projectId")));
              return gate ?? {
                status: 200,
                body: {
                  personas: personas.map((one) => ({
                    id: one.id,
                    name: one.name,
                  })),
                  nextPageToken: null,
                },
              };
            }),
        },
      ],
    },
  };
}
