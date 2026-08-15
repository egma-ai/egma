/**
 * How a secret gets into `egma self-host setup`, and how it does not.
 *
 * **Never as an argument.** A command line is readable by every process on the
 * machine through the process table, and shells keep it in history for months.
 * An argument named for one of these is refused outright rather than accepted
 * with a warning nobody reads — the same rule `egma connect` applies to a
 * Retell key, for the same reason.
 *
 * **Never echoed.** Typed answers are read with the terminal's echo off, so the
 * value is not on the screen for a shoulder or a screen recording, and it never
 * reaches a scrollback buffer.
 *
 * **From the environment, for a run with nobody watching.** A coding agent
 * driving `--apply --yes --json` has no keystroke to give, so each input has one
 * environment variable it may arrive in. That is still not an argument.
 */

import { createInterface } from "node:readline/promises";

/**
 * The three inputs the carrier step takes, and where each may arrive from for a
 * run with nobody watching.
 *
 * Every *setting* has a variable of its own — the same name the platform seeds
 * that setting from, so one word means one thing whichever of the two ways in
 * an operator uses. Two of these are not settings at all: the Auth Token opens
 * a whole Twilio account and is kept nowhere, and the account identifier says
 * which account the paperwork is done in. The third is: `carrier_trunk_number`
 * is the number a call appears to come from, and it is the one carrier fact a
 * person supplies rather than the paperwork producing.
 */
export const CARRIER_VARIABLES = {
  accountSid: "TWILIO_ACCOUNT_SID",
  authToken: "TWILIO_AUTH_TOKEN",
  sourceNumber: "EGMA_PHONE_SOURCE_NUMBER",
} as const;

/** Argument names that would put a secret in the process table. */
export const REFUSED_SECRET_ARGUMENTS = [
  "--auth-token",
  "--twilio-auth-token",
  "--openai-key",
  "--openai-api-key",
  "--api-key",
  "--key",
  "--password",
];

/**
 * What a developer is told when they tried to pass a secret as an argument.
 *
 * The advice deliberately does not say `TWILIO_AUTH_TOKEN=… egma self-host …`.
 * An inline assignment is part of the command line, and both zsh and bash write
 * the whole command line to history — so recommending one, in a refusal whose
 * stated reason is that arguments are kept in shell history, would be telling
 * somebody to do the thing they were just refused for.
 */
export function secretArgumentRefusal(argument: string): string {
  return [
    `egma will not take a secret in ${argument}. Command arguments are readable by every process on this machine and are kept in shell history.`,
    "",
    "Run it and type the value when setup asks. Nothing you type is echoed.",
    "",
    "For a run with nobody watching, export it from a file first, so the value",
    "is never a word in any command:",
    "",
    `  export ${CARRIER_VARIABLES.authToken}="$(cat twilio-token.txt)"`,
    '  export EGMA_PERSONA_MODEL_API_KEY="$(cat model-key.txt)"',
    "  egma self-host setup --apply --yes",
  ].join("\n");
}

/**
 * Somebody pressed Ctrl-C at a question.
 *
 * Its own type because the command above has to tell it apart from a failure:
 * "I do not have my token to hand" is the most likely first-run interaction in
 * the whole command, and it ends in one sentence and exit 130 rather than in a
 * Node stack trace, which reads as a bug in egma at the moment somebody was
 * being careful.
 */
export class StoppedError extends Error {
  constructor() {
    super("stopped at a question");
    this.name = "StoppedError";
  }
}

/**
 * The last characters of a key, so two keys can be told apart without either
 * being shown.
 *
 * The same hint the platform already keeps beside a project's judge, for the
 * same reason: a key taken silently from an exported variable is the one a
 * developer has forgotten they still have, and it surfaces much later as a
 * provider refusing every turn. Four characters name it and open nothing.
 */
export function keyHint(key: string): string {
  return key.length <= 4 ? "…" : `…${key.slice(-4)}`;
}

export class NoAnswerError extends Error {
  constructor(what: string, variable: string) {
    super(
      `egma self-host setup needs ${what}, and this run has no terminal to ask on. ` +
        `Set ${variable} in the environment of this one command, or run it where somebody can type.`,
    );
    this.name = "NoAnswerError";
  }
}

export type AskOptions = {
  readonly env: NodeJS.ProcessEnv;
  readonly input: NodeJS.ReadableStream & { isTTY?: boolean };
  readonly output: NodeJS.WritableStream & { isTTY?: boolean };
  readonly signal?: AbortSignal | undefined;
};

/** An answer, and where it came from — never the value itself in a log. */
export type Answered = {
  readonly value: string;
  /** `typed` at a keyboard, or the environment variable it was taken from. */
  readonly from: string;
};

/**
 * One secret, from the environment if it is there and from the keyboard if it
 * is not. Returned and never printed, never logged, never put in an argument.
 *
 * **It says where it took the answer from.** `OPENAI_API_KEY` is a variable
 * most developers already export, so a run that reads it asks nothing and looks
 * exactly like a run that was told — and a stale exported key configures the
 * whole platform silently, surfacing an hour later as a provider refusing every
 * turn. Naming the source and the key's last four characters costs one line and
 * makes that visible at the moment it happens.
 */
