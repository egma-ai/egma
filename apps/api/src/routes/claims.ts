import { setTimeout as sleep } from "node:timers/promises";

import {
  claimSimulations,
  failSimulationDispatch,
  getPersonaVersion,
  getRun,
  getSimulationTestVersion,
  markSimulationCanceled,
  releaseSimulationClaim,
  resolveMockTools,
  resolvePlatformSettings,
  resolveSimulationConnection,
  type PlatformSettingValues,
  type Run,
  type SimulationClaim,
} from "@egma/db";
import { specComplaints } from "@egma/simulation-contract";
import type { FastifyInstance } from "fastify";

import { acceptsServiceToken } from "../auth/service-token.ts";
import { invalid, notTheService } from "../http/refusals.ts";
import { platformEvent, safeExceptionType } from "../platform-log.ts";
import {
  verifyRetellDirectChatAgent,
  type RetellDirectTargetCheck,
} from "../providers/retell.ts";

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
 * credentials unsealed, the answers this simulation's mock tools serve, the
 * deployment's own settings unsealed beside them, and the platform's limits
 * — validated against the contract schema before a byte of it is sent. This
 * is the only place credential material ever travels; the report direction
 * structurally has nowhere to put it.
 *
 * **The platform's settings ride this same answer on purpose.** They used to
 * live in each simulator's environment, which meant a second simulator on
 * another machine needed a file copied to it and a container started
 * without one dialled nothing while reporting itself healthy. Sending them
 * here opens no new door: it is the door a connection's credentials already
 * come through, with the same authority behind it and the same protection
 * over it — and it keeps the property that every arrow points outward from
 * the simulator, which talks to this API and to nothing else, and never to
 * Postgres.
 */

export type ClaimRoutesOptions = {
  /** The deployment's service token, from configuration. */
  readonly serviceToken: string;
  /** Test seam for Retell's read-only dispatch preflight. */
  readonly retellFetch?: typeof fetch | undefined;
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

/** Hard wall for queue wait, provider checks, assembly, and the response. */
const CLAIM_RESPONSE_MILLISECONDS = 28_000;

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

/**
 * The deployment's own settings, in the three groups the contract carries
 * them in and the simulator already has seams for: what the persona thinks
 * with, what it speaks and hears with, and how a call reaches the telephone
 * network.
 *
 * **Grouped rather than flat, because the groups are what can be absent.** A
 * deployment that has never been given a carrier is the ordinary deployment,
 * and it is exactly the one the fixtures cover — so "the phone half is
 * absent" has to be one missing object rather than five missing keys that
 * nothing holds together. The three groups also land one-for-one on the
 * simulator's own records, which is what makes taking a value from here a
 * substitution rather than a translation.
 *
 * A field the platform does not hold is left out entirely rather than sent
 * as `null` or `""`. The contract's rule is that what is here replaces what
 * the simulator has and what is absent leaves it standing, and an empty
 * string sent as a model name would be a name the simulator was told to use.
 */
function platformBlock(
  held: PlatformSettingValues,
): Record<string, unknown> | undefined {
  // Written out setting by setting rather than folded over the catalog, for
  // the reason `config.ts` reads each variable by name: this is where a
  // stored setting becomes a field the simulator reads, and a loop would
  // make an unread setting look exactly like a read one.
  const model = onlyWhatIsHeld({
    provider: held.persona_model_provider,
    model: held.persona_model,
    key: held.persona_model_key,
    reasoning_effort: held.persona_model_reasoning_effort,
  });
  const speech = onlyWhatIsHeld({
    stt_provider: held.speech_to_text_provider,
    stt_key: held.speech_to_text_key,
    stt_model: held.speech_to_text_model,
    tts_provider: held.text_to_speech_provider,
    tts_key: held.text_to_speech_key,
    tts_model: held.text_to_speech_model,
    tts_voice: held.text_to_speech_voice,
    vad_provider: held.voice_activity_provider,
  });
  const carrier = onlyWhatIsHeld({
    media_backend: held.media_backend,
    trunk_address: held.carrier_trunk_address,
    trunk_number: held.carrier_trunk_number,
    trunk_username: held.carrier_trunk_username,
    trunk_password: held.carrier_trunk_password,
  });

  const platform = onlyWhatIsHeld({ model, speech, carrier });
  // A platform that has configured nothing sends no block at all, so a spec
  // it assembles is byte for byte the spec it was before these settings
  // existed — which is what makes every fixture written before today still
  // the document this door really produces.
  return platform === undefined ? undefined : platform;
}

/** One block with its absent fields dropped, or nothing where none is held. */
function onlyWhatIsHeld<T>(
  fields: Record<string, T | undefined>,
): Record<string, T> | undefined {
  const present = Object.entries(fields).filter(
    ([, value]) => value !== undefined,
  );
  return present.length === 0
    ? undefined
    : (Object.fromEntries(present) as Record<string, T>);
}

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
        `and Egma holds for ${DEFAULT_HOLD_SECONDS}.`,
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
  retellTargets: Map<string, Promise<RetellDirectTargetCheck>>,
  retellFetch?: typeof fetch,
  responseDeadline = Date.now() + CLAIM_RESPONSE_MILLISECONDS,
): Promise<
  | Record<string, unknown>
  | { readonly unbuildable: string }
  | { readonly retryable: string }
