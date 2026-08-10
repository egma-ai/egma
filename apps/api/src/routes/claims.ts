import { setTimeout as sleep } from "node:timers/promises";

import {
  claimSimulations,
  failSimulationDispatch,
  getPersonaVersion,
  getRun,
  getSimulationTestVersion,
  resolveMockTools,
  resolveSimulationConnection,
  type Run,
  type SimulationClaim,
} from "@egma/db";
import { specComplaints } from "@egma/simulation-contract";
import type { FastifyInstance } from "fastify";

import { acceptsServiceToken } from "../auth/service-token.ts";
import { invalid, notTheService } from "../http/refusals.ts";

/**
 * The claim door: `POST /v1/claims`, where the simulator asks for work.
 *
 * This group is deliberately unlike every other on the API, in three ways
 * that are each contract rather than convenience.
 *
 * **The service token is the whole gate, and it resolves to nothing.** These
 * routes never accept a customer key or a session — the deployment's own
 * `EGMA_SIMULATOR_SERVICE_TOKEN`, compared in constant time, opens the door
 * and becomes no context at all. Every claimed simulation instead arrives
 * from the module with a context narrowed to that row's own organization and
 * project, so the credential a simulator holds cannot widen into anybody's
 * data even in principle: there is no context to widen.
 *
 * **The group sits outside the per-organization rate limit.** The budget
 * exists so one customer's runaway loop is not everybody's problem, and it
 * is keyed on the organization a credential resolves to; the simulator is
 * egma's own service standing behind every organization at once, so a busy
 * run must never eat any customer's budget from the inside — and there is no
 * organization to key its own on. The token is the gate here, not a budget.
 *
 * **The claim is held open rather than answered empty.** Dispatch is pull,
 * and the promise a developer actually feels is "a queued simulation is
 * claimed within about a second". So an empty queue holds the request and
 * re-asks every second until work arrives or the hold runs out — the long
 * poll every pull-dispatch product ships. The client says how long it is
 * willing to hang (`wait_seconds`), the server holds at most `min` of that
 * and its own cap, and a client that said nothing gets a middling default —
 * so a short-waiting client can never see its own request time out. A
 * notification may one day replace the re-ask behind this same route;
 * nothing the simulator sees would change.
 *
 * What goes back is the whole work order: for each claimed simulation, a
 * fully assembled spec — persona traits as the pinned version saved them,
 * the pinned test version's scenario, the connection's config with its
 * credentials unsealed, the answers this simulation's mock tools serve, and
 * the platform's limits — validated against the contract schema before a
 * byte of it is sent. This is the only place credential material ever
 * travels; the report direction structurally has nowhere to put it.
 */

export type ClaimRoutesOptions = {
  /** The deployment's service token, from configuration. */
  readonly serviceToken: string;
};

export const CLAIMS_PATH = "/v1/claims";

/**
 * How long a claim may be held open, however patient the client says it is.
 * Under the common 30s+ client timeouts and proxy idle windows, so a held
 * claim always answers as a response rather than dying as a timeout.
 */
const LONGEST_HOLD_SECONDS = 25;

/** The hold for a client that did not say how long it would wait. */
const DEFAULT_HOLD_SECONDS = 15;

/** How often a held claim re-asks the queue. The "about a second" promise. */
const RECHECK_MILLISECONDS = 1_000;

/**
 * The most simulations one claim may take, mirrored from the module's own
 * cap. A larger ask is clamped rather than refused: a simulator declaring a
 * huge capacity is a configuration to serve at the platform's pace, not a
 * request that deserves to fail.
 */
const LARGEST_CLAIM_CAPACITY = 50;

/**
 * The walls around one simulation, by modality — named constants matching
 * the contract's golden fixtures, so what the platform hands out and what
 * the fixtures teach cannot drift apart. A limit tripping ends a simulation
 * deliberately (`limit_reached`), which is never the agent failing; the
 * numbers bound egma's spend on a conversation going nowhere. Voice is
 * shorter than chat because every voice minute costs real speech synthesis
 * and transcription. Per-test limits are a future column on the test; these
 * are the platform's own.
 */
const SIMULATION_LIMITS = {
  chat: { max_duration_seconds: 600, max_turns: 60 },
  voice: { max_duration_seconds: 300, max_turns: 40 },
} as const;

/** The one contract version this control plane speaks. */
const CONTRACT_VERSION = 1;

type Body = Record<string, unknown>;

/** What a claim request said, once every field has been read and refused for itself. */
type ClaimAsk = {
  readonly claimant: string;
  readonly capacity: number;
  /** Seconds this request may be held; already bounded by the cap. */
  readonly holdSeconds: number;
};

/**
 * The body as this door reads it, or the sentence refusing it. Each field
 * refuses for itself in words that say what to send instead, because the
 * reader is the simulator's log and whoever is tailing it.
 */
