import type { Simulation, VerdictSource } from "@egma/db";

/**
 * The conversation, as a grader reads it.
 *
 * **One shape for both sources**, which is the whole reason it exists as a type
 * rather than as "the simulation row". A grader judges a simulation and a
 * production trace with the same logic, and the difference between them is where
 * this was read from — the simulation's header row today, spans when production
 * grading arrives — rather than what a grader is looking at. Anything a grader
 * has to know about *where* it came from would be a second grading path growing
 * quietly inside the first.
 *
 * The v1 read path is the settled one: a finished simulation already carries its
 * transcript, its events and its measures on its own row, so grading needs no
 * second store and no join. The three are `unknown` because they are stored
 * jsonb and nothing has yet fixed their shape at the write door — each grader
 * reads what it needs and says honestly when what it needs is not there.
 */
export type Conversation = {
  /** Which kind of conversation this is, in the verdict row's own vocabulary. */
  readonly source: VerdictSource;
  /**
   * The conversation this judgment is filed under.
   *
   * A verdict's `trace_id` is the conversation, and for a simulation that is the
   * simulation's own id: it is what every other row about this conversation is
   * reachable from, and it is the same string in Postgres, in a URL and in a
   * log. When simulator reports converge on the OTLP door, a simulation's spans
   * arrive under an id from the wire and this becomes the place that changes —
   * one line, in one file, with the verdicts already filed under a conversation
   * rather than under a run.
   */
  readonly traceId: string;
  /**
   * **Whether there is a conversation here at all.**
   *
   * A simulation the simulator reported `failed` never produced one: the agent
   * never joined, the line was never answered, egma's own runtime broke. Every
   * grader's verdict on it is `errored`, never `failed`, and this is the flag
   * that says so — a broken test is never a broken agent, and that line is the
   * one normalisation a test product cannot get wrong.
   */
  readonly happened: boolean;
  /** Why it ended, in the simulator's own vocabulary, for the rationale. */
  readonly endingReason: string | null;
  readonly transcript: unknown;
  readonly events: unknown;
  /** What was measured. A metric measures; a grader judges. */
  readonly metrics: unknown;
  /** Where the verdict rows file the conversation, beside the conversation. */
  readonly runId: string;
  readonly agentId: string;
};

/**
 * A finished simulation, read as a conversation.
 *
 * `agent_version_id` is deliberately absent from what this produces and lands
 * empty on the verdict row: egma does not version agents yet, and an empty
 * string is the honest way to say "there was no version to record" — filling it
 * with the agent's own id would make a comparison of two versions answer with
 * nonsense the day versions arrive.
 */
export function conversationOf(simulation: Simulation): Conversation {
  return {
    source: "simulation",
    traceId: simulation.id,
    happened: simulation.status === "completed",
    endingReason: simulation.endingReason,
    transcript: simulation.transcript,
    events: simulation.events,
    metrics: simulation.metrics,
    runId: simulation.runId,
    agentId: simulation.agentId,
  };
}