> {
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

  if (connection.connectionKind === "retell_chat_api") {
    const apiKey = connection.credentials?.["apiKey"] ?? "";
    const agentId = connection.config["retellAgentId"] ?? "";
    let checked = retellTargets.get(connection.connectionId);
    if (checked === undefined) {
      checked = verifyRetellDirectChatAgent(
        apiKey,
        agentId,
        retellFetch,
        Math.max(1, responseDeadline - Date.now() - 500),
      );
      retellTargets.set(connection.connectionId, checked);
    }
    const target = await checked;
    if (target.kind === "blocked") {
      return { unbuildable: target.message };
    }
    if (target.kind === "retryable") {
      return { retryable: target.message };
    }
  }

  // Read for **each** simulation and never cached, which is the whole point
  // of the settings living in the store: an operator who replaces a spent key
  // has it in effect on the next simulation, with no container restarted and
  // nothing to remember to do. One more small select is nothing beside
  // conducting a conversation over a telephone connection, and a measurement
  // may ask for caching later — nothing has yet.
  const platform = platformBlock(await resolvePlatformSettings(claim.auth));

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
      agent_platform: connection.agentPlatform,
      connection_kind: connection.connectionKind,
      access_variant: connection.accessVariant,
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
    // And left out entirely where the platform holds nothing, on the same
    // reasoning one line up: a deployment that has configured no settings of
    // its own hands the simulator the document it always handed it.
    ...(platform === undefined ? {} : { platform }),
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
      const responseDeadline = Date.now() + CLAIM_RESPONSE_MILLISECONDS;
      const holdDeadline = Date.now() + ask.holdSeconds * 1_000;
      let claims = await claimSimulations({
        claimant: ask.claimant,
        capacity: ask.capacity,
      });
      while (claims.length === 0 && !gone && Date.now() < holdDeadline) {
        await sleep(
          Math.min(RECHECK_MILLISECONDS, holdDeadline - Date.now()),
        );
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
      const retellTargets = new Map<
        string,
        Promise<RetellDirectTargetCheck>
      >();
      // Every spec, and every unique Retell check cached inside them, starts
      // together. A batch of fifty must not spend one provider timeout fifty
      // times or break the route's sub-30-second response promise.
      const assembled = await Promise.all(
        claims.map((claim) =>
          assembledSpec(
            claim,
            runs,
            retellTargets,
            options.retellFetch,
            responseDeadline,
          ).catch(
            (
              fault: unknown,
            ): { readonly unbuildable: string } => ({
              unbuildable:
                fault instanceof Error ? fault.message : String(fault),
            }),
          ),
        ),
      );
      for (const [index, claim] of claims.entries()) {
        // A row whose stored shapes will not open — a sealed envelope that no
        // longer decrypts, a column holding something egma never writes —
        // throws from the reads rather than answering empty. Caught here,
        // because that too is one row's fault and never the batch's: an
        // escape would abort the whole response and withhold every valid
        // claim beside it from a simulator standing ready to conduct them.
        const spec = assembled[index];
        if (spec === undefined) continue;
        if ("retryable" in spec) {
          // A provider outage says nothing about the customer or their agent.
          // Give this lease back instead of minting a terminal error; a later
          // claim repeats the bounded check.
          request.log.warn(
            platformEvent(
              "egma.simulation.dispatch.deferred",
              "simulation dispatch was deferred after provider preflight",
              {
                "egma.simulation_id": claim.id,
                "egma.run_id": claim.runId,
                "error.type": "provider_preflight_failed",
              },
            ),
          );
          const released = await releaseSimulationClaim(
            claim.auth,
            claim.id,
            claim.claimedBy,
          );
          if (!released) {
            // A cancel can land while the provider check is in flight. In
            // that race the release correctly refuses to put canceled work
            // back in the queue, but no simulator received the work and none
            // will arrive later to honor the cancel. Land it here through the
            // same guarded cancellation door the simulator uses. If the row
            // moved for another reason, that door also refuses and the log is
            // the orphan sweep's honest last-chance signal.
            const canceled = await markSimulationCanceled(
              claim.auth,
              claim.id,
              claim.claimedBy,
            );
            if (canceled === undefined) {
              request.log.error(
                platformEvent(
                  "egma.simulation.claim.release_failed",
                  "simulation claim could not be released or canceled",
                  {
                    "egma.simulation_id": claim.id,
                    "egma.run_id": claim.runId,
                    "error.type": "simulation_claim_release_failed",
                  },
                ),
              );
            }
          }
          continue;
        }
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
            platformEvent(
              "egma.simulation.dispatch.failed",
              "claimed simulation could not be dispatched",
              {
                "egma.simulation_id": claim.id,
                "egma.run_id": claim.runId,
                "error.type": "simulation_spec_unbuildable",
              },
            ),
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
              platformEvent(
                "egma.simulation.dispatch.failure_record_failed",
                "simulation dispatch failure could not be recorded",
                {
                  "egma.simulation_id": claim.id,
                  "egma.run_id": claim.runId,
                  "error.type": "dispatch_failure_record_failed",
                  "exception.type": safeExceptionType(fault),
                },
              ),
            );
          });
          continue;
        }
        specs.push(spec);
        request.log.info(
          platformEvent(
            "egma.simulation.dispatched",
            "simulation was placed in a claim response",
            {
              "egma.simulation_id": claim.id,
              "egma.run_id": claim.runId,
            },
          ),
        );
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
