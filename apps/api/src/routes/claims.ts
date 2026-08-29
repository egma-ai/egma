import { setTimeout as sleep } from "node:timers/promises";

import {
  claimSimulations,
  catalogEntry,
  connectionTypeUsesPlatformCarrier,
  failSimulationDispatch,
  getPersonaVersion,
  getRun,
  getSimulationExecutionEvidence,
  markSimulationCanceled,
  releaseSimulationClaim,
  resolveMockTools,
  resolveSimulationConnection,
  type PersonaModels,
  type ProviderCatalogEntry,
  type Run,
  type SimulationClaim,
} from "@egma/db";
import {
  ProviderCredentialSourceUnavailableError,
  credentialFor,
  type ProviderCredentialSource,
} from "@egma/provider-credentials";
import { SIMULATION_VARIABLE } from "@egma/retell";
import { specComplaints } from "@egma/simulation-contract";
import type { FastifyInstance } from "fastify";

import { acceptsServiceToken } from "../auth/service-token.ts";
import type { CarrierRoute } from "../config.ts";
import { invalid, notTheService } from "../http/refusals.ts";
import { platformEvent, safeExceptionType } from "../platform-log.ts";
import {
  verifyRetellChatAgent,
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
 * fully assembled spec — the pinned persona whole and their model choices,
 * current keys for only those model providers, the pinned test scenario, connection
 * config and credentials, mock answers, the current carrier route, and limits
 * — validated against the contract before a byte is sent. This is the only
 * place runtime credential material travels; reports have no field for it.
 *
 * Model choices have one source: the pinned persona version. Provider keys
 * have one source: this deployment's credential source. The carrier route comes
 * straight from this process's deployment environment. These boundaries prevent
 * a model from one provider being combined with another adapter or credential.
 */

export type ClaimRoutesOptions = {
  /** The deployment's service token, from configuration. */
  readonly serviceToken: string;
  /** Current provider keys, read once for each simulation work order. */
  readonly providerCredentials: ProviderCredentialSource;
  /** Complete phone route, or absent when phone simulations are unavailable. */
  readonly carrierRoute: CarrierRoute | undefined;
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
 * numbers bound egma's spend on a conversation going nowhere. Per-test
 * limits are a future column on the test; these are the platform's own.
 *
 * **Ten minutes on both, as of 2026-08-28.** Voice used to stop at five,
 * on the reasoning that a voice minute costs real speech synthesis and
 * transcription while a chat minute does not. The reasoning is sound and
 * the number was wrong for what people actually test: a screening
 * interview, a support call that escalates, an onboarding walk-through —
 * conversations that are fifteen minutes in production and had every
 * simulation of them cut at five, which grades an agent on an exchange
 * that never finished. Ten is the developer's call and is a ceiling
 * rather than a target; almost every simulation ends on the persona
 * concluding, long before it.
 *
 * **The turn count is where voice still costs more, and it binds first.**
 * Forty turns at a typical voice pace is roughly six to eight minutes, so
 * a talkative agent meets `max_turns` before it meets the ten minutes.
 * Raising that number is a separate decision with a separate bill, and it
 * was not taken here.
 */
const SIMULATION_LIMITS = {
  chat: { max_duration_seconds: 600, max_turns: 60 },
  voice: { max_duration_seconds: 600, max_turns: 40 },
} as const;

/** The one clean-cut contract this control plane and simulator speak. */
const CONTRACT_VERSION = 5;

type Body = Record<string, unknown>;

/**
 * The current carrier route, or no platform block when this deployment has no
 * phone route. Model, speech, voice, VAD and media facts cannot enter here.
 */
function platformBlock(
  carrier: CarrierRoute | undefined,
): Record<string, unknown> | undefined {
  if (carrier === undefined) return undefined;
  return {
    carrier: {
      trunk_address: carrier.trunkAddress,
      trunk_number: carrier.sourceNumber,
      trunk_username: carrier.trunkUsername,
      trunk_password: carrier.trunkPassword,
    },
  };
}

/**
 * The pinned persona selections with only the credentials this simulation
 * can use.
 *
 * The source is loaded exactly once in this function. A voice simulation gets
 * keys for all three legs; a chat simulation gets only its LLM key. The whole
 * current bundle never crosses the claim door.
 */
async function modelsBlock(
  modality: SimulationClaim["modality"],
  models: PersonaModels,
  source: ProviderCredentialSource,
): Promise<Record<string, unknown>> {
  const entryFor = <Job extends "llm" | "stt" | "tts">(
    job: Job,
    selection: { readonly provider: string; readonly model: string },
  ): ProviderCatalogEntry<Job> => {
    const entry = catalogEntry(job, selection.provider, selection.model);
    if (entry === undefined) {
      throw new Error(
        `the pinned persona selected ${selection.provider}/${selection.model} ` +
          `for ${job}, but that entry is absent from the model catalog`,
      );
    }
    return entry;
  };
  const entries = {
    llm: entryFor("llm", models.llm),
    stt: entryFor("stt", models.stt),
    tts: entryFor("tts", models.tts),
  };
  const credentials = await source.load();
  const keyFor = (
    provider: PersonaModels["llm"]["provider"],
  ): string => credentialFor(credentials, provider);
  const speechKey = (
    provider: PersonaModels["llm"]["provider"],
  ): Record<string, string> =>
    modality === "voice" ? { key: keyFor(provider) } : {};

  return {
    llm: {
      provider: models.llm.provider,
      model: models.llm.model,
      adapter: entries.llm.adapter,
      ...(entries.llm.reasoningEffort === undefined
        ? {}
        : { reasoning_effort: entries.llm.reasoningEffort }),
      key: keyFor(models.llm.provider),
    },
    stt: {
      provider: models.stt.provider,
      model: models.stt.model,
      adapter: entries.stt.adapter,
      ...speechKey(models.stt.provider),
    },
    tts: {
      provider: models.tts.provider,
      model: models.tts.model,
      adapter: entries.tts.adapter,
      voice_id: models.tts.voiceId,
      speed: models.tts.speed,
      ...speechKey(models.tts.provider),
    },
  };
}

/**
 * The version this simulation is placed against and the variables it carries —
 * one code path for both lanes that name a version, or nothing at all.
 *
 * **The version** is named explicitly, because the platform's own default is
 * "the newest version" — which a concurrent edit or a branch can move between
 * one simulation and the next. Where it comes from is the only thing the two
 * lanes differ on:
 *
 * - **the draft lane** hands the DRAFT version Egma branched, so the
 *   conversation reaches the mocked tools on the temporary version;
 * - **the text-mode lane** hands the RESOLVED serving version the run read
 *   once at start, so every simulation of the run tests the one version a real
 *   caller reaches.
 *
 * The temporary version wins when both are present, because a run that branched
 * one is being conducted against the mocked tools on it and nothing else would
 * be honest: the serving version beside it is what the copy was branched from.
 *
 * **The variables** are what the platform renders per call, and Egma passes only
 * its own: the attribution variable that carries this simulation's identifier
 * into the tool URL. Everything else falls back to the version's declared
 * defaults. Both lanes hand it, because both render variables.
 *
 * The attribution variable is **asserted rather than assumed**. The whole tool
 * record of a mocked simulation rides on it: the swapped URL carries
 * `{{egma_simulation}}` as a path segment, and a spec that omitted it would send
 * every tool call to a path naming no simulation — which the endpoint refuses,
 * silently losing every tool fact the run exists to collect. Nothing else
 * catches that, so it is caught here, where the value is put in.
 */
function runVersionSpecOf(
  run: Run,
  simulationId: string,
): Record<string, unknown> {
  const version = run.tempMockAgentVersion ?? run.agentVersion ?? undefined;
  if (version === null || version === undefined) return {};

  const variables = dynamicVariablesFor(simulationId);
  if (variables[SIMULATION_VARIABLE] !== simulationId) {
    throw new Error(
      `simulation ${simulationId} would be conducted against a named version ` +
        `whose variables do not carry ${SIMULATION_VARIABLE}, so no tool call ` +
        "it made could be traced back to it",
    );
  }

  return {
    agent_version: version,
    dynamic_variables: variables,
  };
}

/**
 * The variables one simulation is conducted with.
 *
 * One entry today, and the assertion above is on its answer rather than inside
 * it deliberately: authored caller-context variables are a named later chapter,
 * and the day this function merges a second source is the day it could drop the
 * first. The check is placed where it will still be looking at the whole answer
 * when that happens.
 */
function dynamicVariablesFor(simulationId: string): Record<string, string> {
  return { [SIMULATION_VARIABLE]: simulationId };
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

  const contractVersions = body.contract_versions;
  if (
    !Array.isArray(contractVersions) ||
    contractVersions.length === 0 ||
    !contractVersions.every(
      (version) => typeof version === "number" && Number.isInteger(version),
    )
  ) {
    return {
      refusal:
        "contract_versions is the simulation-contract versions this worker " +
        `implements. Send a non-empty list that includes ${CONTRACT_VERSION}.`,
    };
  }
  if (!contractVersions.includes(CONTRACT_VERSION)) {
    return {
      refusal:
        `this control plane sends simulation contract version ${CONTRACT_VERSION}, ` +
        "and this worker does not say it can read it. Deploy the matching " +
        "simulator before it claims work.",
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
  providerCredentials: ProviderCredentialSource,
  carrierRoute: CarrierRoute | undefined,
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

  const evidence = await getSimulationExecutionEvidence(claim.auth, claim.id);
  if (evidence === undefined) {
    return { unbuildable: "its pinned test version could not be read" };
  }
  const testVersion = evidence.testVersion;

  const connection = await resolveSimulationConnection(claim.auth, claim.id);
  if (connection === undefined) {
    return {
      unbuildable: "its connection is gone or its credentials would not unseal",
    };
  }

  if (connection.connectionType === "retell_chat_api") {
    const apiKey = connection.credentials?.["apiKey"] ?? "";
    const agentId = connection.config["retellAgentId"] ?? "";
    let checked = retellTargets.get(connection.connectionId);
    if (checked === undefined) {
      checked = verifyRetellChatAgent(
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

  // Add the deployment carrier route only for `phone_number`. A Retell chat or
  // LiveKit room claim must not carry a SIP password it cannot use.
  const platform =
    connectionTypeUsesPlatformCarrier(connection.connectionType)
      ? platformBlock(carrierRoute)
      : undefined;

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
  const resolved = resolveMockTools(
    evidence.mockToolSnapshot,
    claim.testVersionId,
  );

  // **Whether this run is mocked at all is read from its own snapshot**, on
  // every lane. The switch lives on the connection, and the run froze it at
  // start — so a switch unticked mid-run leaves this run in the world it began
  // in, and a text run started with the switch off carries no answers and goes
  // real. Nothing consults the connection row here.
  const mockTools = (
    run.connectionSnapshot.mockToolsEnabled ? resolved : []
  ).map((mock) => ({
    tool_name: mock.toolName,
    answer: mock.answer,
    // Carried on every lane, and deliberately never spent on a chat one: a
    // declared delay is speech-world fidelity, which is the layer chat leaves
    // out. It rides along so one authored answer serves every modality.
    delay_milliseconds: mock.delayMilliseconds,
  }));

  let models: Record<string, unknown>;
  try {
    // The source loads here, once per simulation work order. Persona choices
    // are pinned; credentials are current. A rotated AWS bundle therefore
    // reaches the next claimed simulation without changing the persona or
    // restarting either service.
    models = await modelsBlock(
      claim.modality,
      personaVersion.models,
      providerCredentials,
    );
  } catch (fault) {
    if (fault instanceof ProviderCredentialSourceUnavailableError) {
      return {
        retryable:
          "the current model-provider credential bundle could not be read",
      };
    }
    throw fault;
  }

  // The version this simulation is placed against and the variables it carries,
  // for whichever lane named a version — the draft lane's temporary version or
  // the text-mode lane's resolved serving version, in one code path.
  const versionSpec = runVersionSpecOf(run, claim.id);

  const spec = {
    contract_version: CONTRACT_VERSION,
    simulation_id: claim.id,
    modality: claim.modality,
    connection: {
      agent_platform: connection.agentPlatform,
      connection_type: connection.connectionType,
      access_variant: connection.accessVariant,
      config: connection.config,
      credentials: connection.credentials,
    },
    ...versionSpec,
    // Flat and whole, straight off the pinned version: the name this person
    // gives the agent, who they are, and the language the roleplay runs in.
    // The identity name is the authored one — never the team's label for the
    // library row — which is what makes the same test hear the same person on
    // every run.
    persona: {
      name: personaVersion.identityName,
      personality: personaVersion.personality,
      language: personaVersion.language,
    },
    models,
    scenario: { instructions: testVersion.scenario },
    // The same walls the chat lane has always had, by modality and by nothing
    // else. A text-mode exchange is a chat, so it gets the chat numbers.
    limits: SIMULATION_LIMITS[claim.modality],
    // `agent_version` and `dynamic_variables` are handed by `versionSpec` above,
    // one path for both lanes — the draft lane's temporary version and the
    // text-mode lane's resolved serving version alike. They are not written a
    // second time here.
    //
    // Left out entirely where the run mocks nothing, which is what most
    // runs do: a simulation egma answers no tool for is byte for byte the
    // work order it was before mock tools existed, and an empty list
    // would be a claim about tools where there is nothing to claim.
    ...(mockTools.length === 0 ? {} : { mock_tools: mockTools }),
    // No phone route means no platform block.
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
            options.providerCredentials,
            options.carrierRoute,
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
          // fail the same way again. The landing is terminal like any other,
          // and a run waiting only on this row settles with truthful counts.
          // No grading job is created because no completed trace exists.
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
