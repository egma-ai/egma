import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

import { GRADING } from "../lib/grading-copy.ts";
import { DETAIL } from "../lib/transcript-copy.ts";
import { assertionHeading, type Judgment } from "../lib/transcripts.ts";

/**
 * Which of the chip's three meanings a verdict word carries.
 *
 * **Four words arrive and three chips draw them**, which is the reading this
 * card has always had: passed is green, failed and errored are red, and
 * anything else — skipped, pending, a word a newer grader invents — is the
 * neutral chip rather than a colour guessed for it. A verdict is a word first
 * and a colour second, so an unrecognised one still reads.
 */
function toneOf(verdict: string): "success" | "failure" | "neutral" {
  if (verdict === "passed") return "success";
  return verdict === "failed" || verdict === "errored" ? "failure" : "neutral";
}

/**
 * The lane's edge: the one line down the side of the card that says at a glance
 * how this judgment came out. Neutral by default, so a word nobody has a colour
 * for is not painted one.
 */
const EDGE: Readonly<Record<string, string>> = {
  success: "border-s-success",
  failure: "border-s-failure",
  neutral: "border-s-foreground",
};

/**
 * One judged assertion, as a person reads it.
 *
 * **The heading is the sentence somebody wrote**, resolved by the read from the
 * version this conversation was executed against — not the key the row is filed
 * under. A verdict row keeps a key because the fold counts one assertion once
 * and a key derived from content would make an edited sentence a second
 * assertion; the words are fetched back at display time, which is here. Where
 * nothing could place a key the key is shown as itself, because a plausible
 * wrong sentence is worse than a terse right one.
 *
 * **A diagnostic says so.** A copy carrying `required: false` reports and never
 * decides, so its judgment is marked rather than left to read as a failure that
 * somehow did not count. Nothing is marked on the ordinary case: a blocking
 * grader is what a grader is.
 *
 * **The verdict is a word, a shape and a colour, in that order.** The chip is
 * the product's own — `DESIGN.md` puts every chip at the tag radius and gives
 * the three state edges one recipe — and the small dot inside it is what keeps
 * the state off colour alone, which a red-green reader needs and which the
 * hand-drawn chip this replaced did not have.
 */
export function JudgmentCard({
  judgment,
  placement = "inline",
}: {
  judgment: Judgment;
  placement?: "inline" | "result";
}) {
  const cited =
    placement === "inline" || judgment.cited_turns.length === 0
      ? ""
      : judgment.cited_turns.join(", ");
  const diagnostic = judgment.required === false;
  const tone = toneOf(judgment.verdict);

  return (
    <article
      className={cn(
        "min-w-0 rounded-input border border-border border-s-[3px] bg-surface-soft",
        EDGE[tone],
        /*
         * Inline, the card is indented to the words it judges: it lines up
         * under what was said rather than under the turn's timing rail, so the
         * sentence and the judgement of it read as one column. A narrow screen
         * has no room to spend on that, so the indent goes.
         */
        placement === "inline"
          ? "mt-0 mr-4 mb-4 ml-24 px-4 py-3 max-[620px]:mx-0"
          : "p-4",
        "[&>p]:my-2 [&>p]:[overflow-wrap:anywhere] [&>p]:text-sm",
        "[&>small]:text-sm [&>small]:text-muted-foreground",
        "[&>small]:[overflow-wrap:anywhere]",
      )}
      data-verdict={judgment.verdict}
      data-lane={diagnostic ? "diagnostic" : undefined}
    >
      <div className="flex min-w-0 items-center gap-2">
        <Badge variant={tone}>
          <span
            aria-hidden="true"
            className="size-1.5 shrink-0 rounded-chip bg-current"
          />
          {judgment.verdict}
        </Badge>
        <strong className="min-w-0 text-sm font-normal [overflow-wrap:anywhere]">
          {assertionHeading(judgment)}
        </strong>
        {/*
          The lane, where a judgment is in the one that only reports.
          Deliberately quiet and never coloured by the verdict: a diagnostic's
          failure is information rather than a problem, and painting it red
          would say the opposite of what the flag means. The dashed edge is
          what tells it from a verdict chip without a second colour.
        */}
        {diagnostic ? (
          <Badge
            className="ms-auto border-dashed"
            title={GRADING.diagnosticMeans}
          >
            {GRADING.diagnostic}
          </Badge>
        ) : null}
      </div>
      <p>{judgment.rationale}</p>
      {cited === "" ? null : (
        <small>
          {DETAIL.citedTurns} <span className="font-mono">{cited}</span>
        </small>
      )}
    </article>
  );
}
