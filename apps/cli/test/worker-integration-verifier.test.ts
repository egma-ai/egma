import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  snapshotWorkerIntegration,
  verifyWorkerIntegration,
  verifyWorkerIntegrationClaim,
  type WorkerIntegrationContract,
  type WorkerIntegrationSnapshot,
} from "../src/wizard/worker-integration-verifier.ts";

const temporary: string[] = [];

const WORKER_BEFORE = [
  "from livekit.agents import AgentSession",
  "",
  "",
  "async def entrypoint(ctx):",
  "    await ctx.connect()",
  "    agent = object()",
  "    session = AgentSession()",
  "    await session.start(agent=agent, room=ctx.room)",
  "",
].join("\n");

const WORKER_WITH_DIRECT_MOCKABLE = [
  "from egma import mockable",
  "from livekit.agents import AgentSession",
  "",
  "",
  "async def entrypoint(ctx):",
  "    await ctx.connect()",
  "    agent = object()",
  "    session = AgentSession()",
  "    await mockable(agent, ctx, session)",
  "    await session.start(agent=agent, room=ctx.room)",
  "",
].join("\n");

const WORKER_WITH_QUALIFIED_MOCKABLE = [
  "import egma",
  "from livekit.agents import AgentSession",
  "",
  "",
  "async def entrypoint(ctx):",
  "    await ctx.connect()",
  "    agent = object()",
  "    session = AgentSession()",
  "    await egma.mockable(agent, ctx, session)",
  "    await session.start(agent=agent, room=ctx.room)",
  "",
].join("\n");

const WORKER_WITH_UNBOUND_MOCKABLE = WORKER_WITH_DIRECT_MOCKABLE.replace(
  "from egma import mockable\n",
  "",
);

const WORKER_WITH_ALIASED_BOTH = [
  "from egma import mockable as isolate, monitor_livekit as observe",
  "from livekit.agents import AgentSession",
  "",
  "async def entrypoint(ctx):",
  "    observe(ctx)",
  "    await ctx.connect()",
  "    agent = object()",
  "    session = AgentSession()",
  "    await isolate(agent, ctx, session)",
  "    await session.start(agent=agent, room=ctx.room)",
  "",
].join("\n");

const WORKER_WITH_DIRECT_MONITORING = WORKER_BEFORE.replace(
  "from livekit.agents import AgentSession",
  "from egma import monitor_livekit\nfrom livekit.agents import AgentSession",
).replace(
  "async def entrypoint(ctx):\n    await ctx.connect()",
  "async def entrypoint(ctx):\n    monitor_livekit(ctx)\n    await ctx.connect()",
);

type Workspace = {
  readonly dir: string;
  readonly worker: string;
};

afterEach(async () => {
  await Promise.all(
    temporary.splice(0).map((folder) => rm(folder, { recursive: true, force: true })),
  );
});

async function workspace(): Promise<Workspace> {
  const dir = await mkdtemp(path.join(tmpdir(), "egma-worker-verifier-"));
  temporary.push(dir);
  await mkdir(path.join(dir, "src"), { recursive: true });
  const worker = path.join(dir, "src", "agent.py");
  await writeFile(worker, WORKER_BEFORE, "utf8");
  await writeFile(
    path.join(dir, "requirements.txt"),
    "livekit-agents>=1.2\n",
    "utf8",
  );
  return { dir, worker };
}

async function snapshotOf(dir: string): Promise<WorkerIntegrationSnapshot> {
  const result = await snapshotWorkerIntegration(dir, "src/agent.py");
  expect(result.kind).toBe("snapshotted");
  if (result.kind !== "snapshotted") throw new Error(result.reason);
  return result.snapshot;
}

async function claim(
  made: Workspace,
  workerSource: string,
  manifest: string,
  manifestSource: string,
) {
  await mkdir(path.dirname(path.join(made.dir, manifest)), { recursive: true });
  const manifestBefore = manifest.endsWith(".toml")
    ? manifestSource
    : manifestSource
        .split("\n")
        .filter((line) => !/^\s*egma\b/iu.test(line))
        .join("\n");
  await writeFile(path.join(made.dir, manifest), manifestBefore, "utf8");
  if (manifest.endsWith(".toml")) {
    await rm(path.join(made.dir, "requirements.txt"), { force: true });
  }
  const snapshot = await snapshotOf(made.dir);
  await writeFile(made.worker, workerSource, "utf8");
  await writeFile(path.join(made.dir, manifest), manifestSource, "utf8");
  return verifyWorkerIntegrationClaim(
    made.dir,
    snapshot,
    "src/agent.py",
    manifest,
    "testing",
  );
}

function contractFrom(
  result: Awaited<ReturnType<typeof verifyWorkerIntegrationClaim>>,
): WorkerIntegrationContract {
  expect(result.kind).toBe("verified");
  if (result.kind !== "verified") throw new Error(result.reason);
  return result.contract;
}