export async function askSecret(
  variable: string,
  what: string,
  options: AskOptions,
): Promise<Answered> {
  const held = options.env[variable]?.trim();
  if (held !== undefined && held !== "") return { value: held, from: variable };
  if (options.input.isTTY !== true) throw new NoAnswerError(what, variable);
  return { value: await askWithoutEcho(`${what}: `, options), from: "typed" };
}

/**
 * One ordinary answer, which is not a secret and may be shown as it is typed.
 *
 * Ctrl-C here goes through `readline`, which raises its own `AbortError`
 * rather than the stop the raw reader below raises — and an interruption at
 * the *first* question, which is what this is, is at least as likely as one at
 * a secret. Both become the same stop, so the command above has one thing to
 * catch and a person gets one sentence either way.
 */
export async function askPlainly(
  variable: string,
  what: string,
  options: AskOptions,
): Promise<string> {
  const answered = await askOptionally(variable, what, options, null);
  if (answered === null) throw new NoAnswerError(what, variable);
  return answered;
}

/**
 * One ordinary answer that egma can carry on without.
 *
 * Three sources, in order, and the order is the whole of it: the environment,
 * because an operator who exported the variable meant it; then a person, if
 * there is one to ask; then the suggestion, where the product has one.
 *
 * **A run with nobody watching takes the suggestion rather than refusing.** The
 * command it replaced hard-coded the same values — `openai`, `livekit`,
 * `silero` — so a coding agent driving `--apply --yes` gets what it always got,
 * and the suggestion is offered to a person as a default they can overtype
 * rather than hidden in the code that used to hold it.
 *
 * `null` means nobody answered and there was nothing to fall back on, which is
 * an ordinary state for a setting egma can do without.
 */
export async function askOptionally(
  variable: string,
  what: string,
  options: AskOptions,
  suggested: string | null,
): Promise<string | null> {
  const held = options.env[variable]?.trim();
  if (held !== undefined && held !== "") return held;
  if (options.input.isTTY !== true) return suggested;

  const asked = createInterface({ input: options.input, output: options.output });
  try {
    const typed = (
      await asked.question(
        suggested === null ? `${what}: ` : `${what} [${suggested}]: `,
        { signal: options.signal },
      )
    ).trim();
    return typed === "" ? suggested : typed;
  } catch (stopped) {
    throw asStop(stopped);
  } finally {
    asked.close();
  }
}

/**
 * Somebody's interruption, whichever shape it arrived in.
 *
 * `readline` raises an `AbortError` carrying `ABORT_ERR`, both when it reads
 * Ctrl-C itself and when the signal this command installs aborts it. Neither is
 * a failure worth a stack trace.
 */
export function asStop(error: unknown): unknown {
  const code = (error as { code?: unknown } | null)?.code;
  return code === "ABORT_ERR" ? new StoppedError() : error;
}

/**
 * Read a line with the terminal's echo off.
 *
 * **Deliberately without `readline`.** Raw mode stops the *terminal driver*
 * echoing, which is most of the job — but a readline interface built on the
 * same stream runs its own line editor and echoes what it reads itself, so a
 * secret typed into one is on the screen and in the scrollback whatever the
 * driver was told. That is not a theory: it is what the first version of this
 * function did, and the terminal check next door read the token straight off
 * the screen. So this reads the bytes directly and prints none of them.
 *
 * The echo is put back in a `finally`, including when the answer is
 * interrupted, because a terminal left in raw mode is a terminal the next
 * command types into blind.
 */
async function askWithoutEcho(prompt: string, options: AskOptions): Promise<string> {
  const terminal = options.input as NodeJS.ReadStream;
  const wasRaw = terminal.isRaw === true;
  options.output.write(prompt);
  if (terminal.setRawMode !== undefined) terminal.setRawMode(true);
  terminal.resume();
  try {
    const answer = await new Promise<string>((resolve, reject) => {
      let typed = "";
      const done = (): void => {
        terminal.off("data", onData);
        options.signal?.removeEventListener("abort", onAbort);
      };
      const onAbort = (): void => {
        done();
        reject(new StoppedError());
      };
      const onData = (chunk: Buffer): void => {
        for (const byte of chunk) {
          // Ctrl-C, which in raw mode is a byte rather than a signal: nothing
          // else is going to turn it into one.
          if (byte === 0x03) {
            done();
            reject(new StoppedError());
            return;
          }
          if (byte === 0x0d || byte === 0x0a) {
            done();
            resolve(typed);
            return;
          }
          if (byte === 0x7f || byte === 0x08) {
            typed = typed.slice(0, -1);
            continue;
          }
          typed += String.fromCharCode(byte);
        }
      };
      terminal.on("data", onData);
      options.signal?.addEventListener("abort", onAbort, { once: true });
    });
    return answer.trim();
  } finally {
    if (terminal.setRawMode !== undefined) terminal.setRawMode(wasRaw);
    terminal.pause();
    // One newline of egma's own, because nothing the person typed was echoed
    // and the prompt would otherwise stay on the same line as whatever comes
    // next.
    options.output.write("\n");
  }
}
