import {
  agentMonitoringKey,
  cancelRun,
  claimMockDraftFor,
  connectionTypeBranchesMockDraft,
  getAgent,
  MockDraftFenceBusyError,
  owedMockCleanups,
  recordMockState,
  runCarriesMockTools,
  type AuthContext,
  type MockRunState,
  type OwedMockCleanup,
  type Run,
} from "@egma/db";
import {
  buildMockedWorld,
  finishMockedWorld,
  mockRunIsSettled,
  type Fetch as ProviderFetch,
  type MockRunRecord,
  type RetellCredential,
} from "@egma/retell";

import { platformEvent, safeExceptionType } from "./platform-log.ts";

/**
 * Coordinate Retell mock-draft creation and cleanup with run state.
 * Eligible runs with test-owned mock tools cannot be claimed until the
 * temporary version is recorded. Build refusal attempts to cancel the run;
 * there is no fallback to real tools.
 *
 * Hold the agent lock across claim, prior cleanup, and build. Cleanup deletes
 * the draft and verifies deletion and serving state through @egma/retell.
 * It does not change phone-number bindings. Unfinished cleanup blocks another
 * build. Sweep finished runs and stale pending builds that never recorded
 * a ready version; leave active runs alone.
 */

/**
 * How the world reaches the platform, and how tests stand in for it.
 *
 * **No public origin.** The temporary version carries no address of Egma's at
 * all: every custom tool's URL grows a per-call variable in front of the
 * customer's own, and Egma's address is filled into that variable per call, in
 * the claim (ADR-0022). So the builder needs nothing but a way to reach Retell.
 */
