import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const arguments_ = process.argv.slice(2);
const [packedArgument, liveKitVersion] = arguments_;

if (
  arguments_.length !== 2 ||
  packedArgument === undefined ||
  liveKitVersion === undefined
) {
  throw new Error(
    "usage: node test/verify-packed-compatibility.mjs <@egma/livekit.tgz> <exact @livekit/agents version>",
  );
}
if (!/^\d+\.\d+\.\d+$/u.test(liveKitVersion)) {
  throw new Error(
    `expected an exact stable @livekit/agents version, received ${JSON.stringify(liveKitVersion)}`,
  );
}

const packedPath = path.resolve(packedArgument);
if (!existsSync(packedPath)) {
  throw new Error(`packed SDK does not exist: ${packedPath}`);
}

const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const directory = await mkdtemp(path.join(tmpdir(), "egma-livekit-compat-"));

try {
  await writeFile(
    path.join(directory, "package.json"),
    `${JSON.stringify(
      {
        name: "egma-livekit-packed-compatibility",
        private: true,
        type: "module",
      },
      null,
      2,
    )}\n`,
  );

  run(npm, [
    "install",
    "--no-audit",
    "--no-fund",
    "--save-exact",
    packedPath,
    `@livekit/agents@${liveKitVersion}`,
    "@livekit/rtc-node@0.13.34",
    "zod@4.1.8",
    "typescript@5.9.3",
  ]);

  const installedEgma = JSON.parse(
    await readFile(
      path.join(directory, "node_modules/@egma/livekit/package.json"),
      "utf8",
    ),
  );
  assert.equal(
    installedEgma.peerDependencies["@livekit/agents"],
    ">=1.5.0 <2",
  );

  const installedLiveKit = JSON.parse(
    await readFile(
      path.join(directory, "node_modules/@livekit/agents/package.json"),
      "utf8",
    ),
  );
  assert.equal(installedLiveKit.version, liveKitVersion);

  await writeFile(
    path.join(directory, "consumer.ts"),
    `import { monitor, simulation } from "@egma/livekit";
import { type JobContext, voice } from "@livekit/agents";

export async function integrate(
  agent: voice.Agent,
  ctx: JobContext,
  session: voice.AgentSession,
): Promise<void> {
  monitor(ctx);
  await simulation(agent, ctx, session);
  const isEgmaChat =
    ctx.job.room?.name?.startsWith("egma-sim-chat-") ?? false;
  await session.start({
    agent,
    room: ctx.room,
    ...(isEgmaChat
      ? {
          inputOptions: { audioEnabled: false },
          outputOptions: {
            audioEnabled: false,
            syncTranscription: false,
          },
        }
      : {}),
  });
}
`,
  );
  await writeFile(
    path.join(directory, "tsconfig.json"),
    `${JSON.stringify(
      {
        compilerOptions: {
          target: "ES2023",
          module: "NodeNext",
          moduleResolution: "NodeNext",
          strict: true,
          noEmit: true,
          skipLibCheck: true,
        },
        include: ["consumer.ts"],
      },
      null,
      2,
    )}\n`,
  );
  run(npm, ["exec", "--", "tsc", "-p", "tsconfig.json"]);

  await writeFile(
    path.join(directory, "runtime.mjs"),
    `import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { simulation } from "@egma/livekit";
import { initializeLogger, llm, voice } from "@livekit/agents";
import { z } from "zod";

const liveKitVersion = process.argv[2];
const projectKey = \`egma_sk_\${"a".repeat(43)}\`;
// The discard port: an exporter that is real, and a flush that fails fast
// rather than retrying on a timer while this script waits on it.
const egmaEndpoint = "http://127.0.0.1:9";
const [major, minor, patch] = liveKitVersion.split(".").map(Number);
// Both verbs export spans, so both need LiveKit's public telemetry seam.
// Below it the peer range still installs and the mock-tool hook still
// exists, but a simulation Egma cannot be told about must not run.
const hasTelemetrySeam =
  major > 1 ||
  (major === 1 && (minor > 5 || (minor === 5 && patch >= 5)));
initializeLogger({ pretty: false, level: "silent" });

function forbidReads(target, label) {
  return new Proxy(target, {
    get(_target, property) {
      throw new Error(\`production simulation read \${label}.\${String(property)}\`);
    },
    set(_target, property) {
      throw new Error(\`production simulation wrote \${label}.\${String(property)}\`);
    },
  });
}

function allowReads(target, label, allowed) {
  return new Proxy(target, {
    get(inner, property, receiver) {
      if (allowed.has(property)) {
        return Reflect.get(inner, property, receiver);
      }
      throw new Error(\`production simulation read \${label}.\${String(property)}\`);
    },
    set(_target, property) {
      throw new Error(\`production simulation wrote \${label}.\${String(property)}\`);
    },
  });
}

const productionRoom = allowReads(
  { name: "production-compatibility-room" },
  "context.job.room",
  new Set(["name"]),
);
const productionJob = allowReads(
  { room: productionRoom },
  "context.job",
  new Set(["room"]),
);
const productionContext = allowReads(
  { job: productionJob },
  "context",
  new Set(["job"]),
);
const productionAgent = new voice.Agent({ instructions: "Compatibility check" });
const productionSession = new voice.AgentSession();
const agent = forbidReads(
  productionAgent,
  "agent",
);
const session = forbidReads(productionSession, "session");
await simulation(agent, productionContext, session);
await productionSession.close();

if (!hasTelemetrySeam) {
  // Everything below needs the exporter, and this version has nowhere to
  // install it. A simulation room says so plainly and stops; the production
  // room above stayed inert, which is the whole of what this version can do.
  const belowSeamSession = new voice.AgentSession();
  await assert.rejects(
    simulation(
      new voice.Agent({ instructions: "Compatibility check" }),
      { job: { room: { name: "egma-sim-packed-below-seam" } } },
      belowSeamSession,
      { endpoint: egmaEndpoint, apiKey: projectKey },
    ),
    (error) =>
      error instanceof Error &&
      error.message.includes(
        "requires a supported @livekit/agents version (>=1.5.5 <2)",
      ),
  );
  await belowSeamSession.close();
  process.exit(0);
}

class CompatibilityAgent extends voice.Agent {
  constructor(execute) {
    super({
      instructions: "Calendar compatibility agent",
      tools: [
        llm.tool({
          name: "check_calendar",
          description: "Check the calendar",
          parameters: z.object({ value: z.string() }),
          execute,
        }),
      ],
    });
  }
}

class SimulationRoom extends EventEmitter {
  isConnected = true;
  remoteParticipants = new Map([
    ["egma-persona", { identity: "egma-persona" }],
  ]);
  calls = [];
  localParticipant = {
    performRpc: async (call) => {
      this.calls.push(call);
      if (call.method === "egma.hello") {
        return JSON.stringify({
          protocol_version: 1,
          mocked_tools: ["check_calendar"],
        });
      }
      if (call.method === "egma.tool") {
        return JSON.stringify({ answer: "mocked-calendar" });
      }
      throw new Error(\`unexpected RPC method: \${call.method}\`);
    },
  };
}

function simulationContext(roomName) {
  const room = new SimulationRoom();
  const shutdownCallbacks = [];
  return {
    room,
    shutdownCallbacks,
    value: {
      job: { room: { name: roomName } },
      room,
      async connect() {
        throw new Error("the simulation verb connected an already-connected room");
      },
      addShutdownCallback(callback) {
        shutdownCallbacks.push(callback);
      },
    },
  };
}

function toolCallingSession(input, value) {
  return new voice.AgentSession({
    llm: new voice.testing.FakeLLM([
      {
        input,
        toolCalls: [{ name: "check_calendar", args: { value } }],
      },
    ]),
  });
}

let realToolCalls = 0;
const oneSimulation = simulationContext("egma-sim-packed-compatibility");
oneSimulation.agent = new CompatibilityAgent(async () => {
  realToolCalls += 1;
  return "real-calendar";
});
const simulationSession = toolCallingSession("find a slot", "Tuesday");
await simulation(oneSimulation.agent, oneSimulation.value, simulationSession, {
  endpoint: egmaEndpoint,
  apiKey: projectKey,
});
await simulationSession.start({ agent: oneSimulation.agent });
await simulationSession.run({ userInput: "find a slot" }).wait();

assert.equal(realToolCalls, 0);
assert.deepEqual(
  oneSimulation.room.calls.map(({ method }) => method),
  ["egma.hello", "egma.tool"],
);
assert.deepEqual(
  oneSimulation.room.calls.map(({ responseTimeout }) => responseTimeout),
  [15_000, 45_000],
);
const hello = JSON.parse(oneSimulation.room.calls[0].payload);
assert.deepEqual(hello.tools.map(({ name }) => name), ["check_calendar"]);
assert.deepEqual(JSON.parse(oneSimulation.room.calls[1].payload), {
  name: "check_calendar",
  arguments: { value: "Tuesday" },
});
// Two: the export's own flush goes on first, then the mock table's cleanup.
assert.equal(oneSimulation.shutdownCallbacks.length, 2);

await simulationSession.close();
await Promise.all(
  oneSimulation.shutdownCallbacks.map((callback) => callback()),
);

let realAfterCleanup = 0;
const unwrappedAgent = new CompatibilityAgent(async () => {
  realAfterCleanup += 1;
  return "real-after-cleanup";
});
const unwrappedSession = toolCallingSession("find another slot", "Friday");
await unwrappedSession.start({ agent: unwrappedAgent });
await unwrappedSession.run({ userInput: "find another slot" }).wait();
assert.equal(realAfterCleanup, 1);
assert.equal(oneSimulation.room.calls.length, 2);
await unwrappedSession.close();

// One LiveKit job per process. The mock table releases on close, but the
// exporter's resource carries the room this process files spans under and
// cannot be rewritten — so a second room in this process is refused.
const nextSimulation = simulationContext("egma-sim-packed-owner-release");
const nextAgent = new CompatibilityAgent(async () => "real");
const nextSession = new voice.AgentSession();
await assert.rejects(
  simulation(nextAgent, nextSimulation.value, nextSession, {
    endpoint: egmaEndpoint,
    apiKey: projectKey,
  }),
  (error) =>
    error instanceof Error && error.message.includes("one job per process"),
);
assert.equal(nextSimulation.shutdownCallbacks.length, 0);
await nextSession.close();
`,
  );
  run(process.execPath, ["runtime.mjs", liveKitVersion]);

  // Its own process, because the one above belongs to a simulation room and
  // an exporter belongs to one LiveKit job.
  await writeFile(
    path.join(directory, "monitoring.mjs"),
    `import assert from "node:assert/strict";
import { monitor } from "@egma/livekit";

const liveKitVersion = process.argv[2];
const projectKey = \`egma_sk_\${"a".repeat(43)}\`;

const shutdownCallbacks = [];
const monitoringContext = {
  job: {
    room: { name: \`production-monitoring-\${liveKitVersion}\` },
    agentName: "compatibility-agent",
  },
  addShutdownCallback(callback) {
    shutdownCallbacks.push(callback);
  },
};
const monitoringOptions = {
  endpoint: "http://127.0.0.1:9",
  apiKey: projectKey,
};
const [major, minor, patch] = liveKitVersion.split(".").map(Number);
const hasMonitoringSeam =
  major > 1 ||
  (major === 1 && (minor > 5 || (minor === 5 && patch >= 5)));

if (hasMonitoringSeam) {
  assert.doesNotThrow(() =>
    monitor(monitoringContext, monitoringOptions),
  );
  assert.equal(shutdownCallbacks.length, 1);
} else {
  assert.throws(
    () => monitor(monitoringContext, monitoringOptions),
    (error) =>
      error instanceof Error &&
      error.message.includes(
        "requires a supported @livekit/agents version (>=1.5.5 <2)",
      ),
  );
  assert.equal(shutdownCallbacks.length, 0);
}
`,
  );
  run(process.execPath, ["monitoring.mjs", liveKitVersion]);

  process.stdout.write(
    `packed @egma/livekit is compatible with @livekit/agents@${liveKitVersion}\n`,
  );
} finally {
  await rm(directory, { recursive: true, force: true });
}

function run(command, arguments_) {
  execFileSync(command, arguments_, {
    cwd: directory,
    env: {
      ...process.env,
      EGMA_API_KEY: "",
      EGMA_URL: "",
      LIVEKIT_API_KEY: "",
      LIVEKIT_API_SECRET: "",
      LIVEKIT_URL: "",
      OTEL_EXPORTER_OTLP_ENDPOINT: "",
      OTEL_EXPORTER_OTLP_HEADERS: "",
    },
    stdio: "inherit",
  });
}
