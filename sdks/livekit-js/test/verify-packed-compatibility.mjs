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
    `import { mockable, monitorLiveKit } from "@egma/livekit";
import { type JobContext, voice } from "@livekit/agents";

export async function integrate(
  agent: voice.Agent,
  ctx: JobContext,
  session: voice.AgentSession,
): Promise<void> {
  monitorLiveKit(ctx);
  await mockable(agent, ctx, session);
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
import { mockable, monitorLiveKit } from "@egma/livekit";
import { initializeLogger, llm, voice } from "@livekit/agents";
import { z } from "zod";

const liveKitVersion = process.argv[2];
const projectKey = \`egma_sk_\${"a".repeat(43)}\`;
initializeLogger({ pretty: false, level: "silent" });

function forbidReads(target, label) {
  return new Proxy(target, {
    get(_target, property) {
      throw new Error(\`production mockable read \${label}.\${String(property)}\`);
    },
    set(_target, property) {
      throw new Error(\`production mockable wrote \${label}.\${String(property)}\`);
    },
  });
}

function allowReads(target, label, allowed) {
  return new Proxy(target, {
    get(inner, property, receiver) {
      if (allowed.has(property)) {
        return Reflect.get(inner, property, receiver);
      }
      throw new Error(\`production mockable read \${label}.\${String(property)}\`);
    },
    set(_target, property) {
      throw new Error(\`production mockable wrote \${label}.\${String(property)}\`);
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
await mockable(agent, productionContext, session);
await productionSession.close();

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
        throw new Error("mockable connected an already-connected room");
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
const simulation = simulationContext("egma-sim-packed-compatibility");
const simulationAgent = new CompatibilityAgent(async () => {
  realToolCalls += 1;
  return "real-calendar";
});
const simulationSession = toolCallingSession("find a slot", "Tuesday");
await mockable(simulationAgent, simulation.value, simulationSession);
await simulationSession.start({ agent: simulationAgent });
await simulationSession.run({ userInput: "find a slot" }).wait();

assert.equal(realToolCalls, 0);
assert.deepEqual(
  simulation.room.calls.map(({ method }) => method),
  ["egma.hello", "egma.tool"],
);
assert.deepEqual(
  simulation.room.calls.map(({ responseTimeout }) => responseTimeout),
  [15_000, 45_000],
);
const hello = JSON.parse(simulation.room.calls[0].payload);
assert.deepEqual(hello.tools.map(({ name }) => name), ["check_calendar"]);
assert.deepEqual(JSON.parse(simulation.room.calls[1].payload), {
  name: "check_calendar",
  arguments: { value: "Tuesday" },
});
assert.equal(simulation.shutdownCallbacks.length, 1);

await simulationSession.close();
await Promise.all(simulation.shutdownCallbacks.map((callback) => callback()));

let realAfterCleanup = 0;
const unwrappedAgent = new CompatibilityAgent(async () => {
  realAfterCleanup += 1;
  return "real-after-cleanup";
});
const unwrappedSession = toolCallingSession("find another slot", "Friday");
await unwrappedSession.start({ agent: unwrappedAgent });
await unwrappedSession.run({ userInput: "find another slot" }).wait();
assert.equal(realAfterCleanup, 1);
assert.equal(simulation.room.calls.length, 2);
await unwrappedSession.close();

const nextSimulation = simulationContext("egma-sim-packed-owner-release");
const nextAgent = new CompatibilityAgent(async () => "real");
const nextSession = new voice.AgentSession();
await mockable(nextAgent, nextSimulation.value, nextSession);
assert.equal(nextSimulation.shutdownCallbacks.length, 1);
await Promise.all(
  nextSimulation.shutdownCallbacks.map((callback) => callback()),
);
await nextSession.close();

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
    monitorLiveKit(monitoringContext, monitoringOptions),
  );
  assert.equal(shutdownCallbacks.length, 1);
} else {
  assert.throws(
    () => monitorLiveKit(monitoringContext, monitoringOptions),
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
  run(process.execPath, ["runtime.mjs", liveKitVersion]);

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
