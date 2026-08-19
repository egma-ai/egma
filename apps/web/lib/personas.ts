/**
 * The personas of one project, as `/api/personas` answers them.
 *
 * A **persona** is the synthetic person who calls the agent. Egma supplies
 * predefined personas to every project, and a project can author its own or
 * fork one of Egma's. Personality says how the person behaves; it never says
 * what they want in one simulation.
 *
 * **Nothing in a persona says what that persona wants.** That is the test's
 * scenario. The whole worth of a persona is that one of them calls about forty
 * different situations, and a trait that said "asks to reschedule" would turn
 * a reusable person into a second copy of one test. The editor says so where
 * somebody is typing, and this file says so where somebody is reading.
 *
 * The shape is the API's own, field names included. Renaming its fields on the
 * way in would put a second vocabulary between the contract and the page, and
 * the two would drift the first time the API grew a field.
 */

export type PersonaTraits = {
  readonly personality: string;
};

export type Persona = {
  readonly id: string;
  /** Null for an Egma-owned predefined persona. */
  readonly project_id: string | null;
  /** Who owns the definition and therefore who may edit it. */
  readonly owner: "egma" | "organization";
  readonly name: string;
  readonly description: string | null;
  readonly version: number;
  /** The current version's own id — what a traits write is written against. */
  readonly version_id: string;
  readonly traits: PersonaTraits;
  /** The opaque token an identity write or a lifecycle change has to name. */
  readonly revision: string;
  readonly archived_at: string | null;
  /** Whether the project points at them when a test names nobody. */
  readonly is_default: boolean;
  readonly created_at: string;
  readonly updated_at: string;
};

export type PersonaPage = {
  readonly items: readonly Persona[];
  readonly next_cursor: string | null;
};

/** One frozen version, as history and the older-version read show it. */
export type PersonaVersion = {
  readonly id: string;
  readonly persona_id: string;
  readonly version: number;
  readonly traits: PersonaTraits;
  readonly created_at: string;
};

export type PersonaVersionPage = {
  readonly items: readonly PersonaVersion[];
  readonly next_cursor: string | null;
};

export const PERSONAS_PATH = "/api/personas";

/** One server-side search and one cursor page of a lifecycle state. */
export function personasQuery(options: {
  readonly archived?: boolean;
  readonly search?: string;
  readonly cursor?: string;
}): string {
  const query = new URLSearchParams();
  if (options.archived === true) query.set("archived", "true");
  const wanted = options.search?.trim() ?? "";
  if (wanted !== "") query.set("search", wanted);
  if (options.cursor !== undefined) query.set("cursor", options.cursor);
  const written = query.toString();
  return written === "" ? PERSONAS_PATH : `${PERSONAS_PATH}?${written}`;
}

/** The list of one lifecycle state. Two lists, never one with a column. */
export function personasPath(archived: boolean): string {
  return personasQuery({ archived });
}

/** The next page of the same list, carrying the same filter. */
export function personasAfter(cursor: string, archived: boolean): string {
  return personasQuery({ archived, cursor });
}

export function personaPath(personaId: string): string {
  return `${PERSONAS_PATH}/${personaId}`;
}

export function personaVersionsPath(personaId: string): string {
  return `${PERSONAS_PATH}/${personaId}/versions`;
}

/**
 * The versioned field an editor is holding, before anybody decides whether it
 * differs from what is stored.
 */
export type TraitsDraft = {
  readonly personality: string;
};

/** What a persona egma has not been told anything about starts as. */
export const BLANK_TRAITS: TraitsDraft = {
  personality: "",
};

/** The stored traits, as the editor holds them. */
export function draftOf(traits: PersonaTraits): TraitsDraft {
  return { personality: traits.personality };
}

/** The personality draft, in the exact shape the API accepts. */
export function traitsFrom(draft: TraitsDraft): PersonaTraits {
  return { personality: draft.personality };
}
