/**
 * Docker Compose, driven from the CLI.
 *
 * The deployment is a compose file and always has been; this is not a second
 * way to run egma, it is the same `docker compose` a self-hoster would type,
 * with the arguments got right and the platform's own configuration already in
 * the environment. `egma self-host up` and `docker compose up -d --wait` bring
 * up the same containers.
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
      `egma could not run docker compose: ${cause}\n\n` +
        "The whole deployment is Docker with Compose and nothing else. Install " +
        "Docker Desktop, or the docker engine with the compose plugin, and run " +
        "this again.",
    );
    this.name = "DockerMissingError";
  }
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