export type MockedWorldReach = {
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
  | { readonly kind: "refused"; readonly reason: string }
  /**
   * Another run of this agent already holds its one mocked world. Its own
   * refusal, because the next move is different from every other one here:
   * nothing is misconfigured and nothing needs fixing — wait for that run.
   */
  | { readonly kind: "in-use"; readonly reason: string };

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
 * Build when the frozen connection type branches drafts and a pinned test
 * uses mock tools, matching the queue gate. On refusal, attempt cancellation
 * so an unclaimable run does not remain pending.
 */
export async function buildRunMockedWorld(
  auth: AuthContext,
  run: Run,
  reach: MockedWorldReach,
  log: { error: (payload: unknown, message?: string) => void },
): Promise<MockedWorldOutcome> {
  // Two facts: the lane, frozen onto this run's own snapshot at start, and
  // whether any test of this run carries a mock tool of its own. A run whose
  // tests mock nothing goes real, and one over a lane that carries its answers
  // on the request — text mode — branches nothing here. The queue's own gate
  // reads the same two facts, so the two can never disagree about which runs
  // wait for a copy.
  if (!connectionTypeBranchesMockDraft(run.connectionSnapshot.connectionType)) {
    return { kind: "not-mocked" };
  }
  if (!(await runCarriesMockTools(auth, run.id))) {
    return { kind: "not-mocked" };
  }
  const agent = await getAgent(auth, run.agentId);
  const platformAgentId = agent?.platformAgentId ?? "";
  if (platformAgentId === "") {
    return await refuseRun(
      auth,
      run,
      "A test in this run carries mock tools, but this agent holds no platform " +
        "identity, so Egma has no agent to branch a temporary version of.",
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
      "A test in this run carries mock tools, but this agent holds no platform " +
        "key, so Egma cannot create the temporary version a mocked run needs.",
      log,
    );
  }
  const key = credential(apiKey);

  // Hold the agent lock across claim, previous cleanup, and build so draft
  // lifecycles cannot overlap. The claim records cleanup owed before platform
  // writes, making a crashed build visible to the sweep. A bounded lock wait
  // returns an in-use refusal.
  try {
    return await owedMockCleanups(
      auth,
      run.agentId,
      { exceptRunId: run.id, fence: "take" },
      async (outstanding): Promise<MockedWorldOutcome> => {
        const claim = await claimMockDraftFor(auth, {
          runId: run.id,
          agentId: run.agentId,
          staleBuildMilliseconds: STALE_BUILD_MILLISECONDS,
        });
        if (claim.kind === "taken") {
          return await refuseInUse(auth, run, claim.byRunId, log);
        }

        // Finish previous cleanup before creating another draft. If cleanup cannot
        // be verified, refuse this build and leave the prior record for retry.
        const swept = await settleTheseMockCleanups(
          auth,
          run.agentId,
          outstanding,
          reach,
          log,
        );
        if (swept.kind === "unsettled") {
          return await refuseRun(
            auth,
            run,
            "An earlier mocked run of this agent could not be fully given back " +
              `to Retell: ${swept.reason}. Egma does not branch a new temporary ` +
              "version while that cleanup is owed — the moment the cleanup " +
              "lands, it would point the agent's restored routing at this run's " +
              "draft. The earlier run has already finished, so this is the only " +
              "thing that retries the cleanup: settle whatever stopped it (a " +
              "revoked platform key is the usual cause), then start this run " +
              "again.",
            log,
          );
        }

        const built = await buildMockedWorld(
          key,
          {
            agentId: platformAgentId,
            record: async (state) => {
              await recordMockState(auth, run.id, asStoredState(state));
            },
          },
          reachOf(reach),
        ).catch((cause: unknown) => ({
          kind: "refused" as const,
          reason:
            "Egma could not finish building the mocked world for this run " +
            `(${safeExceptionType(cause)}).`,
          state: null,
        }));

        if (built.kind === "built") {
          // The serving version this run conducts against, written down once the
          // build has resolved it. Every request of the run names the temporary
          // copy beside it, and this is what the copy was branched from — so a
          // reader asking what real traffic reaches gets an answer on the same
          // row.
          await recordMockState(auth, run.id, {
            ...built.state,
            agentVersion: built.agentVersion,
          });
          return { kind: "built" };
        }

        // Whatever was made before the refusal is given back at once, in the one
        // order that is safe, and then the run is failed.
        if (built.state !== null) {
          await finishMockedWorld(
            key,
            {
              agentId: platformAgentId,
              state: built.state,
              record: async (state) => {
                await recordMockState(auth, run.id, asStoredState(state));
              },
            },
            reachOf(reach),
          ).catch(() => undefined);
        }
        return await refuseRun(auth, run, built.reason, log);
      },
    );
  } catch (cause) {
    if (!(cause instanceof MockDraftFenceBusyError)) throw cause;
    return await standDownInUse(auth, run, cause.message, log);
  }
}

/** What the sweep left behind: nothing owed, or a debt it could not clear. */
export type SweptMockedWorlds =
  | { readonly kind: "settled" }
  /** Something is still owed to the account, and the one-sentence why. */
  | { readonly kind: "unsettled"; readonly reason: string };

/**
 * Clean up finished or stale unbuilt runs under the agent lock. Active runs
 * remain untouched. Return unsettled when cleanup is still owed or cannot
 * be verified; callers must not build another draft in that state.
 */
export async function settleOwedMockCleanups(
  auth: AuthContext,
  agentId: string,
  reach: MockedWorldReach,
  log: { error: (payload: unknown, message?: string) => void },
  options: { readonly exceptRunId?: string } = {},
): Promise<SweptMockedWorlds> {
  try {
    return await owedMockCleanups(
      auth,
      agentId,
      { ...options, fence: "only-when-owed" },
      async (outstanding) =>
        settleTheseMockCleanups(auth, agentId, outstanding, reach, log),
    );
  } catch (cause) {
    log.error(
      platformEvent(
        "egma.mock_tools.sweep_failed",
        "the outstanding mocked worlds of an agent could not be settled",
        {
          "egma.agent_id": agentId,
          "error.type": "mock_tools_sweep_failed",
          "exception.type": safeExceptionType(cause),
        },
      ),
    );
    return {
      kind: "unsettled",
      reason: "what this agent's runs still owe could not be read",
    };
  }
}

/**
 * The settling itself, over rows already read under the fence — and only ever
 * called inside one, by the two callers above.
 *
 * Split from the fence rather than nested inside it because the build path
 * holds one fence over its claim, this sweep and its whole build: two holds
 * would be this process waiting on a lock it is already holding.
 */
async function settleTheseMockCleanups(
  auth: AuthContext,
  agentId: string,
  outstanding: readonly OwedMockCleanup[],
  reach: MockedWorldReach,
  log: { error: (payload: unknown, message?: string) => void },
): Promise<SweptMockedWorlds> {
  if (outstanding.length === 0) return { kind: "settled" };

  const agent = await getAgent(auth, agentId);
  const platformAgentId = agent?.platformAgentId ?? "";
  const apiKey = await agentMonitoringKey(auth, agentId).catch(() => undefined);
  if (platformAgentId === "" || apiKey === undefined) {
    return {
      kind: "unsettled",
      reason:
        "an outstanding mocked world cannot be given back without the " +
        "agent's platform agent id and platform key",
    };
  }
  const key = credential(apiKey);
  const now = Date.now();
  const owed: string[] = [];

  for (const held of outstanding) {
    const finished = held.finishedAt !== null;
    // Staleness is measured **only while the world is still unbuilt**. A run
    // whose world is fully built (its draft exists) and which is merely pending
    // because no simulator has claimed it yet is not stuck — its clock is queue
    // wait, and cancelling it for that would be a fate no other run in the
    // product suffers. Only a run still without a draft after the window has
    // genuinely lost its build process.
    const worldBuilt = held.tempMockAgentVersion !== null;
    const stale =
      held.status === "pending" &&
      !worldBuilt &&
      now - held.createdAt.getTime() > STALE_BUILD_MILLISECONDS;
    if (!finished && !stale) {
      // Alive, so its world is its own to settle — but the agent is not clean
      // while it stands. The build path never sees this arm: the claim it just
      // won is what proves no such run exists.
      owed.push(`run ${held.runId} still holds this agent's mocked world`);
      continue;
    }

    if (stale) {
      // Its process died before it could make its simulations claimable, so
      // nothing will ever finish it. Cancel it, so the record says what
      // happened rather than showing a queue that never moves.
      await cancelRun(auth, held.runId).catch(() => undefined);
    }

    const settled = await finishMockedWorld(
      key,
      {
        agentId: platformAgentId,
        state: {
          tempMockAgentVersion: held.tempMockAgentVersion,
          tempMockAgentVersionCleanup: false,
          mockMetadata: held.metadata,
        },
        record: async (state) => {
          await recordMockState(auth, held.runId, asStoredState(state));
        },
      },
      reachOf(reach),
    ).catch((cause: unknown) => ({
      unfinished: [`the teardown threw (${safeExceptionType(cause)})`],
    }));

    if (settled.unfinished.length > 0) {
      log.error(
        platformEvent(
          "egma.mock_tools.not_settled",
          "a run's mocked world could not be given back in full",
          {
            "egma.agent_id": agentId,
            "egma.run_id": held.runId,
            "error.type": "mock_tools_not_settled",
          },
        ),
        settled.unfinished.join("; "),
      );
      owed.push(`run ${held.runId} still owes ${settled.unfinished.join("; ")}`);
    }
  }

  return owed.length === 0
    ? { kind: "settled" }
    : { kind: "unsettled", reason: owed.join("; ") };
}

/** Whether a run still owes the platform anything. */
export { mockRunIsSettled };

/**
 * The mock-tool record, as the store keeps it.
 *
 * The two shapes are the same shape, and this is where that is said out loud:
 * `@egma/retell` knows Retell and nothing about a store, `@egma/db` knows the
 * store and nothing about Retell, and a change to either one that broke the
 * other stops compiling here.
 */
function asStoredState(state: MockRunRecord): MockRunState {
  return state;
}

async function refuseRun(
  auth: AuthContext,
  run: Run,
  reason: string,
  log: { error: (payload: unknown, message?: string) => void },
): Promise<MockedWorldOutcome> {
  log.error(
    platformEvent(
      "egma.mock_tools.build_failed",
      "a run over a mockable connection could not build its mocked world",
      {
        "egma.run_id": run.id,
        "egma.agent_id": run.agentId,
        "error.type": "mock_tools_unbuildable",
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

/**
 * Another run of this agent holds its one mocked world.
 *
 * **Nothing was written to the platform**: the claim is refused before the
 * builder reaches Retell, so this run branched nothing, pinned nothing, and
 * leaves nothing behind. Its own sentence, because the next move is not a fix —
 * it is to wait for the other run and start again.
 */
async function refuseInUse(
  auth: AuthContext,
  run: Run,
  byRunId: string,
  log: { error: (payload: unknown, message?: string) => void },
): Promise<MockedWorldOutcome> {
  return await standDownInUse(
    auth,
    run,
    `Run ${byRunId} is already running against this agent with mock tools on, ` +
      "and Egma builds one mocked world per agent at a time. Two at once " +
      "cannot be made safe: each run puts the agent's phone routing back as " +
      "it found it, and the other run's temporary version would be what that " +
      "routing then points at — so a real caller would reach a test version. " +
      `Wait for run ${byRunId} to finish, then start this one again.`,
    log,
    byRunId,
  );
}

/**
 * Cancel this run after a competing claim or lock timeout. A lock timeout
 * may not identify the holding run, so byRunId is optional.
 */
async function standDownInUse(
  auth: AuthContext,
  run: Run,
  reason: string,
  log: { error: (payload: unknown, message?: string) => void },
  byRunId?: string,
): Promise<MockedWorldOutcome> {
  log.error(
    platformEvent(
      "egma.mock_tools.agent_in_use",
      "a mocked run was refused because another run holds the agent's mocked world",
      {
        "egma.run_id": run.id,
        "egma.agent_id": run.agentId,
        ...(byRunId === undefined ? {} : { "egma.holding_run_id": byRunId }),
        "error.type": "mock_tools_agent_in_use",
      },
    ),
    reason,
  );
  // Canceled for the same reason a build failure is: its simulations are
  // unclaimable, so a run left alone would wait forever looking like a queue.
  await cancelRun(auth, run.id).catch(() => undefined);
  return { kind: "in-use", reason };
}
