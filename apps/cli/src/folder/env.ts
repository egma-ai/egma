/**
 * Parse test-owned Env JSON: retell_dynamic_variables and job_dispatch_metadata.
 * Both version with the test. Reject reserved egma_ variable names.
 * Validate shape here; the platform measures compact JSON size when saving.
 */

import { FolderProblem } from "./problem.ts";
import { sameJsonValue } from "./json-value.ts";

/** The world one test is conducted in. Both halves are optional. */
export type TestEnv = {
  /** What Retell substitutes into the agent's prompt, as text. */
  readonly retell_dynamic_variables?: Readonly<Record<string, string>>;
  /** What LiveKit hands the worker when the job is dispatched. */
  readonly job_dispatch_metadata?: Readonly<Record<string, unknown>>;
};

/** The section heading, as egma writes it. */
export const ENV_HEADING = "## Env";

/** The section heading, however many hashes and whatever case it was typed in. */
export const ENV_LINE = /^#{1,6}\s*env\s*$/iu;

/** Three backticks or more, with or without a language after them. */
const FENCE_LINE = /^(`{3,})\s*(\S*)\s*$/u;

/** The two keys an env holds, and no others. */
const ENV_KEYS = ["retell_dynamic_variables", "job_dispatch_metadata"] as const;

/**
 * The prefix a test may not use for a dynamic variable.
 *
 * egma's own words to the simulator start here, so a test that set one would be
 * overwriting what egma says about the run rather than what the caller's world
 * holds. Kept beside the reader because a repository can be validated with no
 * platform in reach.
 */
export const RESERVED_ENV_VARIABLE_PREFIX = "egma_";

/** A file egma could not read, said with enough to go and fix it. */
export class EnvProblem extends FolderProblem {
  constructor(where: string, said: string) {
    super(where, `${where}: ${said}`);
    this.name = "EnvProblem";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** One half, or nothing where it was left out, written null, or left empty. */
function held<Value extends Readonly<Record<string, unknown>>>(
  written: unknown,
  read: (value: unknown) => Value,
): Value | null {
  if (written === undefined || written === null) return null;
  const value = read(written);
  return Object.keys(value).length === 0 ? null : value;
}

/**
 * The env with nothing in it, said as no env at all.
 *
 * An env holding neither half is a test that named its world and then said
 * nothing about it, which is the same thing as naming none — and so is a half
 * with no values in it. egma stores all three the same way, so all three are
 * read the same way here; a file that said one of the others would come back
 * from the next pull saying this one, and the round trip would move bytes.
 */
function orNothing(env: TestEnv): TestEnv | null {
  return Object.keys(env).length === 0 ? null : env;
}

function variablesIn(value: unknown, where: string): Readonly<Record<string, string>> {
  if (!isRecord(value)) {
    throw new EnvProblem(
      where,
      `retell_dynamic_variables says ${JSON.stringify(value)}. It is the ` +
        `values Retell substitutes into the agent's prompt, written as an ` +
        `object of text — like {"caller_name": "Margaret"}.`,
    );
  }
  for (const [name, said] of Object.entries(value)) {
    if (name.startsWith(RESERVED_ENV_VARIABLE_PREFIX)) {
      throw new EnvProblem(
        where,
        `retell_dynamic_variables names "${name}". A variable beginning ` +
          `${RESERVED_ENV_VARIABLE_PREFIX} is one Egma says to the simulator ` +
          `itself; name the variable something the agent's own prompt uses.`,
      );
    }
    if (typeof said !== "string") {
      throw new EnvProblem(
        where,
        `retell_dynamic_variables gives "${name}" the value ` +
          `${JSON.stringify(said)}. A dynamic variable is substituted into the ` +
          `prompt as it stands, so every value is written as text.`,
      );
    }
  }
  return value as Record<string, string>;
}

function dispatchMetadataIn(
  value: unknown,
  where: string,
): Readonly<Record<string, unknown>> {
  if (!isRecord(value)) {
    throw new EnvProblem(
      where,
      `job_dispatch_metadata says ${JSON.stringify(value)}. It is the blob ` +
        `LiveKit hands the worker when the job is dispatched, written as an ` +
        `object — like {"tenant": "acme"}.`,
    );
  }
  return value;
}

