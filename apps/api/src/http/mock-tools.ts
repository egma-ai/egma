import { isErrorAnswer, type MockToolAnswer } from "@egma/db";

/**
 * How a mock tool's answer crosses the wire.
 *
 * **The two branches are two keys, never one nullable field.** `null` is a
 * perfectly good answer for a tool to give, and a shape that could not tell it
 * from "no answer" would make an authored `null` unreadable — so only the
 * branch this answer is on is written, and a client reads which one arrived.
 */
export function answerAsWritten(
  answer: MockToolAnswer,
): Record<string, unknown> {
  return isErrorAnswer(answer)
    ? { error: answer.error }
    : { answer: answer.answer };
}

/**
 * Everything a served answer needs beside its own bytes: the tool it answers
 * for, and how long egma holds it back.
 *
 * Structural rather than named after any of the three rows that satisfy it — a
 * project's mock tool, a test version's stored override, a run's frozen
 * snapshot entry — because this is the shape the wire carries and all three
 * happen to have it.
 */
export type DescribableMockTool = {
  readonly toolName: string;
  readonly answer: MockToolAnswer;
  readonly delayMilliseconds: number;
};

/**
 * One mocked answer as every read of one describes it: the tool it answers
 * for, the branch it answers with, and the delay.
 *
 * Written once because three groups carry the same three fields — a project's
 * mock tools, a test's own overrides, and the world a run froze — and three
 * copies of the projection were three chances for one of them to answer a
 * shape the others do not. Each of the three adds its own keys around this
 * one: a project mock tool its identity and scope, a run's default the row it
 * was frozen from, a test's override nothing at all.
 *
 * The field names are the door's, not the row's; that translation is the whole
 * of what this file is for.
 */
export function describedMockTool(
  one: DescribableMockTool,
): Record<string, unknown> {
  return {
    tool: one.toolName,
    ...answerAsWritten(one.answer),
    delayMs: one.delayMilliseconds,
  };
}

/**
 * What a body says a tool answers with, forwarded rather than judged.
 *
 * Both keys travel exactly as they arrived — including neither of them, and
 * including both. **Whether that is one answer, two or none is the factory's
 * rule**, decided in one place and refused in one set of words; a door that
 * settled it first would be a second copy free to disagree the day either
 * moved. What the door still owns is the envelope: which keys exist at all.
 */
export function answerAsSent(
  body: Record<string, unknown>,
): { readonly answer?: unknown; readonly error?: unknown } {
  return {
    ...("answer" in body ? { answer: body.answer } : {}),
    ...("error" in body ? { error: body.error } : {}),
  };
}
