import {
  authorize,
  cancelRun,
  getRun,
  listRunEvents,
  listSimulations,
  NotPermittedError,
  ProjectOutsideOrganizationError,
  RunWriteRefusedError,
  startRun,
  type AuthContext,
  type ConductedSimulation,
  type MockToolCoverage,
  type MockToolSnapshot,
  type Run,
  type RunEvent,
  type SnapshotEntry,
} from "@egma/db";
import type { FastifyInstance } from "fastify";

import type { SessionIdentityProvider } from "../auth/seam.ts";
import { actingIn, cannotActIn, refuseActing } from "../http/acting.ts";
import { credentialed, requesterOf } from "../http/credentialed.ts";
import { answerAsWritten } from "../http/mock-tools.ts";
import type { RateLimit } from "../http/rate-limit.ts";
import { given, text } from "../http/reading.ts";
import {
  conflict,
  invalid,
  noAdapter,
  notFound,
  notPermitted,
  unprocessable,
} from "../http/refusals.ts";

/**
 * Starting a run, reading it whole, following it while it happens, and
 * stopping it.
 *
 * Four things about this group are contract rather than convenience.
 *
 * **A run pins the exact versions it executes.** The request names test
 * version ids and never "whatever is current when this runs", because what
 * executed is the whole of what a green result means. Every id is resolved
 * before a single row is written, and one unknown or doubled id refuses the
 * whole creation — a run that quietly executed eleven of the twelve versions
 * somebody named would report green about a suite that did not run.
 *
 * **A type nothing can conduct is refused at the door**, with the platform's
 * own sentence and the code `no_adapter`. A run left queued for a conductor
 * that does not exist is a promise egma cannot keep, and it would be
 * discovered by a person waiting for a terminal that never moves.
 *
 * **The feed is a numbered cursor, and the split is written down.** This side
 * is stateless: it remembers nothing about who has read what, and the same
 * `after` twice answers the same page twice. The client's half is to apply
 * each sequence number at most once. Between them, a follower that crashes and
 * restarts from the last number it applied misses nothing and repeats nothing
 * — which is what makes following a run over a flaky connection honest rather
 * than hopeful. `done` says the run has finished and there will be no more.
 *
 * **Stopping early never masquerades as passing.** Cancel settles the three
 * counts together, and a conversation that never ran is counted as canceled
 * rather than quietly forgotten.
 *
 * The addresses follow the standing rule: nothing is rooted at a project, and
 * the organization is never in a path. A run may name a project in its body
 * and does not have to; in a single-project organization nothing ever does.
 */

export type RunRoutesOptions = {
  readonly provider: SessionIdentityProvider;
  readonly rateLimit: RateLimit;
  /** Where this instance is, for the address a person opens results at. */
  readonly baseUrl: string;
};

export const RUNS_PATH = "/api/runs";
export const RUN_PATH = "/api/runs/:runId";
export const RUN_EVENTS_PATH = "/api/runs/:runId/events";
export const RUN_CANCEL_PATH = "/api/runs/:runId/cancel";

type Body = Record<string, unknown>;

/**
 * The versions a body pinned, in the order it pinned them.
 *
 * **Text, and every entry of it.** An entry that is not a version id is
 * refused rather than dropped, and that is the whole point: dropping one would
 * start a run over the rest, and the caller would read a green result about a
 * selection egma quietly shortened. The same reason one unknown id refuses the
 * whole creation further down.
 */
type PinnedVersions =
  | { readonly entries: readonly string[] }
  | { readonly refusal: string };

function pinnedVersions(value: unknown): PinnedVersions {
  if (!Array.isArray(value)) {
    return {
      refusal:
        "test_versions is the list of frozen versions this run executes, by " +
        'id. Send it as a list of text, like ["tstv_..."], taking each ' +
        "version_id from the test it belongs to.",
    };
  }

  const entries: string[] = [];
  for (const entry of value) {
    const named = text(entry);
    if (typeof entry !== "string" || named === "") {
      return {
        refusal:
          "a run pins each test version as text — the version_id a push or a " +
          "read answered with — and one entry in test_versions is neither. " +
          "Send them all, or none of them runs.",
      };
    }
    entries.push(named);
  }
  return { entries };
}

