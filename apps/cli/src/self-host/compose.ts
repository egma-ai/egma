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
import { existsSync } from "node:fs";
import path from "node:path";

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

/** Docker Compose could not resolve the operator's environment safely. */
export class OperatorEnvironmentError extends Error {
  constructor() {
    super(
      "Docker Compose could not read this workspace's .env configuration. " +
        "Fix its Compose syntax and run this command again. Nothing was " +
        "generated or started.",
    );
    this.name = "OperatorEnvironmentError";
  }
}

export class DockerStateInspectionError extends Error {
  constructor() {
    super(
      "Egma could not inspect this installation's Docker volumes. Nothing was " +
        "generated or started. Check that the Docker daemon is available, then " +
        "run this command again.",
    );
    this.name = "DockerStateInspectionError";
  }
}

/**
 * PostgreSQL volumes already owned by this Compose project.
 *
 * This is asked before any internal credential is generated. A database may
 * outlive every container and the private workspace file, so containers are
 * not enough evidence. Compose labels find the current and former volume
 * names; the two exact names also catch a volume restored without its labels.
 */
export async function persistedPostgresVolumes(options: {
  readonly projectName: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly signal?: AbortSignal | undefined;
}): Promise<readonly string[]> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "docker",
      [
        "volume",
        "ls",
        "--format",
        '{{.Name}}\t{{.Label "com.docker.compose.project"}}\t{{.Label "com.docker.compose.volume"}}',
      ],
      {
        env: { ...process.env, ...options.environment },
        stdio: ["ignore", "pipe", "pipe"],
        signal: options.signal,
      },
    );

    let stdout = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    // A daemon error cannot contain a platform secret, but the stable refusal
    // above is more useful than Docker's transport-specific wording.
    child.stderr.resume();

    child.on("error", (failure: NodeJS.ErrnoException) => {
      if (failure.code === "ENOENT") {
        reject(new DockerMissingError("there is no docker on this machine's PATH"));
        return;
      }
      reject(new DockerStateInspectionError());
    });
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new DockerStateInspectionError());
        return;
      }
      const currentByName = `${options.projectName}_postgres-17-data`;
      const formerByName = `${options.projectName}_postgres-data`;
      const found = stdout
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line !== "")
        .flatMap((line) => {
          const [name = "", project = "", logical = ""] = line.split("\t");
          const belongsByLabel =
            project === options.projectName && logical.startsWith("postgres");
          const belongsByKnownName =
            name === currentByName || name === formerByName;
          return belongsByLabel || belongsByKnownName ? [name] : [];
        });
      resolve([...new Set(found)].sort());
    });
  });
}

/** One resolved `NAME=value` list from `docker compose config --environment`. */
export function parseComposeEnvironment(output: string): Record<string, string> {
  const found: Record<string, string> = {};
  for (const line of output.split("\n")) {
    const split = line.indexOf("=");
    if (split <= 0) continue;
    const name = line.slice(0, split);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name)) continue;
    found[name] = line.slice(split + 1).replace(/\r$/u, "");
  }
  return found;
}

/**
 * Resolve the workspace environment with Docker Compose's own parser.
 *
 * This deliberately does not parse `.env` in TypeScript. Compose accepts
 * interpolation and `NAME: value` syntax that Node's dotenv parser does not,
 * and an older deployment may hold the encryption key that opens its database
 * in either form. Asking a different parser could generate a replacement key
 * and make every sealed row unreadable.
 *
 * A minimal Compose document arrives on stdin, so this reads only the
 * interpolation environment and never evaluates the real deployment's
 * required variables. The resolved values are captured in memory and are
 * never printed. The same values are later placed in the real Compose child
 * environment, which also keeps `$` inside a SIP password literal.
 */
export async function composeEnvironment(options: {
  readonly workspace: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly signal?: AbortSignal | undefined;
}): Promise<Record<string, string>> {
  return new Promise((resolve, reject) => {
    const operatorFile = path.join(options.workspace, ".env");
    const environmentFile = existsSync(operatorFile)
      ? ["--env-file", operatorFile]
      : [];
    const child = spawn(
      "docker",
      [
        "compose",
        ...environmentFile,
        "-f",
        "-",
        "config",
        "--environment",
      ],
      {
        cwd: options.workspace,
        env: { ...process.env, ...options.environment },
        stdio: ["pipe", "pipe", "pipe"],
        signal: options.signal,
      },
    );

    let stdout = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    // Drain stderr without repeating it. A parser diagnostic can contain the
    // line that failed, and that line may be a provider key or SIP password.
    child.stderr.resume();

    child.on("error", (failure: NodeJS.ErrnoException) => {
      if (failure.code === "ENOENT") {
        reject(new DockerMissingError("there is no docker on this machine's PATH"));
        return;
      }
      reject(failure);
    });
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new OperatorEnvironmentError());
        return;
      }
      resolve(parseComposeEnvironment(stdout));
    });

    child.stdin.on("error", () => undefined);
    child.stdin.end("services:\n  resolver:\n    image: scratch\n");
  });
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
    const operatorFile = path.join(options.workspace, ".env");
    const environmentFile = existsSync(operatorFile)
      ? ["--env-file", operatorFile]
      : [];
    const child = spawn("docker", ["compose", ...environmentFile, ...args], {
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
