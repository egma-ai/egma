import { spawn, spawnSync } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

const HELPER = fileURLToPath(
  new URL("../runtime/livekit-local.mjs", import.meta.url),
);
const LIVEKIT_ENV = {
  LIVEKIT_URL: "wss://example.livekit.cloud",
  LIVEKIT_API_KEY: "livekit-secret",
  LIVEKIT_API_SECRET: "livekit-secret-value",
};
const EGMA_ENV = {
  EGMA_URL: "https://app.egma.example",
  EGMA_API_KEY: "egma-secret",
  EGMA_FUTURE_SECRET: "future-secret",
};
const NO_LIVEKIT_ENV = { url: null, key: null, secret: null };
const NO_PRIVATE_ENV = {
  ...NO_LIVEKIT_ENV,
  egmaUrl: null,
  egmaKey: null,
  futureEgmaSecret: null,
};
const temporary: string[] = [];

const FAKE_PYTHON = `#!/usr/bin/env node
import { appendFileSync, existsSync, writeFileSync } from "node:fs";

const args = process.argv.slice(2);
if (process.env.OBSERVED_PYTHON_FILE) {
  appendFileSync(process.env.OBSERVED_PYTHON_FILE, JSON.stringify({
    args,
    cwd: process.cwd(),
    url: process.env.LIVEKIT_URL ?? null,
    key: process.env.LIVEKIT_API_KEY ?? null,
    secret: process.env.LIVEKIT_API_SECRET ?? null,
    egmaUrl: process.env.EGMA_URL ?? null,
    egmaKey: process.env.EGMA_API_KEY ?? null,
    futureEgmaSecret: process.env.EGMA_FUTURE_SECRET ?? null,
  }) + "\\n");
}
if (args[0] === "-c") process.exit(existsSync(process.env.FIXTURE_INSTALLED_MARKER) ? 0 : 1);
if (args[0] === "-m" && args[1] === "pip" && args[2] === "install" && args[3] === "-r") {
  writeFileSync(process.env.FIXTURE_INSTALLED_MARKER, "0.2.0\\n");
  process.exit(0);
}
process.exit(2);
`;

const FAKE_LIVEKIT = `#!/usr/bin/env node
import { appendFileSync, writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const command = args.join(" ");
if (command === "--version" || command === "agent dev --help") {
  if (process.env.OBSERVED_PREPARATION_FILE) {
    appendFileSync(process.env.OBSERVED_PREPARATION_FILE, JSON.stringify({
      args,
      url: process.env.LIVEKIT_URL ?? null,
      key: process.env.LIVEKIT_API_KEY ?? null,
      secret: process.env.LIVEKIT_API_SECRET ?? null,
      egmaUrl: process.env.EGMA_URL ?? null,
      egmaKey: process.env.EGMA_API_KEY ?? null,
      futureEgmaSecret: process.env.EGMA_FUTURE_SECRET ?? null,
    }) + "\\n");
  }
  if (command === "--version") process.stdout.write("lk version 2.18.3\\n");
  process.exit(0);
}

writeFileSync(process.env.OBSERVED_WORKER_FILE, JSON.stringify({
  args,
  cwd: process.cwd(),
  url: process.env.LIVEKIT_URL,
  key: process.env.LIVEKIT_API_KEY,
  secret: process.env.LIVEKIT_API_SECRET,
  egmaUrl: process.env.EGMA_URL,
  egmaKey: process.env.EGMA_API_KEY,
  futureEgmaSecret: process.env.EGMA_FUTURE_SECRET,
}));
const secret = process.env.LIVEKIT_API_SECRET;
if (process.env.EMIT_SECRET === "true") {
  process.stdout.write("worker secret=" + secret.slice(0, 5));
  setTimeout(() => process.stdout.write(secret.slice(5) + "\\n"), 5);
  setTimeout(() => process.stdout.write("registered worker will appear later\\n"), 10);
}
setTimeout(() => {
  if (process.env.REGISTRATION_STYLE === "node-pretty") {
    process.stdout.write("[12:00:00.000] INFO (123): registered worker\\n");
    process.stdout.write('    id: "AW_123"\\n');
    process.stdout.write('    agentName: "front-desk"\\n');
    return;
  }
  if (process.env.REGISTRATION_STYLE === "node-json") {
    process.stdout.write(JSON.stringify({
      level: 30,
      id: "AW_123",
      agentName: "front-desk",
      msg: "registered worker",
    }) + "\\n");
    return;
  }
  process.stdout.write(JSON.stringify({
    message: "registered worker",
    id: "AW_uv",
    agent_name: "front-desk",
  }) + "\\n");
}, 20);
process.on("SIGTERM", () => process.exit(0));
setInterval(() => {}, 1_000);
`;

