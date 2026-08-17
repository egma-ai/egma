import { execFile } from "node:child_process";
import { access, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import {
  ConfigurationFault,
  loadConfig,
  OPTIONAL_NAMES,
  REQUIRED_NAMES,
  SECRET_NAMES,
} from "../src/config.ts";
import { startLocalGateway } from "../src/host/node.ts";
import { EGMA_PROVIDER_KEY, GATEWAY_SECRET, ORGANIZATION } from "./support/world.ts";

/**
 * The gateway's configuration, checked against what its documentation says, and
 * the application checked against being buildable at all.
 *
 * Nothing fails when a name is documented and unread, or read and undocumented,
 * and the second is the expensive kind: somebody operating a deployment cannot
 * set a name nobody told them about, and the result is a bound that is silently
 * the default or a credential that is silently absent. So the names the code
 * reads, the names the module declares, and the names the README lists are
 * compared here, three ways.
 *
 * The build is the other half. The deployed host is bundled by the deployment
 * tool from `src/worker.ts`, so what this proves is that the whole application
 * typechecks and that both entry points really exist afterwards — the deployed
 * one and the local one — rather than that a particular bundler was installed.
 */

const run = promisify(execFile);
const HERE = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const ROOT = path.resolve(HERE, "../..");

/** Every `EGMA_GATEWAY_*` the application really looks up. */
async function namesTheCodeReads(): Promise<Set<string>> {
  const found = new Set<string>();
  const walk = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.name.endsWith(".ts")) {
        for (const name of (await readFile(full, "utf8")).match(/EGMA_GATEWAY_[A-Z0-9_]+/g) ?? []) {
          found.add(name);
        }
      }
    }
  };
  await walk(path.join(HERE, "src"));
  return found;
}

describe("every name the gateway reads", () => {
  it("is declared as required or optional, so nothing is configured by accident", async () => {
    const declared = new Set<string>([...REQUIRED_NAMES, ...OPTIONAL_NAMES]);
    for (const name of await namesTheCodeReads()) {
      expect(declared, `${name} is read but not declared`).toContain(name);
    }
  });

  it("is in the README, because nobody can set what nobody told them about", async () => {
    const documented = await readFile(path.join(HERE, "README.md"), "utf8");
    for (const name of [...REQUIRED_NAMES, ...OPTIONAL_NAMES]) {
      expect(documented, `${name} is declared but undocumented`).toContain(name);
    }
  });

  it("is read somewhere, so the documentation does not promise a name that does nothing", async () => {
    const read = await namesTheCodeReads();
    for (const name of [...REQUIRED_NAMES, ...OPTIONAL_NAMES]) {
      expect(read, `${name} is declared but never read`).toContain(name);
    }
  });

  it("is marked a secret in the README wherever it holds one", async () => {
    const documented = await readFile(path.join(HERE, "README.md"), "utf8");
    for (const name of SECRET_NAMES) {
      const row = documented.split("\n").find((line) => line.includes(`\`${name}\``));
      expect(row, `${name} has no row in the README`).toBeDefined();
      expect(row, `${name} is a secret and its row does not say so`).toContain("**yes**");
    }
  });
});

describe("the deployment configuration this repository ships", () => {
  it("turns Cloudflare's own recording of these requests off, and forwards them nowhere", async () => {
    const wrangler = await readFile(path.join(HERE, "wrangler.jsonc"), "utf8");
    expect(wrangler).toMatch(/"observability"\s*:\s*\{\s*"enabled"\s*:\s*false\s*\}/);
    expect(wrangler).toMatch(/"logpush"\s*:\s*false/);
  });

  it("declares the deployed entry point and no storage binding at all", async () => {
    const wrangler = await readFile(path.join(HERE, "wrangler.jsonc"), "utf8");
    expect(wrangler).toMatch(/"main"\s*:\s*"src\/worker\.ts"/);
    for (const binding of [
      "kv_namespaces",
      "d1_databases",
      "r2_buckets",
      "durable_objects",
      "queues",
      "hyperdrive",
      "analytics_engine_datasets",
    ]) {
      expect(wrangler, `a ${binding} binding is a place a payload could rest`).not.toContain(
        binding,
      );
    }
  });

  it("holds no secret value, only names", async () => {
    const wrangler = await readFile(path.join(HERE, "wrangler.jsonc"), "utf8");
    for (const secret of [GATEWAY_SECRET, ...Object.values(EGMA_PROVIDER_KEY)]) {
      expect(wrangler).not.toContain(secret);
    }
    expect(wrangler).toMatch(/"vars"\s*:\s*\{\s*\}/);
  });
});

