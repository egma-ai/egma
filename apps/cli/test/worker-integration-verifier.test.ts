import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  snapshotWorkerIntegration,
  verifyWorkerIntegration,
  verifyWorkerIntegrationClaim,
  type WorkerIntegrationContract,
  type WorkerIntegrationMode,
  type WorkerIntegrationSnapshot,
  type WorkerIntegrationVerification,
} from "../src/wizard/worker-integration-verifier.ts";

const temporary: string[] = [];
const REQUIREMENTS_BEFORE = "livekit-agents>=1.2\n";
const REQUIREMENTS_WITH_EGMA = "livekit-agents>=1.2\negma>=0.2\n";

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

const WORKER_WITH_DIRECT_BOTH = [
  "from egma import mockable, monitor_livekit",
  "from livekit.agents import AgentSession",
  "",
  "",
  "async def entrypoint(ctx):",
  "    monitor_livekit(ctx)",
  "    await ctx.connect()",
  "    agent = object()",
  "    session = AgentSession()",
  "    await mockable(agent, ctx, session)",
  "    await session.start(agent=agent, room=ctx.room)",
  "",
].join("\n");

const MULTILINE_SESSION_BEFORE = WORKER_BEFORE.replace(
  "    session = AgentSession()",
  "    session = AgentSession(\n        stt=object(),\n    )",
).replace(
  "    await session.start(agent=agent, room=ctx.room)",
  [
    "    await session.start(",
    "        agent=agent,",
    "        room=ctx.room,",
    "    )",
  ].join("\n"),
);

const MULTILINE_SESSION_AFTER = MULTILINE_SESSION_BEFORE.replace(
  "from livekit.agents import AgentSession",
  "from egma import mockable\nfrom livekit.agents import AgentSession",
).replace(
  "    await session.start(",
  "    await mockable(agent, ctx, session)\n    await session.start(",
);

const MULTILINE_ENTRYPOINT_BEFORE = WORKER_BEFORE.replace(
  "async def entrypoint(ctx):",
  ["async def entrypoint(", "    ctx,", "):"].join("\n"),
);

