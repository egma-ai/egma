import { setTimeout as sleep } from "node:timers/promises";

import {
  claimSimulations,
  failSimulationDispatch,
  getPersonaVersion,
  getRun,
  getSimulationTestVersion,
  ManagedAccessNotConnectedError,
  ManagedAccessUnavailableError,
  ModelProviderCredentialMissingError,
  readModelAccess,
  resolveMockTools,
  resolveManagedAccess,
  resolveModelProviderKeys,
  resolvePlatformSettings,
  resolveSimulationConnection,
  type EndingRepair,
  type PersonaModels,
  type PlatformSettingValues,
  type Run,
  type SimulationClaim,
} from "@egma/db";
import {
  isSpecContractVersion,
  specComplaints,
  SPEC_CONTRACT_VERSIONS,
} from "@egma/simulation-contract";
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

/**
 * The contract version a work order is written in, decided by the row rather
 * than by the deployment.
 *
 * **A simulation whose pinned persona selects its own models needs version 2;
 * one that does not gets version 1, byte for byte as it always did.** So the
 * version is a property of what has to be said rather than of a flag somebody
 * flips, and there is no moment at which the deployment is half-migrated in a
 * way anybody has to reason about. A worker that speaks only version 1 never
 * claims a row that would need version 2 — the queue filters on exactly that —
 * so no document ever arrives at a worker that cannot read it.
 */
const CONTRACT_VERSION_WITHOUT_MODELS = 1;
const CONTRACT_VERSION_WITH_MODELS = 2;

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

/**
 * The models block of one work order: the pinned persona's three selections
 * and, under customer-owned access, the organization's key for each provider
 * they name.
 *
 * **Resolved when the claim is prepared, never when the run was created.** The
 * selections come off the version the run pinned, so they are exactly what they
 * were when somebody pressed start; the credentials and the access mode are
 * read now, so a key replaced or a mode changed mid-run reaches the next
 * simulation to be claimed and leaves the ones already conducting alone. That
 * split is the whole design: authored behavior is pinned, operational state is
 * current, and neither can be mistaken for the other.
 *
 * **Only the providers the selections name.** The keys are asked for by the
 * three providers this persona actually uses, so an organization holding a
 * fourth credential does not put it on this wire. Unrelated secrets not
 * travelling is a property of the argument rather than of a filter somebody
 * remembered to apply afterwards.
 */
async function modelsBlock(
  claim: SimulationClaim,
  models: PersonaModels,
): Promise<Record<string, unknown>> {
  const access = await readModelAccess(claim.auth);

  if (access.mode === "managed") {
    /**
     * **The whole managed answer is two values, and neither is a provider
     * secret.** Where the traffic goes, and what authorizes it at the door —
     * hosted Egma's own signed credential, or the inference key this
     * deployment connected. Egma's provider credentials never leave the
     * gateway, so there is no path from here to one and the closed contract
     * shape refuses a document that carried one anyway.
     *
     * Resolved now rather than when the run was created, exactly as the
     * customer-owned keys below are: a reconnected key reaches the next
     * simulation to be claimed and leaves the ones already conducting alone.
     *
     * A deployment with no gateway address, or an organization on managed
     * access with nothing connected, throws typed and lands on the row as an
     * infrastructure error with somewhere to go. Neither falls back to calling
     * a provider directly: a simulation quietly conducted on an account nobody
     * chose is worse than one that stopped and said why.
     */
    const managed = await resolveManagedAccess(claim.auth);
    return {
      access: access.mode,
      gateway: {
        address: managed.gatewayAddress,
        credential: managed.credential,
      },
      llm: { provider: models.llm.provider, model: models.llm.model },
      stt: { provider: models.stt.provider, model: models.stt.model },
      tts: {
        provider: models.tts.provider,
        model: models.tts.model,
        voice_id: models.tts.voiceId,
        speed: models.tts.speed,
      },
    };
  }

  /**
   * The legs this simulation actually has.
   *
   * **Every simulation thinks; only a voice simulation speaks and listens.** So
   * a chat simulation resolves one credential rather than three: the two speech
   * keys would be secrets on a wire with no use for them, and an organization
   * that has stored no speech credential would be stopped from running chat
   * tests it had everything for. The selections still travel whole, because
   * they are what the persona *is* — it is the keys that follow the legs.
   */
  const needed =
    claim.modality === "voice"
      ? ([
          { job: "llm", provider: models.llm.provider },
          { job: "stt", provider: models.stt.provider },
          { job: "tts", provider: models.tts.provider },
        ] as const)
      : ([{ job: "llm", provider: models.llm.provider }] as const);

  const resolved = await resolveModelProviderKeys(
    claim.auth,
    needed.map((one) => one.provider),
  );

  if (resolved.missing.length > 0) {
    // Named by model job as well as by provider, because "add an OpenAI key"
    // is a different sentence from "your persona listens with a provider you
    // have no key for" — and the person reading it has to know which of their
    // selections stopped the simulation.
    throw new ModelProviderCredentialMissingError(
      needed.filter((one) => resolved.missing.includes(one.provider)),
    );
  }

  const keyFor = (provider: PersonaModels["llm"]["provider"]): string => {
    const key = resolved.keys.get(provider);
    if (key === undefined) {
      throw new Error(`no ${provider} key was resolved for this simulation`);
    }
    return key;
  };
  const speechKey = (
    provider: PersonaModels["llm"]["provider"],
  ): Record<string, string> =>
    claim.modality === "voice" ? { key: keyFor(provider) } : {};

  return {
    access: access.mode,
    llm: {
      provider: models.llm.provider,
      model: models.llm.model,
      key: keyFor(models.llm.provider),
    },
    stt: {
      provider: models.stt.provider,
      model: models.stt.model,
      ...speechKey(models.stt.provider),
    },
    tts: {
      provider: models.tts.provider,
      model: models.tts.model,
      ...speechKey(models.tts.provider),
      voice_id: models.tts.voiceId,
      speed: models.tts.speed,
    },
  };
}

