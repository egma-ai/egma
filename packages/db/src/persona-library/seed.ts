import {
  seedPersonaLibraryInternal,
  type SeededPersona,
} from "../access/personas.ts";
import {
  PERSONA_LIBRARY_CATALOG,
  type PredefinedPersona,
} from "./catalog.ts";

/**
 * Write Egma's predefined personas from the shipped catalog.
 *
 * This is deployment configuration, not a customer data-access call. It lives
 * outside the AuthContext-bound access surface for that reason and cannot name
 * an organization or project. The returned list contains only identities that
 * this call inserted or changed; an unchanged boot returns an empty list.
 */
export async function seedPersonaLibrary(
  catalog: readonly PredefinedPersona[] = PERSONA_LIBRARY_CATALOG,
): Promise<readonly SeededPersona[]> {
  return seedPersonaLibraryInternal(catalog);
}

export type { SeededPersona };
