/**
 * What a finished run leaves behind in the developer's repository.
 *
 * ```
 * egma/runs/<run-id>/
 *   run.json         the platform's whole account of the run
 *   results.jsonl    one line per simulation, for grep and for jq
 *   summary.md       the same facts as something a person reads in a diff
 * ```
 *
 * The tests are files so that a test can be reviewed in a pull request. A
 * result that lived only on a web page would break that halfway: the change
 * would be reviewable and the evidence it works would not be. So the run is
 * written down beside the tests it ran, committed like everything else in the
 * folder, and a reviewer reads what the graders decided without leaving the
 * diff.
 *
 * **The platform's account is copied, not summarised.** `run.json` is the
 * document the platform answered with, whole — every judgment, its rationale,
 * the grader that made it, and the mocked world the run was frozen into. egma
 * writes two more views of it for convenience, and neither is the record: a
 * summary that disagreed with the document would be egma's opinion filed as
 * evidence.
 *
 * **A run folder is named for the run and never written twice.** Run
 * identifiers sort by the moment they were minted, so the directory listing is
 * the run history in order, and a re-read of the same run overwrites its own
 * folder rather than growing a second one.
 *
 * Nothing here throws at the caller. A run that finished is a run that
 * finished, whatever a file system did afterwards, and a verb that turned a
 * failed write into a failed run would be reporting the wrong event.
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  FOLDER_NAME,
  RUNS_FOLDER_NAME,
  type FolderPaths,
} from "../folder/egma-folder.ts";
import { text } from "../platform/wire.ts";

export const RUN_DOCUMENT_FILE_NAME = "run.json";
export const RESULTS_FILE_NAME = "results.jsonl";
export const SUMMARY_FILE_NAME = "summary.md";

/** What was written, and where, as a report says it. */
export type WrittenArtifacts = {
  /** Absolute. */
  readonly directory: string;
  /** As `egma/runs/…` reads in a report, so output is the same everywhere. */
  readonly shown: readonly string[];
};

/* ------------------------------------------------------------------ *
 * Reading the document, defensively.
 *
 * Every one of these takes `unknown` and answers with something. The document
 * came off a wire, an older platform may not send a field this build knows,
 * and a newer one may send a field it does not — neither is a reason to write
 * no file at all.
 * ------------------------------------------------------------------ */

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function records(value: unknown): readonly Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter(
        (entry): entry is Record<string, unknown> =>
          typeof entry === "object" && entry !== null && !Array.isArray(entry),
      )
    : [];
}