describe("the LiveKit worker integration verifier", () => {
  it("accepts a direct mockable import with a PEP 621 egma dependency", async () => {
    const made = await workspace();

    const result = await claim(
      made,
      WORKER_WITH_DIRECT_MOCKABLE,
      "pyproject.toml",
      [
        "[project]",
        'name = "front-desk"',
        "dependencies = [",
        '  "livekit-agents>=1.2",',
        '  "egma>=0.2",',
        "]",
        "",
      ].join("\n"),
    );

    expect(result).toMatchObject({
      kind: "verified",
      file: "src/agent.py",
      dependencyFile: "pyproject.toml",
    });
  });

  it("accepts multiline AgentSession construction and startup", async () => {
    const made = await workspace();
    const before = WORKER_BEFORE
      .replace(
        "    session = AgentSession()",
        "    session = AgentSession(\n        stt=object(),\n    )",
      )
      .replace(
        "    await session.start(agent=agent, room=ctx.room)",
        [
          "    await session.start(",
          "        agent=agent,",
          "        room=ctx.room,",
          "    )",
        ].join("\n"),
      );
    await writeFile(made.worker, before, "utf8");
    const multiline = before
      .replace(
        "from livekit.agents import AgentSession",
        "from egma import mockable\nfrom livekit.agents import AgentSession",
      )
      .replace(
        "    await session.start(",
        "    await mockable(agent, ctx, session)\n    await session.start(",
      );

    const result = await claim(
      made,
      multiline,
      "requirements.txt",
      "egma>=0.2\n",
    );

    expect(result.kind).toBe("verified");
  });

  it("accepts a multiline entrypoint signature and exact mockable call", async () => {
    const made = await workspace();
    const before = WORKER_BEFORE.replace(
      "async def entrypoint(ctx):",
      ["async def entrypoint(", "    ctx,", "):"].join("\n"),
    );
    await writeFile(made.worker, before, "utf8");
    const multiline = before
      .replace(
        "from livekit.agents import AgentSession",
        "from egma import mockable\nfrom livekit.agents import AgentSession",
      )
      .replace(
        "    await session.start(agent=agent, room=ctx.room)",
        [
          "    await mockable(",
          "        agent,",
          "        ctx,",
          "        session,",
          "    )",
          "    await session.start(agent=agent, room=ctx.room)",
        ].join("\n"),
      );

    const result = await claim(
      made,
      multiline,
      "requirements.txt",
      "egma>=0.2\n",
    );

    expect(result.kind).toBe("verified");
  });

  it("accepts a qualified mockable call with a Poetry egma dependency", async () => {
    const made = await workspace();

    const result = await claim(
      made,
      WORKER_WITH_QUALIFIED_MOCKABLE,
      "pyproject.toml",
      [
        "[tool.poetry.dependencies]",
        'python = "^3.12"',
        'livekit-agents = "^1.2"',
        'egma = "^0.2"',
        "",
      ].join("\n"),
    );

    if (result.kind !== "verified") throw new Error(result.reason);
    expect(result.kind).toBe("verified");
  });

  it("accepts egma in requirements.txt", async () => {
    const made = await workspace();

    const result = await claim(
      made,
      WORKER_WITH_DIRECT_MOCKABLE,
      "requirements.txt",
      ["livekit-agents>=1.2", "egma>=0.2", ""].join("\n"),
    );

    expect(result.kind).toBe("verified");
  });

  it("rejects a pyproject that does not declare egma", async () => {
    const made = await workspace();

    const result = await claim(
      made,
      WORKER_WITH_DIRECT_MOCKABLE,
      "pyproject.toml",
      [
        "[project]",
        'name = "front-desk"',
        'dependencies = ["livekit-agents>=1.2"]',
        "",
      ].join("\n"),
    );

    expect(result).toMatchObject({
      kind: "unverified",
      reason: expect.stringContaining("does not declare the Python egma distribution"),
    });
  });

  it("rejects egma that appears only in a requirements comment", async () => {
    const made = await workspace();

    const result = await claim(
      made,
      WORKER_WITH_DIRECT_MOCKABLE,
      "requirements.txt",
      ["livekit-agents>=1.2", "# egma>=0.2", ""].join("\n"),
    );

    expect(result).toMatchObject({
      kind: "unverified",
      reason: expect.stringContaining("does not declare the Python egma distribution"),
    });
  });

  it("rejects a mockable call after its egma import is removed", async () => {
    const made = await workspace();

    const result = await claim(
      made,
      WORKER_WITH_UNBOUND_MOCKABLE,
      "requirements.txt",
      "egma>=0.2\n",
    );

    expect(result).toMatchObject({
      kind: "unverified",
      reason: expect.stringContaining("mockable() is not imported from egma"),
    });
  });

  it("does not snapshot a file with two possible ctx entrypoints", async () => {
    const made = await workspace();
    await writeFile(
      made.worker,
      `${WORKER_BEFORE}\nasync def another_entrypoint(ctx):\n    await ctx.connect()\n`,
      "utf8",
    );

    const result = await snapshotWorkerIntegration(made.dir, "src/agent.py");

    expect(result).toMatchObject({
      kind: "unverified",
      reason: expect.stringContaining("could not identify one async job entrypoint"),
    });
  });

  it("does not bind an entrypoint call to an import inside another function", async () => {
    const made = await workspace();
    const unrelatedImport = [
      "from livekit.agents import AgentSession",
      "",
      "def helper():",
      "    from egma import mockable",
      "",
      "async def entrypoint(ctx):",
      "    await ctx.connect()",
      "    agent = object()",
      "    session = AgentSession()",
      "    await mockable(agent, ctx, session)",
      "    await session.start(agent=agent, room=ctx.room)",
      "",
    ].join("\n");

    const result = await claim(
      made,
      unrelatedImport,
      "requirements.txt",
      "egma>=0.2\n",
    );

    expect(result).toMatchObject({
      kind: "unverified",
      reason: expect.stringContaining("mockable() is not imported from egma"),
    });
  });

  it("does not accept a dead mockable call with the wrong arguments", async () => {
    const made = await workspace();
    const deadCall = WORKER_WITH_DIRECT_MOCKABLE.replace(
      "    await mockable(agent, ctx, session)",
      "    if False:\n        await mockable(wrong_argument)",
    );

    const result = await claim(
      made,
      deadCall,
      "requirements.txt",
      "egma>=0.2\n",
    );

    expect(result).toMatchObject({
      kind: "unverified",
      reason: expect.stringContaining("direct job-entrypoint statement"),
    });
  });

  it("rejects mockable before the inline session.start agent is bound", async () => {
    const made = await workspace();
    const inlineAgent = WORKER_WITH_DIRECT_MOCKABLE
      .replace("    agent = object()\n", "")
      .replace("agent=agent", "agent=Assistant()");

    const result = await claim(
      made,
      inlineAgent,
      "requirements.txt",
      "egma>=0.2\n",
    );

    expect(result).toMatchObject({
      kind: "unverified",
      reason: expect.stringContaining("agent is not bound before mockable"),
    });
  });

  it("rejects mockable before its session binding exists", async () => {
    const made = await workspace();
    const lateSession = WORKER_WITH_DIRECT_MOCKABLE.replace(
      "    session = AgentSession()\n    await mockable(agent, ctx, session)",
      "    await mockable(agent, ctx, session)\n    session = AgentSession()",
    );

    const result = await claim(
      made,
      lateSession,
      "requirements.txt",
      "egma>=0.2\n",
    );

    expect(result).toMatchObject({
      kind: "unverified",
      reason: expect.stringContaining("session is not bound before mockable"),
    });
  });

  it("requires session.start to receive the mocked agent binding", async () => {
    const made = await workspace();
    const differentAgent = WORKER_WITH_DIRECT_MOCKABLE
      .replace("    session = AgentSession()", "    other_agent = object()\n    session = AgentSession()")
      .replace("agent=agent", "agent=other_agent");

    const result = await claim(
      made,
      differentAgent,
      "requirements.txt",
      "egma>=0.2\n",
    );

    expect(result).toMatchObject({
      kind: "unverified",
      reason: expect.stringContaining("same session and agent bindings"),
    });
  });

  it("requires session.start on the same mocked session binding", async () => {
    const made = await workspace();
    const differentSession = WORKER_WITH_DIRECT_MOCKABLE
      .replace("    session = AgentSession()", "    session = AgentSession()\n    other_session = AgentSession()")
      .replace("await session.start", "await other_session.start");

    const result = await claim(
      made,
      differentSession,
      "requirements.txt",
      "egma>=0.2\n",
    );

    expect(result).toMatchObject({
      kind: "unverified",
      reason: expect.stringContaining("same session and agent bindings"),
    });
  });

  it("rejects the mocked session when it already started before mockable", async () => {
    const made = await workspace();
    const startedTwice = WORKER_WITH_DIRECT_MOCKABLE.replace(
      "    await mockable(agent, ctx, session)",
      [
        "    await session.start(agent=agent, room=ctx.room)",
        "    await mockable(agent, ctx, session)",
      ].join("\n"),
    );

    const result = await claim(
      made,
      startedTwice,
      "requirements.txt",
      "egma>=0.2\n",
    );

    expect(result).toMatchObject({
      kind: "unverified",
      reason: expect.stringContaining("session already starts before mockable"),
    });
  });

  it.each(["agent", "session"] as const)(
    "rejects a top-level %s reassignment between mockable and session.start",
    async (binding) => {
      const made = await workspace();
      const reassigned = WORKER_WITH_DIRECT_MOCKABLE.replace(
        "    await session.start(agent=agent, room=ctx.room)",
        [
          `    ${binding} = replacement`,
          "    await session.start(agent=agent, room=ctx.room)",
        ].join("\n"),
      );

      const result = await claim(
        made,
        reassigned,
        "requirements.txt",
        "egma>=0.2\n",
      );

      expect(result).toMatchObject({
        kind: "unverified",
        reason: expect.stringContaining(
          `${binding} is rebound between mockable() and AgentSession.start()`,
        ),
      });
    },
  );

  it.each(["agent", "session"] as const)(
    "rejects a nested %s rebinding between mockable and session.start",
    async (binding) => {
      const made = await workspace();
      const rebound = WORKER_WITH_DIRECT_MOCKABLE.replace(
        "    await session.start(agent=agent, room=ctx.room)",
        [
          "    if True:",
          `        ${binding} = replacement`,
          "    await session.start(agent=agent, room=ctx.room)",
        ].join("\n"),
      );

      const result = await claim(
        made,
        rebound,
        "requirements.txt",
        "egma>=0.2\n",
      );

      expect(result).toMatchObject({
        kind: "unverified",
        reason: expect.stringContaining(
          `${binding} is rebound between mockable() and AgentSession.start()`,
        ),
      });
    },
  );

  it.each([
    {
      mode: "monitoring" as const,
      source: WORKER_WITH_DIRECT_MONITORING.replace(
        "    monitor_livekit(ctx)",
        "    monitor_livekit(ctx)\n    monitor_livekit(ctx)",
      ),
      hook: "monitor_livekit",
    },
    {
      mode: "testing" as const,
      source: WORKER_WITH_DIRECT_MOCKABLE.replace(
        "    await mockable(agent, ctx, session)",
        [
          "    await mockable(agent, ctx, session)",
          "    await mockable(agent, ctx, session)",
        ].join("\n"),
      ),
      hook: "mockable",
    },
    {
      mode: "both" as const,
      source: WORKER_WITH_ALIASED_BOTH.replace(
        "    observe(ctx)",
        "    observe(ctx)\n    observe(ctx)",
      ),
      hook: "monitor_livekit",
    },
    {
      mode: "both" as const,
      source: WORKER_WITH_ALIASED_BOTH.replace(
        "    await isolate(agent, ctx, session)",
        [
          "    await isolate(agent, ctx, session)",
          "    await isolate(agent, ctx, session)",
        ].join("\n"),
      ),
      hook: "mockable",
    },
  ])(
    "rejects duplicate $hook calls in $mode mode",
    async ({ mode, source, hook }) => {
      const made = await workspace();
      const snapshot = await snapshotOf(made.dir);
      await writeFile(made.worker, source, "utf8");
      await writeFile(
        path.join(made.dir, "requirements.txt"),
        "livekit-agents>=1.2\negma>=0.2\n",
        "utf8",
      );

      const result = await verifyWorkerIntegrationClaim(
        made.dir,
        snapshot,
        "src/agent.py",
        "requirements.txt",
        mode,
      );

      expect(result).toMatchObject({
        kind: "unverified",
        reason: expect.stringContaining(`expected exactly one ${hook}() call`),
      });
    },
  );

  it("rejects a new testing hook in monitoring-only mode", async () => {
    const made = await workspace();
    const snapshot = await snapshotOf(made.dir);
    await writeFile(made.worker, WORKER_WITH_ALIASED_BOTH, "utf8");
    await writeFile(path.join(made.dir, "requirements.txt"), "egma>=0.2\n", "utf8");

    const result = await verifyWorkerIntegrationClaim(
      made.dir,
      snapshot,
      "src/agent.py",
      "requirements.txt",
      "monitoring",
    );

    expect(result).toMatchObject({
      kind: "unverified",
      reason: expect.stringContaining("monitoring-only integration added mockable"),
    });
  });

  it("rejects a new monitoring hook in testing-only mode", async () => {
    const made = await workspace();
    const snapshot = await snapshotOf(made.dir);
    await writeFile(made.worker, WORKER_WITH_ALIASED_BOTH, "utf8");
    await writeFile(path.join(made.dir, "requirements.txt"), "egma>=0.2\n", "utf8");

    const result = await verifyWorkerIntegrationClaim(
      made.dir,
      snapshot,
      "src/agent.py",
      "requirements.txt",
      "testing",
    );

    expect(result).toMatchObject({
      kind: "unverified",
      reason: expect.stringContaining("testing-only integration added monitor_livekit"),
    });
  });

  it.each([
    {
      mode: "monitoring" as const,
      source: WORKER_WITH_DIRECT_MONITORING
        .replace(
          "from egma import monitor_livekit",
          "from egma import mockable, monitor_livekit",
        )
        .replace(
          "    await session.start(agent=agent, room=ctx.room)",
          [
            "    mockable(agent, ctx, session)",
            "    await session.start(agent=agent, room=ctx.room)",
          ].join("\n"),
        ),
      reason: "monitoring-only integration added mockable",
    },
    {
      mode: "testing" as const,
      source: WORKER_WITH_DIRECT_MOCKABLE
        .replace(
          "from egma import mockable",
          "from egma import mockable, monitor_livekit",
        )
        .replace(
          "    agent = object()",
          "    await monitor_livekit(ctx)\n    agent = object()",
        ),
      reason: "testing-only integration added monitor_livekit",
    },
  ])(
    "rejects a malformed unrequested hook call in $mode mode",
    async ({ mode, source, reason }) => {
      const made = await workspace();
      const snapshot = await snapshotOf(made.dir);
      await writeFile(made.worker, source, "utf8");
      await writeFile(path.join(made.dir, "requirements.txt"), "egma>=0.2\n", "utf8");

      const result = await verifyWorkerIntegrationClaim(
        made.dir,
        snapshot,
        "src/agent.py",
        "requirements.txt",
        mode,
      );

      expect(result).toMatchObject({
        kind: "unverified",
        reason: expect.stringContaining(reason),
      });
    },
  );

  it.each([
    {
      mode: "monitoring" as const,
      source: `${WORKER_WITH_DIRECT_MONITORING.replace(
        "from egma import monitor_livekit",
        "from egma import mockable, monitor_livekit",
      )}\ndef helper(agent, ctx, session):\n    mockable(agent, ctx, session)\n`,
      reason: "monitoring-only integration added mockable",
    },
    {
      mode: "testing" as const,
      source: `${WORKER_WITH_DIRECT_MOCKABLE.replace(
        "from egma import mockable",
        "from egma import mockable, monitor_livekit",
      )}\ndef helper(ctx):\n    monitor_livekit(ctx)\n`,
      reason: "testing-only integration added monitor_livekit",
    },
  ])(
    "rejects an unrequested hook added outside the entrypoint in $mode mode",
    async ({ mode, source, reason }) => {
      const made = await workspace();
      const snapshot = await snapshotOf(made.dir);
      await writeFile(made.worker, source, "utf8");
      await writeFile(path.join(made.dir, "requirements.txt"), "egma>=0.2\n", "utf8");

      const result = await verifyWorkerIntegrationClaim(
        made.dir,
        snapshot,
        "src/agent.py",
        "requirements.txt",
        mode,
      );

      expect(result).toMatchObject({
        kind: "unverified",
        reason: expect.stringContaining(reason),
      });
    },
  );

  it.each([
    {
      mode: "monitoring" as const,
      before: `${WORKER_BEFORE.replace(
        "from livekit.agents import AgentSession",
        "from egma import mockable\nfrom livekit.agents import AgentSession",
      )}\ndef helper(agent, ctx, session):\n    mockable(agent, ctx, session)\n`,
      after: `${WORKER_WITH_DIRECT_MONITORING.replace(
        "from egma import monitor_livekit",
        "from egma import mockable, monitor_livekit",
      )}\ndef helper(agent, ctx, session):\n    mockable(agent, ctx, session)\n`,
    },
    {
      mode: "testing" as const,
      before: `${WORKER_BEFORE.replace(
        "from livekit.agents import AgentSession",
        "from egma import monitor_livekit\nfrom livekit.agents import AgentSession",
      )}\ndef helper(ctx):\n    monitor_livekit(ctx)\n`,
      after: `${WORKER_WITH_DIRECT_MOCKABLE.replace(
        "from egma import mockable",
        "from egma import mockable, monitor_livekit",
      )}\ndef helper(ctx):\n    monitor_livekit(ctx)\n`,
    },
  ])(
    "preserves an unchanged unrequested helper hook in $mode mode",
    async ({ mode, before, after }) => {
      const made = await workspace();
      await writeFile(made.worker, before, "utf8");
      const snapshot = await snapshotOf(made.dir);
      await writeFile(made.worker, after, "utf8");
      await writeFile(
        path.join(made.dir, "requirements.txt"),
        "livekit-agents>=1.2\negma>=0.2\n",
        "utf8",
      );

      const result = await verifyWorkerIntegrationClaim(
        made.dir,
        snapshot,
        "src/agent.py",
        "requirements.txt",
        mode,
      );

      expect(result.kind).toBe("verified");
    },
  );

  it.each([
    {
      mode: "monitoring" as const,
      source: WORKER_WITH_DIRECT_MONITORING.replace(
        "    await session.start(agent=agent, room=ctx.room)",
        "    await mockable(agent, ctx, session)\n    await session.start(agent=agent, room=ctx.room)",
      ),
      reason: "monitoring-only integration added mockable",
    },
    {
      mode: "testing" as const,
      source: WORKER_WITH_DIRECT_MOCKABLE.replace(
        "    agent = object()",
        "    monitor_livekit(ctx)\n    agent = object()",
      ),
      reason: "testing-only integration added monitor_livekit",
    },
  ])(
    "rejects an unimported hook added outside $mode mode",
    async ({ mode, source, reason }) => {
      const made = await workspace();
      const snapshot = await snapshotOf(made.dir);
      await writeFile(made.worker, source, "utf8");
      await writeFile(path.join(made.dir, "requirements.txt"), "egma>=0.2\n", "utf8");

      const result = await verifyWorkerIntegrationClaim(
        made.dir,
        snapshot,
        "src/agent.py",
        "requirements.txt",
        mode,
      );

      expect(result).toMatchObject({
        kind: "unverified",
        reason: expect.stringContaining(reason),
      });
    },
  );

  it.each([
    {
      mode: "monitoring" as const,
      after: WORKER_WITH_DIRECT_MONITORING,
      removed: "removed a pre-existing mockable() call",
    },
    {
      mode: "testing" as const,
      after: WORKER_WITH_DIRECT_MOCKABLE,
      removed: "removed a pre-existing monitor_livekit() call",
    },
  ])("preserves aliased existing hooks when adding $mode", async ({ mode, after, removed }) => {
    const made = await workspace();
    await writeFile(made.worker, WORKER_WITH_ALIASED_BOTH, "utf8");
    const snapshot = await snapshotOf(made.dir);
    await writeFile(made.worker, after, "utf8");
    await writeFile(path.join(made.dir, "requirements.txt"), "egma>=0.2\n", "utf8");

    const result = await verifyWorkerIntegrationClaim(
      made.dir,
      snapshot,
      "src/agent.py",
      "requirements.txt",
      mode,
    );

    expect(result).toMatchObject({
      kind: "unverified",
      reason: expect.stringContaining(removed),
    });
  });

  it("does not accept an Egma hook shadowed inside the entrypoint", async () => {
    const made = await workspace();
    const shadowed = WORKER_WITH_DIRECT_MOCKABLE.replace(
      "    await mockable(agent, ctx, session)",
      "    mockable = unsafe_mockable\n    await mockable(agent, ctx, session)",
    );

    const result = await claim(
      made,
      shadowed,
      "requirements.txt",
      "egma>=0.2\n",
    );

    expect(result).toMatchObject({
      kind: "unverified",
      reason: expect.stringContaining("is shadowed inside the job entrypoint"),
    });
  });

  it("does not accept an Egma hook shadowed by an entrypoint parameter", async () => {
    const made = await workspace();
    const shadowed = WORKER_WITH_DIRECT_MOCKABLE.replace(
      "async def entrypoint(ctx):",
      "async def entrypoint(ctx, mockable=unsafe_mockable):",
    );

    const result = await claim(
      made,
      shadowed,
      "requirements.txt",
      "egma>=0.2\n",
    );

    expect(result).toMatchObject({
      kind: "unverified",
      reason: expect.stringContaining("is shadowed inside the job entrypoint"),
    });
  });

  it("does not accept an Egma hook rebound by a later top-level import", async () => {
    const made = await workspace();
    const shadowed = WORKER_WITH_DIRECT_MOCKABLE.replace(
      "from egma import mockable",
      "from egma import mockable\nfrom project.testing import mockable",
    );

    const result = await claim(
      made,
      shadowed,
      "requirements.txt",
      "egma>=0.2\n",
    );

    expect(result).toMatchObject({
      kind: "unverified",
      reason: expect.stringContaining("rebound after its egma import"),
    });
  });

  it("rejects a dependency manifest reported outside the repository", async () => {
    const made = await workspace();
    const snapshot = await snapshotOf(made.dir);
    await writeFile(made.worker, WORKER_WITH_DIRECT_MOCKABLE, "utf8");

    const result = await verifyWorkerIntegrationClaim(
      made.dir,
      snapshot,
      "src/agent.py",
      "../requirements.txt",
      "testing",
    );

    expect(result).toMatchObject({
      kind: "unverified",
      reason: expect.stringContaining("outside this repository"),
    });
  });

  it.each([
    "requirements-dev.txt",
    "docs/requirements.txt",
  ])(
    "rejects dependency manifest %s when it was not on the worker ancestor path before integration",
    async (manifest) => {
      const made = await workspace();
      await writeFile(
        path.join(made.dir, "pyproject.toml"),
        '[project]\nname = "front-desk"\ndependencies = []\n',
        "utf8",
      );
      const snapshot = await snapshotOf(made.dir);
      await writeFile(made.worker, WORKER_WITH_DIRECT_MOCKABLE, "utf8");
      await mkdir(path.dirname(path.join(made.dir, manifest)), { recursive: true });
      await writeFile(path.join(made.dir, manifest), "egma>=0.2\n", "utf8");

      const result = await verifyWorkerIntegrationClaim(
        made.dir,
        snapshot,
        "src/agent.py",
        manifest,
        "testing",
      );

      expect(result).toMatchObject({
        kind: "unverified",
        reason: expect.stringContaining(
          "was not the existing runtime dependency manifest for the worker",
        ),
      });
    },
  );

  it("requires pyproject.toml when the worker runtime has a uv project", async () => {
    const made = await workspace();
    await writeFile(
      path.join(made.dir, "pyproject.toml"),
      '[project]\nname = "front-desk"\ndependencies = []\n',
      "utf8",
    );
    await writeFile(path.join(made.dir, "uv.lock"), "version = 1\n", "utf8");
    await writeFile(
      path.join(made.dir, "requirements-dev.txt"),
      "livekit-agents>=1.2\n",
      "utf8",
    );
    const snapshot = await snapshotOf(made.dir);
    await writeFile(made.worker, WORKER_WITH_DIRECT_MOCKABLE, "utf8");
    await writeFile(
      path.join(made.dir, "requirements-dev.txt"),
      "livekit-agents>=1.2\negma>=0.2\n",
      "utf8",
    );

    const result = await verifyWorkerIntegrationClaim(
      made.dir,
      snapshot,
      "src/agent.py",
      "requirements-dev.txt",
      "testing",
    );

    expect(result).toMatchObject({
      kind: "unverified",
      reason: expect.stringContaining(
        "was not the existing runtime dependency manifest for the worker",
      ),
    });
  });

  it.each([
    "requirements-dev.txt",
    "requirements.in",
    "requirements/base.txt",
  ])(
    "does not treat %s as the LiveKit pip project manifest",
    async (manifest) => {
      const made = await workspace();
      await rm(path.join(made.dir, "requirements.txt"));
      await mkdir(path.dirname(path.join(made.dir, manifest)), { recursive: true });
      await writeFile(
        path.join(made.dir, manifest),
        "livekit-agents>=1.2\n",
        "utf8",
      );

      const result = await snapshotWorkerIntegration(made.dir, "src/agent.py");

      expect(result).toMatchObject({
        kind: "unverified",
        reason: expect.stringContaining(
          "found no existing Python dependency manifest",
        ),
      });
    },
  );

  it("uses a nearer requirements project instead of a parent pyproject", async () => {
    const made = await workspace();
    const serviceWorker = path.join(made.dir, "service", "src", "agent.py");
    await mkdir(path.dirname(serviceWorker), { recursive: true });
    await writeFile(serviceWorker, WORKER_BEFORE, "utf8");
    await writeFile(
      path.join(made.dir, "pyproject.toml"),
      '[project]\nname = "repository-root"\ndependencies = []\n',
      "utf8",
    );
    await writeFile(
      path.join(made.dir, "service", "requirements.txt"),
      "livekit-agents>=1.2\n",
      "utf8",
    );
    const snapshotted = await snapshotWorkerIntegration(
      made.dir,
      "service/src/agent.py",
    );
    expect(snapshotted.kind).toBe("snapshotted");
    if (snapshotted.kind !== "snapshotted") {
      throw new Error(snapshotted.reason);
    }
    await writeFile(serviceWorker, WORKER_WITH_DIRECT_MOCKABLE, "utf8");
    await writeFile(
      path.join(made.dir, "service", "requirements.txt"),
      "livekit-agents>=1.2\negma>=0.1.0\n",
      "utf8",
    );

    const result = await verifyWorkerIntegrationClaim(
      made.dir,
      snapshotted.snapshot,
      "service/src/agent.py",
      "service/requirements.txt",
      "testing",
    );

    expect(result).toMatchObject({
      kind: "verified",
      dependencyFile: "service/requirements.txt",
    });
  });

  it("rejects an unrelated worker rewrite during integration", async () => {
    const made = await workspace();
    const rewritten = WORKER_WITH_DIRECT_MOCKABLE.replace(
      "await ctx.connect()",
      "await ctx.connect(auto_subscribe=False)",
    );

    const result = await claim(
      made,
      rewritten,
      "requirements.txt",
      "livekit-agents>=1.2\negma>=0.2\n",
    );

    expect(result).toMatchObject({
      kind: "unverified",
      reason: expect.stringContaining(
        "changed worker code outside the exact Egma imports and entry hooks",
      ),
    });
  });

  it.each([
    ["deletes", "from egma import mockable"],
    ["changes", "from egma import replacement, mockable"],
  ])(
    "rejects an integration that %s an unrelated name in a mixed Egma import",
    async (_change, afterImport) => {
      const made = await workspace();
      const before = WORKER_WITH_DIRECT_MOCKABLE.replace(
        "from egma import mockable",
        "from egma import other, mockable",
      );
      await writeFile(made.worker, before, "utf8");
      const snapshot = await snapshotOf(made.dir);
      await writeFile(
        made.worker,
        WORKER_WITH_DIRECT_MOCKABLE.replace(
          "from egma import mockable",
          afterImport,
        ),
        "utf8",
      );
      await writeFile(
        path.join(made.dir, "requirements.txt"),
        "livekit-agents>=1.2\negma>=0.2\n",
        "utf8",
      );

      const result = await verifyWorkerIntegrationClaim(
        made.dir,
        snapshot,
        "src/agent.py",
        "requirements.txt",
        "testing",
      );

      expect(result).toMatchObject({
        kind: "unverified",
        reason: expect.stringContaining(
          "changed worker code outside the exact Egma imports and entry hooks",
        ),
      });
    },
  );

  it("rejects deletion of import egma when another Egma API still uses it", async () => {
    const made = await workspace();
    const before = WORKER_BEFORE.replace(
      "from livekit.agents import AgentSession",
      "import egma\nfrom livekit.agents import AgentSession",
    ).replace(
      "async def entrypoint(ctx):\n    await ctx.connect()",
      "async def entrypoint(ctx):\n    egma.configure()\n    await ctx.connect()",
    );
    const after = before
      .replace("import egma", "from egma import mockable")
      .replace(
        "    await session.start(agent=agent, room=ctx.room)",
        "    await mockable(agent, ctx, session)\n    await session.start(agent=agent, room=ctx.room)",
      );
    await writeFile(made.worker, before, "utf8");
    const snapshot = await snapshotOf(made.dir);
    await writeFile(made.worker, after, "utf8");
    await writeFile(
      path.join(made.dir, "requirements.txt"),
      "livekit-agents>=1.2\negma>=0.2\n",
      "utf8",
    );

    const result = await verifyWorkerIntegrationClaim(
      made.dir,
      snapshot,
      "src/agent.py",
      "requirements.txt",
      "testing",
    );

    expect(result).toMatchObject({
      kind: "unverified",
      reason: expect.stringContaining(
        "changed worker code outside the exact Egma imports and entry hooks",
      ),
    });
  });

  it("allows a requested hook to join an existing unrelated Egma import", async () => {
    const made = await workspace();
    const before = WORKER_BEFORE.replace(
      "from livekit.agents import AgentSession",
      "from egma import other\nfrom livekit.agents import AgentSession",
    );
    const after = WORKER_WITH_DIRECT_MOCKABLE.replace(
      "from egma import mockable",
      "from egma import other, mockable",
    );
    await writeFile(made.worker, before, "utf8");
    const snapshot = await snapshotOf(made.dir);
    await writeFile(made.worker, after, "utf8");
    await writeFile(
      path.join(made.dir, "requirements.txt"),
      "livekit-agents>=1.2\negma>=0.2\n",
      "utf8",
    );

    const result = await verifyWorkerIntegrationClaim(
      made.dir,
      snapshot,
      "src/agent.py",
      "requirements.txt",
      "testing",
    );

    expect(result).toMatchObject({ kind: "verified" });
  });

  it("rejects an unrelated runtime dependency rewrite during integration", async () => {
    const made = await workspace();
    const snapshot = await snapshotOf(made.dir);
    await writeFile(made.worker, WORKER_WITH_DIRECT_MOCKABLE, "utf8");
    await writeFile(
      path.join(made.dir, "requirements.txt"),
      "livekit-agents>=1.3\negma>=0.2\n",
      "utf8",
    );

    const result = await verifyWorkerIntegrationClaim(
      made.dir,
      snapshot,
      "src/agent.py",
      "requirements.txt",
      "testing",
    );

    expect(result).toMatchObject({
      kind: "unverified",
      reason: expect.stringContaining(
        "changed the runtime manifest beyond one registry egma dependency",
      ),
    });
  });

  it("rejects the final integration if a hook loses its egma import", async () => {
    const made = await workspace();
    const claimed = await claim(
      made,
      WORKER_WITH_DIRECT_MOCKABLE,
      "requirements.txt",
      "egma>=0.2\n",
    );
    const contract = contractFrom(claimed);
    await writeFile(made.worker, WORKER_WITH_UNBOUND_MOCKABLE, "utf8");

    const result = await verifyWorkerIntegration(made.dir, contract);

    expect(result).toMatchObject({
      kind: "unverified",
      reason: expect.stringContaining("worker changed after integration approval"),
    });
  });

  it("rejects the final integration if egma is later removed from its manifest", async () => {
    const made = await workspace();
    const manifest = "requirements.txt";
    const claimed = await claim(
      made,
      WORKER_WITH_DIRECT_MOCKABLE,
      manifest,
      "egma>=0.2\n",
    );
    const contract = contractFrom(claimed);
    await writeFile(path.join(made.dir, manifest), "livekit-agents>=1.2\n", "utf8");

    const result = await verifyWorkerIntegration(made.dir, contract);

    expect(result).toMatchObject({
      kind: "unverified",
      reason: expect.stringContaining(
        "runtime dependency manifest changed after integration approval",
      ),
    });
  });

  it.each([
    {
      file: "worker" as const,
      expected: "worker changed after integration approval",
    },
    {
      file: "manifest" as const,
      expected: "runtime dependency manifest changed after integration approval",
    },
  ])("rejects a later $file rewrite even when Egma remains valid", async ({ file, expected }) => {
    const made = await workspace();
    const claimed = await claim(
      made,
      WORKER_WITH_DIRECT_MOCKABLE,
      "requirements.txt",
      "livekit-agents>=1.2\negma>=0.2\n",
    );
    const contract = contractFrom(claimed);
    if (file === "worker") {
      await writeFile(
        made.worker,
        WORKER_WITH_DIRECT_MOCKABLE.replace(
          "    agent = object()",
          "    print('later task')\n    agent = object()",
        ),
        "utf8",
      );
    } else {
      await writeFile(
        path.join(made.dir, "requirements.txt"),
        "livekit-agents>=1.2\negma>=0.2\npytest>=8\n",
        "utf8",
      );
    }

    const result = await verifyWorkerIntegration(made.dir, contract);

    expect(result).toMatchObject({
      kind: "unverified",
      reason: expect.stringContaining(expected),
    });
  });
});
