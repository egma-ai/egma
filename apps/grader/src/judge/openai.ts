import {
  DECISIONS,
  type Decision,
  type Judge,
  type JudgeAnswer,
  type JudgeQuestion,
  type ResolvedJudge,
} from "./contract.ts";
import { asJudgeReads } from "./input.ts";

/**
 * The OpenAI judge: one criterion, one chat completion, one answer.
 *
 * The only provider v1 ships, and it is deliberately the smallest surface that
 * can ask a model a question — one POST, one JSON body, one JSON answer. There
 * is no SDK behind it: the whole request is four fields, an SDK would be a
 * dependency that moves under the product, and the day a second provider
 * arrives it is a second file of this size rather than a second dependency.
 *
 * **Version-pinned in the URL.** `/v1/chat/completions` is the endpoint every
 * OpenAI-compatible provider implements, which is what makes the next provider
 * a base URL rather than a rewrite.
 */

const OPENAI_CHAT_COMPLETIONS = "https://api.openai.com/v1/chat/completions";

/**
 * How many times a call is made before the assertion is `errored`.
 *
 * Three, for the reason the grading job's own attempt count is three: the
 * failures worth retrying are the transient ones — a rate limit, a gateway that
 * dropped the connection — and a fourth attempt at a request the provider keeps
 * refusing is spending the customer's money to learn the same thing again.
 */
const MOST_ATTEMPTS = 3;

/** How long a judge is given to answer before the attempt is abandoned. */
const DEADLINE_MILLISECONDS = 60_000;

/** The wait before a retry, doubling. Short: a grading job holds a lease. */
const FIRST_BACKOFF_MILLISECONDS = 500;

/**
 * What the judge is told it is. Deliberately spare: the criterion and the
 * evidence carry the judgment, and a system prompt full of encouragement is a
 * prompt that moves the answer without anybody being able to say how.
 *
 * Two instructions earn their place. **Decide only the one criterion** — the
 * fan-out's isolation is worth nothing if the model helpfully judges the whole
 * conversation. And **`cannot_determine` is available** — a judge that believes
 * it must choose between met and not-met will guess, and a guess dressed as a
 * judgment is the false trust this product exists to kill.
 */
const SYSTEM_PROMPT = [
  "You judge one criterion about one recorded conversation between a customer's",
  "agent and a synthetic caller. You are shown the transcript, how the",
  "conversation ended, the tools the agent called, and what was measured.",
  "",
  "Decide only the criterion you are given. Do not judge anything else about the",
  "conversation, however obvious it seems.",
  "",
  "Answer with a JSON object and nothing else:",
  '  {"decision": "met" | "not_met" | "cannot_determine",',
  '   "rationale": "one sentence",',
  '   "cited_turns": [<turn numbers from the transcript>]}',
  "",
  "Use cannot_determine when the evidence does not settle the criterion — a",
  "conversation that never reached the subject, or a criterion about something",
  "the record does not show. It is a real answer, not a failure, and guessing",
  "instead of using it is the one thing you must not do.",
  "",
  "Cite the turns your rationale rests on, by their numbers in the transcript.",
  "Cite none when the criterion is about something nobody said.",
].join("\n");

export function openaiJudge(judge: ResolvedJudge): Judge {
  return async (question: JudgeQuestion): Promise<JudgeAnswer> => {
    const body = JSON.stringify({
      model: judge.model,
      // The lowest the API allows, because the same conversation and the same
      // criterion should get the same verdict twice. It is not a guarantee —
      // no model offers one — and it is the difference between a judgment that
      // usually reproduces and one that never does.
      temperature: 0,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: asked(question) },
      ],
    });

    const said = await withRetries(async () => {
      const response = await fetch(OPENAI_CHAT_COMPLETIONS, {
        method: "POST",
        headers: {
          // The one place the key is ever written down, and it is written into
          // a header on the way out. Nothing logs this object.
          authorization: `Bearer ${judge.key}`,
          "content-type": "application/json",
        },
        body,
        signal: AbortSignal.timeout(DEADLINE_MILLISECONDS),
      });

      if (!response.ok) {
        // The provider's own words, trimmed to a line — never the request, so
        // there is no path by which the header above reaches a log.
        throw new JudgeRefused(
          `the judge model answered ${response.status}: ${(await response.text()).slice(0, 200)}`,
          retryable(response.status),
        );
      }

      return response.json() as Promise<unknown>;
    });

    return answerOf(said);
  };
}

