import styles from "./onboarding.module.css";

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
 */
export function AgentOnboardingProgress({
  current,
}: {
  readonly current: AgentOnboardingStage;
}) {
  const currentIndex = STAGES.findIndex((stage) => stage.id === current);

  return (
    <nav className={styles.progress} aria-label="Agent setup">
      <ol>
        {STAGES.map((stage, index) => {
          const complete = index < currentIndex;
          return (
            <li
              className={styles.stage}
              data-complete={complete ? "true" : undefined}
              aria-current={stage.id === current ? "step" : undefined}
              key={stage.id}
            >
              <span aria-hidden="true">{complete ? "✓" : ""}</span>
              {stage.label}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
