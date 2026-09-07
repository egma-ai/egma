import { newId } from "@egma/ids";
import { and, eq } from "drizzle-orm";

import type { Queryable } from "../client.ts";
import {
  defaultPersonaParameterValues,
  personaModelsOfParameters,
  validatePersonaParameterValues,
  type PersonaParameterValues,
} from "../persona-library/parameters.ts";
import { persona, personaVersion, projectPersona } from "../schema/personas.ts";
import type { AuthContext } from "./context.ts";
import { UnprocessableInputError } from "./errors.ts";
import { personaAvailableToProject } from "./persona-availability.ts";
import { within } from "./within.ts";

export type ProjectPersonaSettings = {
  readonly id: string;
  readonly parameterValues: PersonaParameterValues;
  readonly models: ReturnType<typeof personaModelsOfParameters>;
  readonly createdAt: Date;
  readonly updatedAt: Date;
};

/** Called inside the write transaction, after locking the selected definition. */
export async function readProjectPersonaSettingsOn(
  on: Queryable,
  auth: AuthContext,
  projectId: string,
  definitionId: string,
  contract: unknown,
  lock = false,
): Promise<ProjectPersonaSettings | undefined> {
  const query = on
    .select({
      id: projectPersona.id,
      parameterValues: projectPersona.parameterValues,
      createdAt: projectPersona.createdAt,
      updatedAt: projectPersona.updatedAt,
    })
    .from(projectPersona)
    .where(
      within(
        auth,
        projectPersona,
        and(
          eq(projectPersona.projectId, projectId),
          eq(projectPersona.personaDefinitionId, definitionId),
        ),
      ),
    )
    .limit(1);
  const [row] = await (lock
    ? query.for("share", { of: projectPersona })
    : query);
  if (row === undefined) return undefined;
  const parameterValues = validatePersonaParameterValues(
    contract,
    row.parameterValues,
  );
  return {
    ...row,
    parameterValues,
    models: personaModelsOfParameters(parameterValues),
  };
}

/** First use writes complete defaults once; repeated use preserves saved choices. */
export async function ensureProjectPersonaOn(
  on: Queryable,
  auth: AuthContext,
  projectId: string,
  definitionId: string,
  parameterValues?: PersonaParameterValues,
  allowArchived = false,
): Promise<ProjectPersonaSettings> {
  const [definition] = await on
    .select({
      currentVersionId: persona.currentVersionId,
      archivedAt: persona.archivedAt,
    })
    .from(persona)
    .where(
      personaAvailableToProject(auth, projectId, eq(persona.id, definitionId)),
    )
    .limit(1)
    .for("share", { of: persona });
  if (
    definition === undefined ||
    (!allowArchived && definition.archivedAt !== null)
  ) {
    throw new UnprocessableInputError(
      `persona ${definitionId} is not active in this project`,
    );
  }
  const [version] = await on
    .select({ parameterContract: personaVersion.parameterContract })
    .from(personaVersion)
    .where(eq(personaVersion.id, definition.currentVersionId))
    .limit(1);
  if (version === undefined) {
    throw new Error("the persona's current version is missing");
  }
  const values =
    parameterValues === undefined
      ? defaultPersonaParameterValues(version.parameterContract)
      : validatePersonaParameterValues(
          version.parameterContract,
          parameterValues,
        );
  await on
    .insert(projectPersona)
    .values({
      id: newId("ppr"),
      organizationId: auth.organizationId,
      projectId,
      personaDefinitionId: definitionId,
      parameterValues: values,
    })
    .onConflictDoNothing({
      target: [projectPersona.projectId, projectPersona.personaDefinitionId],
    });
  const saved = await readProjectPersonaSettingsOn(
    on,
    auth,
    projectId,
    definitionId,
    version.parameterContract,
    true,
  );
  if (saved === undefined) {
    throw new Error("the project persona settings were not written");
  }
  return saved;
}
