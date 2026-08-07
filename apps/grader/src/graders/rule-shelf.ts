/**
 * What the two rule shelves share, and it is an argument rather than a lot of
 * code.
 *
 * `tool_calls` and `phrase_match` are the deterministic types, and they are one
 * shape twice: a list of things that had to happen and a list of things that
 * must never have, checked against what the simulation actually recorded, with
 * no model asked anything. Written here once so that each type states its own
 * half of it — which tools, which phrases — rather than the whole reasoning
 * twice, where two copies could come to disagree.
 *
 * ## One grader, one dimension
 *
 * A shelf names one dimension — its own type — however many rules it holds, and
 * the rationale names every rule that was broken.
 *
 * **Because a dimension name may derive nothing from the config.** The fold
 * counts one dimension once, keyed by the conversation, the grader and the name,
 * and prefers the latest grading of it. A per-rule dimension could only be named
 * out of the config — by the rule's own words, which an edit changes, or by its
 * position, which a reorder changes — so a grader edited from three rules to two
 * would leave the third rule's row behind, speaking forever about a rule nobody
 * is checking any more, with no later grading able to supersede it. The built-in
 * behaviors grader escapes that by filing under the frozen test version a
 * conversation was executed against, which never changes for that conversation;
 * an authored grader has no such pin, because editing it is exactly what it is
 * for.
 *
 * **And because a shelf is one policy.** "These tools must fire, and this one
 * must never" is one thing a team decided; so is "say the disclosure, never
 * promise a refund". Two thirds of a compliance rule is not a pass, and a score
 * of 0.67 would say it was. So the verdict is one word about the whole shelf,
 * and the granularity a developer needs lives where they will actually read it:
 * in the rationale, which names the rules that were broken and nothing else.
 */

/**
 * What a shelf that held says about itself: its rules by name, joined into a
 * sentence.
 *
 * It names them rather than saying "all checks passed", because a verdict
 * somebody reads a week later has to say what was actually checked — a bare
 * "passed" is a row nobody can audit against the config it came from.
 *
 * **A shelf naming nothing says so out loud.** The write door refuses one,
 * because a shelf that names nothing can never fail; a row hand-edited past it
 * would otherwise pass with an empty sentence. `holds` is what this shelf calls
 * the things on it — "tools", "phrases" — so the refusal reads as its own type's.
 */
export function heldRationale(said: readonly string[], holds: string): string {
  if (said.length === 0) {
    return `this grader names no ${holds}, so nothing was checked.`;
  }
  return `${said.join(", and ")}.`;
}
