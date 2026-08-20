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
 * **It counts stages finished, not the stage being worked on**, so it reads 0
 * of 3 on the first page and 2 of 3 on the last. It never reaches 3, because
 * finishing the last stage leaves onboarding — a bar that filled completely on
 * a page still asking for something would be claiming the work was done.
 *
 * The reduced-motion form is the primitive's: `components/ui/progress.tsx`
 * carries `motion-reduce:transition-none`, so the bar is simply at its new
 * length and the stage words are what say it moved. Nothing else here moves.
 */
export function AgentOnboardingProgress({
  current,
}: {
  readonly current: AgentOnboardingStage;
}) {
  /*
   * Clamped, because `Progress` is given this number. `current` is typed to one
   * of the three stages so the miss cannot happen through the types, but a -1
   * reaching Radix is a console error and a bar drawn at an impossible length,
   * and the floor costs one call.
   */
  const finished = Math.max(0, STAGES.findIndex((stage) => stage.id === current));

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
         * fact said in the words the list beside it already uses.
         */
        getValueLabel={(value, max) =>
          `${String(value)} of ${String(max)} stages finished`
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
          const complete = index < finished;
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
              aria-current={stage.id === current ? "step" : undefined}
              key={stage.id}
            >
              {/*
                The tick keeps its 12px whether or not one is drawn, so the
                labels do not shift sideways as stages complete.
              */}
              <span className="w-3 text-success" aria-hidden="true">
                {complete ? "✓" : ""}
              </span>
              {stage.label}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
