#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";

const MINIMUM_VERSION = [2, 18, 2];
const MINIMUM_EGMA_VERSION = [0, 1, 0];
const LIVEKIT_INSTALLER = "https://get.livekit.io/cli";
const REQUIRED_ENV = ["LIVEKIT_URL", "LIVEKIT_API_KEY", "LIVEKIT_API_SECRET"];
const PREPARATION_SECRETS = [...REQUIRED_ENV, "EGMA_URL", "EGMA_API_KEY"];
const READY_MARKER = "egma:livekit-worker ready";
const ANSI_ESCAPE = /\u001B(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001B\\))/gu;

const usage = `Usage:
  node livekit-local.mjs --cwd <repository-root> --entrypoint <repository-relative-file> --dependency-manifest <repository-relative-file> --dispatch-name <agent-name>

The LiveKit credentials must be supplied through LIVEKIT_URL, LIVEKIT_API_KEY,
and LIVEKIT_API_SECRET. They are never accepted as command-line arguments.`;

function fail(message) {
  process.stderr.write(`livekit-local: ${message}\n`);
  process.exitCode = 1;
}

function parseArguments(argv) {
  if (argv.includes("--help") || argv.includes("-h")) return { help: true };
  let cwd = null;
  let entrypoint = null;
  let dependencyManifest = null;
  let dispatchName = null;
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (
      flag !== "--cwd" &&
      flag !== "--entrypoint" &&
      flag !== "--dependency-manifest" &&
      flag !== "--dispatch-name"
    ) {
      throw new Error(`unknown argument ${flag ?? ""}`.trim());
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`${flag} requires a value`);
    }
    if (flag === "--cwd") cwd = value;
    else if (flag === "--entrypoint") entrypoint = value;
    else if (flag === "--dependency-manifest") dependencyManifest = value;
    else dispatchName = value;
    index += 1;
  }
  if (cwd === null) throw new Error("--cwd is required");
  if (entrypoint === null) throw new Error("--entrypoint is required");
  if (dependencyManifest === null) {
    throw new Error("--dependency-manifest is required");
  }
  if (dispatchName === null || dispatchName.trim() === "") {
    throw new Error("--dispatch-name is required");
  }
  return {
    help: false,
    cwd,
    entrypoint,
    dependencyManifest,
    dispatchName: dispatchName.trim(),
  };
}

function executable(name) {
  return process.platform === "win32" ? `${name}.exe` : name;
}

function withoutRuntimeCredentials(env = process.env) {
  const safe = { ...env };
  for (const name of PREPARATION_SECRETS) delete safe[name];
  return safe;
}

const PREPARATION_ENV = withoutRuntimeCredentials();

