import {
  advanceProductionSampling,
  getGrader,
  getSimulationTestVersion,
  listGraders,
  type AuthContext,
  type Grader,
  type Simulation,
} from "@egma/db";

/**
 * Which graders judge this simulation.
 *
 * Two sources add up, and the addition is the product's own promise: **every
 * grader in the project applies to every test by default**, so writing a policy
 * check once makes it judge everything without touching a test file, and **a
 * test's own grader array adds scenario-specific ones on top**, so "the refund
 * tool must fire" judges the refund test and nothing else.
 *
 * A grader named by both is one grader and produces one row per assertion: the
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
 *
 * **Sampling never happens here.** A simulation is a conversation somebody asked
 * for, one at a time, and judging nine of ten of them would mean a suite whose
 * report is missing a test for no reason anybody chose. Sampling is about
 * traffic egma did not cause, and it lives on the production path alone.
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

  return inAStableOrder(applicable.values());
}

/**
 * Which graders judge this production trace, and whose turn it is.
 *
 * **The project's graders scoped to production, and nothing else at all.** Two
 * absences do the work here, and both are the same fact said twice: a production
 * trace has no test.
 *
 * - **No test-attached grader.** A test's grader array says "this grader judges
 *   this scenario", and a real caller phoning a real agent is not in anybody's
 *   scenario. There is no test version to read an array off, and inventing one
 *   would mean a customer's monitoring bill quietly depending on which tests
 *   somebody happened to write.
 * - **No built-in `expected_behaviors`.** It judges a test against the behaviors
 *   that test wrote down, and there is no test here to have written any. A
 *   built-in with nothing to check would either judge nothing at all or judge a
 *   real conversation against expectations somebody set for a different one.
 *
 * So the scope setting is the *whole* of the decision on this side, which is why
 * `production` and `both` are the only two words that reach here — a grader
 * scoped to simulations is not a grader that failed on this conversation, it was
 * never about it, and there is no verdict row for it at all.
 *
 * **Then sampling, per grader, deterministically.** Each applicable grader is
 * asked whether this trace is its turn; the accumulator behind that answer lives
 * in the data-access module because it is state and this file is not the place
 * for state. A grader that says no produces **nothing** — not a `skipped` row,
 * which would mean "this check did not apply to this conversation" and would
 * drag every un-judged call into the record as evidence of something. A call
 * nobody chose to judge leaves no trace of having been considered.
 *
 * **Scope and rate are read live, so both take effect forward only.** They are
 * settings on the grader row rather than on its versions, so pointing a grader
 * at production judges the next trace and says nothing about the ones before it:
 * no back-fill, and no deleting the verdicts a wider scope had already produced.
 * The rate moves the same way — raising it speeds the next decision up, lowering
 * it slows the next one down, and neither reaches backwards.
 */
export async function applicableProductionGraders(
  auth: AuthContext,
): Promise<readonly Grader[]> {
  const scoped = [...(await everyGraderInTheProject(auth))]
    .filter(
      (grader) => grader.scope === "production" || grader.scope === "both",
    )
    .sort(byId);

  const theirTurn: Grader[] = [];
  // One at a time and in the settled order, so that a deployment reading its own
  // logs sees the same sequence of decisions a second run over the same traffic
  // would make.
  for (const grader of scoped) {
    if (await advanceProductionSampling(auth, grader.id)) {
      theirTurn.push(grader);
    }
  }

  return theirTurn;
}

/**
 * By id, which is the mint order: an arbitrary order, but the same one every
 * time, so two gradings of one conversation walk the same list.
 */
function inAStableOrder(graders: Iterable<Grader>): readonly Grader[] {
  return [...graders].sort(byId);
}

function byId(left: Grader, right: Grader): number {
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
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
