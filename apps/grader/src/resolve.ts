import {
  advanceProductionSampling,
  listGraders,
  type AuthContext,
  type Grader,
} from "@egma/db";

/**
 * Which graders judge this simulation.
 *
 * **One source, and it is the project's running copies.** Every active copy
 * whose scope covers simulations judges every simulation in the project. There
 * is no second list to add to it and no test content to consult: a test names no
 * graders, and the junction that let one is gone.
 *
 * That is the product's promise said once instead of twice. Pressing **Use** on
 * a library entry makes a check that judges everything inside its scope, so
 * writing a policy check once makes it judge everything without touching a
 * single test — and nobody has to remember to attach it to the next test
 * somebody writes.
 *
 * **The scope is the whole of the decision.** A copy scoped to production alone
 * is not a grader that failed to run here; it was never about this conversation,
 * and there is no verdict row for it at all — not a `skipped` one, which would
 * mean the check applied and could not be made. Scenario-specific grading
 * returns as filters on the copy, decided grader-side, when custom authoring
 * arrives.
 *
 * **A deleted copy judges nothing from now on.** Deleting it is exactly how a
 * project stops being judged by it; its versions stay, so the verdicts it
 * already wrote remain interpretable, and it simply stops appearing here.
 *
 * **The expected-behaviors grader is resolved here like everything else.** It
 * used to be absent — never a row, never attachable, applied because running a
 * test meant judging it against what the test says. Every project is seeded with
 * an active copy of the library entry now, so it arrives in this list, and
 * deleting that copy is how a project stops being judged against its own
 * expectations. It is simulations-only because its scope says so rather than
 * because a branch somewhere leaves it out.
 *
 * **`required` is not consulted here, deliberately.** A diagnostic copy is
 * judged exactly like a blocking one and writes exactly the same rows — that is
 * what makes its fraction worth reading. Whether it can fail anything is decided
 * by the fold, at read time, from the flag as it stands: a check quietly not run
 * because somebody made it a diagnostic would be a diagnostic that diagnoses
 * nothing.
 *
 * **Sampling never happens here.** A simulation is a conversation somebody asked
 * for, one at a time, and judging nine of ten of them would mean a suite whose
 * report is missing a test for no reason anybody chose. Sampling is about
 * traffic egma did not cause, and it lives on the production path alone.
 */
export async function applicableGraders(
  auth: AuthContext,
): Promise<readonly Grader[]> {
  return [...(await everyGraderInTheProject(auth))]
    .filter((grader) => grader.scope === "simulations" || grader.scope === "both")
    .sort(byId);
}

/**
 * Which graders judge this production trace, and whose turn it is.
 *
 * **The project's copies scoped to production, and nothing else at all.** The
 * simulation side reads the same one list through the same one filter, so the
 * two paths differ by a word rather than by a shape — which is what stops
 * "where does this grader apply" from being answered twice.
 *
 * Two absences remain worth saying out loud here, and both are the same fact: a
 * production trace has no test.
 *
 * - **No `expected_behaviors`.** Its copy is scoped to simulations, which is the
 *   setting saying this: it judges a test against the behaviors that test wrote
 *   down, and there is no test here to have written any. A copy of it pointed at
 *   production by hand would find no simulation and answer nothing, which is the
 *   honest reply, but the scope is where the decision belongs.
 * - **Nothing arrives from a scenario.** A real caller phoning a real agent is
 *   in nobody's scenario, and there is no test content anywhere in this
 *   resolution to have said otherwise.
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
