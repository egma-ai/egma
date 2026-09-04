import { db } from "../client.ts";
import type { AuthContext } from "./context.ts";
import { ProjectOutsideOrganizationError } from "./errors.ts";
import { authorize, here } from "./permissions.ts";
import { isProjectOfOrganization } from "./projects.ts";
import { lockRepositoryProject } from "./repository-lock.ts";
import {
  applyRepositorySuitesOn,
  type RepositorySuite,
} from "./suites.ts";
import {
  applyRepositoryTestsOn,
  type AppliedRepositoryTest,
  type RepositoryTest,
} from "./tests.ts";

/**
 * The complete authored repository state for one project.
 *
 * **Two lists, not three.** There was a third — the project's own mock
 * tools — and it is gone with the project-owned mocked world: a test carries
 * the tools it answers for itself, so what a repository declares about mocking
 * arrives inside each test rather than beside them all.
 */
export type RepositoryChangeSet = {
  readonly suites: readonly RepositorySuite[];
  readonly tests: readonly RepositoryTest[];
};

export type AppliedRepositoryChangeSet = {
  readonly tests: readonly AppliedRepositoryTest[];
};

/**
 * Apply one repository as one database change. Each table owner performs its
 * part on the same transaction. One project advisory lock closes the gap
 * between checking the complete remote set and writing it. Ordinary authoring
 * writes take the same lock first, so their row locks cannot deadlock with it.
 */
export async function applyRepositoryChangeSet(
  auth: AuthContext,
  changeSet: RepositoryChangeSet,
): Promise<AppliedRepositoryChangeSet> {
  authorize(auth, "author_definitions", here(auth));
  const projectId = auth.projectId;
  if (projectId === undefined) {
    throw new Error(
      "a repository belongs to a project, and this credential is acting in none",
    );
  }
  if (!(await isProjectOfOrganization(auth, projectId))) {
    throw new ProjectOutsideOrganizationError(auth.organizationId, projectId);
  }

  return db().transaction(async (tx) => {
    await lockRepositoryProject(tx, projectId);

    await applyRepositorySuitesOn(tx, auth, changeSet.suites);
    const tests = await applyRepositoryTestsOn(tx, auth, changeSet.tests);
    return { tests };
  });
}
