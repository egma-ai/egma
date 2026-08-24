import { newId } from "@egma/ids";
import { and, eq, isNull } from "drizzle-orm";

import type { Queryable } from "../client.ts";
import { PREDEFINED_GRADERS } from "../grader-library/catalog.ts";
import {
  graderDefinition,
  projectGrader,
  type ProjectGraderScope,
} from "../schema/graders.ts";
import { project } from "../schema/tenancy.ts";

/** Expected behaviors grades every simulation and never grades production. */
export const EXPECTED_BEHAVIORS_SCOPE = {
  simulations: [{ kind: "all" }],
  production: null,
} as const satisfies ProjectGraderScope;

export type SeededProjectGrader = {
  readonly id: string;
  readonly projectId: string;
};

/**
 * Add the one project policy Egma creates automatically.
 *
 * There is no copy of the prompt here. The project row points to Egma's stable
 * definition and future runs read whichever immutable definition version is
 * current when their plan is captured.
 */
export async function insertExpectedBehaviorsProjectGrader(
  on: Queryable,
  input: {
    readonly organizationId: string;
    readonly projectId: string;
  },
): Promise<string> {
  const [installed] = await on
    .select({ id: graderDefinition.id })
    .from(graderDefinition)
    .where(eq(graderDefinition.id, PREDEFINED_GRADERS.expectedBehaviors))
    .limit(1)
    .for("share");
  if (installed === undefined) {
    throw new Error("Egma's Expected behaviors grader definition is not installed");
  }

  const id = newId("grd");
  await on.insert(projectGrader).values({
    id,
    organizationId: input.organizationId,
    projectId: input.projectId,
    graderDefinitionId: PREDEFINED_GRADERS.expectedBehaviors,
    scope: EXPECTED_BEHAVIORS_SCOPE,
    parameterValues: {},
    passThreshold: 1,
  });
  return id;
}

/** Repair projects created before this model existed. */
export async function backfillExpectedBehaviorsProjectGraders(
  on: Queryable,
): Promise<readonly SeededProjectGrader[]> {
  const missing = await on
    .select({
      id: project.id,
      organizationId: project.organizationId,
    })
    .from(project)
    .leftJoin(
      projectGrader,
      and(
        eq(projectGrader.projectId, project.id),
        eq(
          projectGrader.graderDefinitionId,
          PREDEFINED_GRADERS.expectedBehaviors,
        ),
        isNull(projectGrader.archivedAt),
      ),
    )
    .where(isNull(projectGrader.id))
    .orderBy(project.id);

  const written: SeededProjectGrader[] = [];
  for (const one of missing) {
    const id = await insertExpectedBehaviorsProjectGrader(on, {
      organizationId: one.organizationId,
      projectId: one.id,
    });
    written.push({ id, projectId: one.id });
  }
  return written;
}
