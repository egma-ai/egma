import {
  agentMonitoringKey,
  cancelRun,
  connectionTypeTakesMockedWorld,
  getAgent,
  outstandingMockedWorlds,
  recordMockedWorld,
  type AuthContext,
  type MockedWorld,
  type Run,
} from "@egma/db";
import {
  buildMockedWorld,
  finishMockedWorld,
  mockedWorldIsSettled,
  type Fetch as ProviderFetch,
  type MockedWorldRecord,
  type RetellCredential,
} from "@egma/retell";

import { mockToolBase } from "./routes/mock-endpoint.ts";
import { platformEvent, safeExceptionType } from "./platform-log.ts";

/**
 * Where the mocked world's lifecycle is joined to a run.
 *
 * The order and the guards are in `@egma/retell`, against a fake account, where
 * they can be made to fire one at a time. What is here is the joining: which
 * runs get a world at all, which key does the platform writes, where the record
 * is written, and what happens to a run whose world could not be built.
 *
 * ## The one rule this file exists for
 *
 * **A run over a mockable connection that cannot build its world is canceled
 * before a single simulation is conducted.** There is no fallback branch, and
 * there is deliberately nowhere to put one: a green run that quietly used the
 * customer's real tools is the exact outcome the whole seam exists to prevent.
 *
 * Nothing races that promise. The queue itself is gated — a mocked run's
 * simulations are unclaimable until its record names a temporary version, from
 * the instant the rows are written — so the build takes as long as it takes and
 * no simulator can get in front of it. See `mock-tools/lanes.ts` in `@egma/db`.
 *
 * ## Teardown, and the sweep that is the same act
 *
 * A run's own teardown and the next run's sweep call one function with one
 * order: delete the draft, then restore the pin. The sweep settles the worlds
 * of runs that have **finished**, and never one that could still be conducting
 * — two runs of one agent at once must not tear each other's world down.
 *
 * A run stuck `pending` long past any plausible build is the one exception, and
 * it is the crash case: its process died between minting a version and making
 * its simulations claimable, so nothing will ever finish it. It is canceled and
 * swept.
 */

/** How the world reaches the platform, and how tests stand in for it. */
export type MockedWorldReach = {
  /** This deployment's own public origin, where the mock endpoint answers. */
  readonly baseUrl: string;
  readonly retellFetch?: ProviderFetch | undefined;
};

/**
 * How long a run may sit `pending` with an unfinished world before the next
 * sweep treats it as a crash.
 *
 * Far longer than a build, which is a handful of requests, and far longer than
 * a queue waiting for a simulator to poll. A run still `pending` after this
 * either lost its process mid-build or has no simulator at all, and in both
 * cases the honest thing is to cancel it and give the account back.
 */
const STALE_BUILD_MILLISECONDS = 15 * 60 * 1000;

export type MockedWorldOutcome =
  | { readonly kind: "built" }
  /** This run mocks nothing, which is what most runs do. */
  | { readonly kind: "not-mocked" }
  | { readonly kind: "refused"; readonly reason: string };

function credential(apiKey: string): RetellCredential {
  return { reveal: () => apiKey };
}

function reachOf(reach: MockedWorldReach) {
  return {
    ...(reach.retellFetch === undefined ? {} : { fetchImpl: reach.retellFetch }),
    signal: AbortSignal.timeout(60_000),
  };
}

/**
 * Build the temporary world this run will be conducted in, or refuse.
 *
 * **Whether this run is one at all is decided from the same two facts the
 * queue's own gate reads** — the agent's tick and the run's own recorded
 * connection type — so the two can never disagree about which runs wait for a
 * world. The connection type is checked first because it costs nothing: every
 * run over a lane that is never mocked leaves here without a read.
 *
 * On a refusal the run is canceled here rather than left for somebody to
 * notice: its simulations are unclaimable, so a run left alone would sit
 * forever looking like a queue that is merely slow.
 */
