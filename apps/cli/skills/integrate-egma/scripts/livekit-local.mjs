#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";

const MINIMUM_VERSION = [2, 18, 2];
const LIVEKIT_INSTALLER = "https://get.livekit.io/cli";
const REQUIRED_ENV = ["LIVEKIT_URL", "LIVEKIT_API_KEY", "LIVEKIT_API_SECRET"];
const READY_MARKER = "egma:livekit-worker ready";
const ANSI_ESCAPE = /\u001B(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001B\\))/gu;

const usage = `Usage:
  node livekit-local.mjs --cwd <repository-root> --entrypoint <repository-relative-file> --dispatch-name <agent-name>

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
  let dispatchName = null;
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag !== "--cwd" && flag !== "--entrypoint" && flag !== "--dispatch-name") {
      throw new Error(`unknown argument ${flag ?? ""}`.trim());
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`${flag} requires a value`);
    }
    if (flag === "--cwd") cwd = value;
    else if (flag === "--entrypoint") entrypoint = value;
    else dispatchName = value;
    index += 1;
  }
  if (cwd === null) throw new Error("--cwd is required");
  if (entrypoint === null) throw new Error("--entrypoint is required");
  if (dispatchName === null || dispatchName.trim() === "") {
    throw new Error("--dispatch-name is required");
  }
  return { help: false, cwd, entrypoint, dispatchName: dispatchName.trim() };
}

function executable(name) {
  return process.platform === "win32" ? `${name}.exe` : name;
}

function withoutLiveKitCredentials(env = process.env) {
  const safe = { ...env };
  for (const name of REQUIRED_ENV) delete safe[name];
  return safe;
}

const PREPARATION_ENV = withoutLiveKitCredentials();

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

async function workerArguments(cwdValue, entrypointValue) {
  const cwd = path.resolve(cwdValue);
  if (!(await stat(cwd)).isDirectory()) throw new Error(`${cwd} is not a directory`);

  const entrypoint = path.resolve(cwd, entrypointValue);
  const below = path.relative(cwd, entrypoint);
  if (below === "" || below.startsWith("..") || path.isAbsolute(below)) {
    throw new Error("--entrypoint must name a file inside --cwd");
  }
  if (!(await stat(entrypoint)).isFile()) throw new Error(`${entrypoint} is not a file`);
  return { cwd, entrypoint: below };
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

  const worker = await workerArguments(parsed.cwd, parsed.entrypoint);
  await prepareLiveKitCli();
  await runWorker(worker.cwd, worker.entrypoint, parsed.dispatchName);
}

main().catch((error) => fail(error instanceof Error ? error.message : String(error)));
