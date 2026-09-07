import {
  DECISIONS,
  type Judge,
  type JudgeAnswer,
  type JudgeQuestion,
  type JudgeUsageSink,
  type ResolvedJudge,
} from "./contract.ts";
import { asJudgeReads } from "./input.ts";
import { validateJudgeAnswer } from "./response.ts";

/** Call OpenAI Chat Completions and validate the structured LLM-judge response. */

const OPENAI_CHAT_COMPLETIONS = "https://api.openai.com/v1/chat/completions";

/** Make the provider enforce the fixed judge answer contract before parsing. */
const JUDGE_RESPONSE_FORMAT = {
  type: "json_schema",
  json_schema: {
    name: "egma_judge_answer",
    strict: true,
    schema: {
      type: "object",
      properties: {
        results: {
          type: "array",
          items: {
            type: "object",
            properties: {
              id: { type: "string" },
              decision: { type: "string", enum: DECISIONS },
              rationale: { type: "string" },
              cited_turns: { type: "array", items: { type: "integer" } },
            },
            required: ["id", "decision", "rationale", "cited_turns"],
            additionalProperties: false,
          },
        },
      },
      required: ["results"],
      additionalProperties: false,
    },
  },
} as const;

/** Maximum model requests, including retries for transient failures. */
const MOST_ATTEMPTS = 3;

/** How long a judge is given to answer before the attempt is abandoned. */
const DEADLINE_MILLISECONDS = 60_000;

/** The wait before a retry, doubling. Short: a grading job holds a lease. */
const FIRST_BACKOFF_MILLISECONDS = 500;

export function openaiJudge(judge: ResolvedJudge): Judge {
  return async (question: JudgeQuestion): Promise<JudgeAnswer> => {
    const body = JSON.stringify({
      model: judge.model,
      ...(judge.reasoningEffort === undefined
        ? {}
        : { reasoning_effort: judge.reasoningEffort }),
      // Reduce output variation across repeated judgments.
      temperature: 0,
      response_format: JUDGE_RESPONSE_FORMAT,
      messages: [
        // Use the grading instructions from the resolved grader definition version.
        { role: "system", content: question.prompt },
        { role: "user", content: asked(question) },
      ],
    });

    const said = await withRetries(async (httpAttempt) => {
      const response = await fetch(OPENAI_CHAT_COMPLETIONS, {
        method: "POST",
        headers: {
          // Send the provider key only in the authorization header; do not log it.
          authorization: `Bearer ${judge.key}`,
          "content-type": "application/json",
        },
        body,
        signal: AbortSignal.timeout(DEADLINE_MILLISECONDS),
      });

      if (!response.ok) {
        // Include up to 200 characters of the provider's error response.
        throw new JudgeRefused(
          `the judge model answered ${response.status}: ${(await response.text()).slice(0, 200)}`,
          retryable(response.status),
        );
      }

      const answered = (await response.json()) as unknown;
      // Reported here rather than after the answer is parsed, because this is
      // the moment the provider billed: a body that turns out to be unreadable
      // was still generated and still cost money, and a spend record that
      // depended on Egma liking the answer would under-count exactly the calls
      // worth looking at.
      report(judge.usage, httpAttempt, answered);
      return answered;
    });

    return answerOf(said, question);
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

/** Retry transient rate-limit and server failures, not authentication or model errors. */
function retryable(status: number): boolean {
  return status === 408 || status === 409 || status === 429 || status >= 500;
}

async function withRetries<T>(
  attempt: (httpAttempt: number) => Promise<T>,
): Promise<T> {
  let waited = FIRST_BACKOFF_MILLISECONDS;

  for (let made = 1; ; made += 1) {
    try {
      return await attempt(made);
    } catch (error) {
      const worthRetrying =
        error instanceof JudgeRefused ? error.retryable : true;
      if (!worthRetrying || made >= MOST_ATTEMPTS) throw error;

      await new Promise((resolve) => setTimeout(resolve, waited));
      waited *= 2;
    }
  }
}

/**
 * What one answered request consumed, handed to whoever is collecting.
 *
 * **The cached half of the prompt is separated here, once.** OpenAI's
 * `prompt_tokens` includes the tokens it served from its cache, and the cached
 * rate is a tenth of the uncached one on the models Egma grades with — so a
 * record that carried the gross figure and rated it at the uncached price
 * would overcharge every grading call whose prompt repeated. The provider's own
 * object rides along verbatim, so a mistake here can be re-rated later rather
 * than re-measured.
 *
 * A body with no `usage` reports nothing. That is not a silent loss: it means
 * the provider said nothing about what it consumed, and inventing a number
 * would be worse than the gap.
 */
function report(
  sink: JudgeUsageSink | undefined,
  httpAttempt: number,
  said: unknown,
): void {
  if (sink === undefined) return;
  const body = typeof said === "object" && said !== null
    ? (said as Record<string, unknown>)
    : {};
  const usage = body["usage"];
  if (typeof usage !== "object" || usage === null || Array.isArray(usage)) {
    return;
  }
  const counted = usage as Record<string, unknown>;
  const promptTokens = numberIn(counted, "prompt_tokens");
  const details = counted["prompt_tokens_details"];
  const cached =
    typeof details === "object" && details !== null
      ? numberIn(details as Record<string, unknown>, "cached_tokens")
      : 0;
  const completionTokens = numberIn(counted, "completion_tokens");

  const quantities: Record<string, number> = {};
  const uncached = Math.max(promptTokens - cached, 0);
  if (uncached > 0) quantities["input_tokens"] = uncached;
  if (cached > 0) quantities["cached_input_tokens"] = cached;
  if (completionTokens > 0) quantities["output_tokens"] = completionTokens;
  if (Object.keys(quantities).length === 0) return;

  const id = body["id"];
  sink({
    occurredAt: new Date(),
    httpAttempt,
    providerRef: typeof id === "string" && id !== "" ? id : undefined,
    quantities,
    rawUsage: counted,
  });
}

function numberIn(held: Record<string, unknown>, key: string): number {
  const value = held[key];
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : 0;
}

/** The question, as the words after the system prompt. */
function asked(question: JudgeQuestion): string {
  return [
    "## Instruction (instruction_1)",
    question.criterion,
    "",
    "## Expected behaviors",
    ...question.expectedBehaviors.map((behavior) => `${behavior.id}: ${behavior.text}`),
    ...(question.expectedBehaviors.length === 0 ? ["(no test expected behaviors were supplied)"] : []),
    "",
    asJudgeReads(question.evidence),
  ].join("\n");
}

/**
 * Reject malformed model responses as grading errors. Do not treat a parse
 * failure as the model deciding that evidence is insufficient.
 */
function answerOf(said: unknown, question: JudgeQuestion): JudgeAnswer {
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

  try {
    return validateJudgeAnswer(parsed, question);
  } catch (error) {
    throw new JudgeRefused(error instanceof Error ? error.message : "invalid judge response", false);
  }
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