const FAKE_UV = `#!/usr/bin/env node
import { writeFileSync } from "node:fs";

const args = process.argv.slice(2);
if (args.join(" ") === "--version") {
  process.stdout.write("uv 0.8.0\\n");
  process.exit(0);
}
if (args.slice(0, 4).join(" ") === "run --no-sync python -c") {
  process.stdout.write(process.env.FAKE_UV_PYTHON + "\\n");
  process.exit(0);
}
writeFileSync(process.env.OBSERVED_UV_FILE, JSON.stringify({
  args,
  cwd: process.cwd(),
  url: process.env.LIVEKIT_URL ?? null,
  key: process.env.LIVEKIT_API_KEY ?? null,
  secret: process.env.LIVEKIT_API_SECRET ?? null,
}));
writeFileSync(process.env.FIXTURE_INSTALLED_MARKER, "0.2.0\\n");
`;

afterEach(async () => {
  await Promise.all(
    temporary.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function createFixture(prefix: string) {
  const root = await mkdtemp(path.join(tmpdir(), prefix));
  const repository = path.join(root, "repository");
  const bin = path.join(root, "bin");
  temporary.push(root);
  await Promise.all([mkdir(repository), mkdir(bin)]);
  return { bin, repository, root };
}

async function writeExecutable(file: string, source: string): Promise<void> {
  await writeFile(file, source, { mode: 0o755 });
  await chmod(file, 0o755);
}

async function runHelper(options: {
  bin: string;
  repository: string;
  entrypoint: string;
  manifest: string;
  dispatchName: string;
  env: NodeJS.ProcessEnv;
  stopWhenReady: boolean;
}) {
  return new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
    stdout: string;
    stderr: string;
  }>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        HELPER,
        "--cwd",
        options.repository,
        "--entrypoint",
        options.entrypoint,
        "--dependency-manifest",
        options.manifest,
        "--dispatch-name",
        options.dispatchName,
      ],
      {
        env: {
          ...process.env,
          PATH: `${options.bin}${path.delimiter}${process.env.PATH ?? ""}`,
          ...options.env,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    let ready = false;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (
        options.stopWhenReady &&
        !ready &&
        stdout.split(/\r?\n/u).includes("egma:livekit-worker ready")
      ) {
        ready = true;
        child.kill("SIGTERM");
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`helper did not finish\n${stdout}\n${stderr}`));
    }, 5_000);
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      if (options.stopWhenReady && !ready) {
        reject(new Error(`helper exited before readiness with ${String(code)}\n${stderr}`));
        return;
      }
      resolve({ code, signal, stdout, stderr });
    });
  });
}

async function readJson<T>(file: string): Promise<T> {
  return JSON.parse(await readFile(file, "utf8")) as T;
}

