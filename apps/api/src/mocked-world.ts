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
 * order: delete the draft, then prove it is gone. There is nothing else to give
 * back — Egma writes to no customer's number bindings — so a world is settled
 * exactly when its temporary version is proved deleted. The sweep settles the
 * worlds of runs that have **finished**, and never one that could still be
 * conducting: two runs of one agent at once must not tear each other's world
 * down.
 *
 * **The proof is why an unsettled world is answered rather than assumed.** A
 * delete's own answer cannot say a version is gone: a request Retell has no
 * route for answers 404 exactly as an absent version does. So the versions are
 * read back, and a read that cannot say leaves the world unsettled — which the
 * build path below refuses to branch over.
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
 * Build the temporary world this run will be conducted in, or refuse.
 *
 * **Whether this run is one at all is decided from the same two facts the
 * queue's own gate reads**: the connection type frozen onto this run's own
 * snapshot at start, and whether any test this run pins named a mock tool. So
 * the two can never disagree about which runs wait for a world. The connection
 * type is checked first because it costs nothing: every run over a lane that
 * never branches a copy leaves here without a read.
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

  // **The fence, held from before the claim until after the build.**
  //
  // Two mocked runs of one agent overlapping is a hijack rather than a queue:
  // one run's teardown restores a `latest` binding it captured, while the
  // other's freshly branched draft is what `latest` now resolves to, and real
  // callers reach a mocked agent. Delete-before-restore protects a run from its
  // own draft and cannot see another's, so the overlap itself is what is
  // refused.
  //
  // A settle counts as one of the two. A finished run does not block a claim —
  // its litter is this sweep's job — so without the fence a teardown of that
  // run could still be waiting on its restore while this run branched the
  // version the restore would then point real callers at. Nothing downstream
  // can catch that: the late restore writes a `latest` binding onto a number
  // that still points exactly where its note says it pinned it. So the claim,
  // the sweep and the whole build happen inside one hold, and every settle of
  // this agent waits for it.
  //
  // The claim writes the building marker, which is also what makes this run
  // visible to a later sweep: a run that dies between here and the build's
  // first record would otherwise leave a null cleanup flag no sweep ever sees,
  // and its simulations — unclaimable until a draft exists — would sit queued
  // forever.
  //
  // The fence's own wait is bounded, and a wait that runs out is answered as an
  // in-use refusal rather than thrown: it means the agent is held by work this
  // process cannot see — another instance still building, or a holder killed
  // with its session still standing — and "wait for that run, then start again"
  // is the true next move either way.
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

        // The sweep, before anything new is made. Litter from a crashed or
        // finished run is cleared while it is still only litter — and,
        // critically, **before this run branches**: a finished run's outstanding
        // pin is restored while no draft of this run's exists yet, so that
        // restore can never resolve `latest` onto something this run minted.
        //
        // And when the sweep could not clear it, nothing new is made at all. An
        // unsettled world still owes a restore, and the next mocked run of this
        // agent is what retries it; a draft branched now is exactly what the
        // agent's restored `latest` binding would then resolve to. Refusing here
        // is what makes the retry safe: a restore only ever runs while no
        // temporary version of this agent exists.
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
            target: { base: mockToolBase(reach.baseUrl), runId: run.id },
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
 * Settle every world this agent's runs still owe the account, and answer
 * whether anything is still owed.
 *
 * The teardown and the sweep, which are the same act: a run that has finished
 * owes nothing, so whatever it recorded is given back. A run that could still
 * be conducting is left alone — two runs of one agent at once must not tear
 * each other's world down.
 *
 * The answer is load-bearing for exactly one caller: the build refuses to
 * branch over an `unsettled` agent, because an unsettled world's restore
 * retries later and must never find a draft to route `latest` onto. Anything
 * that keeps this sweep from *knowing* the agent is clean — the read failing,
 * the platform key gone — is therefore `unsettled` too, never a shrug.
 *
 * **Under this agent's mocked-world fence, from the read to the last restore.**
 * A teardown that ran beside a new run's claim would be the hijack itself: this
 * settle deletes a draft and then puts a `latest` binding back, while the new
 * run — which a *finished* run never blocks — branches the version that binding
 * would then resolve to. The fence is what makes the two take turns, and the
 * re-read inside it is what makes the loser harmless: whoever gets there second
 * finds the cleanup flag already `true`, has nothing in its list, and restores
 * nothing.
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
 * Give this run up because the agent is somebody else's, said one way.
 *
 * Two things reach here. The claim finds a named run holding the copy, which is
 * the ordinary collision. Or the fence itself would not come free inside its
 * wait — a holder in another process still building, or one killed hard enough
 * that Postgres has not yet reaped its session. The second names no run,
 * because there is no row to name: what is known is that the agent is busy,
 * which is the whole of what the caller has to act on.
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
