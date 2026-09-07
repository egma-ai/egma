import { setTimeout as sleep } from "node:timers/promises";

import {
  claimSimulations,
  catalogEntry,
  connectionTypeBranchesMockDraft,
  connectionTypeUsesPlatformCarrier,
  failSimulationDispatch,
  getPersonaVersion,
  personaModelsOfParameters,
  validatePersonaParameterValues,
  getRun,
  getSimulationExecutionEvidence,
  LANES_SERVING_MOCK_TOOLS,
  markSimulationCanceled,
  releaseSimulationClaim,
  resolveSimulationConnection,
  type PersonaModels,
  type ProviderCatalogEntry,
  type Run,
  type SimulationClaim,
  type TestEnv,
  type TestMockTool,
  type MockToolVariable,
} from "@egma/db";
import {
  ProviderCredentialSourceUnavailableError,
  credentialFor,
  type ProviderCredentialSource,
} from "@egma/provider-credentials";
import { mockToolUrl } from "@egma/retell";
import { specComplaints } from "@egma/simulation-contract";
import type { FastifyInstance } from "fastify";

import { acceptsServiceToken } from "../auth/service-token.ts";
import type { CarrierRoute } from "../config.ts";
import { invalid, notTheService } from "../http/refusals.ts";
import { mockToolBase } from "./mock-endpoint.ts";
import { platformEvent, safeExceptionType } from "../platform-log.ts";
import {
  verifyRetellChatAgent,
  type RetellDirectTargetCheck,
} from "../providers/retell.ts";

/**
 * Internal simulation claims require the deployment service token and bypass
 * per-organization rate limits. Stored work supplies each claim's scope.
 * Long-poll within client/server bounds, rechecking the queue for work.
 *
 * Assemble and validate each spec from pinned test/persona content and run
 * settings, current connection and model-provider credentials, mock tools,
 * carrier configuration when needed, and execution limits. Return only specs
 * that satisfy the simulation contract.
 */