async function readJsonLines(file: string): Promise<Record<string, unknown>[]> {
  return (await readFile(file, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe.skipIf(process.platform === "win32")("the local LiveKit CLI helper", () => {
  it("refuses worker paths that escape through symlinks", async () => {
    const { bin, repository, root } = await createFixture(
      "egma-livekit-helper-path-",
    );
    const outsideWorker = path.join(root, "outside-agent.py");
    await Promise.all([
      writeFile(outsideWorker, "# outside\n", "utf8"),
      writeFile(path.join(repository, "requirements.txt"), "egma>=0.2.0\n", "utf8"),
    ]);
    await symlink(outsideWorker, path.join(repository, "agent.py"));

    const run = await runHelper({
      bin,
      repository,
      entrypoint: "agent.py",
      manifest: "requirements.txt",
      dispatchName: "front-desk",
      env: LIVEKIT_ENV,
      stopWhenReady: false,
    });

    expect(run.code).toBe(1);
    expect(run.stderr).toContain("--entrypoint must not point outside --cwd");
  });

  it("refuses dependency paths that resolve to environment files", async () => {
    const { bin, repository } = await createFixture("egma-livekit-helper-env-");
    await Promise.all([
      writeFile(path.join(repository, "agent.py"), "# worker\n", "utf8"),
      writeFile(path.join(repository, ".env.local"), "EGMA_API_KEY=secret\n", "utf8"),
    ]);
    await symlink(".env.local", path.join(repository, "requirements.txt"));

    const run = await runHelper({
      bin,
      repository,
      entrypoint: "agent.py",
      manifest: "requirements.txt",
      dispatchName: "front-desk",
      env: LIVEKIT_ENV,
      stopWhenReady: false,
    });

    expect(run.code).toBe(1);
    expect(run.stderr).toContain(
      "--dependency-manifest must not name an environment file",
    );
  });

  it("uses env credentials, waits for registration, redacts output, and stops cleanly", async () => {
    const { bin, repository, root } = await createFixture("egma-livekit-helper-");
    const observedWorker = path.join(root, "observed-worker.json");
    const observedPreparation = path.join(root, "observed-preparation.jsonl");
    const observedPython = path.join(root, "observed-python.jsonl");
    const installedEgma = path.join(root, "egma-installed");
    const requirements = path.join(repository, "requirements.txt");
    const fakePython = path.join(repository, ".venv", "bin", "python");
    await Promise.all([
      mkdir(path.join(repository, "src"), { recursive: true }),
      mkdir(path.dirname(fakePython), { recursive: true }),
    ]);
    await Promise.all([
      writeFile(path.join(repository, "src", "agent.py"), "# fixture\n", "utf8"),
      writeFile(requirements, "livekit-agents>=1.6.7\negma>=0.2.0\n", "utf8"),
      writeExecutable(fakePython, FAKE_PYTHON),
      writeExecutable(path.join(bin, "lk"), FAKE_LIVEKIT),
    ]);

    const sharedEnv = {
      OBSERVED_WORKER_FILE: observedWorker,
      OBSERVED_PREPARATION_FILE: observedPreparation,
      OBSERVED_PYTHON_FILE: observedPython,
      FIXTURE_INSTALLED_MARKER: installedEgma,
      ...LIVEKIT_ENV,
    };
    const run = await runHelper({
      bin,
      repository,
      entrypoint: "src/agent.py",
      manifest: "requirements.txt",
      dispatchName: "front-desk",
      env: {
        ...sharedEnv,
        ...EGMA_ENV,
        REGISTRATION_STYLE: "node-pretty",
        EMIT_SECRET: "true",
      },
      stopWhenReady: true,
    });

    expect({ code: run.code, signal: run.signal }).toEqual({ code: 0, signal: null });
    const lines = run.stdout.split(/\r?\n/u);
    const registration = lines.findIndex((line) => line.includes("registered worker"));
    const ready = lines.indexOf("egma:livekit-worker ready");
    expect(registration).toBeGreaterThanOrEqual(0);
    expect(ready).toBeGreaterThan(registration);
    expect(lines.filter((line) => line === "egma:livekit-worker ready")).toHaveLength(1);
    expect(`${run.stdout}\n${run.stderr}`).not.toContain(LIVEKIT_ENV.LIVEKIT_API_SECRET);
    expect(`${run.stdout}\n${run.stderr}`).not.toContain("-value");
    expect(run.stdout).toContain("worker secret=[REDACTED]");

    const launched = await readJson<{
      args: string[];
      cwd: string;
      url: string;
      key: string;
      secret: string;
    }>(observedWorker);
    expect(launched).toMatchObject({
      args: ["agent", "dev", "--no-reload", "src/agent.py"],
      url: LIVEKIT_ENV.LIVEKIT_URL,
      key: LIVEKIT_ENV.LIVEKIT_API_KEY,
      secret: LIVEKIT_ENV.LIVEKIT_API_SECRET,
      egmaUrl: EGMA_ENV.EGMA_URL,
      egmaKey: EGMA_ENV.EGMA_API_KEY,
      futureEgmaSecret: EGMA_ENV.EGMA_FUTURE_SECRET,
    });
    expect(await realpath(launched.cwd)).toBe(await realpath(repository));
    expect(launched.args.join(" ")).not.toContain(LIVEKIT_ENV.LIVEKIT_API_SECRET);

    const preparation = await readJsonLines(observedPreparation);
    expect(preparation).toHaveLength(2);
    for (const command of preparation) {
      expect(command).toMatchObject(NO_PRIVATE_ENV);
    }

    const python = await readJsonLines(observedPython);
    expect(python.map((command) => command.args)).toEqual([
      expect.arrayContaining(["-c"]),
      ["-m", "pip", "install", "-r", await realpath(requirements)],
      expect.arrayContaining(["-c"]),
    ]);
    for (const command of python) {
      expect(command).toMatchObject(NO_PRIVATE_ENV);
    }

    const probe = (python[0]?.args as string[] | undefined)?.[1];
    expect(probe).toEqual(expect.any(String));
    const probeVersion = async (version: string): Promise<number | null> => {
      const site = path.join(root, `site-${version}`);
      const metadata = path.join(site, `egma-${version}.dist-info`);
      await mkdir(metadata, { recursive: true });
      await writeFile(
        path.join(metadata, "METADATA"),
        `Metadata-Version: 2.1\nName: egma\nVersion: ${version}\n`,
        "utf8",
      );
      return spawnSync("python3", ["-c", probe as string], {
        env: { ...process.env, PYTHONPATH: site },
      }).status;
    };
    expect(await probeVersion("0.1.0.dev1")).toBe(1);
    expect(await probeVersion("0.1.0")).toBe(1);
    expect(await probeVersion("0.1.1")).toBe(1);
    expect(await probeVersion("0.1.9")).toBe(1);
    expect(await probeVersion("0.2.0.dev1")).toBe(1);
    expect(await probeVersion("0.2.0")).toBe(0);
    expect(await probeVersion("0.2.0.post1")).toBe(0);
    expect(await probeVersion("0.2.0+local.1")).toBe(0);
    expect(await probeVersion("0.2.1")).toBe(0);
    expect(await probeVersion("1.0.0")).toBe(0);

    const mismatch = await runHelper({
      bin,
      repository,
      entrypoint: "src/agent.py",
      manifest: "requirements.txt",
      dispatchName: "some-other-worker",
      env: {
        ...sharedEnv,
        REGISTRATION_STYLE: "node-json",
        EMIT_SECRET: "true",
      },
      stopWhenReady: false,
    });
    expect(mismatch.code).toBe(1);
    expect(mismatch.stdout).not.toContain("egma:livekit-worker ready");
    expect(mismatch.stderr).toContain(
      'registered worker AW_123 as "front-desk", but Egma will dispatch "some-other-worker"',
    );
    expect(`${mismatch.stdout}\n${mismatch.stderr}`).not.toContain(
      LIVEKIT_ENV.LIVEKIT_API_SECRET,
    );
  });

  it.each([
    { marker: "uv.lock", hasLock: true },
    { marker: "[tool.uv]", hasLock: false },
  ])("prepares the exact nested uv project marked by $marker", async ({ hasLock }) => {
    const { bin, repository, root } = await createFixture("egma-livekit-uv-helper-");
    const project = path.join(repository, "service");
    const marker = path.join(root, "egma-installed");
    const observedUv = path.join(root, "observed-uv.json");
    const observedWorker = path.join(root, "observed-worker.json");
    const uvEnvironment = path.join(root, "uv-environment");
    const unrelatedEnvironment = path.join(root, "unrelated-environment");
    const fakePython = path.join(uvEnvironment, "bin", "python");
    const lock = path.join(project, "uv.lock");
    const lockSource = "version = 1\nrevision = 42\n";
    await Promise.all([
      mkdir(path.join(project, "src"), { recursive: true }),
      mkdir(path.dirname(fakePython), { recursive: true }),
      mkdir(path.join(unrelatedEnvironment, "bin"), { recursive: true }),
    ]);
    await Promise.all([
      writeFile(path.join(project, "src", "agent.py"), "# fixture\n", "utf8"),
      writeFile(
        path.join(project, "pyproject.toml"),
        '[project]\nname = "fixture-agent"\nversion = "0.0.0"\ndependencies = ["livekit-agents>=1.6.7", "egma>=0.2.0"]\n' +
          (hasLock ? "" : "\n[tool.uv]\n"),
        "utf8",
      ),
      writeExecutable(fakePython, FAKE_PYTHON),
      writeExecutable(path.join(unrelatedEnvironment, "bin", "python"), "#!/bin/sh\nexit 0\n"),
      writeExecutable(path.join(bin, "uv"), FAKE_UV),
      writeExecutable(path.join(bin, "lk"), FAKE_LIVEKIT),
    ]);
    if (hasLock) await writeFile(lock, lockSource, "utf8");

    const run = await runHelper({
      bin,
      repository,
      entrypoint: "service/src/agent.py",
      manifest: "service/pyproject.toml",
      dispatchName: "front-desk",
      env: {
        FIXTURE_INSTALLED_MARKER: marker,
        OBSERVED_UV_FILE: observedUv,
        OBSERVED_WORKER_FILE: observedWorker,
        FAKE_UV_PYTHON: fakePython,
        VIRTUAL_ENV: unrelatedEnvironment,
        UV_PROJECT_ENVIRONMENT: uvEnvironment,
        ...LIVEKIT_ENV,
      },
      stopWhenReady: true,
    });

    const uv = await readJson<{
      args: string[];
      cwd: string;
      url: string | null;
      key: string | null;
      secret: string | null;
    }>(observedUv);
    expect(uv).toMatchObject({
      args: ["pip", "install", "--python", fakePython, "-e", "."],
      ...NO_LIVEKIT_ENV,
    });
    expect(await realpath(uv.cwd)).toBe(await realpath(project));
    if (hasLock) expect(await readFile(lock, "utf8")).toBe(lockSource);
    else await expect(readFile(lock, "utf8")).rejects.toThrow();

    const worker = await readJson<{ args: string[]; cwd: string }>(observedWorker);
    expect(worker.args).toEqual(["agent", "dev", "--no-reload", "src/agent.py"]);
    expect(await realpath(worker.cwd)).toBe(await realpath(project));
  });
});