export async function buildRunMockedWorld(
  auth: AuthContext,
  run: Run,
  reach: MockedWorldReach,
  log: { error: (payload: unknown, message?: string) => void },
): Promise<MockedWorldOutcome> {
  if (!connectionTypeTakesMockedWorld(run.connectionSnapshot.connectionType)) {
    return { kind: "not-mocked" };
  }
  const agent = await getAgent(auth, run.agentId);
  if (agent?.mockToolsDuringSimulations !== true) return { kind: "not-mocked" };

  const platformAgentId = agent.platformAgentId ?? "";
  if (platformAgentId === "") {
    return await refuseRun(
      auth,
      run,
      "This agent has mock tools turned on but holds no platform identity, so " +
        "Egma has no agent to branch a temporary version of.",
      log,
    );
  }

  // The two keys must see one account. The connection's own key opens the
  // conversations; the agent's platform key builds the world. If they name two
  // different platform agents, one account would build the draft while another
  // tried to call it — a failure that would otherwise surface only after the
  // world was built.
  const config = run.connectionSnapshot.config as Record<string, unknown>;
  const named = config["retellAgentId"];
  if (typeof named === "string" && named.trim() !== "" && named.trim() !== platformAgentId) {
    return await refuseRun(
      auth,
      run,
      `This connection reaches Retell agent ${named.trim()}, and mock tools ` +
        `are set up against Retell agent ${platformAgentId}. Egma would build ` +
        "the mocked world on one agent and place the calls against another. " +
        "Point both at the same agent before starting a run.",
      log,
    );
  }

  const apiKey = await agentMonitoringKey(auth, run.agentId);
  if (apiKey === undefined) {
    return await refuseRun(
      auth,
      run,
      "This agent has mock tools turned on but holds no platform key, so Egma " +
        "cannot create the temporary version a mocked run needs.",
      log,
    );
  }
  const key = credential(apiKey);

  // The sweep, before anything new is made. Litter from a crashed run is
  // cleared while it is still only litter.
  await settleMockedWorlds(auth, run.agentId, reach, log, { exceptRunId: run.id });

  const built = await buildMockedWorld(
    key,
    {
      agentId: platformAgentId,
      target: { base: mockToolBase(reach.baseUrl), runId: run.id },
      record: async (world) => {
        await recordMockedWorld(auth, run.id, asStoredWorld(world));
      },
    },
    reachOf(reach),
  ).catch((cause: unknown) => ({
    kind: "refused" as const,
    reason:
      "Egma could not finish building the mocked world for this run " +
      `(${safeExceptionType(cause)}).`,
    world: null,
  }));

  if (built.kind === "built") return { kind: "built" };

  // Whatever was made before the refusal is given back at once, in the one
  // order that is safe, and then the run is failed.
  if (built.world !== null) {
    await finishMockedWorld(
      key,
      {
        agentId: platformAgentId,
        world: built.world,
        record: async (world) => {
          await recordMockedWorld(auth, run.id, asStoredWorld(world));
        },
      },
      reachOf(reach),
    ).catch(() => undefined);
  }
  return await refuseRun(auth, run, built.reason, log);
}

/**
 * Settle every world this agent's runs still owe the account.
 *
 * The teardown and the sweep, which are the same act: a run that has finished
 * owes nothing, so whatever it recorded is given back. A run that could still
 * be conducting is left alone — two runs of one agent at once must not tear
 * each other's world down.
 */
export async function settleMockedWorlds(
  auth: AuthContext,
  agentId: string,
  reach: MockedWorldReach,
  log: { error: (payload: unknown, message?: string) => void },
  options: { readonly exceptRunId?: string } = {},
): Promise<void> {
  let outstanding;
  try {
    outstanding = await outstandingMockedWorlds(auth, agentId, options);
  } catch (cause) {
    log.error(
      platformEvent(
        "egma.mocked_world.sweep_failed",
        "the outstanding mocked worlds of an agent could not be read",
        {
          "egma.agent_id": agentId,
          "error.type": "mocked_world_sweep_failed",
          "exception.type": safeExceptionType(cause),
        },
      ),
    );
    return;
  }
  if (outstanding.length === 0) return;

  const agent = await getAgent(auth, agentId);
  const platformAgentId = agent?.platformAgentId ?? "";
  const apiKey = await agentMonitoringKey(auth, agentId).catch(() => undefined);
  if (platformAgentId === "" || apiKey === undefined) return;
  const key = credential(apiKey);
  const now = Date.now();

  for (const held of outstanding) {
    const finished = held.finishedAt !== null;
    const stale =
      held.status === "pending" &&
      now - held.createdAt.getTime() > STALE_BUILD_MILLISECONDS;
    if (!finished && !stale) continue;

    if (stale) {
      // Its process died between minting a version and making its simulations
      // claimable, so nothing will ever finish it. Cancel it, so the record
      // says what happened rather than showing a queue that never moves.
      await cancelRun(auth, held.runId).catch(() => undefined);
    }

    const settled = await finishMockedWorld(
      key,
      {
        agentId: platformAgentId,
        world: held.world,
        record: async (world) => {
          await recordMockedWorld(auth, held.runId, asStoredWorld(world));
        },
      },
      reachOf(reach),
    ).catch((cause: unknown) => ({
      world: held.world,
      unfinished: [`the teardown threw (${safeExceptionType(cause)})`],
    }));

    if (settled.unfinished.length > 0) {
      log.error(
        platformEvent(
          "egma.mocked_world.not_settled",
          "a run's mocked world could not be given back in full",
          {
            "egma.agent_id": agentId,
            "egma.run_id": held.runId,
            "error.type": "mocked_world_not_settled",
          },
        ),
        settled.unfinished.join("; "),
      );
    }
  }
}

/** Whether a world still owes the platform anything. */
export { mockedWorldIsSettled };

/**
 * The temporary world, as the record stores it.
 *
 * The two shapes are the same shape, and this is where that is said out loud:
 * `@egma/retell` knows Retell and nothing about a store, `@egma/db` knows the
 * store and nothing about Retell, and a change to either one that broke the
 * other stops compiling here.
 */
function asStoredWorld(world: MockedWorldRecord): MockedWorld {
  return world;
}

async function refuseRun(
  auth: AuthContext,
  run: Run,
  reason: string,
  log: { error: (payload: unknown, message?: string) => void },
): Promise<MockedWorldOutcome> {
  log.error(
    platformEvent(
      "egma.mocked_world.build_failed",
      "a run over a mockable connection could not build its mocked world",
      {
        "egma.run_id": run.id,
        "egma.agent_id": run.agentId,
        "error.type": "mocked_world_unbuildable",
      },
    ),
    reason,
  );
  // Canceled rather than left: every simulation of this run is unclaimable
  // while the world is unbuilt, so a run nobody cancels is a run that waits
  // forever looking like a slow queue.
  await cancelRun(auth, run.id).catch(() => undefined);
  return { kind: "refused", reason };
}