const MULTILINE_ENTRYPOINT_AFTER = MULTILINE_ENTRYPOINT_BEFORE.replace(
  "from livekit.agents import AgentSession",
  "from egma import mockable\nfrom livekit.agents import AgentSession",
).replace(
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

type Workspace = {
  readonly dir: string;
  readonly worker: string;
};

type WorkerChange = {
  readonly after: string;
  readonly before?: string;
  readonly manifest?: string;
  readonly manifestAfter?: string;
  readonly manifestBefore?: string;
  readonly mode?: WorkerIntegrationMode;
};

afterEach(async () => {
  await Promise.all(
    temporary.splice(0).map((folder) => rm(folder, { recursive: true, force: true })),
  );
});

async function workspace(workerSource = WORKER_BEFORE): Promise<Workspace> {
  const dir = await mkdtemp(path.join(tmpdir(), "egma-worker-verifier-"));
  temporary.push(dir);
  await mkdir(path.join(dir, "src"), { recursive: true });
  const worker = path.join(dir, "src", "agent.py");
  await writeFile(worker, workerSource, "utf8");
  await writeFile(path.join(dir, "requirements.txt"), REQUIREMENTS_BEFORE, "utf8");
  return { dir, worker };
}

async function snapshotOf(dir: string): Promise<WorkerIntegrationSnapshot> {
  const result = await snapshotWorkerIntegration(dir, "src/agent.py");
  expect(result.kind).toBe("snapshotted");
  if (result.kind !== "snapshotted") throw new Error(result.reason);
  return result.snapshot;
}

async function verifyChange({
  after,
  before = WORKER_BEFORE,
  manifest = "requirements.txt",
  manifestAfter = REQUIREMENTS_WITH_EGMA,
  manifestBefore = REQUIREMENTS_BEFORE,
  mode = "testing",
}: WorkerChange): Promise<WorkerIntegrationVerification> {
  const made = await workspace(before);
  if (manifest !== "requirements.txt") {
    await rm(path.join(made.dir, "requirements.txt"), { force: true });
  }
  await mkdir(path.dirname(path.join(made.dir, manifest)), { recursive: true });
  await writeFile(path.join(made.dir, manifest), manifestBefore, "utf8");
  const snapshot = await snapshotOf(made.dir);
  await writeFile(made.worker, after, "utf8");
  await writeFile(path.join(made.dir, manifest), manifestAfter, "utf8");
  return verifyWorkerIntegrationClaim(
    made.dir,
    snapshot,
    "src/agent.py",
    manifest,
    mode,
  );
}

async function claim(
  workerSource: string,
  manifest: string,
  manifestSource: string,
  before = WORKER_BEFORE,
): Promise<WorkerIntegrationVerification> {
  const manifestBefore = manifest.endsWith(".toml")
    ? manifestSource
    : manifestSource
        .split("\n")
        .filter((line) => !/^\s*egma\b/iu.test(line))
        .join("\n");
  return verifyChange({
    after: workerSource,
    before,
    manifest,
    manifestAfter: manifestSource,
    manifestBefore,
  });
}

function expectVerified(
  result: WorkerIntegrationVerification,
  expected: Record<string, unknown> = {},
): void {
  expect(result).toMatchObject({ kind: "verified", ...expected });
}

function expectUnverified(
  result: WorkerIntegrationVerification,
  reason: string,
): void {
  expect(result).toMatchObject({
    kind: "unverified",
    reason: expect.stringContaining(reason),
  });
}

function contractFrom(result: WorkerIntegrationVerification): WorkerIntegrationContract {
  expect(result.kind).toBe("verified");
  if (result.kind !== "verified") throw new Error(result.reason);
  return result.contract;
}

async function approvedIntegration(): Promise<{
  readonly made: Workspace;
  readonly contract: WorkerIntegrationContract;
}> {
  const made = await workspace();
  const snapshot = await snapshotOf(made.dir);
  await writeFile(made.worker, WORKER_WITH_DIRECT_MOCKABLE, "utf8");
  await writeFile(
    path.join(made.dir, "requirements.txt"),
    REQUIREMENTS_WITH_EGMA,
    "utf8",
  );
  const claimed = await verifyWorkerIntegrationClaim(
    made.dir,
    snapshot,
    "src/agent.py",
    "requirements.txt",
    "testing",
  );
  return { made, contract: contractFrom(claimed) };
}

describe("the LiveKit worker integration verifier", () => {
  it("accepts a direct mockable import with a PEP 621 egma dependency", async () => {
    const manifest = [
      "[project]",
      'name = "front-desk"',
      "dependencies = [",
      '  "livekit-agents>=1.2",',
      '  "egma>=0.2",',
      "]",
      "",
    ].join("\n");

    const result = await claim(
      WORKER_WITH_DIRECT_MOCKABLE,
      "pyproject.toml",
      manifest,
    );

    expectVerified(result, {
      file: "src/agent.py",
      dependencyFile: "pyproject.toml",
    });
  });

  it.each([
    {
      name: "multiline AgentSession construction and startup",
      before: MULTILINE_SESSION_BEFORE,
      after: MULTILINE_SESSION_AFTER,
      manifest: "requirements.txt",
      dependency: "egma>=0.2\n",
    },
    {
      name: "a multiline entrypoint signature and exact mockable call",
      before: MULTILINE_ENTRYPOINT_BEFORE,
      after: MULTILINE_ENTRYPOINT_AFTER,
      manifest: "requirements.txt",
      dependency: "egma>=0.2\n",
    },
    {
      name: "a qualified mockable call with a Poetry egma dependency",
      after: WORKER_WITH_QUALIFIED_MOCKABLE,
      manifest: "pyproject.toml",
      dependency: [
        "[tool.poetry.dependencies]",
        'python = "^3.12"',
        'livekit-agents = "^1.2"',
        'egma = "^0.2"',
        "",
      ].join("\n"),
    },
    {
      name: "egma in requirements.txt",
      after: WORKER_WITH_DIRECT_MOCKABLE,
      manifest: "requirements.txt",
      dependency: REQUIREMENTS_WITH_EGMA,
    },
  ])("accepts $name", async ({ after, before, manifest, dependency }) => {
    expectVerified(await claim(after, manifest, dependency, before));
  });

  it.each([
    {
      name: "an Egma SDK pin two releases under the floor",
      dependency: "livekit-agents>=1.6.7\negma>=0.1.0\n",
    },
    {
      name: "the last Egma SDK pin that reads dispatch metadata",
      dependency: "livekit-agents>=1.6.7\negma>=0.1.1\n",
    },
    {
      name: "an Egma SDK pin that excludes the floor itself",
      dependency: "livekit-agents>=1.6.7\negma>0.2.0\n",
    },
  ])("rejects $name", async ({ dependency }) => {
    const result = await claim(
      WORKER_WITH_DIRECT_MOCKABLE,
      "requirements.txt",
      dependency,
    );

    expectUnverified(result, "egma>=0.2.0");
  });

  it("accepts an Egma SDK pin at the floor exactly", async () => {
    expectVerified(
      await claim(
        WORKER_WITH_DIRECT_MOCKABLE,
        "requirements.txt",
        "livekit-agents>=1.6.7\negma>=0.2.0\n",
      ),
    );
  });

  it.each([
    {
      name: "testing integration when session.start connects the worker",
      before: WORKER_BEFORE.replace("    await ctx.connect()\n", ""),
      after: WORKER_WITH_DIRECT_MOCKABLE.replace("    await ctx.connect()\n", ""),
      mode: "testing" as const,
    },
    {
      name: "monitor, connect, mockable, and matching session.start in order",
      before: WORKER_BEFORE,
      after: WORKER_WITH_DIRECT_BOTH,
      mode: "both" as const,
    },
  ])("accepts $name", async ({ before, after, mode }) => {
    expectVerified(await verifyChange({ before, after, mode }));
  });

  it.each([
    {
      name: "an awaited ctx.connect added only for the Egma integration",
      before: WORKER_BEFORE.replace("    await ctx.connect()\n", ""),
      after: WORKER_WITH_DIRECT_MOCKABLE,
      reason: "changed worker code outside the exact Egma imports and entry hooks",
    },
    {
      name: "mockable before the awaited ctx.connect",
      before: WORKER_BEFORE,
      after: WORKER_WITH_DIRECT_MOCKABLE.replace("    await ctx.connect()\n", "").replace(
        "    await session.start(agent=agent, room=ctx.room)",
        "    await ctx.connect()\n    await session.start(agent=agent, room=ctx.room)",
      ),
      reason: "ctx.connect() runs after mockable",
    },
  ])("rejects $name", async ({ before, after, reason }) => {
    expectUnverified(await verifyChange({ before, after }), reason);
  });

  it.each([
    {
      name: "a pyproject that does not declare egma",
      source: WORKER_WITH_DIRECT_MOCKABLE,
      manifest: "pyproject.toml",
      dependency: [
        "[project]",
        'name = "front-desk"',
        'dependencies = ["livekit-agents>=1.2"]',
        "",
      ].join("\n"),
      reason: "does not declare the Python egma distribution",
    },
    {
      name: "egma that appears only in a requirements comment",
      source: WORKER_WITH_DIRECT_MOCKABLE,
      manifest: "requirements.txt",
      dependency: "livekit-agents>=1.2\n# egma>=0.2\n",
      reason: "does not declare the Python egma distribution",
    },
    {
      name: "a mockable call after its egma import is removed",
      source: WORKER_WITH_UNBOUND_MOCKABLE,
      manifest: "requirements.txt",
      dependency: "egma>=0.2\n",
      reason: "mockable() is not imported from egma",
    },
    {
      name: "an entrypoint call bound to an import inside another function",
      source: [
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
      ].join("\n"),
      manifest: "requirements.txt",
      dependency: "egma>=0.2\n",
      reason: "mockable() is not imported from egma",
    },
    {
      name: "a dead mockable call with the wrong arguments",
      source: WORKER_WITH_DIRECT_MOCKABLE.replace(
        "    await mockable(agent, ctx, session)",
        "    if False:\n        await mockable(wrong_argument)",
      ),
      manifest: "requirements.txt",
      dependency: "egma>=0.2\n",
      reason: "direct job-entrypoint statement",
    },
    {
      name: "mockable before the inline session.start agent is bound",
      source: WORKER_WITH_DIRECT_MOCKABLE.replace("    agent = object()\n", "").replace(
        "agent=agent",
        "agent=Assistant()",
      ),
      manifest: "requirements.txt",
      dependency: "egma>=0.2\n",
      reason: "agent is not bound before mockable",
    },
    {
      name: "mockable before its session binding exists",
      source: WORKER_WITH_DIRECT_MOCKABLE.replace(
        "    session = AgentSession()\n    await mockable(agent, ctx, session)",
        "    await mockable(agent, ctx, session)\n    session = AgentSession()",
      ),
      manifest: "requirements.txt",
      dependency: "egma>=0.2\n",
      reason: "session is not bound before mockable",
    },
    {
      name: "session.start with a different agent binding",
      source: WORKER_WITH_DIRECT_MOCKABLE.replace(
        "    session = AgentSession()",
        "    other_agent = object()\n    session = AgentSession()",
      ).replace("agent=agent", "agent=other_agent"),
      manifest: "requirements.txt",
      dependency: "egma>=0.2\n",
      reason: "same session and agent bindings",
    },
    {
      name: "session.start on a different session binding",
      source: WORKER_WITH_DIRECT_MOCKABLE.replace(
        "    session = AgentSession()",
        "    session = AgentSession()\n    other_session = AgentSession()",
      ).replace("await session.start", "await other_session.start"),
      manifest: "requirements.txt",
      dependency: "egma>=0.2\n",
      reason: "same session and agent bindings",
    },
    {
      name: "a mocked session that already started before mockable",
      source: WORKER_WITH_DIRECT_MOCKABLE.replace(
        "    await mockable(agent, ctx, session)",
        [
          "    await session.start(agent=agent, room=ctx.room)",
          "    await mockable(agent, ctx, session)",
        ].join("\n"),
      ),
      manifest: "requirements.txt",
      dependency: "egma>=0.2\n",
      reason: "session already starts before mockable",
    },
  ])("rejects $name", async ({ source, manifest, dependency, reason }) => {
    expectUnverified(await claim(source, manifest, dependency), reason);
  });

  it("does not snapshot a file with two possible ctx entrypoints", async () => {
    const made = await workspace(
      `${WORKER_BEFORE}\nasync def another_entrypoint(ctx):\n    await ctx.connect()\n`,
    );

    const result = await snapshotWorkerIntegration(made.dir, "src/agent.py");

    expect(result).toMatchObject({
      kind: "unverified",
      reason: expect.stringContaining("could not identify one async job entrypoint"),
    });
  });

  it.each(
    (["top-level", "nested"] as const).flatMap((placement) =>
      (["agent", "session"] as const).map((binding) => ({ placement, binding })),
    ),
  )(
    "rejects a $placement $binding rebinding between mockable and session.start",
    async ({ placement, binding }) => {
      const replacement =
        placement === "top-level"
          ? `    ${binding} = replacement`
          : `    if True:\n        ${binding} = replacement`;
      const after = WORKER_WITH_DIRECT_MOCKABLE.replace(
        "    await session.start(agent=agent, room=ctx.room)",
        `${replacement}\n    await session.start(agent=agent, room=ctx.room)`,
      );

      expectUnverified(
        await claim(after, "requirements.txt", "egma>=0.2\n"),
        `${binding} is rebound between mockable() and AgentSession.start()`,
      );
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
        "    await mockable(agent, ctx, session)\n    await mockable(agent, ctx, session)",
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
        "    await isolate(agent, ctx, session)\n    await isolate(agent, ctx, session)",
      ),
      hook: "mockable",
    },
  ])("rejects duplicate $hook calls in $mode mode", async ({ mode, source, hook }) => {
    expectUnverified(
      await verifyChange({ after: source, mode }),
      `expected exactly one ${hook}() call`,
    );
  });

  it.each([
    {
      name: "a new testing hook in monitoring-only mode",
      mode: "monitoring" as const,
      after: WORKER_WITH_ALIASED_BOTH,
      reason: "monitoring-only integration added mockable",
    },
    {
      name: "a new monitoring hook in testing-only mode",
      mode: "testing" as const,
      after: WORKER_WITH_ALIASED_BOTH,
      reason: "testing-only integration added monitor_livekit",
    },
    {
      name: "a malformed unrequested testing hook in monitoring-only mode",
      mode: "monitoring" as const,
      after: WORKER_WITH_DIRECT_MONITORING.replace(
        "from egma import monitor_livekit",
        "from egma import mockable, monitor_livekit",
      ).replace(
        "    await session.start(agent=agent, room=ctx.room)",
        "    mockable(agent, ctx, session)\n    await session.start(agent=agent, room=ctx.room)",
      ),
      reason: "monitoring-only integration added mockable",
    },
    {
      name: "a malformed unrequested monitoring hook in testing-only mode",
      mode: "testing" as const,
      after: WORKER_WITH_DIRECT_MOCKABLE.replace(
        "from egma import mockable",
        "from egma import mockable, monitor_livekit",
      ).replace(
        "    agent = object()",
        "    await monitor_livekit(ctx)\n    agent = object()",
      ),
      reason: "testing-only integration added monitor_livekit",
    },
    {
      name: "an unrequested testing hook outside the monitoring entrypoint",
      mode: "monitoring" as const,
      after: `${WORKER_WITH_DIRECT_MONITORING.replace(
        "from egma import monitor_livekit",
        "from egma import mockable, monitor_livekit",
      )}\ndef helper(agent, ctx, session):\n    mockable(agent, ctx, session)\n`,
      reason: "monitoring-only integration added mockable",
    },
    {
      name: "an unrequested monitoring hook outside the testing entrypoint",
      mode: "testing" as const,
      after: `${WORKER_WITH_DIRECT_MOCKABLE.replace(
        "from egma import mockable",
        "from egma import mockable, monitor_livekit",
      )}\ndef helper(ctx):\n    monitor_livekit(ctx)\n`,
      reason: "testing-only integration added monitor_livekit",
    },
    {
      name: "an unimported testing hook in monitoring-only mode",
      mode: "monitoring" as const,
      after: WORKER_WITH_DIRECT_MONITORING.replace(
        "    await session.start(agent=agent, room=ctx.room)",
        "    await mockable(agent, ctx, session)\n    await session.start(agent=agent, room=ctx.room)",
      ),
      reason: "monitoring-only integration added mockable",
    },
    {
      name: "an unimported monitoring hook in testing-only mode",
      mode: "testing" as const,
      after: WORKER_WITH_DIRECT_MOCKABLE.replace(
        "    agent = object()",
        "    monitor_livekit(ctx)\n    agent = object()",
      ),
      reason: "testing-only integration added monitor_livekit",
    },
    {
      name: "removal of a pre-existing aliased testing hook while adding monitoring",
      mode: "monitoring" as const,
      before: WORKER_WITH_ALIASED_BOTH,
      after: WORKER_WITH_DIRECT_MONITORING,
      reason: "removed a pre-existing mockable() call",
    },
    {
      name: "removal of a pre-existing aliased monitoring hook while adding testing",
      mode: "testing" as const,
      before: WORKER_WITH_ALIASED_BOTH,
      after: WORKER_WITH_DIRECT_MOCKABLE,
      reason: "removed a pre-existing monitor_livekit() call",
    },
  ])("rejects $name", async ({ mode, before, after, reason }) => {
    expectUnverified(
      await verifyChange({
        ...(before === undefined ? {} : { before }),
        after,
        mode,
      }),
      reason,
    );
  });

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
      expectVerified(await verifyChange({ before, after, mode }));
    },
  );

  it.each([
    {
      name: "inside the entrypoint",
      source: WORKER_WITH_DIRECT_MOCKABLE.replace(
        "    await mockable(agent, ctx, session)",
        "    mockable = unsafe_mockable\n    await mockable(agent, ctx, session)",
      ),
      reason: "is shadowed inside the job entrypoint",
    },
    {
      name: "by an entrypoint parameter",
      source: WORKER_WITH_DIRECT_MOCKABLE.replace(
        "async def entrypoint(ctx):",
        "async def entrypoint(ctx, mockable=unsafe_mockable):",
      ),
      reason: "is shadowed inside the job entrypoint",
    },
    {
      name: "by a later top-level import",
      source: WORKER_WITH_DIRECT_MOCKABLE.replace(
        "from egma import mockable",
        "from egma import mockable\nfrom project.testing import mockable",
      ),
      reason: "rebound after its egma import",
    },
  ])("does not accept an Egma hook shadowed $name", async ({ source, reason }) => {
    expectUnverified(
      await claim(source, "requirements.txt", "egma>=0.2\n"),
      reason,
    );
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

    expectUnverified(result, "outside this repository");
  });

  it.each(["requirements-dev.txt", "docs/requirements.txt"])(
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

      expectUnverified(
        result,
        "was not the existing runtime dependency manifest for the worker",
      );
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
      REQUIREMENTS_BEFORE,
      "utf8",
    );
    const snapshot = await snapshotOf(made.dir);
    await writeFile(made.worker, WORKER_WITH_DIRECT_MOCKABLE, "utf8");
    await writeFile(
      path.join(made.dir, "requirements-dev.txt"),
      REQUIREMENTS_WITH_EGMA,
      "utf8",
    );

    const result = await verifyWorkerIntegrationClaim(
      made.dir,
      snapshot,
      "src/agent.py",
      "requirements-dev.txt",
      "testing",
    );

    expectUnverified(
      result,
      "was not the existing runtime dependency manifest for the worker",
    );
  });

  it.each(["requirements-dev.txt", "requirements.in", "requirements/base.txt"])(
    "does not treat %s as the LiveKit pip project manifest",
    async (manifest) => {
      const made = await workspace();
      await rm(path.join(made.dir, "requirements.txt"));
      await mkdir(path.dirname(path.join(made.dir, manifest)), { recursive: true });
      await writeFile(path.join(made.dir, manifest), REQUIREMENTS_BEFORE, "utf8");

      const result = await snapshotWorkerIntegration(made.dir, "src/agent.py");

      expect(result).toMatchObject({
        kind: "unverified",
        reason: expect.stringContaining("found no existing Python dependency manifest"),
      });
    },
  );

  it("uses a nearer requirements project instead of a parent pyproject", async () => {
    const made = await workspace();
    const workerFile = "service/src/agent.py";
    const serviceWorker = path.join(made.dir, workerFile);
    await mkdir(path.dirname(serviceWorker), { recursive: true });
    await writeFile(serviceWorker, WORKER_BEFORE, "utf8");
    await writeFile(
      path.join(made.dir, "pyproject.toml"),
      '[project]\nname = "repository-root"\ndependencies = []\n',
      "utf8",
    );
    const dependencyFile = "service/requirements.txt";
    await writeFile(path.join(made.dir, dependencyFile), REQUIREMENTS_BEFORE, "utf8");
    const snapshotted = await snapshotWorkerIntegration(made.dir, workerFile);
    expect(snapshotted.kind).toBe("snapshotted");
    if (snapshotted.kind !== "snapshotted") throw new Error(snapshotted.reason);
    await writeFile(serviceWorker, WORKER_WITH_DIRECT_MOCKABLE, "utf8");
    await writeFile(
      path.join(made.dir, dependencyFile),
      "livekit-agents>=1.2\negma>=0.2.0\n",
      "utf8",
    );

    const result = await verifyWorkerIntegrationClaim(
      made.dir,
      snapshotted.snapshot,
      workerFile,
      dependencyFile,
      "testing",
    );

    expectVerified(result, { dependencyFile });
  });

  it("rejects an unrelated worker rewrite during integration", async () => {
    const after = WORKER_WITH_DIRECT_MOCKABLE.replace(
      "await ctx.connect()",
      "await ctx.connect(auto_subscribe=False)",
    );

    expectUnverified(
      await claim(after, "requirements.txt", REQUIREMENTS_WITH_EGMA),
      "changed worker code outside the exact Egma imports and entry hooks",
    );
  });

  it.each([
    ["deletes", "from egma import mockable"],
    ["changes", "from egma import replacement, mockable"],
  ])(
    "rejects an integration that %s an unrelated name in a mixed Egma import",
    async (_change, afterImport) => {
      const before = WORKER_WITH_DIRECT_MOCKABLE.replace(
        "from egma import mockable",
        "from egma import other, mockable",
      );
      const after = WORKER_WITH_DIRECT_MOCKABLE.replace(
        "from egma import mockable",
        afterImport,
      );

      expectUnverified(
        await verifyChange({ before, after }),
        "changed worker code outside the exact Egma imports and entry hooks",
      );
    },
  );

  it("rejects deletion of import egma when another Egma API still uses it", async () => {
    const before = WORKER_BEFORE.replace(
      "from livekit.agents import AgentSession",
      "import egma\nfrom livekit.agents import AgentSession",
    ).replace(
      "async def entrypoint(ctx):\n    await ctx.connect()",
      "async def entrypoint(ctx):\n    egma.configure()\n    await ctx.connect()",
    );
    const after = before.replace("import egma", "from egma import mockable").replace(
      "    await session.start(agent=agent, room=ctx.room)",
      "    await mockable(agent, ctx, session)\n    await session.start(agent=agent, room=ctx.room)",
    );

    expectUnverified(
      await verifyChange({ before, after }),
      "changed worker code outside the exact Egma imports and entry hooks",
    );
  });

  it("allows a requested hook to join an existing unrelated Egma import", async () => {
    const before = WORKER_BEFORE.replace(
      "from livekit.agents import AgentSession",
      "from egma import other\nfrom livekit.agents import AgentSession",
    );
    const after = WORKER_WITH_DIRECT_MOCKABLE.replace(
      "from egma import mockable",
      "from egma import other, mockable",
    );

    expectVerified(await verifyChange({ before, after }));
  });

  it("rejects an unrelated runtime dependency rewrite during integration", async () => {
    expectUnverified(
      await verifyChange({
        after: WORKER_WITH_DIRECT_MOCKABLE,
        manifestAfter: "livekit-agents>=1.3\negma>=0.2\n",
      }),
      "changed the runtime manifest beyond one registry egma dependency",
    );
  });

  it.each([
    {
      name: "a hook loses its egma import",
      expected: "worker changed after integration approval",
      mutate: ({ worker }: Workspace) =>
        writeFile(worker, WORKER_WITH_UNBOUND_MOCKABLE, "utf8"),
    },
    {
      name: "egma is removed from its manifest",
      expected: "runtime dependency manifest changed after integration approval",
      mutate: ({ dir }: Workspace) =>
        writeFile(path.join(dir, "requirements.txt"), REQUIREMENTS_BEFORE, "utf8"),
    },
    {
      name: "the worker is later rewritten even though Egma remains valid",
      expected: "worker changed after integration approval",
      mutate: ({ worker }: Workspace) =>
        writeFile(
          worker,
          WORKER_WITH_DIRECT_MOCKABLE.replace(
            "    agent = object()",
            "    print('later task')\n    agent = object()",
          ),
          "utf8",
        ),
    },
    {
      name: "the manifest is later rewritten even though Egma remains valid",
      expected: "runtime dependency manifest changed after integration approval",
      mutate: ({ dir }: Workspace) =>
        writeFile(
          path.join(dir, "requirements.txt"),
          `${REQUIREMENTS_WITH_EGMA}pytest>=8\n`,
          "utf8",
        ),
    },
  ])("rejects the final integration when $name", async ({ expected, mutate }) => {
    const { made, contract } = await approvedIntegration();
    await mutate(made);

    const result = await verifyWorkerIntegration(made.dir, contract);

    expectUnverified(result, expected);
  });
});