/** A number off the wire, or `null` for anything that is not one. */
function count(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** What a missing value reads as in a table, so a column never sits empty. */
const NOTHING = "—";

function said(value: unknown): string {
  const written = text(value);
  return written === "" ? NOTHING : written;
}

/** A number as a cell, at the precision the platform sent it. */
function shownCount(value: unknown): string {
  const held = count(value);
  return held === null ? NOTHING : String(held);
}

/**
 * Text going inside a table cell.
 *
 * A pipe would open a column the row does not have, and a line break would end
 * the row early. Both come out of the developer's own material — a test named
 * with a pipe is a perfectly ordinary test — so they are handled here rather
 * than hoped about.
 */
function cell(value: unknown): string {
  return said(value).replaceAll("|", "\\|").replaceAll(/\s*\n\s*/gu, " ");
}

/**
 * A grader's rationale as a block quote.
 *
 * Quoted rather than printed plain because it is somebody else's sentence, and
 * every line of it is quoted because markdown ends a quote at the first line
 * that is not.
 */
function quoted(value: unknown): readonly string[] {
  const written = said(value);
  return written.split("\n").map((line) => `> ${line.trim()}`);
}

/* ------------------------------------------------------------------ *
 * The three files.
 * ------------------------------------------------------------------ */

/** One simulation as a line: the judgment folded, and the judgments whole. */
function resultLine(
  document: Record<string, unknown>,
  simulation: Record<string, unknown>,
): string {
  return JSON.stringify({
    run_id: text(document.id),
    label: text(document.label),
    simulation_id: text(simulation.id),
    position: count(simulation.position),
    test_name: text(simulation.test_name),
    test_id: text(simulation.test_id),
    test_version_id: text(simulation.test_version_id),
    persona_name: text(simulation.persona_name),
    status: text(simulation.status),
    grading: text(simulation.grading),
    verdict: simulation.verdict ?? null,
    score: count(simulation.score),
    counts: simulation.counts ?? null,
    reason: simulation.reason ?? null,
    mock_tool_coverage: simulation.mock_tool_coverage ?? null,
    verdicts: simulation.verdicts ?? [],
  });
}

function resultsDocument(document: Record<string, unknown>): string {
  const lines = records(document.simulations).map((one) => resultLine(document, one));
  return lines.length === 0 ? "" : `${lines.join("\n")}\n`;
}

/** The header: what ran, against what, and how it came out. */
function summaryHeader(document: Record<string, unknown>): readonly string[] {
  const counts = record(document.counts);
  const label = text(document.label);
  return [
    `# Run ${said(document.id)}`,
    "",
    ...(label === "" ? [] : [`- Suite: ${cell(label)}`]),
    `- Status: ${said(document.status)}`,
    `- Verdict: ${said(document.verdict)}`,
    `- Agent: ${said(document.agent_id)}`,
    `- Connection: ${said(document.connection_id)} (${said(document.connection_type)}, ${said(document.modality)})`,
    `- Started: ${said(document.created_at)}`,
    `- Finished: ${said(document.finished_at)}`,
    `- Results: ${said(document.results_url)}`,
    "",
    [
      `${shownCount(counts.passed)} passed`,
      `${shownCount(counts.failed)} failed`,
      `${shownCount(counts.skipped)} skipped`,
      `${shownCount(counts.errored)} errored`,
    ].join(" · "),
    "",
  ];
}

/** One row per simulation: the fold, and nothing a reader has to unfold. */
function summaryResults(document: Record<string, unknown>): readonly string[] {
  const simulations = records(document.simulations);
  if (simulations.length === 0) return ["## Results", "", "This run conducted nothing.", ""];

  return [
    "## Results",
    "",
    "| # | Test | Persona | Status | Verdict | Score |",
    "| --- | --- | --- | --- | --- | --- |",
    ...simulations.map((one) =>
      [
        "",
        cell(one.position),
        cell(one.test_name),
        cell(one.persona_name),
        cell(one.status),
        // A conversation nobody has judged yet says so, rather than reading
        // as one judged and found wanting.
        text(one.grading) === "graded" ? cell(one.verdict) : "not judged yet",
        shownCount(one.score),
        "",
      ].join(" | ").trim(),
    ),
    "",
  ];
}

/**
 * The same run counted per grader.
 *
 * Two graders disagreeing about one suite is the thing this table exists to
 * show: a run that is green overall and red on one dimension is a run somebody
 * needs to look at, and a single folded verdict would hide it.
 */
function summaryGraders(document: Record<string, unknown>): readonly string[] {
  const graders = records(document.by_grader);
  if (graders.length === 0) return [];

  return [
    "## By grader",
    "",
    "| Grader | Verdict | Score | Passed | Failed | Skipped | Errored |",
    "| --- | --- | --- | --- | --- | --- | --- |",
    ...graders.map((one) => {
      const counts = record(one.counts);
      return [
        "",
        cell(one.grader_id),
        cell(one.verdict),
        shownCount(one.score),
        shownCount(counts.passed),
        shownCount(counts.failed),
        shownCount(counts.skipped),
        shownCount(counts.errored),
        "",
      ].join(" | ").trim();
    }),
    "",
  ];
}

/** Every judgment, whole: what was judged, how it came out, and why. */
function summaryJudgments(document: Record<string, unknown>): readonly string[] {
  const judged = records(document.simulations).filter(
    (one) => records(one.verdicts).length > 0,
  );
  if (judged.length === 0) return [];

  const lines: string[] = ["## Judgments", ""];
  for (const simulation of judged) {
    lines.push(
      `### ${said(simulation.test_name)} — ${said(simulation.persona_name)} — ${said(simulation.verdict)}`,
      "",
    );
    const reason = text(simulation.reason);
    if (reason !== "") lines.push(`Ended: ${reason}`, "");

    for (const judgment of records(simulation.verdicts)) {
      const cited = Array.isArray(judgment.cited_turns)
        ? judgment.cited_turns.map((one) => text(one)).filter((one) => one !== "")
        : [];
      lines.push(
        `**${said(judgment.dimension)}** — ${said(judgment.verdict)} · score ${shownCount(judgment.score)} · priority ${said(judgment.priority)}`,
        "",
        ...quoted(judgment.rationale),
        "",
        `Judged by ${said(judgment.grader_id)} (${said(judgment.judged_by)}) at ${said(judgment.judged_at)}${
          cited.length === 0 ? "" : ` · cites ${cited.join(", ")}`
        }`,
        "",
      );
    }
  }
  return lines;
}

export function summaryDocument(document: Record<string, unknown>): string {
  return [
    ...summaryHeader(document),
    ...summaryResults(document),
    ...summaryGraders(document),
    ...summaryJudgments(document),
    "---",
    "",
    "Written by `egma run`. `run.json` beside this file is the platform's own",
    "account of this run, and is what to read when the two ever disagree.",
    "",
  ].join("\n");
}

/* ------------------------------------------------------------------ *
 * Writing them.
 * ------------------------------------------------------------------ */

/**
 * Whether this run is still moving.
 *
 * Execution and grading settle separately, and a run whose last conversation
 * has ended can still have a grader writing about it. Waiting on the
 * simulation rows rather than on the run's own counters is deliberate: those
 * counters stay null until the whole run settles, so a reader that watched
 * them would see no progress and then all of it.
 */
export function stillMoving(document: Record<string, unknown>): boolean {
  const simulations = records(document.simulations);
  const expected = count(document.expected_simulation_count) ?? simulations.length;
  const terminal = ["completed", "failed", "canceled"];
  const gradable = ["completed", "failed"];

  const finished = simulations.filter((one) => terminal.includes(text(one.status))).length;
  if (finished < expected) return true;

  // A platform that does not say how far grading has got is a platform with
  // nothing here to wait for. Waiting anyway would mean every run pausing for
  // the whole budget before writing files it already had.
  const graded = count(document.graded_count);
  if (graded === null) return false;

  const judgeable = simulations.filter((one) => gradable.includes(text(one.status))).length;
  return graded < judgeable;
}

/**
 * Write the run down, and say what was written.
 *
 * The directory is made here rather than by `egma init`, because a repository
 * that has never run anything has nothing to put in it.
 */
export async function writeRunArtifacts(options: {
  readonly paths: FolderPaths;
  readonly document: Record<string, unknown>;
}): Promise<WrittenArtifacts> {
  const runId = text(options.document.id);
  // A run with no identifier is not something to file under a made-up name.
  const folder = runId === "" ? "unnamed-run" : runId;
  const directory = path.join(options.paths.runs, folder);
  await mkdir(directory, { recursive: true });

  const written: [string, string][] = [
    [RUN_DOCUMENT_FILE_NAME, `${JSON.stringify(options.document, null, 2)}\n`],
    [RESULTS_FILE_NAME, resultsDocument(options.document)],
    [SUMMARY_FILE_NAME, summaryDocument(options.document)],
  ];
  for (const [name, content] of written) {
    await writeFile(path.join(directory, name), content, "utf8");
  }

  return {
    directory,
    shown: written.map(
      ([name]) => `${FOLDER_NAME}/${RUNS_FOLDER_NAME}/${folder}/${name}`,
    ),
  };
}