function claimAsk(body: Body): ClaimAsk | { readonly refusal: string } {
  const claimant = body.claimant;
  if (typeof claimant !== "string" || claimant.trim() === "") {
    return {
      refusal:
        "a claim names its claimant — this simulator's own name for itself, " +
        'stamped on every row it takes. Send claimant as non-empty text, like ' +
        '"egma-simulator-1".',
    };
  }
  if (claimant.trim().length > 200) {
    return {
      refusal:
        "a claimant's name fits in 200 characters; it is a label for telling " +
        "two simulators apart, not a place for anything longer.",
    };
  }

  const capacity = body.capacity;
  if (typeof capacity !== "number" || !Number.isInteger(capacity) || capacity < 1) {
    return {
      refusal:
        "a claim declares capacity — how many simulations this simulator has " +
        "room to conduct at once — as a whole number of at least 1.",
    };
  }

  const wait = body.wait_seconds;
  if (
    wait !== undefined &&
    (typeof wait !== "number" || !Number.isFinite(wait) || wait < 0)
  ) {
    return {
      refusal:
        "wait_seconds is how long this request may be held open while the " +
        "queue is empty, as a number of seconds of at least 0. Leave it out " +
        `and egma holds for ${DEFAULT_HOLD_SECONDS}.`,
    };
  }

  return {
    claimant: claimant.trim(),
    capacity: Math.min(capacity, LARGEST_CLAIM_CAPACITY),
    holdSeconds: Math.min(
      wait === undefined ? DEFAULT_HOLD_SECONDS : wait,
      LONGEST_HOLD_SECONDS,
    ),
  };
}

/**
 * One claimed simulation as the wire carries it — the flattened work order
 * the contract's spec schema describes — or the reason it could not become
 * one.
 *
 * Everything is read through the claim's own narrowed context, so the
 * assembly of one customer's spec happens inside that customer exactly as a
 * person's read would. The reads can each come back empty — a connection
 * deleted mid-flight, a row from before tests were pinned — and the schema
 * check at the end holds whatever was assembled to the same standard the
 * simulator's own check will apply on receipt.
 */
async function assembledSpec(
  claim: SimulationClaim,
  /**
   * The runs already read while answering this one claim request, by id.
   *
   * A claim takes up to fifty conversations at once and they are usually a
   * run's — that is what a run *is* — so the run header would otherwise be
   * read fifty times for fifty specs that all want the same frozen world. The
   * cache lives for one request and no longer: the header is frozen from the
   * moment the run was created, so re-reading it inside one response could
   * only ever return the same rows, and a cache that outlived the request
   * would be a second copy of a record somebody may since have deleted.
   *
   * Keyed by run id alone, which is safe because every claim in one batch was
   * read through its own row's tenancy and a run id is unique across the
   * deployment — two claims naming one run are two conversations of it.
   */
  runs: Map<string, Run | undefined>,
): Promise<Record<string, unknown> | { readonly unbuildable: string }> {
  const personaVersion = await getPersonaVersion(
    claim.auth,
    claim.personaVersionId,
  );
  if (personaVersion === undefined) {
    return { unbuildable: "its pinned persona version could not be read" };
  }

  const testVersion = await getSimulationTestVersion(claim.auth, claim.id);
  if (testVersion === undefined) {
    return { unbuildable: "its pinned test version could not be read" };
  }

  const connection = await resolveSimulationConnection(claim.auth, claim.id);
  if (connection === undefined) {
    return {
      unbuildable: "its connection is gone or its credentials would not unseal",
    };
  }

  if (!runs.has(claim.runId)) {
    runs.set(claim.runId, await getRun(claim.auth, claim.runId));
  }
  const run = runs.get(claim.runId);
  if (run === undefined) {
    return { unbuildable: "its run could not be read" };
  }

  // Resolved here and nowhere else. `resolveMockTools` is the one place a
  // project default and a test override are folded together, and the
  // snapshot it folds was frozen when the run was created — so every
  // simulation in one run is served one world, and a mock tool edited
  // mid-run tears nothing. The simulator receives the answers already
  // decided, exactly as it receives everything else: flattened, with
  // nothing left to look up and nothing left to choose between.
  const mockTools = resolveMockTools(
    run.mockToolSnapshot,
    claim.testVersionId,
  ).map((mock) => ({
    tool_name: mock.toolName,
    answer: mock.answer,
    delay_milliseconds: mock.delayMilliseconds,
  }));

  const spec = {
    contract_version: CONTRACT_VERSION,
    simulation_id: claim.id,
    modality: claim.modality,
    connection: {
      type: connection.type,
      config: connection.config,
      credentials: connection.credentials,
    },
    persona: { traits: personaVersion.traits },
    scenario: { instructions: testVersion.scenario },
    limits: SIMULATION_LIMITS[claim.modality],
    // Left out entirely where the run mocks nothing, which is what most
    // runs do: a simulation egma answers no tool for is byte for byte the
    // work order it was before mock tools existed, and an empty list
    // would be a claim about tools where there is nothing to claim.
    ...(mockTools.length === 0 ? {} : { mock_tools: mockTools }),
  };
  // `mockToolId` is deliberately not among the fields sent. The simulator
  // records which mock tool answered by its tool name, which is the whole
  // of how one is matched; an identifier it would carry and never read is
  // a field two sides could come to disagree about.

  // Validated on the way out, against the same schema the simulator compiles
  // on the way in — so a document that does not speak the contract is this
  // side's fault, caught here, rather than a refusal the simulator has to
  // explain back over the wire.
  const complaints = specComplaints(spec);
  if (complaints.length > 0) {
    return { unbuildable: `its spec violates the contract: ${complaints.join("; ")}` };
  }

  return spec;
}

