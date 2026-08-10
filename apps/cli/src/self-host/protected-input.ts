/**
 * How a secret gets into `egma self-host phone setup`, and how it does not.
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

/** Which secret is being asked for. */
export type SecretName = "twilio-auth-token" | "openai-api-key";

/** Where each input may arrive from, for a run with nobody watching. */
export const SECRET_VARIABLES: Readonly<Record<SecretName, string>> = {
  "twilio-auth-token": "TWILIO_AUTH_TOKEN",
  "openai-api-key": "OPENAI_API_KEY",
};

/** The non-secret inputs, which may be arguments and often should be. */
export const PLAIN_VARIABLES = {
  accountSid: "TWILIO_ACCOUNT_SID",
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

/** What a developer is told when they tried to pass a secret as an argument. */
export function secretArgumentRefusal(argument: string): string {
  return [
    `egma will not take a secret in ${argument}. Command arguments are readable by every process on this machine and are kept in shell history.`,
    "",
    "Type it when setup asks, or put it in the environment of this one command:",
    "",
    `  ${SECRET_VARIABLES["twilio-auth-token"]}=… ${SECRET_VARIABLES["openai-api-key"]}=… egma self-host phone setup --apply --yes`,
  ].join("\n");
}

export class NoAnswerError extends Error {
  constructor(what: string, variable: string) {
    super(
      `egma self-host phone setup needs ${what}, and this run has no terminal to ask on. ` +
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

/**
 * One secret, from the environment if it is there and from the keyboard if it
 * is not. Returned and never printed, never logged, never put in an argument.
 */
export async function askSecret(
  name: SecretName,
  what: string,
  options: AskOptions,
): Promise<string> {
  const variable = SECRET_VARIABLES[name];
  const held = options.env[variable]?.trim();
  if (held !== undefined && held !== "") return held;
  if (options.input.isTTY !== true) throw new NoAnswerError(what, variable);
  return askWithoutEcho(`${what}: `, options);
}

/** One ordinary answer, which is not a secret and may be shown as it is typed. */
export async function askPlainly(
  variable: string,
  what: string,
  options: AskOptions,
): Promise<string> {
  const held = options.env[variable]?.trim();
  if (held !== undefined && held !== "") return held;
  if (options.input.isTTY !== true) throw new NoAnswerError(what, variable);
  const asked = createInterface({ input: options.input, output: options.output });
  try {
    return (await asked.question(`${what}: `, { signal: options.signal })).trim();
  } finally {
    asked.close();
  }
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
        reject(new Error("interrupted"));
      };
      const onData = (chunk: Buffer): void => {
        for (const byte of chunk) {
          // Ctrl-C, which in raw mode is a byte rather than a signal: nothing
          // else is going to turn it into one.
          if (byte === 0x03) {
            done();
            reject(new Error("interrupted"));
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
