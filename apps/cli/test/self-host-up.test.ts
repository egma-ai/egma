/** `egma self-host up`, driven through a real CLI process and local stand-ins. */

import { chmod, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  BOOTSTRAP_VARIABLES,
  PLATFORM_CREDENTIAL_VARIABLES,
} from "../src/self-host/workspace.ts";
import {
  makePlatformWorkspace,
  runSelfHost,
  startPlatform,
} from "./support/platform-workspace.ts";

const WORKSPACE_PREFIX = "egma-platform-up-";
const COMPOSE_BUILD = "ARGS compose build";
const COMPOSE_UP = "ARGS compose up -d --wait --wait-timeout 300";

const OLDER_INTERNAL_VALUES = Object.fromEntries(
  PLATFORM_CREDENTIAL_VARIABLES.map((name, index) => [
    name,
    `older-value-${index}-${"x".repeat(40)}`,
  ]),
) as Record<(typeof PLATFORM_CREDENTIAL_VARIABLES)[number], string>;

describe("egma self-host up", () => {
  it("starts the platform and prints the configured address", async () => {
    const platform = await startPlatform();
    const workspace = await makePlatformWorkspace(WORKSPACE_PREFIX);
    try {
      const run = await runSelfHost(workspace, ["up"], { EGMA_BASE_URL: platform.url });

      expect(run.code).toBe(0);
      expect(run.stdout).toContain(platform.url);
      expect(run.stdout).not.toMatch(/^(?:workspace|url|status|login):/mu);
      expect(run.stdout).toContain(`Egma is ready at ${platform.url}.`);
      expect(run.stdout).toContain(`egma login --url ${platform.url}`);

      // Every service it started, named. Five of them — the object store, the
      // simulator, the grader, the SIP gateway and its Redis — publish nothing
      // and have no page to visit, so this line is the only sign a person gets
      // that they are running at all.
      const services = [
        "postgres",
        "clickhouse",
        "minio",
        "api",
        "web",
        "simulator",
        "grader",
        "livekit",
        "livekit-sip",
        "livekit-redis",
      ];
      for (const service of services) expect(run.stdout).toContain(service);

      const calls = await workspace.dockerCalls();
      // Everything, in one stack. The local services are built from this
      // checkout before they start, so a pull cannot restart an old image.
      // Compose still uses its normal build cache and leaves published-image
      // services alone.
      expect(calls).toContain(`${COMPOSE_BUILD}\n`);
      expect(calls).toContain(`${COMPOSE_UP}\n`);
      // And the address it printed is the address the containers were given.
      expect(calls).toContain(`EGMA_BASE_URL=${platform.url}`);

      // The normal start prepares every credential used only between Egma
      // containers. A self-hoster does not have to invent any of them.
      const stored = await workspace.storedConfig();
      expect(Object.keys(stored).sort()).toEqual([...BOOTSTRAP_VARIABLES].sort());
      expect(stored.EGMA_BASE_URL).toBe(platform.url);
      for (const name of PLATFORM_CREDENTIAL_VARIABLES) {
        expect(stored[name], name).not.toBe("");
        expect(calls).toContain(`${name}=${stored[name]}`);
      }

      expect(new Set(platform.asked)).toEqual(new Set(["GET /api/health"]));
    } finally {
      await platform.close();
    }
  });

  it("reuses one recorded bootstrap set on every later start", async () => {
    const platform = await startPlatform();
    const workspace = await makePlatformWorkspace(WORKSPACE_PREFIX);
    try {
      const first = await runSelfHost(workspace, ["up"], {
        EGMA_BASE_URL: platform.url,
      });
      const firstStored = await workspace.storedConfig();
      const second = await runSelfHost(workspace, ["up"], {
        EGMA_BASE_URL: platform.url,
      });

      expect(first.code, first.stderr).toBe(0);
      expect(second.code, second.stderr).toBe(0);
      expect(first.stdout).not.toMatch(/^platform_credentials:/mu);
      expect(second.stdout).not.toMatch(/^platform_credentials:/mu);
      expect(await workspace.storedConfig()).toEqual(firstStored);
    } finally {
      await platform.close();
    }
  });

  it("refuses a phone route unless all four deployment values are present", async () => {
    const platform = await startPlatform();
    const workspace = await makePlatformWorkspace(WORKSPACE_PREFIX);
    await writeFile(
      path.join(workspace.dir, ".env"),
      [
        "EGMA_PHONE_TRUNK_ADDRESS=carrier.example.com",
        "EGMA_PHONE_SOURCE_NUMBER=+15550100100",
        "",
      ].join("\n"),
    );
    try {
      const run = await runSelfHost(workspace, ["up"], {
        EGMA_BASE_URL: platform.url,
      });

      expect(run.code).toBe(1);
      expect(run.stderr).toContain("phone carrier route in .env is incomplete");
      expect(run.stderr).toContain("EGMA_PHONE_TRUNK_USERNAME");
      expect(run.stderr).toContain("EGMA_PHONE_TRUNK_PASSWORD");
      expect(run.stdout).not.toMatch(/^(?:status|reason):/mu);
      const calls = await workspace.dockerCalls();
      expect(calls).not.toContain(COMPOSE_BUILD);
      expect(calls).not.toContain(COMPOSE_UP);
    } finally {
      await platform.close();
    }
  });

  it("adopts an older deployment's internal values without rewriting its .env contents", async () => {
    const platform = await startPlatform();
    const workspace = await makePlatformWorkspace(WORKSPACE_PREFIX);
    const operatorValues = {
      ...OLDER_INTERNAL_VALUES,
      EGMA_OPENAI_API_KEY: "provider-key-stays-with-the-operator",
      EGMA_PHONE_TRUNK_ADDRESS: "carrier.example.com",
      EGMA_PHONE_SOURCE_NUMBER: "+15550100100",
      EGMA_PHONE_TRUNK_USERNAME: "egma-local",
      // Single quotes are Compose's literal form for a credential containing
      // `$`; the resolved value handed to the API contains no quote bytes.
      EGMA_PHONE_TRUNK_PASSWORD: "'alpha$UNSETomega'",
    };
    const operatorFile = `${Object.entries(operatorValues)
      .map(([name, value]) => `${name}=${value}`)
      .join("\n")}\n`;
    await writeFile(path.join(workspace.dir, ".env"), operatorFile);
    await chmod(path.join(workspace.dir, ".env"), 0o644);

    try {
      const run = await runSelfHost(workspace, ["up"], {
        EGMA_BASE_URL: platform.url,
      });

      expect(run.code, run.stderr).toBe(0);
      expect(run.stdout).not.toMatch(/^platform_credentials:/mu);
      expect(await readFile(path.join(workspace.dir, ".env"), "utf8")).toBe(
        operatorFile,
      );
      expect((await stat(path.join(workspace.dir, ".env"))).mode & 0o777).toBe(
        0o600,
      );

      const stored = await workspace.storedConfig();
      expect(stored).toEqual({
        EGMA_BASE_URL: platform.url,
        ...OLDER_INTERNAL_VALUES,
      });
      expect(stored).not.toHaveProperty("EGMA_OPENAI_API_KEY");
      expect(stored).not.toHaveProperty("EGMA_PHONE_TRUNK_ADDRESS");
      expect(stored).not.toHaveProperty("EGMA_PHONE_SOURCE_NUMBER");
      expect(stored).not.toHaveProperty("EGMA_PHONE_TRUNK_USERNAME");
      expect(stored).not.toHaveProperty("EGMA_PHONE_TRUNK_PASSWORD");

      const calls = await workspace.dockerCalls();
      expect(calls).toContain("EGMA_PHONE_TRUNK_PASSWORD=alpha$UNSETomega");
    } finally {
      await platform.close();
    }
  });

  it("adopts legacy internal values exactly as Docker Compose resolves them", async () => {
    const platform = await startPlatform();
    const workspace = await makePlatformWorkspace(WORKSPACE_PREFIX);
    const encryptionKey = "ab".repeat(32);
    const authSecret = "legacy-auth-secret-resolved-from-another-name";
    const operatorFile = [
      `LEGACY_ENCRYPTION_KEY=${encryptionKey}`,
      // Both forms are legal to Compose and are deliberately not interpreted
      // by a second dotenv parser inside Egma.
      "EGMA_ENCRYPTION_KEY: ${LEGACY_ENCRYPTION_KEY}",
      "EGMA_AUTH_SECRET=${LEGACY_AUTH_SECRET}",
      "",
    ].join("\n");
    await writeFile(path.join(workspace.dir, ".env"), operatorFile);
    await writeFile(
      workspace.dockerShim,
      `#!/bin/sh\necho "ARGS $@" >> "${workspace.callsFile}"\n` +
        `case "$*" in *"config --environment"*)\n` +
        `  env\n` +
        `  printf 'EGMA_ENCRYPTION_KEY=%s\\n' "$FAKE_COMPOSE_ENCRYPTION_KEY"\n` +
        `  printf 'EGMA_AUTH_SECRET=%s\\n' "$FAKE_COMPOSE_AUTH_SECRET"\n` +
        `  exit 0\n` +
        `;; esac\n` +
        `env >> "${workspace.callsFile}"\nexit 0\n`,
    );
    await chmod(workspace.dockerShim, 0o755);

    try {
      const run = await runSelfHost(workspace, ["up"], {
        EGMA_BASE_URL: platform.url,
        FAKE_COMPOSE_ENCRYPTION_KEY: encryptionKey,
        FAKE_COMPOSE_AUTH_SECRET: authSecret,
      });

      expect(run.code, run.stderr).toBe(0);
      const stored = await workspace.storedConfig();
      expect(stored.EGMA_ENCRYPTION_KEY).toBe(encryptionKey);
      expect(stored.EGMA_AUTH_SECRET).toBe(authSecret);
      expect(await readFile(path.join(workspace.dir, ".env"), "utf8")).toBe(
        operatorFile,
      );
    } finally {
      await platform.close();
    }
  });

  it("refuses to replace missing internal state beside an existing database", async () => {
    const platform = await startPlatform();
    const workspace = await makePlatformWorkspace(WORKSPACE_PREFIX);
    await writeFile(
      workspace.dockerShim,
      `#!/bin/sh\necho "ARGS $@" >> "${workspace.callsFile}"\n` +
        `case "$*" in *"config --environment"*) env; exit 0 ;; esac\n` +
        `case "$*" in *"volume ls"*)\n` +
        `  printf 'egma_postgres-17-data\\tegma\\tpostgres-17-data\\n'\n` +
        `  exit 0\n` +
        `;; esac\n` +
        `exit 0\n`,
    );
    await chmod(workspace.dockerShim, 0o755);

    try {
      const run = await runSelfHost(workspace, ["up"], {
        EGMA_BASE_URL: platform.url,
      });

      expect(run.code).toBe(1);
      expect(run.stderr).toContain("Nothing was generated");
      expect(run.stderr).toContain("egma_postgres-17-data");
      expect(run.stderr).toContain("Restore .egma-platform/platform.env");
      expect(run.stdout).not.toMatch(/^(?:status|reason):/mu);
      await expect(readFile(workspace.configFile, "utf8")).rejects.toThrow();
      const calls = await workspace.dockerCalls();
      expect(calls).not.toContain(COMPOSE_BUILD);
      expect(calls).not.toContain(COMPOSE_UP);
    } finally {
      await platform.close();
    }
  });

  it("tries once more when a store's first boot takes the API down with it", async () => {
    // Measured on a clean workspace against real containers: ClickHouse's
    // entrypoint starts a server, creates the database, stops it and starts the
    // real one — and its health check answers during the first of those, so the
    // API is released to connect to a server on its way down and exits. A
    // second `up` works. A first run that fails once and works when you type
    // the same thing again is a product that taught its first user to distrust
    // it, so the command types it again itself.
    const platform = await startPlatform();
    const workspace = await makePlatformWorkspace(WORKSPACE_PREFIX);
    await writeFile(
      workspace.dockerShim,
      `#!/bin/sh\necho "ARGS $@" >> "${workspace.callsFile}"\n` +
        `case "$*" in *"config --environment"*) env; exit 0 ;; esac\n` +
        `case "$*" in *"volume ls"*) exit 0 ;; esac\n` +
        `if [ "$*" = "compose build" ]; then exit 0; fi\n` +
        `n=$(grep -c "^ARGS compose up" "${workspace.callsFile}")\n` +
        `if [ "$n" -le 1 ]; then exit 1; fi\nexit 0\n`,
    );
    await chmod(workspace.dockerShim, 0o755);

    try {
      const run = await runSelfHost(workspace, ["up"], { EGMA_BASE_URL: platform.url });

      expect(run.code).toBe(0);
      expect(run.stdout).not.toMatch(/^status:/mu);
      expect(run.stdout).toContain(`Egma is ready at ${platform.url}.`);
      expect(run.stderr).toContain("did not come up on the first try");
      const said = await workspace.dockerCalls();
      expect(said.split("\n").filter((line) => line === COMPOSE_BUILD)).toHaveLength(1);
      expect(said.split("\n").filter((line) => line === COMPOSE_UP)).toHaveLength(2);
    } finally {
      await platform.close();
    }
  });

  it("reports an impossible missing internal value as a preparation fault", async () => {
    // The other half of the retry above, and the reason the two have to be told
    // apart. A bootstrap variable this deployment cannot invent — the key that
    // seals every stored credential, the token a simulator claims with — has no
    // default any more, so Compose refuses before it creates a container and
    // names the one it is missing. A second attempt would invent nothing, and
    // reporting it as a store's first boot would send an operator reading
    // ClickHouse logs for a variable they never set.
    const platform = await startPlatform();
    const workspace = await makePlatformWorkspace(WORKSPACE_PREFIX);
    await writeFile(
      workspace.dockerShim,
      `#!/bin/sh\necho "ARGS $@" >> "${workspace.callsFile}"\n` +
        `case "$*" in *"config --environment"*) env; exit 0 ;; esac\n` +
        `case "$*" in *"volume ls"*) exit 0 ;; esac\n` +
        "echo 'error while interpolating services.api.environment.EGMA_ENCRYPTION_KEY: " +
        "required variable EGMA_ENCRYPTION_KEY is missing a value: no default' >&2\n" +
        "exit 1\n",
    );
    await chmod(workspace.dockerShim, 0o755);

    try {
      const run = await runSelfHost(workspace, ["up"], { EGMA_BASE_URL: platform.url });

      expect(run.code).toBe(1);
      expect(run.stdout).not.toMatch(/^(?:status|reason):/mu);
      expect(run.stderr).toContain("EGMA_ENCRYPTION_KEY");
      expect(run.stderr).toContain("platform preparation error");
      expect(run.stderr).not.toContain("Set it in .env");
      // Compose's own sentence reached the operator too, because it carries
      // what to do about that particular variable.
      expect(run.stderr).toContain("required variable EGMA_ENCRYPTION_KEY");
      expect(run.stderr).not.toContain("did not come up on the first try");
      const said = await workspace.dockerCalls();
      expect(said.split("\n").filter((line) => line === COMPOSE_BUILD)).toHaveLength(1);
      expect(said.split("\n").filter((line) => line === COMPOSE_UP)).toHaveLength(0);
    } finally {
      await platform.close();
    }
  });

  it("reports a failed image build once, without calling it a store's first boot", async () => {
    const platform = await startPlatform();
    const workspace = await makePlatformWorkspace(WORKSPACE_PREFIX);
    await writeFile(
      workspace.dockerShim,
      `#!/bin/sh\necho "ARGS $@" >> "${workspace.callsFile}"\n` +
        `case "$*" in *"config --environment"*) env; exit 0 ;; esac\n` +
        `case "$*" in *"volume ls"*) exit 0 ;; esac\n` +
        "echo 'Dockerfile: build failed' >&2\n" +
        "exit 1\n",
    );
    await chmod(workspace.dockerShim, 0o755);

    try {
      const run = await runSelfHost(workspace, ["up"], {
        EGMA_BASE_URL: platform.url,
      });

      expect(run.code).toBe(1);
      expect(run.stdout).not.toMatch(/^(?:status|reason):/mu);
      expect(run.stderr).toMatch(/could not build the platform images/i);
      expect(run.stderr).not.toContain("store's first boot");
      const said = await workspace.dockerCalls();
      expect(said.split("\n").filter((line) => line === COMPOSE_BUILD)).toHaveLength(1);
      expect(said.split("\n").filter((line) => line === COMPOSE_UP)).toHaveLength(0);
    } finally {
      await platform.close();
    }
  });

  it("returns 130 when Ctrl-C interrupts Docker Compose", async () => {
    const workspace = await makePlatformWorkspace(WORKSPACE_PREFIX);
    await writeFile(
      workspace.dockerShim,
      `#!/bin/sh\necho "ARGS $@" >> "${workspace.callsFile}"\n` +
        `case "$*" in *"config --environment"*) env; exit 0 ;; esac\n` +
        `case "$*" in *"volume ls"*) exit 0 ;; esac\n` +
        `if [ "$*" = "compose build" ]; then\n` +
        `  trap 'exit 0' INT TERM\n` +
        `  kill -INT "$PPID"\n` +
        `  while :; do sleep 1; done\n` +
        `fi\n` +
        `exit 0\n`,
    );
    await chmod(workspace.dockerShim, 0o755);

    const run = await runSelfHost(workspace, ["up"], {
      EGMA_BASE_URL: "http://127.0.0.1:1",
    });

    expect(run.code).toBe(130);
    expect(run.stderr).toContain("The command was interrupted before it finished.");
    expect(run.stderr).not.toContain("within 300s");
    expect(run.stderr).not.toContain("AbortError");
    expect(run.stderr).not.toContain("at runUp");
    expect(run.stdout).not.toContain("Egma is ready");
  });

  it("refuses in a directory that is not a platform workspace", async () => {
    const notAWorkspace = await mkdtemp(path.join(tmpdir(), "egma-not-platform-"));
    const workspace = await makePlatformWorkspace(WORKSPACE_PREFIX);
    const run = await runSelfHost({ dir: notAWorkspace, binDir: workspace.binDir }, ["up"], {
      EGMA_BASE_URL: "http://127.0.0.1:1",
    });

    expect(run.code).toBe(1);
    expect(run.stderr).toContain("this is not a platform workspace");
    // The distinction the whole command rests on is spelled out, because
    // running it in an agent repository is the mistake somebody will make.
    expect(run.stderr).toContain("not your agent repository");
  });
});