function commandOutput(command, args) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    windowsHide: true,
    env: PREPARATION_ENV,
  });
  if (result.error !== undefined || result.status !== 0) return null;
  return `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim();
}

function installedVersion() {
  const output = commandOutput(executable("lk"), ["--version"]);
  if (output === null) return null;
  const match = /\b(\d+)\.(\d+)\.(\d+)\b/u.exec(output);
  return match === null
    ? null
    : [Number(match[1]), Number(match[2]), Number(match[3])];
}

function versionText(version) {
  return version === null ? "not installed" : version.join(".");
}

function meetsMinimum(version) {
  if (version === null) return false;
  for (let index = 0; index < MINIMUM_VERSION.length; index += 1) {
    const actual = version[index] ?? 0;
    const required = MINIMUM_VERSION[index] ?? 0;
    if (actual !== required) return actual > required;
  }
  return true;
}

async function run(command, args, options = {}) {
  const code = await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? PREPARATION_ENV,
      stdio: "inherit",
      windowsHide: true,
    });
    child.once("error", reject);
    child.once("exit", (status, signal) => {
      if (signal !== null) reject(new Error(`${command} stopped from ${signal}`));
      else resolve(status ?? 1);
    });
  });
  if (code !== 0 && options.allowFailure !== true) {
    throw new Error(`${command} exited with status ${String(code)}`);
  }
  return code;
}

async function installOrUpgrade(current) {
  process.stderr.write(
    `livekit-local: LiveKit CLI ${versionText(current)}; 2.18.2 or newer is required.\n`,
  );

  if (process.platform === "darwin") {
    if (commandOutput(executable("brew"), ["--version"]) === null) {
      throw new Error("Homebrew is required to install LiveKit CLI on macOS");
    }
    const installedByBrew = commandOutput(executable("brew"), [
      "list",
      "--versions",
      "livekit-cli",
    ]);
    await run(executable("brew"), [
      installedByBrew === null ? "install" : "upgrade",
      "livekit-cli",
    ]);
    return;
  }

  if (process.platform === "linux") {
    const response = await fetch(LIVEKIT_INSTALLER, { redirect: "follow" });
    if (!response.ok) {
      throw new Error(`LiveKit's Linux installer returned HTTP ${String(response.status)}`);
    }
    const temporary = await mkdtemp(path.join(tmpdir(), "egma-livekit-cli-"));
    const installer = path.join(temporary, "install-cli.sh");
    try {
      await writeFile(installer, await response.text(), { mode: 0o700 });
      await run(executable("bash"), [installer]);
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
    return;
  }

  if (process.platform === "win32") {
    if (commandOutput(executable("winget"), ["--version"]) === null) {
      throw new Error("winget is required to install LiveKit CLI on Windows");
    }
    const action = current === null ? "install" : "upgrade";
    await run(executable("winget"), [
      action,
      "--id",
      "LiveKit.LiveKitCLI",
      "--exact",
      "--accept-package-agreements",
      "--accept-source-agreements",
    ]);
    return;
  }

  throw new Error(`LiveKit CLI installation is not supported on ${process.platform}`);
}

async function prepareLiveKitCli() {
  let version = installedVersion();
  if (!meetsMinimum(version)) {
    await installOrUpgrade(version);
    version = installedVersion();
  }
  if (!meetsMinimum(version)) {
    throw new Error(
      `LiveKit CLI ${versionText(version)} is still below required version 2.18.2`,
    );
  }
  if (commandOutput(executable("lk"), ["agent", "dev", "--help"]) === null) {
    throw new Error("this LiveKit CLI does not provide `lk agent dev`");
  }
  process.stderr.write(`livekit-local: using LiveKit CLI ${versionText(version)}.\n`);
}

async function fileInside(cwd, value, label) {
  const candidate = path.resolve(cwd, value);
  const below = path.relative(cwd, candidate);
  if (below === "" || below.startsWith("..") || path.isAbsolute(below)) {
    throw new Error(`${label} must name a file inside --cwd`);
  }
  if (!(await stat(candidate)).isFile()) throw new Error(`${candidate} is not a file`);
  return { absolute: candidate, relative: below };
}

async function workerArguments(cwdValue, entrypointValue, dependencyValue) {
  const repository = path.resolve(cwdValue);
  if (!(await stat(repository)).isDirectory()) {
    throw new Error(`${repository} is not a directory`);
  }
  const entrypoint = await fileInside(
    repository,
    entrypointValue,
    "--entrypoint",
  );
  const dependency = await fileInside(
    repository,
    dependencyValue,
    "--dependency-manifest",
  );
  const dependencyName = path.basename(dependency.absolute).toLowerCase();
  if (
    dependencyName !== "pyproject.toml" &&
    dependencyName !== "requirements.txt"
  ) {
    throw new Error(
      "--dependency-manifest must be pyproject.toml or requirements.txt",
    );
  }
  const projectDir = path.dirname(dependency.absolute);
  const projectEntrypoint = path.relative(projectDir, entrypoint.absolute);
  if (
    projectEntrypoint === "" ||
    projectEntrypoint.startsWith("..") ||
    path.isAbsolute(projectEntrypoint)
  ) {
    throw new Error(
      "--dependency-manifest must be in the LiveKit worker's project directory",
    );
  }
  return {
    cwd: projectDir,
    entrypoint: projectEntrypoint,
    dependencyManifest: dependency,
  };
}

