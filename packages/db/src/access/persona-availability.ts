import { and, eq, isNull, or, type SQL } from "drizzle-orm";

import { persona } from "../schema/personas.ts";
import type { AuthContext } from "./context.ts";
import { within } from "./within.ts";

function oneOf(...conditions: readonly (SQL | undefined)[]): SQL {
  const combined = or(...conditions);
  if (combined === undefined) {
    throw new Error("a persona availability predicate can never be empty");
  }
  return combined;
}

/** Egma's definitions, plus the customer's definitions in the acting scope. */
export function readablePersona(
  auth: AuthContext,
  narrower?: SQL,
): SQL {
  const project =
    auth.projectId === undefined
      ? undefined
      : eq(persona.projectId, auth.projectId);
  return and(
    oneOf(
      isNull(persona.organizationId),
      within(auth, persona, project),
    ),
    narrower,
  ) ?? oneOf(isNull(persona.organizationId), within(auth, persona, project));
}

/** Egma's definitions, plus definitions owned by this exact project. */
export function personaAvailableToProject(
  auth: AuthContext,
  projectId: string,
  narrower?: SQL,
): SQL {
  return and(
    oneOf(
      isNull(persona.organizationId),
      within(auth, persona, eq(persona.projectId, projectId)),
    ),
    narrower,
  ) ??
    oneOf(
      isNull(persona.organizationId),
      within(auth, persona, eq(persona.projectId, projectId)),
    );
}