export type ClaimRoutesOptions = {
  /** The deployment's service token, from configuration. */
  readonly serviceToken: string;
  /**
   * This deployment's own public origin, where the mock endpoint answers.
   *
   * Read here rather than written onto the temporary version, because which
   * tools point at Egma is decided **per call**: the version carries one
   * per-call variable in front of every custom tool's own URL, and this claim
   * fills each of them with Egma's address or with nothing (ADR-0022).
   */
  readonly baseUrl: string;
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
 * Platform execution limits by modality, pinned by contract fixtures.
 * Reaching a limit ends the simulation with limit_reached; it is not itself
 * a failing grade.
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
 * Select the run's temporary version when this test mocks tools and routing
 * variables exist; otherwise use its serving-version pin. Pass authored
 * Retell variables for either version. Add routing variables only for the
 * temporary version, after authored values so they cannot be overridden.
 * Covered tools receive Egma URLs; uncovered tools receive empty prefixes.
 */
function runVersionSpecOf(
  run: Run,
  simulationId: string,
  connectionType: string,
  agentPlatform: string | null,
  env: TestEnv | null,
  /** What this simulation's own test mocks, in the order it named them. */
  mockTools: readonly TestMockTool[],
  baseUrl: string,
): Record<string, unknown> {
  const routing = urlVariablesFor(run, connectionType, simulationId, mockTools, baseUrl);
  // The temporary version is what carries the routing variables, so it is
  // named exactly where there are routing values to render on it — and the
  // variables are passed exactly there too. One answer, read twice: the call
  // that is not on the copy has no name for them and is given none.
  const onTemporaryVersion =
    Object.keys(routing).length > 0 && mockTools.length > 0;
  const version = onTemporaryVersion
    ? (run.tempMockAgentVersion ?? run.agentVersion)
    : run.agentVersion;
  const variables = {
    ...authoredVariables(agentPlatform, env),
    ...(onTemporaryVersion ? routing : {}),
  };

  if (version === null || version === undefined) {
    return Object.keys(variables).length === 0
      ? {}
      : { dynamic_variables: variables };
  }
  return {
    agent_version: version,
    ...(Object.keys(variables).length === 0
      ? {}
      : { dynamic_variables: variables }),
  };
}

/**
 * Provide every declared routing variable on mocked web calls: Egma URL for
 * covered tools, empty prefix for others. Do not rely on the draft's single-space
 * fallback. Return no routing variables without a supported temporary version.
 */
function urlVariablesFor(
  run: Run,
  connectionType: string,
  simulationId: string,
  mockTools: readonly TestMockTool[],
  baseUrl: string,
): Record<string, string> {
  // The same authority the builder and the queue's gate read: a routing
  // variable exists exactly on the lanes that branch a temporary copy, because
  // the copy is the only place one is written.
  if (!connectionTypeBranchesMockDraft(connectionType)) return {};
  const declared: readonly MockToolVariable[] =
    run.mockMetadata?.urlVariables ?? [];
  if (declared.length === 0 || run.tempMockAgentVersion === null) return {};

  const mocked = new Set(mockTools.map((entry) => entry.tool));
  const target = { base: mockToolBase(baseUrl), simulationId };
  const variables: Record<string, string> = {};
  for (const { tool, variable } of declared) {
    variables[variable] = mocked.has(tool) ? mockToolUrl(target, tool) : "";
  }
  return variables;
}

/**
 * The caller context this test carries, where the platform renders one.
 *
 * `retell_dynamic_variables` is Retell's own word for its own feature, so a
 * LiveKit or phone simulation carries none — a lane that renders nothing must
 * never be handed a name it would drop silently while looking like it had been
 * served.
 */
function authoredVariables(
  agentPlatform: string | null,
  env: TestEnv | null,
): Record<string, string> {
  if (agentPlatform !== "retell") return {};
  return { ...(env?.retell_dynamic_variables ?? {}) };
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
 * Assemble a claimed simulation using its stored organization/project context.
 * Missing execution inputs produce a dispatch refusal. Validate the completed
 * spec against the same contract used by the simulator.
 */
async function assembledSpec(
  claim: SimulationClaim,
  /**
   * Cache run reads within this claim request to avoid rereading a shared run
   * for each simulation. Run IDs are deployment-unique; each initial read uses
   * the claim's stored scope. Do not retain the cache across requests.
   */
  runs: Map<string, Run | undefined>,
  retellTargets: Map<string, Promise<RetellDirectTargetCheck>>,
  providerCredentials: ProviderCredentialSource,
  carrierRoute: CarrierRoute | undefined,
  /** Where the mock endpoint answers, for the routing variables below. */
  baseUrl: string,
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

  // **The test carries its own world, and this is the whole of the decision.**
  // The answers come off the pinned test version — immutable, so an edit
  // mid-run moves nothing — and there is nothing else to fold in: no project
  // list, no run-level switch, nothing frozen on the run. A simulation is
  // mocked when its own test named a tool and the lane can serve one.
  //
  // The simulator receives the answers already decided, exactly as it receives
  // everything else: flattened, with nothing left to look up and nothing left
  // to choose between.
  const mockTools = (LANES_SERVING_MOCK_TOOLS as readonly string[]).includes(
    connection.connectionType,
  )
    ? evidence.mockTools.map((entry) => ({
        tool_name: entry.tool,
        answer:
          "error" in entry ? { error: entry.error } : { answer: entry.answer },
      }))
    : [];

  let models: Record<string, unknown>;
  try {
    // The source loads here, once per simulation work order. Persona choices
    // are pinned; credentials are current. A rotated AWS bundle therefore
    // reaches the next claimed simulation without changing the persona or
    // restarting either service.
    models = await modelsBlock(
      claim.modality,
      personaModelsOfParameters(validatePersonaParameterValues(personaVersion.parameterContract, claim.personaParameterValues)),
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

  // The version this simulation is placed against and the variables it carries:
  // the temporary version where this test mocks something on the draft lane,
  // the run's resolved serving version otherwise, with the test's own caller
  // context and — on a mocked web call — Egma's own routing variables.
  const versionSpec = runVersionSpecOf(
    run,
    claim.id,
    connection.connectionType,
    connection.agentPlatform,
    evidence.env,
    evidence.mockTools,
    baseUrl,
  );

  // What the room's agent is dispatched with, straight off the test's env and
  // verbatim: it is the customer's own word to their own agent, and Egma reads
  // none of it. A Project-credentials connection writes it to the dispatch;
  // a token-endpoint connection sends it in room_config for the endpoint to
  // copy into the token.
  const jobDispatchMetadata =
    connection.connectionType === "livekit_room"
      ? evidence.env?.job_dispatch_metadata
      : undefined;

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
    // Left out entirely where the test mocks nothing, which is what most
    // tests do: a simulation egma answers no tool for is byte for byte the
    // work order it was before mock tools existed, and an empty list
    // would be a claim about tools where there is nothing to claim.
    ...(mockTools.length === 0 ? {} : { mock_tools: mockTools }),
    // The same rule for the room's dispatch: absent where the test wrote none.
    ...(jobDispatchMetadata === undefined
      ? {}
      : { job_dispatch_metadata: jobDispatchMetadata }),
    // No phone route means no platform block.
    ...(platform === undefined ? {} : { platform }),
  };
  // A mock tool is named by its tool name and by nothing else, here and
  // everywhere: that is the whole of how one is matched, and an identifier
  // two sides carried and never read is a field they could come to disagree
  // about.

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
            options.baseUrl,
            options.retellFetch,
            responseDeadline,
          ).catch(
            (
              _fault: unknown,
            ): { readonly unbuildable: string } => ({
              // This broad catch can hold dependency or credential errors.
              // Unlike a simulator report, it has no secret-redaction seam,
              // so the retained customer-facing sentence stays generic.
              unbuildable: "an internal error prevented Egma from building its simulation spec",
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
          // Mark an unbuildable claim failed with dispatch_failed and continue the
          // batch. Do not send an invalid spec or wait for orphan cleanup. No grading
          // is requested for this execution failure.
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
            `Egma could not dispatch this simulation: ${spec.unbuildable}`,
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