async function exists(file) {
  try {
    return (await stat(file)).isFile();
  } catch {
    return false;
  }
}

function egmaVersionProbe() {
  return [
    "import importlib.metadata as m",
    "import re",
    'match = re.fullmatch(r"(\\d+)(?:\\.(\\d+))?(?:\\.(\\d+))?(?:\\.post\\d+)?(?:\\+[a-z0-9]+(?:[._-][a-z0-9]+)*)?", m.version("egma"), re.I)',
    "found = tuple(int(part or 0) for part in match.groups()) if match else ()",
    `raise SystemExit(0 if found >= (${MINIMUM_EGMA_VERSION.join(", ")}) else 1)`,
  ].join("; ");
}

async function localPython(projectDir) {
  const names =
    process.platform === "win32"
      ? [path.join("Scripts", "python.exe")]
      : [path.join("bin", "python")];
  const roots = [
    process.env.VIRTUAL_ENV ?? "",
    path.join(projectDir, ".venv"),
    path.join(projectDir, "venv"),
  ].filter((value) => value !== "");
  for (const root of roots) {
    for (const name of names) {
      const candidate = path.join(root, name);
      if (await exists(candidate)) return candidate;
    }
  }
  return null;
}

async function uvProjectPython(uv, projectDir) {
  const result = spawnSync(
    uv,
    [
      "run",
      "--no-sync",
      "python",
      "-c",
      "import sys; print(sys.executable)",
    ],
    {
      cwd: projectDir,
      env: PREPARATION_ENV,
      encoding: "utf8",
      windowsHide: true,
    },
  );
  if (result.error !== undefined || result.status !== 0) {
    throw new Error("uv could not resolve the LiveKit worker's Python runtime");
  }
  const printed = `${result.stdout ?? ""}`
    .trim()
    .split(/\r?\n/u)
    .filter((line) => line.trim() !== "")
    .at(-1);
  if (printed === undefined) {
    throw new Error("uv reported no Python runtime for the LiveKit worker");
  }
  const python = path.resolve(projectDir, printed.trim());
  if (!(await exists(python))) {
    throw new Error(`uv reported a Python runtime that does not exist: ${python}`);
  }
  return python;
}

