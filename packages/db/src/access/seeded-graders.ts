import { newId } from "@egma/ids";
import { and, eq, isNull } from "drizzle-orm";

import type { Queryable } from "../client.ts";
import {
  MAXIMUM_AVERAGE_RESPONSE_TIME_PARAMETER,
  MAXIMUM_RESPONSE_TIME_PARAMETER,
  PREDEFINED_GRADERS,
} from "../grader-library/catalog.ts";
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


/**
 * Move Response latency's setting onto the key its contract now names.
 *
 * The grader bounded the mean and its setting was called
 * ``maximum_average_response_time_ms``. It bounds the p90 now, so the word
 * *average* in that key names something the grader stopped doing — and a
 * stored key that lies is worse than one that is merely long. The contract
 * renamed it; every project that had already turned the grader on still holds
 * its answer under the old one, and a project whose only setting is a key the
 * current contract does not name is a project that cannot be edited and a
 * grader that errors instead of grading.
 *
 * So the number moves with the name. The value is untouched: what a project
 * chose as its maximum is its choice, and this renames where that choice is
 * filed rather than deciding it again.
 *
 * Runs in the same boot door as the catalog reconcile, inside its transaction
 * and after it, so a definition version naming the new key is never live for a
 * row that still holds the old one. Idempotent by construction: a row already
 * moved has no old key to match.
 */
export async function moveResponseLatencySettingToItsNewKey(
  on: Queryable,
): Promise<readonly SeededProjectGrader[]> {
  const held = await on
    .select({
      id: projectGrader.id,
      projectId: projectGrader.projectId,
      parameterValues: projectGrader.parameterValues,
    })
    .from(projectGrader)
    .where(eq(projectGrader.graderDefinitionId, PREDEFINED_GRADERS.responseLatency))
    .orderBy(projectGrader.id);

  const moved: SeededProjectGrader[] = [];
  for (const one of held) {
    const values = one.parameterValues;
    if (values === null || typeof values !== "object" || Array.isArray(values)) {
      continue;
    }
    const settings = values as Record<string, unknown>;
    const carried = settings[MAXIMUM_AVERAGE_RESPONSE_TIME_PARAMETER];
    if (carried === undefined) continue;

    // The new key wins where both somehow exist: it is the one the current
    // contract names, so it is the one an edit since the rename would have
    // written, and the older key is then the stale half of the pair.
    const { [MAXIMUM_AVERAGE_RESPONSE_TIME_PARAMETER]: _old, ...rest } = settings;
    await on
      .update(projectGrader)
      .set({
        parameterValues: {
          [MAXIMUM_RESPONSE_TIME_PARAMETER]: carried,
          ...rest,
        },
      })
      .where(eq(projectGrader.id, one.id));
    moved.push({ id: one.id, projectId: one.projectId });
  }
  return moved;
}
