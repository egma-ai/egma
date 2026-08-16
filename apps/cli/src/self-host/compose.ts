/**
 * Docker Compose, driven from the CLI.
 *
 * The deployment is a compose file and always has been; this is not a second
 * way to run egma, it is the same `docker compose` a self-hoster would type,
 * with the arguments got right and the platform's own configuration already in
 * the environment. `egma self-host up` performs the same source-checkout
 * sequence as `docker compose build` followed by
 * `docker compose up -d --wait`.
 *
 * **Secrets go through the environment of the child process, never through its
 * arguments.** A command line is readable by every process on the machine and
 * is kept in shell history; an environment is neither.
 */

import { spawn } from "node:child_process";

export type ComposeResult = {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
};

export type ComposeOptions = {
  readonly workspace: string;
  /** What the platform's own configuration adds to the child's environment. */
  readonly environment: Record<string, string>;
  /** Where the command's own output goes, line by line, as it arrives. */
  readonly onLine?: ((line: string) => void) | undefined;
  readonly signal?: AbortSignal | undefined;
};

export class DockerMissingError extends Error {
  constructor(cause: string) {
    super(
      `Egma could not run docker compose: ${cause}\n\n` +
        "The whole deployment is Docker with Compose and nothing else. Install " +
        "Docker Desktop, or the docker engine with the compose plugin, and run " +
        "this again.",
    );
    this.name = "DockerMissingError";
  }
}

/**
 * What Compose says when a variable the deployment description requires was
 * not supplied.
 *
 * This deployment's own secrets and its own address have no defaults — a
 * default for one of them is a value every reader of a public repository holds
 * — so Compose refuses while it is still reading the file, before a container
 * is created, and names the variable. That refusal is the whole point of the
 * required form, and it must not be mistaken for a service that failed to
 * start: nothing is half-done, no second attempt can help, and what the
 * operator needs is the name.
 */
const REQUIRED_VARIABLE = /required variable ([A-Z0-9_]+) is missing a value/u;

/**
 * The first variable Compose refused for, or `null` where it refused for
 * anything else.
 *
 * Both streams are read, because which one carries the line is Compose's
 * business rather than a contract.
 */
export function missingRequiredVariable(result: ComposeResult): string | null {
  if (result.code === 0) return null;
  return REQUIRED_VARIABLE.exec(`${result.stderr}\n${result.stdout}`)?.[1] ?? null;
}

/** Run one `docker compose` subcommand in a workspace. */
export async function compose(
  args: readonly string[],
  options: ComposeOptions,
): Promise<ComposeResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("docker", ["compose", ...args], {
      cwd: options.workspace,
      env: { ...process.env, ...options.environment },
      stdio: ["ignore", "pipe", "pipe"],
      signal: options.signal,
    });

    let stdout = "";
    let stderr = "";
    const collect = (into: "out" | "err") => (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      if (into === "out") stdout += text;
      else stderr += text;
      if (options.onLine === undefined) return;
      for (const line of text.split("\n")) {
        const trimmed = line.trimEnd();
        if (trimmed !== "") options.onLine(trimmed);
      }
    };
    child.stdout.on("data", collect("out"));
    child.stderr.on("data", collect("err"));

    child.on("error", (failure: NodeJS.ErrnoException) => {
      if (failure.code === "ENOENT") {
        reject(new DockerMissingError("there is no docker on this machine's PATH"));
        return;
      }
      reject(failure);
    });
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}
