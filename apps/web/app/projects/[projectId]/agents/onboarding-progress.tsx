import { Progress } from "@/components/ui/progress";

export type AgentOnboardingStage = "agent" | "connection" | "tests";

const STAGES: readonly {
  readonly id: AgentOnboardingStage;
  readonly label: string;
}[] = [
  { id: "agent", label: "Agent details" },
  { id: "connection", label: "Connection" },
  { id: "tests", label: "Tests" },
];

/**
 * The one compact orientation aid shared by every page in agent onboarding.
 *
 * Each page still has one task and one title. This small list says where the
 * task sits without repeating numbered progress copy or putting three forms in
 * one large wizard card.
 *
 * **The bar is the kit's `Progress` rather than a shape drawn here**, which is
 * the whole of this file's part in the primitives migration. What it adds over
 * the stage list on its own is the measure: the list says which stage is being
 * worked on, and the bar says how much of the setup is behind it. `DESIGN.md`
 * asks a state for a word as well as a shape, so the two are shown together and
 * neither is asked to carry the meaning alone.
 *
 * **It counts stages finished, not stages behind**, so it reads 0 of 3 on the
 * first page and never reaches 3 — finishing the last stage leaves onboarding,
 * and a bar that filled completely on a page still asking for something would
 * be claiming the work was done.
 *
 * The reduced-motion form is the primitive's: `components/ui/progress.tsx`
 * carries `motion-reduce:transition-none`, so the bar is simply at its new
 * length and the stage words are what say it moved. Nothing else here moves.
 */
export function AgentOnboardingProgress({
  current,
  skipped = [],
}: {
  readonly current: AgentOnboardingStage;
  /**
   * Stages that were passed over rather than done.
   *
   * **Being behind the current stage is not the same as being finished**, and
   * onboarding has one place where the two part company: "Skip connection for
   * now" lands on the tests page with the connection stage behind it and
   * nothing attached. Deriving the count from the current stage alone counted
   * that skip as work done, so the bar said "2 of 3 stages finished" about an
   * agent that could not run a simulation.
   *
   * A caller that knows a stage was skipped says so, and the stage is then
   * drawn as skipped rather than silently promoted. `DESIGN.md` names skipped
   * as its own state, separate from complete, for exactly this reason.
   */
  readonly skipped?: readonly AgentOnboardingStage[];
}) {
  const currentIndex = STAGES.findIndex((stage) => stage.id === current);
  /*
   * Only what is genuinely done. A stage ahead of the current one is not
   * counted whether or not it was named as skipped, because nobody has reached
   * it yet and a skip is something a person did rather than a state to predict.
   */
  const finished = STAGES.filter(
    (stage, index) => index < currentIndex && !skipped.includes(stage.id),
  ).length;
  const passedOver = currentIndex - finished;

  return (
    <nav className="mb-6 border-b border-border pb-4" aria-label="Agent setup">
      <Progress
        className="mb-4"
        value={finished}
        max={STAGES.length}
        aria-label="Agent setup progress"
        /*
         * A percentage is the wrong unit for three named stages: "33%" is a
         * number nobody can act on, while "1 of 3 stages finished" is the same
         * fact said in the words the list beside it already uses. A skip is
         * added rather than folded in, so the sentence accounts for every stage
         * the reader can see behind them.
         */
        getValueLabel={(value, max) =>
          passedOver === 0
            ? `${String(value)} of ${String(max)} stages finished`
            : `${String(value)} of ${String(max)} stages finished, ${String(passedOver)} skipped`
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
          const behind = index < currentIndex;
          const passed = behind && skipped.includes(stage.id);
          const complete = behind && !passed;
          return (
            <li
              className={
                "inline-flex items-center gap-2 text-sm text-muted-foreground " +
                // The stage being worked on is the one that reads as text.
                // `aria-current` is what says so, so it is what styles it: the
                // attribute the screen reader announces and the weight the eye
                // reads cannot then disagree.
                "aria-[current=step]:font-medium aria-[current=step]:text-foreground " +
                // Too narrow for three stages on one line. Each takes an equal
                // share of the room rather than leaving a ragged right edge.
                "max-[36rem]:flex-auto"
              }
              data-complete={complete ? "true" : undefined}
              data-skipped={passed ? "true" : undefined}
              aria-current={stage.id === current ? "step" : undefined}
              key={stage.id}
            >
              {/*
                The mark keeps its 12px whether or not one is drawn, so the
                labels do not shift sideways as stages complete. A skip gets its
                own shape as well as its own colour — a tick that meant either
                "done" or "passed over" would be the colour carrying the
                difference on its own.
              */}
              <span
                className={passed ? "w-3 text-warning" : "w-3 text-success"}
                aria-hidden="true"
              >
                {complete ? "✓" : passed ? "–" : ""}
              </span>
              {stage.label}
              {/*
                And the word, because `DESIGN.md` will not let a state rest on a
                mark and a colour. It is inside the list item, so a screen
                reader reads the stage and its state together.
              */}
              {passed ? <span className="text-warning">Skipped</span> : null}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