describe("the application", () => {
  it("builds, and leaves both entry points behind", async () => {
    await run("node", [path.join(ROOT, "node_modules/typescript/bin/tsc"), "-b", "apps/gateway"], {
      cwd: ROOT,
    });
    await access(path.join(HERE, "dist/worker.js"));
    await access(path.join(HERE, "dist/host/node.js"));
  }, 120_000);

  it("refuses to start when a required name is missing, and names it", () => {
    const complete: Record<string, string> = {
      EGMA_GATEWAY_ORGANIZATION_SECRET: GATEWAY_SECRET,
      EGMA_GATEWAY_ORGANIZATION_ID: ORGANIZATION,
      EGMA_GATEWAY_INFERENCE_KEY_ID: "inference-key-preview-1",
      EGMA_GATEWAY_DEEPGRAM_KEY: EGMA_PROVIDER_KEY.deepgram,
      EGMA_GATEWAY_OPENAI_KEY: EGMA_PROVIDER_KEY.openai,
      EGMA_GATEWAY_CARTESIA_KEY: EGMA_PROVIDER_KEY.cartesia,
    };
    expect(loadConfig(complete)).toBeTruthy();

    for (const name of REQUIRED_NAMES) {
      const missing = { ...complete };
      delete missing[name];
      expect(() => loadConfig(missing), `${name} was not required`).toThrow(ConfigurationFault);
      try {
        loadConfig(missing);
      } catch (fault) {
        expect((fault as Error).message).toContain(name);
      }
    }
  });

  it("refuses a bound that is not a bound, rather than silently using a default", () => {
    const base: Record<string, string> = {
      EGMA_GATEWAY_ORGANIZATION_SECRET: GATEWAY_SECRET,
      EGMA_GATEWAY_ORGANIZATION_ID: ORGANIZATION,
      EGMA_GATEWAY_INFERENCE_KEY_ID: "inference-key-preview-1",
      EGMA_GATEWAY_DEEPGRAM_KEY: EGMA_PROVIDER_KEY.deepgram,
      EGMA_GATEWAY_OPENAI_KEY: EGMA_PROVIDER_KEY.openai,
      EGMA_GATEWAY_CARTESIA_KEY: EGMA_PROVIDER_KEY.cartesia,
    };
    expect(() => loadConfig({ ...base, EGMA_GATEWAY_MAX_FRAME_BYTES: "lots" })).toThrow(
      ConfigurationFault,
    );
    expect(() => loadConfig({ ...base, EGMA_GATEWAY_SOCKET_IDLE_TIMEOUT_MS: "0" })).toThrow(
      ConfigurationFault,
    );
    expect(() => loadConfig({ ...base, EGMA_GATEWAY_OPENAI_HOME: "not-an-address" })).toThrow(
      ConfigurationFault,
    );
    expect(() => loadConfig({ ...base, EGMA_GATEWAY_LOG_LEVEL: "CHATTY" })).toThrow(
      ConfigurationFault,
    );
    // A first-output bound outside the whole-exchange bound could never fire.
    expect(() =>
      loadConfig({
        ...base,
        EGMA_GATEWAY_EXCHANGE_TIMEOUT_MS: "1000",
        EGMA_GATEWAY_FIRST_OUTPUT_TIMEOUT_MS: "5000",
      }),
    ).toThrow(ConfigurationFault);
  });

  it("runs from the documented configuration and answers its health check", async () => {
    const running = await startLocalGateway({
      EGMA_GATEWAY_ORGANIZATION_SECRET: GATEWAY_SECRET,
      EGMA_GATEWAY_ORGANIZATION_ID: ORGANIZATION,
      EGMA_GATEWAY_INFERENCE_KEY_ID: "inference-key-preview-1",
      EGMA_GATEWAY_DEEPGRAM_KEY: EGMA_PROVIDER_KEY.deepgram,
      EGMA_GATEWAY_OPENAI_KEY: EGMA_PROVIDER_KEY.openai,
      EGMA_GATEWAY_CARTESIA_KEY: EGMA_PROVIDER_KEY.cartesia,
    });
    try {
      const answered = await fetch(`${running.origin}/health`);
      expect(answered.status).toBe(200);
      expect(await answered.json()).toEqual({ status: "ok" });
    } finally {
      await running.stop();
    }
  });
});