export async function claimRoutes(
  app: FastifyInstance,
  options: ClaimRoutesOptions,
): Promise<void> {
  // The gate, as a hook on this scope rather than a line in the route, for
  // the reason `credentialed` is one: a route inside this group cannot run
  // unguarded, and a header is all it reads — an unauthenticated request
  // never has its body parsed at all.
  app.addHook("onRequest", async (request, reply) => {
    if (!acceptsServiceToken(request.headers.authorization, options.serviceToken)) {
      return notTheService(reply);
    }
    return undefined;
  });

  /**
   * Claim up to `capacity` queued simulations, held open while the queue is
   * empty, answering `{ specs: [...] }` — possibly empty, which is what a
   * quiet queue looks like and what the client asks again after.
   */
  app.post(CLAIMS_PATH, async (request, reply) => {
    const ask = claimAsk((request.body ?? {}) as Body);
    if ("refusal" in ask) return invalid(reply, ask.refusal);

    // A client that hangs up mid-hold should stop being worked for: rows
    // claimed for nobody would sit claimed until the sweep called them
    // orphaned, so the hold checks the client is still there before every
    // re-ask. The signal has to come from the **socket**, not the request:
    // a request message emits `close` the moment its body has been read —
    // which happened before this handler ran — so a listener there would
    // read every hold as abandoned at once and answer each empty-queue
    // claim immediately. The socket closes only when the client actually
    // goes.
    const socket = request.raw.socket;
    let gone = socket.destroyed;
    const clientLeft = (): void => {
      gone = true;
    };
    socket.once("close", clientLeft);

    try {
      const deadline = Date.now() + ask.holdSeconds * 1_000;
      let claims = await claimSimulations({
        claimant: ask.claimant,
        capacity: ask.capacity,
      });
      while (claims.length === 0 && !gone && Date.now() < deadline) {
        await sleep(Math.min(RECHECK_MILLISECONDS, deadline - Date.now()));
        if (gone) break;
        claims = await claimSimulations({
          claimant: ask.claimant,
          capacity: ask.capacity,
        });
      }

      const specs: Record<string, unknown>[] = [];
      // One read of each run, however many of its conversations this batch
      // took. Lives exactly as long as this response.
      const runs = new Map<string, Run | undefined>();
      for (const claim of claims) {
        // A row whose stored shapes will not open — a sealed envelope that no
        // longer decrypts, a column holding something egma never writes —
        // throws from the reads rather than answering empty. Caught here,
        // because that too is one row's fault and never the batch's: an
        // escape would abort the whole response and withhold every valid
        // claim beside it from a simulator standing ready to conduct them.
        const spec = await assembledSpec(claim, runs).catch(
          (fault: unknown): { readonly unbuildable: string } => ({
            unbuildable: fault instanceof Error ? fault.message : String(fault),
          }),
        );
        if ("unbuildable" in spec) {
          // Fail loudly on this side and keep dispatching the rest: one
          // corrupt row must not hold up the batch, and the simulator is
          // never handed a document it would have to refuse. The row lands
          // its honest terminal state here and now — `failed`, with the
          // platform's own `dispatch_failed` — because a spec that was never
          // handed over is never the simulator's error, must not wait to be
          // misnamed orphaned, and must never loop back through the queue to
          // fail the same way again. The landing is terminal like any other:
          // the judgement is minted beside it, and a run waiting only on
          // this row settles with truthful counts.
          request.log.error(
            { simulationId: claim.id, runId: claim.runId },
            `simulation ${claim.id} was claimed and could not be dispatched: ${spec.unbuildable}`,
          );
          await failSimulationDispatch(
            claim.auth,
            claim.id,
            claim.claimedBy,
          ).catch((fault: unknown) => {
            // The one place left where the sweep is the backstop: a row so
            // broken even its landing throws stays claimed until swept, and
            // saying so costs one log line rather than aborting a batch a
            // simulator is standing ready to conduct.
            request.log.error(
              { simulationId: claim.id, runId: claim.runId },
              `simulation ${claim.id} could not even land dispatch_failed: ${
                fault instanceof Error ? fault.message : String(fault)
              }`,
            );
          });
          continue;
        }
        specs.push(spec);
      }

      return await reply.send({ specs });
    } finally {
      // Taken back off rather than left behind: a keep-alive socket outlives
      // this request, and a listener per claim would pile up for as long as
      // the simulator keeps its connection — which is its whole life.
      socket.removeListener("close", clientLeft);
    }
  });
}
