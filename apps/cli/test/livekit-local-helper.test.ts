import { spawn, spawnSync } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

const HELPER = fileURLToPath(
  new URL("../../../skills/integrate-egma/scripts/livekit-local.mjs", import.meta.url),
);
const temporary: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporary.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe.skipIf(process.platform === "win32")("the local LiveKit skill helper", () => {
  it("uses env credentials, waits for registration, redacts output, and stops cleanly", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "egma-livekit-helper-"));
    temporary.push(root);
    const repository = path.join(root, "repository");
    const bin = path.join(root, "bin");
    const observed = path.join(root, "observed.json");
    const observedPreparation = path.join(root, "observed-preparation.jsonl");
    const observedPython = path.join(root, "observed-python.jsonl");
    const installedEgma = path.join(root, "egma-installed");
    await mkdir(path.join(repository, "src"), { recursive: true });
    await mkdir(path.join(repository, ".venv", "bin"), { recursive: true });
    await mkdir(bin);
    await writeFile(path.join(repository, "src", "agent.py"), "# fixture\n", "utf8");
    const requirements = path.join(repository, "requirements.txt");
    await writeFile(requirements, "livekit-agents>=1.6.7\negma>=0.1.0\n", "utf8");

    const fakePython = path.join(repository, ".venv", "bin", "python");
    await writeFile(
      fakePython,
      `#!/usr/bin/env node
import { appendFileSync, existsSync, writeFileSync } from "node:fs";

const args = process.argv.slice(2);
appendFileSync(process.env.OBSERVED_PYTHON_FILE, JSON.stringify({
  args,
  cwd: process.cwd(),
  url: process.env.LIVEKIT_URL ?? null,
  key: process.env.LIVEKIT_API_KEY ?? null,
  secret: process.env.LIVEKIT_API_SECRET ?? null,
}) + "\\n");
if (args[0] === "-c") process.exit(existsSync(process.env.EGMA_INSTALLED_MARKER) ? 0 : 1);
if (args[0] === "-m" && args[1] === "pip" && args[2] === "install" && args[3] === "-r") {
  writeFileSync(process.env.EGMA_INSTALLED_MARKER, "0.1.0\\n");
  process.exit(0);
}
process.exit(2);
`,
      { mode: 0o755 },
    );
    await chmod(fakePython, 0o755);

    const fakeLiveKit = path.join(bin, "lk");
    await writeFile(
      fakeLiveKit,
      `#!/usr/bin/env node
import { appendFileSync, writeFileSync } from "node:fs";

const args = process.argv.slice(2);
if (args.join(" ") === "--version" || args.join(" ") === "agent dev --help") {
  appendFileSync(process.env.OBSERVED_PREPARATION_FILE, JSON.stringify({
    args,
    url: process.env.LIVEKIT_URL ?? null,
    key: process.env.LIVEKIT_API_KEY ?? null,
    secret: process.env.LIVEKIT_API_SECRET ?? null,
  }) + "\\n");
}
if (args.join(" ") === "--version") {
  process.stdout.write("lk version 2.18.3\\n");
  process.exit(0);
}
if (args.join(" ") === "agent dev --help") process.exit(0);

writeFileSync(process.env.OBSERVED_FILE, JSON.stringify({
  args,
  cwd: process.cwd(),
  url: process.env.LIVEKIT_URL,
  key: process.env.LIVEKIT_API_KEY,
  secret: process.env.LIVEKIT_API_SECRET,
}));
const secret = process.env.LIVEKIT_API_SECRET;
process.stdout.write("worker secret=" + secret.slice(0, 5));
setTimeout(() => process.stdout.write(secret.slice(5) + "\\n"), 5);
setTimeout(() => process.stdout.write("registered worker will appear later\\n"), 10);
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
  process.stdout.write(
    "12:00:00 INFO livekit.agents registered worker {\\\"agent_name\\\":\\\"front-desk\\\",\\\"id\\\":\\\"AW_123\\\"}\\n",
  );
}, 20);
process.on("SIGTERM", () => process.exit(0));
setInterval(() => {}, 1_000);
`,
      { mode: 0o755 },
    );
    await chmod(fakeLiveKit, 0o755);

    const secret = "livekit-secret-value";
    const child = spawn(
      process.execPath,
      [
        HELPER,
        "--cwd",
        repository,
        "--entrypoint",
        "src/agent.py",
        "--dependency-manifest",
        "requirements.txt",
        "--dispatch-name",
        "front-desk",
      ],
      {
        env: {
          ...process.env,
          PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
          OBSERVED_FILE: observed,
          OBSERVED_PREPARATION_FILE: observedPreparation,
          OBSERVED_PYTHON_FILE: observedPython,
          EGMA_INSTALLED_MARKER: installedEgma,
          LIVEKIT_URL: "wss://example.livekit.cloud",
          LIVEKIT_API_KEY: "livekit-secret",
          LIVEKIT_API_SECRET: secret,
          REGISTRATION_STYLE: "node-pretty",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error(`helper did not become ready\nstdout: ${stdout}\nstderr: ${stderr}`)),
        5_000,
      );
      const inspect = () => {
        if (!stdout.split(/\r?\n/u).includes("egma:livekit-worker ready")) return;
        clearTimeout(timeout);
        resolve();
      };
      child.stdout.on("data", inspect);
      child.once("exit", (code) => {
        clearTimeout(timeout);
        reject(new Error(`helper exited before readiness with ${String(code)}`));
      });
    });

    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolve) => child.once("exit", (code, signal) => resolve({ code, signal })),
    );
    child.kill("SIGTERM");
    const exit = await exited;

    expect(exit).toEqual({ code: 0, signal: null });
    const lines = stdout.split(/\r?\n/u);
    const registration = lines.findIndex((line) => line.includes("registered worker"));
    const ready = lines.indexOf("egma:livekit-worker ready");
    expect(registration).toBeGreaterThanOrEqual(0);
    expect(ready).toBeGreaterThan(registration);
    expect(lines.filter((line) => line === "egma:livekit-worker ready")).toHaveLength(1);
    expect(`${stdout}\n${stderr}`).not.toContain(secret);
    expect(`${stdout}\n${stderr}`).not.toContain("-value");
    expect(stdout).toContain("worker secret=[REDACTED]");

    const launched = JSON.parse(await readFile(observed, "utf8")) as {
      args: string[];
      cwd: string;
      url: string;
      key: string;
      secret: string;
    };
    expect(launched).toMatchObject({
      args: ["agent", "dev", "--no-reload", "src/agent.py"],
      url: "wss://example.livekit.cloud",
      key: "livekit-secret",
      secret,
    });
    expect(await realpath(launched.cwd)).toBe(await realpath(repository));
    expect(launched.args.join(" ")).not.toContain(secret);

    const preparation = (await readFile(observedPreparation, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(preparation).toHaveLength(2);
    for (const command of preparation) {
      expect(command).toMatchObject({ url: null, key: null, secret: null });
    }

    const python = (await readFile(observedPython, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(python.map((command) => command.args)).toEqual([
      expect.arrayContaining(["-c"]),
      ["-m", "pip", "install", "-r", requirements],
      expect.arrayContaining(["-c"]),
    ]);
    for (const command of python) {
      expect(command).toMatchObject({ url: null, key: null, secret: null });
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
    expect(await probeVersion("0.1.0")).toBe(0);
    expect(await probeVersion("0.1.0.post1")).toBe(0);
    expect(await probeVersion("0.1.0+local.1")).toBe(0);

    const mismatched = spawn(
      process.execPath,
      [
        HELPER,
        "--cwd",
        repository,
        "--entrypoint",
        "src/agent.py",
        "--dependency-manifest",
        "requirements.txt",
        "--dispatch-name",
        "some-other-worker",
      ],
      {
        env: {
          ...process.env,
          PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
          OBSERVED_FILE: observed,
          OBSERVED_PREPARATION_FILE: observedPreparation,
          OBSERVED_PYTHON_FILE: observedPython,
          EGMA_INSTALLED_MARKER: installedEgma,
          LIVEKIT_URL: "wss://example.livekit.cloud",
          LIVEKIT_API_KEY: "livekit-secret",
          LIVEKIT_API_SECRET: secret,
          REGISTRATION_STYLE: "node-json",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let mismatchOut = "";
    let mismatchError = "";
    mismatched.stdout.setEncoding("utf8");
    mismatched.stderr.setEncoding("utf8");
    mismatched.stdout.on("data", (chunk) => {
      mismatchOut += chunk;
    });
    mismatched.stderr.on("data", (chunk) => {
      mismatchError += chunk;
    });
    const mismatchExit = await new Promise<number | null>((resolve) =>
      mismatched.once("exit", resolve),
    );
    expect(mismatchExit).toBe(1);
    expect(mismatchOut).not.toContain("egma:livekit-worker ready");
    expect(mismatchError).toContain(
      'registered worker AW_123 as "front-desk", but Egma will dispatch "some-other-worker"',
    );
    expect(`${mismatchOut}\n${mismatchError}`).not.toContain(secret);
  });

  it.each([
    { marker: "uv.lock", hasLock: true },
    { marker: "[tool.uv]", hasLock: false },
  ])("prepares the exact nested uv project marked by $marker", async ({ hasLock }) => {
    const root = await mkdtemp(path.join(tmpdir(), "egma-livekit-uv-helper-"));
    temporary.push(root);
    const repository = path.join(root, "repository");
    const project = path.join(repository, "service");
    const bin = path.join(root, "bin");
    const marker = path.join(root, "egma-installed");
    const observedUv = path.join(root, "observed-uv.json");
    const observedWorker = path.join(root, "observed-worker.json");
    const uvEnvironment = path.join(root, "uv-environment");
    const unrelatedEnvironment = path.join(root, "unrelated-environment");
    const lock = path.join(project, "uv.lock");
    const lockSource = "version = 1\nrevision = 42\n";
    await mkdir(path.join(project, "src"), { recursive: true });
    await mkdir(path.join(uvEnvironment, "bin"), { recursive: true });
    await mkdir(path.join(unrelatedEnvironment, "bin"), { recursive: true });
    await mkdir(bin);
    await writeFile(path.join(project, "src", "agent.py"), "# fixture\n", "utf8");
    await writeFile(
      path.join(project, "pyproject.toml"),
      '[project]\nname = "fixture-agent"\nversion = "0.0.0"\ndependencies = ["livekit-agents>=1.6.7", "egma>=0.1.0"]\n' +
        (hasLock ? "" : "\n[tool.uv]\n"),
      "utf8",
    );
    if (hasLock) await writeFile(lock, lockSource, "utf8");

    const fakePython = path.join(uvEnvironment, "bin", "python");
    await writeFile(
      fakePython,
      `#!/usr/bin/env node
import { existsSync } from "node:fs";
const args = process.argv.slice(2);
if (args[0] === "-c") process.exit(existsSync(process.env.EGMA_INSTALLED_MARKER) ? 0 : 1);
process.exit(2);
`,
      { mode: 0o755 },
    );
    await chmod(fakePython, 0o755);
    const unrelatedPython = path.join(unrelatedEnvironment, "bin", "python");
    await writeFile(unrelatedPython, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    await chmod(unrelatedPython, 0o755);

    const fakeUv = path.join(bin, "uv");
    await writeFile(
      fakeUv,
      `#!/usr/bin/env node
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
writeFileSync(process.env.EGMA_INSTALLED_MARKER, "0.1.0\\n");
`,
      { mode: 0o755 },
    );
    await chmod(fakeUv, 0o755);

    const fakeLiveKit = path.join(bin, "lk");
    await writeFile(
      fakeLiveKit,
      `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
const args = process.argv.slice(2);
if (args.join(" ") === "--version") {
  process.stdout.write("lk version 2.18.3\\n");
  process.exit(0);
}
if (args.join(" ") === "agent dev --help") process.exit(0);
writeFileSync(process.env.OBSERVED_WORKER_FILE, JSON.stringify({
  args,
  cwd: process.cwd(),
}));
process.stdout.write(JSON.stringify({
  message: "registered worker",
  id: "AW_uv",
  agent_name: "front-desk",
}) + "\\n");
process.on("SIGTERM", () => process.exit(0));
setInterval(() => {}, 1_000);
`,
      { mode: 0o755 },
    );
    await chmod(fakeLiveKit, 0o755);

    const child = spawn(
      process.execPath,
      [
        HELPER,
        "--cwd",
        repository,
        "--entrypoint",
        "service/src/agent.py",
        "--dependency-manifest",
        "service/pyproject.toml",
        "--dispatch-name",
        "front-desk",
      ],
      {
        env: {
          ...process.env,
          PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
          EGMA_INSTALLED_MARKER: marker,
          OBSERVED_UV_FILE: observedUv,
          OBSERVED_WORKER_FILE: observedWorker,
          FAKE_UV_PYTHON: fakePython,
          VIRTUAL_ENV: unrelatedEnvironment,
          UV_PROJECT_ENVIRONMENT: uvEnvironment,
          LIVEKIT_URL: "wss://example.livekit.cloud",
          LIVEKIT_API_KEY: "livekit-secret",
          LIVEKIT_API_SECRET: "livekit-secret-value",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error(`uv helper did not become ready\n${stdout}\n${stderr}`)),
        5_000,
      );
      child.stdout.on("data", () => {
        if (!stdout.includes("egma:livekit-worker ready")) return;
        clearTimeout(timeout);
        resolve();
      });
      child.once("exit", (code) => {
        clearTimeout(timeout);
        reject(new Error(`uv helper exited before readiness with ${String(code)}`));
      });
    });
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    child.kill("SIGTERM");
    await exited;

    const uv = JSON.parse(await readFile(observedUv, "utf8")) as {
      args: string[];
      cwd: string;
      url: string | null;
      key: string | null;
      secret: string | null;
    };
    expect(uv).toMatchObject({
      args: ["pip", "install", "--python", fakePython, "-e", "."],
      url: null,
      key: null,
      secret: null,
    });
    expect(await realpath(uv.cwd)).toBe(await realpath(project));
    if (hasLock) expect(await readFile(lock, "utf8")).toBe(lockSource);
    else await expect(readFile(lock, "utf8")).rejects.toThrow();
    const worker = JSON.parse(await readFile(observedWorker, "utf8")) as {
      args: string[];
      cwd: string;
    };
    expect(worker.args).toEqual([
      "agent",
      "dev",
      "--no-reload",
      "src/agent.py",
    ]);
    expect(await realpath(worker.cwd)).toBe(await realpath(project));
  });
});
