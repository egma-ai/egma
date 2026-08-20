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
 * Nothing here moves, so there is no reduced-motion form to write: a stage is
 * either done or it is not, and the tick says which without animating in.
 */
export function AgentOnboardingProgress({
  current,
}: {
  readonly current: AgentOnboardingStage;
}) {
  const currentIndex = STAGES.findIndex((stage) => stage.id === current);

  return (
    <nav className="mb-6 border-b border-border pb-4" aria-label="Agent setup">
      {/*
        `m-0 p-0 list-none` is doing work rather than repeating a reset:
        `globals.css` hands the browser's own list defaults back in
        `@layer base`, so a list that asks for nothing arrives with markers and
        an indent.
      */}
      <ol className="m-0 flex list-none flex-wrap gap-4 p-0 max-[36rem]:gap-3">
        {STAGES.map((stage, index) => {
          const complete = index < currentIndex;
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