/**
 * A run nobody can see reads exactly like a run nobody started. Existence is
 * never confirmed to somebody who could not have seen the thing anyway, so
 * another customer's id and a made-up one get the same sentence.
 */
const NO_SUCH_RUN =
  "no run of yours has that id. Check the id, or start a run with POST " +
  "/api/runs.";

/**
 * One conversation of a run, as every read of one describes it.
 *
 * The two pins are both here on purpose: `test_version_id` is what actually
 * executed and never moves, and `test_id` is what to go and edit.
 *
 * `verdict` is what the graders make of the conversation. Nothing judges
 * anything yet, so it is null here and null everywhere — the field is in the
 * shape from the first day so that nothing a client reads changes when the
 * graders arrive. The events record already has a place to carry one; this row
 * gains its own the day something writes one down.
 *
 * `mock_tool_coverage` is here because comparing two of these numbers is only
 * valid when both conversations were conducted in the same world. A simulation
 * whose tools were answered by mock tools and one whose tools ran for real are
 * different units, exactly as two audio bands are, and this is where a reader
 * finds that out — off the conversation itself, with nothing else to fetch and
 * nothing editable to ask. Null says the agent was never asked what tools it
 * has, so nothing was learned and nothing is claimed.
 */
function describedSimulation(one: ConductedSimulation): Record<string, unknown> {
  return {
    id: one.id,
    position: one.position,
    test_id: one.testId,
    test_name: one.testName,
    test_version_id: one.testVersionId,
    persona_id: one.personaId,
    persona_name: one.personaName,
    status: one.status,
    verdict: null,
    reason: one.endingReason,
    mock_tool_coverage: describedMockToolCoverage(one.mockToolCoverage),
  };
}

/**
 * The coverage stamp as the wire carries it: the report's own three keys, in
 * the report's own words, or null where there is nothing claimed.
 *
 * The names are copied key by key rather than passed through, so the shape a
 * client reads is decided here and not by whatever a row happens to hold.
 */
function describedMockToolCoverage(
  coverage: MockToolCoverage | null,
): Record<string, unknown> | null {
  if (coverage === null) return null;
  return {
    discovered: [...coverage.discovered],
    covered: [...coverage.covered],
    uncovered: [...coverage.uncovered],
  };
}

/**
 * The mocked world a run froze, as every read of the run describes it.
 *
 * Two halves rather than one resolved list per test version, because that is
 * how it is stored and for the same reason: an override replaces a default by
 * tool name, and answering the merge per version would repeat every default
 * once per test for nothing. A reader who wants the merge asks for the run's
 * simulations and applies the overrides of the version each one names — which
 * is what the simulator is handed when it claims one.
 */
function describedMockToolEntry(one: SnapshotEntry): Record<string, unknown> {
  return {
    tool: one.toolName,
    ...answerAsWritten(one.answer),
    delay_ms: one.delayMilliseconds,
  };
}

function describedMockTools(
  snapshot: MockToolSnapshot,
): Record<string, unknown> {
  return {
    // A default is one of those with the row it came from named beside it, so a
    // reader can go and look at the mock tool the run froze.
    defaults: snapshot.defaults.map((one) => ({
      ...describedMockToolEntry(one),
      mock_tool_id: one.mockToolId,
    })),
    overrides: Object.fromEntries(
      Object.entries(snapshot.overrides).map(([versionId, entries]) => [
        versionId,
        entries.map(describedMockToolEntry),
      ]),
    ),
  };
}

/** The run and its conversations — one shape for starting, reading and stopping. */
function describedRun(
  one: Run,
  simulations: readonly ConductedSimulation[],
  baseUrl: string,
): Record<string, unknown> {
  return {
    id: one.id,
    status: one.status,
    agent_id: one.agentId,
    connection_id: one.connectionId,
    connection_type: one.connectionSnapshot.type,
    modality: one.connectionSnapshot.modality,
    label: one.label,
    test_versions: [...one.pinnedTestVersionIds],
    // The world this run was frozen into. It never changes after creation,
    // whatever anybody edits, which is what a reader comparing two runs' numbers
    // has to be able to check for themselves.
    mock_tools: describedMockTools(one.mockToolSnapshot),
    expected_simulation_count: one.expectedSimulationCount,
    // Null until all three land together at the finish. A count that appeared
    // one at a time would let a reader do arithmetic on a half-settled run.
    completed_count: one.completedCount,
    failed_count: one.failedCount,
    canceled_count: one.canceledCount,
    // No token, no key, no query at all. A person opens it and the browser
    // they signed in with is already signed in — so the address is safe to
    // paste into a message, a ticket or a terminal somebody else can read.
    results_url: `${baseUrl.replace(/\/+$/u, "")}/runs/${one.id}`,
    created_at: one.createdAt.toISOString(),
    finished_at: one.finishedAt?.toISOString() ?? null,
    simulations: simulations.map(describedSimulation),
  };
}