/** One block, as the env it says. `{}` is read as no env at all. */
function envFrom(block: string | null, where: string): TestEnv | null {
  if (block === null || block.trim() === "") {
    throw new EnvProblem(
      where,
      `the Env section has no JSON block under it. Write one saying what the ` +
        `test is conducted in — like ` +
        `{"retell_dynamic_variables": {"caller_name": "Margaret"}} — or take ` +
        `the heading out.`,
    );
  }

  let read: unknown;
  try {
    read = JSON.parse(block);
  } catch (problem) {
    throw new EnvProblem(
      where,
      `the block under Env is not JSON Egma can read — ` +
        `${problem instanceof Error ? problem.message : String(problem)}`,
    );
  }

  if (!isRecord(read)) {
    throw new EnvProblem(
      where,
      `the block under Env says ${JSON.stringify(read)}, and an env is written ` +
        `as an object holding ${ENV_KEYS.join(" and ")}.`,
    );
  }

  for (const key of Object.keys(read)) {
    if ((ENV_KEYS as readonly string[]).includes(key)) continue;
    throw new EnvProblem(
      where,
      `Env holds "${key}"; it holds ${ENV_KEYS.join(" and ")}, and nothing else.`,
    );
  }

  const variables = held(read["retell_dynamic_variables"], (value) =>
    variablesIn(value, where),
  );
  const dispatch = held(read["job_dispatch_metadata"], (value) =>
    dispatchMetadataIn(value, where),
  );
  return orNothing({
    ...(variables === null ? {} : { retell_dynamic_variables: variables }),
    ...(dispatch === null ? {} : { job_dispatch_metadata: dispatch }),
  });
}

/**
 * The env in the lines under the section heading.
 *
 * The section is one fence, so the first one under the heading is it and
 * anything after is stepped over — the shape a reader who typed prose beneath
 * their env would expect.
 */
export function readEnv(lines: readonly string[], where: string): TestEnv | null {
  let written: string[] | null = null;
  let block: string | null = null;
  let closing: string | null = null;

  for (const raw of lines) {
    const line = raw.trim();

    if (closing !== null) {
      if (line === closing) {
        if (written !== null) block = written.join("\n");
        written = null;
        closing = null;
        continue;
      }
      written?.push(raw);
      continue;
    }

    const fence = FENCE_LINE.exec(line);
    if (fence !== null) {
      closing = fence[1] as string;
      written = block === null ? [] : null;
    }
  }

  // A fence nobody closed still holds what somebody wrote, so it is read rather
  // than thrown away: what it says is judged exactly as a closed one is.
  if (written !== null && block === null) block = written.join("\n");

  return envFrom(block, where);
}

/**
 * The section, as lines, or nothing at all when the test names no env.
 *
 * The keys go out in the one order the format writes them, so the bytes are
 * decided by the value rather than by whatever order the platform answered in.
 */
export function writeEnv(env: TestEnv | null): readonly string[] {
  if (env === null) return [];
  // A half with nothing in it is written as no half at all, and an env with no
  // halves as no env: reading either back gives null, and a section that read
  // back as something else would move bytes on the next pull.
  const filled = (
    half: Readonly<Record<string, unknown>> | undefined,
  ): boolean => half !== undefined && Object.keys(half).length > 0;
  const written = {
    ...(filled(env.retell_dynamic_variables)
      ? { retell_dynamic_variables: env.retell_dynamic_variables }
      : {}),
    ...(filled(env.job_dispatch_metadata)
      ? { job_dispatch_metadata: env.job_dispatch_metadata }
      : {}),
  };
  if (Object.keys(written).length === 0) return [];
  return [ENV_HEADING, "```json", JSON.stringify(written, null, 2), "```"];
}

/** Whether two envs say the same thing, whatever order they say it in. */
export function sameEnv(a: TestEnv | null, b: TestEnv | null): boolean {
  return sameJsonValue(a, b);
}
