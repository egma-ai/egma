/**
 * `egma self-host up`, and the one agreement the whole onboarding path rests
 * on.
 *
 * A repository binds to the platform origin the platform *reports*, and the CLI
 * refuses to send that repository's identifiers anywhere whose reported origin
 * differs from the address the developer typed. That refusal is right and it is
 * load-bearing — and it makes this command's contract sharp: whatever `up`
 * prints, the platform has to answer with. If `up` printed a LAN address while
 * the platform still reported localhost, every later command in every agent
 * repository would be refused, and the failure would surface a directory away
 * from its cause.
 *
 * So this file proves the two are one value: what is printed is what was set,
 * and a platform that disagrees is a failure here rather than a mystery later.
 *
 * The platform and the container runtime this runs against are the shared
 * stand-ins in `support/platform-workspace.ts`; what it drives is the real CLI
 * process.
 */

import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  makePlatformWorkspace,
  runSelfHost,
  startPlatform,
} from "./support/platform-workspace.ts";

const WORKSPACE_PREFIX = "egma-platform-up-";

describe("egma self-host up", () => {
  it("starts the platform, and the address it prints is the one the platform reports", async () => {
    const platform = await startPlatform();
    const workspace = await makePlatformWorkspace(WORKSPACE_PREFIX);
    try {
      const run = await runSelfHost(workspace, ["up"], { EGMA_BASE_URL: platform.url });

      expect(run.code).toBe(0);
      expect(run.stdout).toContain(`url: ${platform.url}`);
      expect(run.stdout).toContain("status: ready");
      // Two facts about one deployment, reported separately and honestly. The
      // platform answers for its whole configuration — the persona's providers
      // as much as the carrier — and for the phone half beside it, because a
      // platform with no carrier runs chat and text simulations perfectly well.
      expect(run.stdout).toContain("setup: setup_required");
      expect(run.stdout).toContain("setup_missing: the persona's model provider");
      expect(run.stdout).toContain("phone: setup_required");
      // And the one command that fixes it, named, because "setup required" with
      // nothing after it sends a self-hoster to read source.
      expect(run.stderr).toContain("egma self-host setup");
      expect(run.stdout).toContain(
        `connect: npx @egma/cli --url ${platform.url}`,
      );

      // Every service it started, named. Five of them — the object store, the
      // simulator, the grader, the SIP gateway and its Redis — publish nothing
      // and have no page to visit, so this line is the only sign a person gets
      // that they are running at all.
      const services = /^services: (.+)$/mu.exec(run.stdout)?.[1]?.split(" ") ?? [];
      expect(services).toEqual([
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
      ]);

      const calls = await workspace.dockerCalls();
      // Everything, in one stack. No overlay named, nothing selected by hand.
      expect(calls).toContain("ARGS compose up -d --wait --wait-timeout 300\n");
      // And the address it printed is the address the containers were given.
      expect(calls).toContain(`EGMA_BASE_URL=${platform.url}`);

      // Starting a platform creates nothing on it. No agent, no connection, no
      // test, no run — and nothing that could reach a paid provider. Bringing
      // a deployment up is not an act on anybody's account, and the only thing
      // this command asks the platform is who it is.
      expect(new Set(platform.asked)).toEqual(new Set(["GET /api/platform"]));
    } finally {
      await platform.close();
    }
  });

  it("fails, naming both addresses, when the platform reports a different one", async () => {
    // The exact shape of the disaster this test exists for: a deployment
    // started on a LAN address whose API still reports localhost. Every later
    // command in every agent repository would be refused, a directory away
    // from anything that could explain it.
    const platform = await startPlatform({ reports: () => "http://localhost:3101" });
    const workspace = await makePlatformWorkspace(WORKSPACE_PREFIX);
    try {
      const run = await runSelfHost(workspace, ["up"], { EGMA_BASE_URL: platform.url });

      expect(run.code).toBe(4);
      expect(run.stdout).toContain("status: failed");
      expect(run.stdout).toContain("reports its address as http://localhost:3101");
      expect(run.stdout).toContain(`but was started at ${platform.url}`);
      expect(run.stdout).toContain("would be refused");
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
        `n=$(grep -c "^ARGS compose up" "${workspace.callsFile}")\n` +
        `if [ "$n" -le 1 ]; then exit 1; fi\nexit 0\n`,
    );
    await chmod(workspace.dockerShim, 0o755);

    try {
      const run = await runSelfHost(workspace, ["up"], { EGMA_BASE_URL: platform.url });

      expect(run.code).toBe(0);
      expect(run.stdout).toContain("status: ready");
      expect(run.stderr).toContain("did not come up on the first try");
      const said = await workspace.dockerCalls();
      expect(said.match(/^ARGS compose up/gmu)).toHaveLength(2);
    } finally {
      await platform.close();
    }
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
