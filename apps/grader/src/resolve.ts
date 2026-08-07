import {
  getGrader,
  getSimulationTestVersion,
  listGraders,
  type AuthContext,
  type Grader,
  type Simulation,
} from "@egma/db";

/**
 * Which graders judge this conversation.
 *
 * Two sources add up, and the addition is the product's own promise: **every
 * grader in the project applies to every test by default**, so writing a policy
 * check once makes it judge everything without touching a test file, and **a
 * test's own grader array adds scenario-specific ones on top**, so "the refund
 * tool must fire" judges the refund test and nothing else.
 *
 * A grader named by both is one grader and produces one row per dimension: the
 * set is by identity, so naming a project grader in a test's array is redundant
 * rather than doubling.
 *
 * **The scope decides where a project grader applies**, and today the answer for
 * a simulation is `simulations` or `both`. A grader scoped to production alone
 * is not a grader that failed to run here; it is a grader that was never about
 * this conversation, and there is no verdict row for it at all. A grader a test
 * names is applied whatever its scope says: naming it *is* the scoping decision,
 * made per test rather than per project.
 *
 * **A deleted grader judges nothing from now on.** It is refused deletion while
 * a live test names it, so a test's array cannot come to point at nothing behind
 * anybody's back; a grader deleted after a run keeps its versions, so what it
 * already said stays readable, and it simply stops appearing here.
 *
 * The built-in `expected_behaviors` grader is deliberately absent. It is never a
 * row and never attachable, so it is never resolved — it is applied because
 * running a test means judging it against what the test says, which is a
 * different fact from a grader being attached.
 */
export async function applicableGraders(
  auth: AuthContext,
  simulation: Simulation,
): Promise<readonly Grader[]> {
  const applicable = new Map<string, Grader>();

  for (const grader of await everyGraderInTheProject(auth)) {
    if (grader.scope === "simulations" || grader.scope === "both") {
      applicable.set(grader.id, grader);
    }
  }

  for (const grader of await theTestVersionsGraders(auth, simulation)) {
    applicable.set(grader.id, grader);
  }

  // By id, which is the mint order: an arbitrary order, but the same one every
  // time, so two gradings of one conversation walk the same list.
  return [...applicable.values()].sort((left, right) =>
    left.id < right.id ? -1 : left.id > right.id ? 1 : 0,
  );
}

/**
 * Every grader the project holds, page by page. A project's graders are a set
 * somebody maintains by hand rather than a stream, so this is bounded by what a
 * team has written down; the paging is the list's own contract rather than a
 * guard against size.
 */
async function everyGraderInTheProject(
  auth: AuthContext,
): Promise<readonly Grader[]> {
  const found: Grader[] = [];
  let cursor: string | undefined;

  do {
    const page = await listGraders(
      auth,
      cursor === undefined ? undefined : { cursor },
    );
    found.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor !== undefined);

  return found;
}

/**
 * The graders the test named, resolved through the version this conversation was
 * *executed against* rather than through the test as it is now.
 *
 * That is what the pin is for. A test that gained a grader this morning does not
 * retroactively judge last night's conversation, and a test that lost one does
 * not retroactively unjudge it — the array is read off the frozen version the
 * run stamped on every simulation it started.
 *
 * A simulation born from no test names no graders here, and that is an ordinary
 * case rather than a gap: somebody proving a connection with a smoke call wrote
 * down no expectations, and the project's own graders still judge it.
 */
async function theTestVersionsGraders(
  auth: AuthContext,
  simulation: Simulation,
): Promise<readonly Grader[]> {
  if (simulation.testVersionId === null) return [];

  const version = await getSimulationTestVersion(auth, simulation.id);
  if (version === undefined) return [];

  const named: Grader[] = [];
  for (const { id } of version.graders) {
    // By identity, never by version: the array names which grader judges, and
    // which version of it judges is always the current one, exactly as an edit
    // to a grader applies from now on. A grader deleted since resolves to
    // nothing and judges nothing further.
    const grader = await getGrader(auth, id);
    if (grader !== undefined) named.push(grader);
  }
  return named;
}
