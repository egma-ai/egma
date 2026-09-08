import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import {
  connect,
  connectClickHouse,
  disconnect,
  disconnectClickHouse,
  priceUsageSpans,
  providerUsageSpan,
  type AuthContext,
} from "@egma/db";
import { expect, it } from "vitest";
import {
  createMigratedDatabase,
  TEST_ENCRYPTION_KEY,
} from "../../../packages/db/test/support/database.ts";
import { createEmptyTraceStore } from "../../../packages/db/test/support/clickhouse.ts";

async function freePort(): Promise<number> {
  const listener = createServer();
  listener.listen(0, "127.0.0.1");
  await once(listener, "listening");
  const address = listener.address();
  if (!address || typeof address === "string") throw new Error("missing port");
  await new Promise<void>((resolve, reject) =>
    listener.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
}

it("serves core API work during a rate-card startup fault and prices usage after recovery without restart", async () => {
  const database = await createMigratedDatabase("rate_card_startup");
  const traceStore = await createEmptyTraceStore("rate_card_startup");
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  let child: ChildProcess | undefined;
  let output = "";
  try {
    await database.sql(
      "create function fail_rate_seed() returns trigger language plpgsql as $$ begin raise exception 'rate seed unavailable'; end $$",
    );
    await database.sql(
      "create trigger fail_rate_seed before insert on rate_card for each row execute function fail_rate_seed()",
    );
    child = spawn(
      process.execPath,
      [
        "--experimental-strip-types",
        fileURLToPath(new URL("../src/index.ts", import.meta.url)),
      ],
      {
        env: {
          PATH: process.env.PATH,
          NODE_ENV: "test",
          DATABASE_URL: database.url,
          CLICKHOUSE_URL: traceStore.url,
          EGMA_AUTH_SECRET: "this-test-only-auth-secret",
          EGMA_ENCRYPTION_KEY: TEST_ENCRYPTION_KEY,
          EGMA_SIMULATOR_SERVICE_TOKEN: "egma_st_this-test-only-service-token",
          EGMA_BASE_URL: origin,
          EGMA_SINGLE_ORGANIZATION: "false",
          EGMA_ROLE: "drain",
          HOST: "127.0.0.1",
          PORT: String(port),
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    child.stdout?.on("data", (data: Buffer) => {
      output += data.toString();
    });
    child.stderr?.on("data", (data: Buffer) => {
      output += data.toString();
    });
    await expect
      .poll(
        async () => {
          if (child?.exitCode !== null)
            throw new Error(`API exited before serving: ${output}`);
          return fetch(`${origin}/health`)
            .then((response) => response.status)
            .catch(() => 0);
        },
        { timeout: 10_000 },
      )
      .toBe(200);
    const created = await fetch(`${origin}/api/signup`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: "pricing-recovery@example.test",
        password: "a-long-enough-password",
        organizationName: "Pricing recovery",
      }),
    });
    expect(created.status).toBe(201);
    const person = (await created.json()) as {
      userId: string;
      organization: { id: string };
      project: { id: string };
    };
    connect({ databaseUrl: database.url });
    connectClickHouse({ clickhouseUrl: traceStore.url });
    const auth: AuthContext = {
      userId: person.userId,
      organizationId: person.organization.id,
      projectId: person.project.id,
      via: "engine",
      role: "member",
    };
    const measured = providerUsageSpan({
      identity: {
        work: "simulation",
        simulationId: "sim_startup",
        spanId: "0000000000000001",
      },
      traceId: "11111111111111111111111111111111",
      occurredAt: new Date(),
      provider: "openai",
      model: "gpt-4o-mini",
      operation: "openai_chat_completions",
      quantities: { input_tokens: 1000, output_tokens: 100 },
      measurement: "provider_reported",
      paymentSource: "platform",
      rawUsage: { prompt_tokens: 1000, completion_tokens: 100 },
    });
    await expect
      .poll(
        async () => {
          try {
            await priceUsageSpans(auth, [measured]);
            return "priced";
          } catch (cause) {
            return cause instanceof Error ? cause.message : String(cause);
          }
        },
        { timeout: 5000 },
      )
      .toContain("missing effective rate");
    await database.sql("drop trigger fail_rate_seed on rate_card");
    await expect
      .poll(
        async () => {
          try {
            return (await priceUsageSpans(auth, [measured]))[0]?.usage?.price
              ?.amountMicros;
          } catch {
            return undefined;
          }
        },
        { timeout: 10_000 },
      )
      .toBe(210);
    expect(child.exitCode).toBeNull();
    expect((await fetch(`${origin}/health`)).status).toBe(200);
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      const ended = once(child, "exit");
      child.kill("SIGTERM");
      await ended;
    }
    await disconnect();
    await disconnectClickHouse();
    await database.drop();
    await traceStore.drop();
  }
}, 30_000);