/**
 * Why one claimed simulation could not become a work order, and — where the
 * platform knows — which screen the person reading it goes to.
 *
 * The repair pointer travels as a word rather than a link, because the address
 * of a page is the browser's business; it is stored on the simulation so that
 * somebody opening the run tomorrow gets the same answer the log gave today.
 */
type Unbuildable = {
  readonly unbuildable: string;
  readonly repair?: EndingRepair | undefined;
};

/**
 * Whether assembly gave back a reason instead of a work order.
 *
 * A function rather than `"unbuildable" in spec`, because the other half of the
 * union is an open record: `in` narrows it to "a record that also has this
 * key", which is true of every record, and the reason would then be read as
 * `unknown`.
 */
function couldNotBeBuilt(
  answer: Record<string, unknown> | Unbuildable,
): answer is Unbuildable {
  return typeof (answer as Unbuildable).unbuildable === "string";
}

/** What a claim request said, once every field has been read and refused for itself. */
type ClaimAsk = {
  readonly claimant: string;
  readonly capacity: number;
  /** Seconds this request may be held; already bounded by the cap. */
  readonly holdSeconds: number;
  /** Which contract versions this simulator implements. */
  readonly contractVersions: readonly number[];
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

  /**
   * Which contract versions this simulator implements.
   *
   * **Absent means version 1 alone**, which is what every simulator built
   * before the second version means by saying nothing — so an old worker
   * pointed at a new control plane keeps receiving exactly the documents it
   * always received, with nothing to configure and no drain step.
   *
   * A version this control plane does not write is refused rather than
   * ignored: a worker declaring a version nobody emits has been deployed
   * against the wrong platform, and finding that out at the claim door is
   * better than finding it out as an empty queue nobody can explain.
   */
  const versions = body.contract_versions;
  if (versions !== undefined) {
    if (
      !Array.isArray(versions) ||
      versions.length === 0 ||
      !versions.every((one) => isSpecContractVersion(one))
    ) {
      return {
        refusal:
          "contract_versions is which versions of the simulation contract " +
          "this simulator implements, as a non-empty list of whole numbers " +
          `from ${SPEC_CONTRACT_VERSIONS.join(", ")}. Leave it out and Egma ` +
          `sends version ${CONTRACT_VERSION_WITHOUT_MODELS}.`,
      };
    }
  }

  return {
    claimant: claimant.trim(),
    capacity: Math.min(capacity, LARGEST_CLAIM_CAPACITY),
    holdSeconds: Math.min(
      wait === undefined ? DEFAULT_HOLD_SECONDS : wait,
      LONGEST_HOLD_SECONDS,
    ),
    contractVersions:
      versions === undefined
        ? [CONTRACT_VERSION_WITHOUT_MODELS]
        : (versions as readonly number[]),
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
): Promise<Record<string, unknown> | Unbuildable> {
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

  /**
   * The persona's own model selections, or nothing for a version still on the
   * compatibility path.
   *
   * Nothing is the ordinary state of every persona authored before the model
   * catalog existed, and it is what keeps those personas running: the work
   * order is written in version 1 and the deployment's own settings decide the
   * models, exactly as they did. A persona that *has* selections is written in
   * version 2, and the queue has already made sure this worker can read one.
   */
  const models =
    personaVersion.models === null
      ? undefined
      : await modelsBlock(claim, personaVersion.models);

  const spec = {
    contract_version:
      models === undefined
        ? CONTRACT_VERSION_WITHOUT_MODELS
        : CONTRACT_VERSION_WITH_MODELS,
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
    // And left out entirely where the platform holds nothing, on the same
    // reasoning one line up: a deployment that has configured no settings of
    // its own hands the simulator the document it always handed it.
    ...(platform === undefined ? {} : { platform }),
    // The persona's own selections, where it has them. A version-1 document
    // has no place for this block at all — its schema closes the top level —
    // so a simulation on the compatibility path is byte for byte the work
    // order it was before persona models existed.
    ...(models === undefined ? {} : { models }),
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
        contractVersions: ask.contractVersions,
      });
      while (claims.length === 0 && !gone && Date.now() < deadline) {
        await sleep(Math.min(RECHECK_MILLISECONDS, deadline - Date.now()));
        if (gone) break;
        claims = await claimSimulations({
          claimant: ask.claimant,
          capacity: ask.capacity,
          contractVersions: ask.contractVersions,
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
          (fault: unknown): Unbuildable => ({
            unbuildable: fault instanceof Error ? fault.message : String(fault),
            // A credential the organization has not stored, and an inference
            // key nobody has connected, are configuration problems with a
            // screen behind them — so the row that lands says which screen.
            // `ManagedAccessUnavailableError` is deliberately not here: a
            // deployment that was never told where its gateway is, is Egma
            // misconfigured, and sending an administrator to Model providers
            // for that would be a link that fixes nothing.
            ...(fault instanceof ModelProviderCredentialMissingError ||
            fault instanceof ManagedAccessNotConnectedError
              ? { repair: "model_providers" as const }
              : {}),
          }),
        );
        if (couldNotBeBuilt(spec)) {
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
            // The same sentence the log just carried, kept on the row: a
            // person opening this run tomorrow must not have to find a log
            // line from today to learn why one conversation is red.
            { detail: spec.unbuildable, repair: spec.repair },
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
