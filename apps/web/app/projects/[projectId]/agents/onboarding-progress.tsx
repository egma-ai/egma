import { Progress } from "@/components/ui/progress";

export type AgentOnboardingStage = "agent" | "connection";

const STAGES: readonly {
  readonly id: AgentOnboardingStage;
  readonly label: string;
}[] = [
  { id: "agent", label: "Agent details" },
  { id: "connection", label: "Connection" },
];

/**
 * The one compact orientation aid shared by every page in agent onboarding.
 *
 * Each page still has one task and one title. This small list says where the
 * task sits without repeating numbered progress copy or putting two forms in
 * one large wizard card.
 *
 * **The bar is the kit's `Progress` rather than a shape drawn here**, which is
 * the whole of this file's part in the primitives migration. What it adds over
 * the stage list on its own is the measure: the list says which stage is being
 * worked on, and the bar says how much of the setup is behind it. `DESIGN.md`
 * asks a state for a word as well as a shape, so the two are shown together and
 * neither is asked to carry the meaning alone.
 *
 * **It counts stages finished, not stages behind**, so it reads 0 of 2 on the
 * first page and never reaches 2 — finishing the last stage leaves onboarding,
 * and a bar that filled completely on a page still asking for something would
 * be claiming the work was done.
 */
export function AgentOnboardingProgress({
  current,
  unfinished = {},
}: {
  readonly current: AgentOnboardingStage;
  /**
   * Stages that are behind the reader and still not done, each with the short
   * state word to show beside it.
   *
   * **Being behind the current stage is not the same as being finished**, and
   * onboarding can grow another stage where the two part company.
   *
   * **The word comes from the caller, and that is the point of the shape.**
   * This component can see that a stage is not done; it cannot see *why*, and
   * a word invented here would be a guess. The first version of this guessed
   * "Skipped" — and a person who connected an agent and later archived that
   * connection reads exactly the same empty list as a person who pressed "Skip
   * connection for now". Calling both a skip told half of them they had done
   * something they had not. So the caller says the word, and it says a state
   * rather than an intention.
   */
  readonly unfinished?: Partial<Record<AgentOnboardingStage, string>>;
}) {
  const currentIndex = STAGES.findIndex((stage) => stage.id === current);
  /*
   * Only what is genuinely done. A stage ahead of the current one is not
   * counted whether or not the caller named it, because nobody has reached it
   * yet and a stage nobody has opened is not one they left undone.
   */
  const behind = STAGES.filter((stage, index) => index < currentIndex);
  const waiting = behind.filter((stage) => unfinished[stage.id] !== undefined);
  const finished = behind.length - waiting.length;

  return (
    <nav className="mb-6 border-b border-border pb-4" aria-label="Agent setup">
      <Progress
        className="mb-4"
        value={finished}
        max={STAGES.length}
        aria-label="Agent setup progress"
        /*
         * A percentage is the wrong unit for two named stages: "50%" is a
         * number nobody can act on, while "1 of 2 stages finished" is the same
         * fact said in the words the list beside it already uses.
         *
         * A stage left behind is named rather than folded into the count,
         * because "0 of 2 finished" with a stage behind you is the one
         * arithmetic a reader should not have to do. It is named as *not
         * finished*, which is all this component knows and all that is true on
         * every path into it.
         */
        getValueLabel={(value, max) =>
          waiting.length === 0
            ? `${String(value)} of ${String(max)} stages finished`
            : `${String(value)} of ${String(max)} stages finished, ${waiting
                .map((stage) => stage.label)
                .join(", ")} not finished`
        }
      />
      {/*
        `m-0 p-0 list-none` is doing work rather than repeating a reset:
        `globals.css` hands the browser's own list defaults back in
        `@layer base`, so a list that asks for nothing arrives with markers and
        an indent.
      */}
      <ol className="m-0 flex list-none flex-wrap gap-4 p-0 max-[36rem]:gap-3">
        {STAGES.map((stage, index) => {
          const passed = index < currentIndex;
          const waitingWord = passed ? unfinished[stage.id] : undefined;
          const complete = passed && waitingWord === undefined;
          return (
            <li
              className={
                "inline-flex items-center gap-2 text-sm text-muted-foreground " +
                // The stage being worked on is the one that reads as text.
                // `aria-current` is what says so, so it is what styles it: the
                // attribute the screen reader announces and the weight the eye
                // reads cannot then disagree.
                "aria-[current=step]:font-medium aria-[current=step]:text-foreground " +
                // Too narrow for two stages on one line. Each takes an equal
                // share of the room rather than leaving a ragged right edge.
                "max-[36rem]:flex-auto"
              }
              data-complete={complete ? "true" : undefined}
              data-unfinished={waitingWord === undefined ? undefined : "true"}
              aria-current={stage.id === current ? "step" : undefined}
              key={stage.id}
            >
              {/*
                The mark keeps its 12px whether or not one is drawn, so the
                labels do not shift sideways as stages complete. A stage left
                behind gets its own shape as well as its own colour — a tick
                that meant either "done" or "not done" would be the colour
                carrying the difference on its own.
              */}
              <span
                className={
                  waitingWord === undefined
                    ? "w-3 text-success"
                    : "w-3 text-warning"
                }
                aria-hidden="true"
              >
                {complete ? "✓" : waitingWord === undefined ? "" : "–"}
              </span>
              {stage.label}
              {/*
                And the word, because `DESIGN.md` will not let a state rest on a
                mark and a colour. It is inside the list item, so a screen
                reader reads the stage and its state together.
              */}
              {waitingWord === undefined ? null : (
                <span className="text-warning">{waitingWord}</span>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