/** A judge call that did not produce an answer, and whether asking again helps. */
export class JudgeRefused extends Error {
  readonly retryable: boolean;

  constructor(message: string, retryable: boolean) {
    super(message);
    this.retryable = retryable;
  }
}

/**
 * Which refusals are worth a second ask. A rate limit and a gateway error pass;
 * a rejected key and a model name that does not exist do not — asking again
 * would spend the same seconds to be told the same thing, and the assertion is
 * `errored` either way with the provider's own words on it.
 */
function retryable(status: number): boolean {
  return status === 408 || status === 409 || status === 429 || status >= 500;
}

async function withRetries<T>(attempt: () => Promise<T>): Promise<T> {
  let waited = FIRST_BACKOFF_MILLISECONDS;

  for (let made = 1; ; made += 1) {
    try {
      return await attempt();
    } catch (error) {
      const worthRetrying =
        error instanceof JudgeRefused ? error.retryable : true;
      if (!worthRetrying || made >= MOST_ATTEMPTS) throw error;

      await new Promise((resolve) => setTimeout(resolve, waited));
      waited *= 2;
    }
  }
}

/** The question, as the words after the system prompt. */
function asked(question: JudgeQuestion): string {
  return [
    "## Criterion",
    question.criterion,
    "",
    asJudgeReads(question.evidence),
  ].join("\n");
}

/**
 * The model's answer, read strictly.
 *
 * A judge that answered something this cannot read is a judge that did not
 * answer, and it is `errored` rather than quietly `cannot_determine`: the two
 * are different facts — one is a model saying the evidence does not settle the
 * question, the other is egma not knowing what the model said — and collapsing
 * them would hide a broken integration behind a word that means "fine, not
 * applicable".
 */
function answerOf(said: unknown): JudgeAnswer {
  const content = contentOf(said);

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new JudgeRefused(
      "the judge model answered something that is not JSON",
      false,
    );
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new JudgeRefused(
      "the judge model answered JSON that is not an object",
      false,
    );
  }

  const fields = parsed as Record<string, unknown>;
  const decision = DECISIONS.find((known) => known === fields["decision"]);
  if (decision === undefined) {
    throw new JudgeRefused(
      `the judge model answered a decision egma does not know; expected one of ${DECISIONS.join(", ")}`,
      false,
    );
  }

  return {
    decision: decision as Decision,
    rationale:
      typeof fields["rationale"] === "string" && fields["rationale"].trim() !== ""
        ? fields["rationale"].trim()
        : "the judge gave no reason.",
    citedTurns: citedTurnsOf(fields["cited_turns"]),
  };
}

function contentOf(said: unknown): string {
  const choices =
    typeof said === "object" && said !== null
      ? (said as Record<string, unknown>)["choices"]
      : undefined;
  const first = Array.isArray(choices) ? choices[0] : undefined;
  const message =
    typeof first === "object" && first !== null
      ? (first as Record<string, unknown>)["message"]
      : undefined;
  const content =
    typeof message === "object" && message !== null
      ? (message as Record<string, unknown>)["content"]
      : undefined;

  if (typeof content !== "string" || content.trim() === "") {
    throw new JudgeRefused(
      "the judge model answered with no message in it",
      false,
    );
  }
  return content;
}

/** Whole positive numbers only; anything else was not a turn. */
function citedTurnsOf(value: unknown): readonly number[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (at): at is number => Number.isInteger(at) && typeof at === "number" && at > 0,
  );
}
