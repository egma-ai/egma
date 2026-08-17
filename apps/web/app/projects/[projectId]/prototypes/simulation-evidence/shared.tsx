"use client";

import { graderDisplayName } from "../../../../../lib/presentation.ts";
import type { VerdictWord } from "../../../../../lib/runs.ts";
import {
  citedTurnPositions,
  judgedAssertions,
  type EvidenceStep,
  type SimulationEvidence,
} from "../../../../../lib/simulations.ts";
import { VerdictBadge } from "../../../../../ui/run-status.tsx";
import {
  SimulationEvidenceSummary,
  useSimulationEvidenceRecording,
  type SimulationEvidenceRecording,
} from "../../../../../ui/simulation-evidence-review.tsx";
import styles from "./prototype.module.css";

export type PrototypeRecording = SimulationEvidenceRecording;
export const usePrototypeRecording = useSimulationEvidenceRecording;

export type VariantProps = {
  readonly evidence: SimulationEvidence;
  readonly recording: PrototypeRecording;
};

export type Criterion = {
  readonly key: string;
  readonly expected: string;
  readonly verdict: VerdictWord | null;
  readonly rationale: string | null;
  readonly grader: string;
  readonly citedTurns: readonly number[];
};

function sameWords(left: string, right: string): boolean {
  return left.trim().toLocaleLowerCase() === right.trim().toLocaleLowerCase();
}

function expectedFor(
  assertion: string,
  assertionText: string | null,
  expected: readonly string[],
): string {
  if (assertionText !== null && assertionText.trim() !== "") return assertionText;
  const position = /^behavior_(\d+)$/u.exec(assertion)?.[1];
  if (position !== undefined) {
    const found = expected[Number(position) - 1];
    if (found !== undefined) return found;
  }
  return assertion.replaceAll("_", " ");
}

/** The readable checks, including expected behaviors that have no verdict yet. */
export function criteriaOf(evidence: SimulationEvidence): readonly Criterion[] {
  const expected = evidence.test.expected_behaviors ?? [];
  const turns = evidence.transcript?.turns ?? [];
  const planNames = new Map(
    (evidence.grading_plan?.items ?? []).map((item) => [
      item.grader_id,
      graderDisplayName(item.name),
    ]),
  );
  const judged = judgedAssertions(evidence.verdicts).map((row, at) => ({
    key: row.key,
    expected: expectedFor(row.assertion, row.assertionText, expected),
    verdict: row.speaking.verdict,
    rationale: row.speaking.rationale,
    grader: planNames.get(row.graderId) ?? `Grader ${String(at + 1)}`,
    citedTurns: citedTurnPositions(row.speaking.cited_turns, turns),
  }));

  const withoutVerdict = expected
    .filter((behavior) => !judged.some((row) => sameWords(row.expected, behavior)))
    .map((behavior, at) => ({
      key: `expected:${String(at)}`,
      expected: behavior,
      verdict: null,
      rationale: null,
      grader: "Expected behaviors",
      citedTurns: [] as readonly number[],
    }));

  return [...judged, ...withoutVerdict];
}

export function SummaryStrip({
  evidence,
}: {
  readonly evidence: SimulationEvidence;
}) {
  return <SimulationEvidenceSummary evidence={evidence} />;
}

export function Scenario({
  evidence,
}: {
  readonly evidence: SimulationEvidence;
}) {
  if (evidence.test.scenario === null) return null;
  return (
    <div className={styles.scenario}>
      <span>Scenario</span>
      <p>{evidence.test.scenario}</p>
    </div>
  );
}

export function speakerOf(turn: EvidenceStep): "Human" | "Agent" {
  return turn.kind === "turn:human" ? "Human" : "Agent";
}

export function TranscriptRows({
  evidence,
  highlighted = [],
  idPrefix,
}: {
  readonly evidence: SimulationEvidence;
  readonly highlighted?: readonly number[];
  readonly idPrefix: string;
}) {
  const marked = new Set(highlighted);
  const turns = evidence.transcript?.turns ?? [];
  if (turns.length === 0) {
    return <p className={styles.quiet}>No transcript was recorded.</p>;
  }
  return (
    <div className={styles.transcript}>
      {turns.map((turn, at) => (
        <article
          className={`${styles.turn} ${marked.has(at + 1) ? styles.turnMarked : ""}`}
          id={`${idPrefix}-turn-${String(at + 1)}`}
          key={turn.span_id}
        >
          <span className={styles.speaker}>{speakerOf(turn)}</span>
          <p>{turn.text === "" ? <em>Nothing was said.</em> : turn.text}</p>
          {marked.has(at + 1) ? (
            <span className={styles.evidenceMark}>Used by this finding</span>
          ) : null}
        </article>
      ))}
    </div>
  );
}

export function Recording({
  recording,
  describeChannels = true,
}: {
  readonly recording: PrototypeRecording;
  readonly describeChannels?: boolean;
}) {
  if (recording.status === "absent") {
    return <p className={styles.quiet}>No audio was recorded.</p>;
  }
  if (recording.status === "loading") {
    return <p className={styles.quiet}>Opening the recording…</p>;
  }
  if (recording.status === "failed" || recording.url === null) {
    return (
      <p className={styles.problem}>
        {recording.message ?? "The recording could not be opened."}
      </p>
    );
  }
  return (
    <div className={styles.recording}>
      <audio
        ref={recording.audioRef}
        aria-label="Call recording"
        controls
        preload="metadata"
        src={recording.url}
        onError={recording.onError}
        onLoadedMetadata={recording.onLoadedMetadata}
        onPause={recording.onPause}
        onPlay={recording.onPlay}
        onTimeUpdate={recording.onTimeUpdate}
      >
        Your browser cannot play this recording.
      </audio>
      {describeChannels ? (
        <p>Real call audio. Human is the left channel. Agent is the right channel.</p>
      ) : null}
    </div>
  );
}

export function CriterionResult({
  criterion,
}: {
  readonly criterion: Criterion;
}) {
  return <VerdictBadge verdict={criterion.verdict} />;
}