async function isUvProject(worker, uvLock) {
  if (await exists(uvLock)) return true;
  if (
    path.basename(worker.dependencyManifest.absolute).toLowerCase() !==
    "pyproject.toml"
  ) {
    return false;
  }
  const source = await readFile(worker.dependencyManifest.absolute, "utf8");
  return /(?:^|\n)\s*\[tool\.uv\]\s*(?:#.*)?(?:\n|$)/u.test(source);
}

function availableCommand(name) {
  return commandOutput(executable(name), ["--version"]) === null
    ? null
    : executable(name);
}

async function pythonEnvironment(worker) {
  const projectDir = path.dirname(worker.dependencyManifest.absolute);
  const uvLock = path.join(projectDir, "uv.lock");
  const uv = availableCommand("uv");
  const usesUv = await isUvProject(worker, uvLock);
  if (usesUv && uv === null) {
    throw new Error("uv is required to run this LiveKit worker project");
  }
  if (usesUv && uv !== null) {
    const python = await uvProjectPython(uv, projectDir);
    return {
      command: python,
      prefix: [],
      installCommand: uv,
      installArguments: ["pip", "install", "--python", python, "-e", "."],
      projectDir,
    };
  }

  let python = await localPython(projectDir);
  if (python === null) {
    const system = availableCommand("python3") ?? availableCommand("python");
    if (system === null) {
      throw new Error(
        "no Python runtime is available for the LiveKit worker; install Python and run Egma again",
      );
    }
    const environment = path.join(projectDir, ".venv");
    await run(system, ["-m", "venv", environment], {
      cwd: projectDir,
      env: PREPARATION_ENV,
    });
    python = await localPython(projectDir);
    if (python === null) {
      throw new Error("Python did not create the expected .venv for the LiveKit worker");
    }
  }

  const manifest = path.basename(worker.dependencyManifest.absolute).toLowerCase();
  const requirements = manifest === "requirements.txt";
  return {
    command: python,
    prefix: [],
    installCommand: python,
    installArguments: requirements
      ? ["-m", "pip", "install", "-r", worker.dependencyManifest.absolute]
      : ["-m", "pip", "install", "-e", "."],
    projectDir,
  };
}

function pythonSucceeds(runtime, args) {
  const result = spawnSync(runtime.command, [...runtime.prefix, ...args], {
    cwd: runtime.projectDir,
    env: PREPARATION_ENV,
    encoding: "utf8",
    windowsHide: true,
  });
  return result.error === undefined && result.status === 0;
}

async function prepareEgmaDependency(worker) {
  const runtime = await pythonEnvironment(worker);
  const probe = ["-c", egmaVersionProbe()];
  if (pythonSucceeds(runtime, probe)) {
    process.stderr.write("livekit-local: Egma Python SDK 0.1.0 or newer is ready.\n");
    return;
  }

  process.stderr.write(
    "livekit-local: installing the declared Egma Python SDK into this worker environment.\n",
  );
  await run(runtime.installCommand, runtime.installArguments, {
    cwd: runtime.projectDir,
    env: PREPARATION_ENV,
  });
  if (!pythonSucceeds(runtime, probe)) {
    throw new Error(
      "the worker environment still cannot import Egma Python SDK 0.1.0 or newer after dependency installation",
    );
  }
}

function redact(text) {
  const secrets = REQUIRED_ENV.map((name) => process.env[name] ?? "")
    .filter((secret) => secret !== "")
    .sort((left, right) => right.length - left.length);
  return secrets.reduce((result, secret) => result.replaceAll(secret, "[REDACTED]"), text);
}

function structuredWorkerRegistration(plain) {
  let record;
  try {
    record = JSON.parse(plain);
  } catch {
    return null;
  }
  if (record === null || typeof record !== "object") return null;
  const message =
    typeof record.message === "string"
      ? record.message
      : typeof record.msg === "string"
        ? record.msg
        : null;
  if (
    message !== "registered worker" ||
    typeof record.id !== "string" ||
    record.id === ""
  ) {
    return null;
  }
  const agentName =
    typeof record.agent_name === "string"
      ? record.agent_name
      : typeof record.agentName === "string"
        ? record.agentName
        : null;
  return { id: record.id, agentName };
}

function scalarField(plain, names) {
  const keys = names.join("|");
  const match = new RegExp(
    `\\b["']?(?:${keys})["']?\\s*[:=]\\s*(?:"([^"]*)"|'([^']*)'|([^\\s,}]+))`,
    "iu",
  ).exec(plain);
  if (match === null) return undefined;
  const value = match[1] ?? match[2] ?? match[3] ?? "";
  return value === "null" || value === "undefined" ? null : value;
}

/**
 * Parse both SDK log formats. Python writes one structured line. Agents-JS
 * uses Pino, whose development formatter puts `id` and `agentName` on later
 * lines, so one bounded registration block must be held across line events.
 */
function registrationObserver() {
  let pending = null;

  return (line) => {
    const plain = line.replaceAll(ANSI_ESCAPE, "").trim();
    if (plain === "") return null;

    const structured = structuredWorkerRegistration(plain);
    if (structured !== null) {
      pending = null;
      return structured;
    }

    if (/\bregistered worker\b/iu.test(plain)) {
      pending = { id: undefined, agentName: undefined, remaining: 24 };
    }
    if (pending === null) return null;

    const id = scalarField(plain, ["id", "worker_id"]);
    const agentName = scalarField(plain, ["agent_name", "agentName"]);
    if (typeof id === "string" && id !== "") pending.id = id;
    if (agentName !== undefined) pending.agentName = agentName;

    if (pending.id !== undefined && pending.agentName !== undefined) {
      const registration = {
        id: pending.id,
        agentName: pending.agentName,
      };
      pending = null;
      return registration;
    }

    pending.remaining -= 1;
    if (pending.remaining === 0) pending = null;
    return null;
  };
}

function relayLines(readable, writable, onLine) {
  let buffered = "";

  const flushCompleteLines = () => {
    while (true) {
      const match = /\r\n|\n|\r/u.exec(buffered);
      if (match === null) return;
      const end = match.index + match[0].length;
      const line = buffered.slice(0, match.index);
      const output = buffered.slice(0, end);
      buffered = buffered.slice(end);
      writable.write(redact(output));
      onLine(line);
    }
  };

  readable.setEncoding("utf8");
  readable.on("data", (chunk) => {
    buffered += chunk;
    flushCompleteLines();
  });
  readable.on("end", () => {
    if (buffered === "") return;
    const line = buffered;
    buffered = "";
    writable.write(redact(line));
    onLine(line);
  });
}

function terminateWorkerTree(child, signal) {
  if (process.platform !== "win32" || child.pid === undefined) {
    if (!child.killed) child.kill(signal);
    return;
  }
  const result = spawnSync(executable("taskkill"), [
    "/pid",
    String(child.pid),
    "/t",
    ...(signal === "SIGKILL" ? ["/f"] : []),
  ], {
    env: PREPARATION_ENV,
    stdio: "ignore",
    windowsHide: true,
  });
  if ((result.error !== undefined || result.status !== 0) && !child.killed) {
    child.kill(signal);
  }
}

async function runWorker(cwd, entrypoint, expectedDispatchName) {
  const child = spawn(
    executable("lk"),
    ["agent", "dev", "--no-reload", entrypoint],
    {
      cwd,
      env: process.env,
      stdio: ["inherit", "pipe", "pipe"],
      windowsHide: true,
    },
  );

  let ready = false;
  let terminating = false;
  let registrationFailure = null;
  const observeRegistration = registrationObserver();
  const forward = (signal) => {
    terminating = true;
    terminateWorkerTree(child, signal);
  };
  const observe = (line) => {
    if (ready || registrationFailure !== null) return;
    const registration = observeRegistration(line);
    if (registration === null) return;
    if (registration.agentName !== expectedDispatchName) {
      registrationFailure =
        `registered worker ${registration.id} as ${JSON.stringify(registration.agentName ?? "<unnamed>")}, ` +
        `but Egma will dispatch ${JSON.stringify(expectedDispatchName)}`;
      process.stderr.write(`livekit-local: ${registrationFailure}.\n`);
      forward("SIGTERM");
      return;
    }
    ready = true;
    process.stdout.write(`${READY_MARKER}\n`);
  };
  relayLines(child.stdout, process.stdout, observe);
  relayLines(child.stderr, process.stderr, observe);

  const interrupt = () => forward("SIGINT");
  const terminate = () => forward("SIGTERM");
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", terminate);

  const status = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (terminating || signal !== null) resolve(0);
      else resolve(code ?? 1);
    });
  });
  process.off("SIGINT", interrupt);
  process.off("SIGTERM", terminate);
  if (registrationFailure !== null) throw new Error(registrationFailure);
  process.exitCode = status;
}

async function main() {
  const parsed = parseArguments(process.argv.slice(2));
  if (parsed.help) {
    process.stdout.write(`${usage}\n`);
    return;
  }

  const missing = REQUIRED_ENV.filter((name) => (process.env[name] ?? "").trim() === "");
  if (missing.length > 0) {
    throw new Error(`missing required environment variables: ${missing.join(", ")}`);
  }

  const worker = await workerArguments(
    parsed.cwd,
    parsed.entrypoint,
    parsed.dependencyManifest,
  );
  await prepareLiveKitCli();
  await prepareEgmaDependency(worker);
  await runWorker(worker.cwd, worker.entrypoint, parsed.dispatchName);
}

main().catch((error) => fail(error instanceof Error ? error.message : String(error)));
