import { telemetry } from "@livekit/agents";

import { monitorLiveKit } from "../src/index.ts";

const endpoint = process.env.EGMA_TEST_ENDPOINT;
const apiKey = process.env.EGMA_TEST_PROJECT_KEY;
if (endpoint === undefined || apiKey === undefined) {
  throw new Error("the public helper probe needs its test endpoint and key");
}

const shutdownCallbacks = [];
const context = {
  job: { room: { name: "public-helper-production-room" } },
  addShutdownCallback(callback) {
    shutdownCallbacks.push(callback);
  },
};

monitorLiveKit(context, { endpoint, apiKey });

const span = telemetry.tracer.startSpan({ name: "public-helper-proof" });
span.end();

if (shutdownCallbacks.length !== 1) {
  throw new Error("the public helper did not register exactly one flush callback");
}
await shutdownCallbacks[0]();
process.stdout.write("public helper flush complete\n", () => process.exit(0));
