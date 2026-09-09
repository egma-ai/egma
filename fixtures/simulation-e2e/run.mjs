import { spawnSync } from "node:child_process";

const dryRun = process.argv.includes("--dry-run");
const modelKey =
  process.env.LIVEKIT_E2E_OPENAI_API_KEY?.trim() ||
  process.env.EGMA_OPENAI_API_KEY?.trim();
const retellKey = process.env.SIMULATION_E2E_RETELL_API_KEY?.trim();

if (!modelKey) {
  throw new Error(
    "EGMA_OPENAI_API_KEY or LIVEKIT_E2E_OPENAI_API_KEY is required.",
  );
}
if (!retellKey) {
  throw new Error("SIMULATION_E2E_RETELL_API_KEY is required.");
}

function run(label, command, arguments_, options = {}) {
  console.log(`\n${label}`);
  if (dryRun) return;
  const result = spawnSync(command, arguments_, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

run("Build the platform API client", "pnpm", [
  "--filter",
  "@egma/platform-api",
  "build",
]);
run("Start the local data stores", "pnpm", ["db:up"]);
run("Sync the simulator", "uv", ["sync", "--frozen"], {
  cwd: "apps/simulator",
});
run(
  "Install the voice sentence tokenizer",
  "uv",
  ["run", "python", "-m", "nltk.downloader", "punkt_tab"],
  { cwd: "apps/simulator" },
);

const shared = {
  ...process.env,
  EGMA_REQUIRE_OBJECT_STORAGE: "1",
  SIMULATION_E2E_MOCKS: "on",
};
const liveKitEnvironment = { ...shared };
delete liveKitEnvironment.LIVEKIT_E2E_PYTHON_WHEEL;
delete liveKitEnvironment.LIVEKIT_E2E_JAVASCRIPT_PACKAGE;
delete liveKitEnvironment.SIMULATION_E2E_TOKEN_ENDPOINT;
const liveKitArguments = [
  "exec",
  "vitest",
  "run",
  "--project",
  "fast",
  "apps/api/test/simulator-conversation.test.ts",
  "--testNamePattern",
  "runs a packaged LiveKit worker",
  "--maxWorkers=1",
];
for (const language of ["python", "javascript"]) {
  for (const modality of ["chat", "voice"]) {
    run(`LiveKit ${language} ${modality}`, "pnpm", liveKitArguments, {
      env: {
        ...liveKitEnvironment,
        LIVEKIT_E2E_OPENAI_API_KEY: modelKey,
        SIMULATION_E2E_LIVE: "1",
        SIMULATION_E2E_LANGUAGE: language,
        SIMULATION_E2E_MODALITY: modality,
        SIMULATION_E2E_ACCESS: "project_credentials",
        LIVEKIT_E2E_PYTHON_AGENTS_VERSION: "1.7.1",
        LIVEKIT_E2E_JAVASCRIPT_AGENTS_VERSION: "1.7.1",
        EGMA_E2E_SESSION_DELAY_MS: "10000",
      },
    });
  }
}

const retellArguments = [
  "exec",
  "vitest",
  "run",
  "--project",
  "fast",
  "apps/api/test/retell-live-simulation.test.ts",
  "--maxWorkers=1",
];
const retellEnvironment = { ...shared };
delete retellEnvironment.SIMULATION_E2E_RETELL_PREFLIGHT;
for (const connection of ["text", "web"]) {
  run(`Retell ${connection}`, "pnpm", retellArguments, {
    env: {
      ...retellEnvironment,
      SIMULATION_E2E_RETELL: "1",
      SIMULATION_E2E_RETELL_CONNECTION: connection,
      SIMULATION_E2E_RETELL_API_KEY: retellKey,
      SIMULATION_E2E_MODEL_API_KEY: modelKey,
    },
  });
}