/** One change, as the feed carries it. */
function describedEvent(event: RunEvent): Record<string, unknown> {
  return event.kind === "run"
    ? {
        seq: event.seq,
        at: event.at.toISOString(),
        kind: "run",
        status: event.status,
      }
    : {
        seq: event.seq,
        at: event.at.toISOString(),
        kind: "simulation",
        simulation_id: event.simulationId,
        test_name: event.testName,
        persona_name: event.personaName,
        status: event.status,
        verdict: event.verdict,
        reason: event.reason,
      };
}

/**
 * The run as it now stands, read back after whatever just happened to it.
 *
 * Both reads go through the module on the caller's own context, so a run this
 * credential cannot see is `undefined` here exactly as it is anywhere else.
 */
async function runAsItStands(
  auth: AuthContext,
  runId: string,
  baseUrl: string,
  /** Already read by the write that just moved it, when there was one. */
  known?: Run,
): Promise<Record<string, unknown> | undefined> {
  const header = known ?? (await getRun(auth, runId));
  if (header === undefined) return undefined;

  const simulations = (await listSimulations(auth, runId)) ?? [];
  return describedRun(header, simulations, baseUrl);
}

export async function runRoutes(
  app: FastifyInstance,
  options: RunRoutesOptions,
): Promise<void> {
  credentialed(app, {
    provider: options.provider,
    rateLimit: options.rateLimit,
  });

  /**
   * Start a run over one connection, pinning the versions it will execute.
   *
   * The body names the connection, and may name the agent it has to be on —
   * a client holding both checks both, and a mismatch is its own answer
   * rather than a quiet choice between the two ids.
   *
   * Unknown keys are read past rather than refused, which is the strictness
   * this verb has always had: a run's body is assembled by a terminal from a
   * folder and a selection, and the fields that matter each refuse for
   * themselves in words that say what to send instead.
   */
  app.post(RUNS_PATH, async (request, reply) => {
    const { auth } = requesterOf(request);
    const body = (request.body ?? {}) as Body;

    // The role is checked before anything is read, which is the stance the
    // factories take for the same reason: a viewer is refused for being a
    // viewer, rather than after a read that tells them what is there.
    authorize(auth, "start_and_cancel_runs", {
      organizationId: auth.organizationId,
      projectId: auth.projectId,
    });

    const pinned = pinnedVersions(body.test_versions ?? []);
    if ("refusal" in pinned) return unprocessable(reply, pinned.refusal);

    const acting = await actingIn(auth, given(text(body.project)));
    if ("refusal" in acting) return refuseActing(reply, acting);

    const onAgent = given(text(body.agent));
    const label = given(text(body.label));

    const started = await startRun(acting.auth, {
      ...(onAgent === undefined ? {} : { agentId: onAgent }),
      connectionId: text(body.connection),
      testVersionIds: pinned.entries,
      ...(label === undefined ? {} : { label }),
    });

    return reply
      .code(201)
      .send(describedRun(started, started.simulations, options.baseUrl));
  });

  /**
   * The run as it now stands, with every conversation in it. What a follower
   * seeds itself from when it did not start the run itself.
   */
  app.get(RUN_PATH, async (request, reply) => {
    const { auth } = requesterOf(request);
    const { runId } = request.params as { runId: string };

    const described = await runAsItStands(auth, runId, options.baseUrl);
    if (described === undefined) return notFound(reply, NO_SUCH_RUN);
    return reply.send(described);
  });

  /**
   * Everything that has changed since a point, in the order it happened.
   *
   * A cursor rather than a socket: a follower that loses its connection asks
   * again from the last number it applied, so it never misses a change and
   * never acts on one twice. `after` is a sequence number this feed issued —
   * anything else is refused rather than read as zero, because silently
   * starting again from the beginning would replay a whole run into a screen
   * that had already drawn it.
   */
  app.get(RUN_EVENTS_PATH, async (request, reply) => {
    const { auth } = requesterOf(request);
    const { runId } = request.params as { runId: string };
    const query = (request.query ?? {}) as { readonly after?: string };

    // Digits and nothing else. `Number` would take 0x10, 1e3, 5.0 and a
    // padded " 7 " and quietly answer about a page nobody asked for, while
    // the sentence below promised it would not — so the shape of a sequence
    // number is checked as written rather than as parsed. And digits alone
    // are still not enough: the sequence column is a Postgres integer, so a
    // number too big for it is refused here rather than surfacing as the
    // database's own error about a page that could never exist.
    const said = given(query.after);
    const after = said === undefined ? 0 : Number(said);
    if (
      said !== undefined &&
      (!/^\d+$/u.test(said) ||
        !Number.isSafeInteger(after) ||
        after > 2_147_483_647)
    ) {
      return invalid(
        reply,
        `"${said}" is not a sequence number this feed issued. Send back the ` +
          `next an earlier page answered with, or leave after out to start ` +
          `at the first change.`,
      );
    }

    const page = await listRunEvents(auth, runId, { after });
    if (page === undefined) return notFound(reply, NO_SUCH_RUN);

    return reply.send({
      events: page.events.map(describedEvent),
      next: page.next,
      done: page.done,
    });
  });

  /**
   * Stop a run.
   *
   * Conversations still queued end here and now; ones already with a simulator
   * are told to stop and land as canceled when they do. The reply is the run
   * as it stands, so a caller reads the counts as soon as they are honest —
   * and they are null until all three of them are.
   *
   * Canceling a canceled run is nothing to do and answers the run; canceling
   * one that already finished is refused out loud, because the caller missed
   * and should know it.
   */
  app.post(RUN_CANCEL_PATH, async (request, reply) => {
    const { auth } = requesterOf(request);
    const { runId } = request.params as { runId: string };

    authorize(auth, "start_and_cancel_runs", {
      organizationId: auth.organizationId,
      projectId: auth.projectId,
    });

    // The header comes back from the write itself rather than from a second
    // read: it is the run as the cancel left it, which is the thing a caller
    // asked about.
    const canceled = await cancelRun(auth, runId);
    if (canceled === undefined) return notFound(reply, NO_SUCH_RUN);

    const described = await runAsItStands(
      auth,
      runId,
      options.baseUrl,
      canceled,
    );
    if (described === undefined) return notFound(reply, NO_SUCH_RUN);
    return reply.send(described);
  });

  /**
   * The refusals this group owns, each answered as an answer rather than as a
   * fault, and each carrying the sentence the layer below wrote.
   *
   * The sentences are relayed word for word on purpose. A client relays them
   * to a terminal a coding agent is reading, so the wording is the contract —
   * and paraphrasing here would put a second, quieter copy of it in a file
   * nobody would think to check.
   */
  app.setErrorHandler(async (error, _request, reply) => {
    if (error instanceof RunWriteRefusedError) {
      // A map from the reason to the answer, and nothing else. The sentence is
      // written whole where the refusal was decided and travels untouched:
      // finishing one off here would put half the contract in a second file,
      // and the wire text would exist nowhere as one string to check.
      switch (error.reason) {
        case "no_such_connection":
        case "connection_not_on_agent":
          return notFound(reply, error.message);
        case "no_adapter":
          return noAdapter(reply, error.message);
        case "already_finished":
          return conflict(reply, error.message);
        default:
          return unprocessable(reply, error.message);
      }
    }

    // Reachable only in a race — the project was checked before the write, and
    // this is what a delete landing in between looks like from inside it.
    if (error instanceof ProjectOutsideOrganizationError) {
      return notPermitted(reply, cannotActIn(error.projectId));
    }

    if (error instanceof NotPermittedError) {
      return notPermitted(reply, error.message);
    }

    throw error;
  });
}
