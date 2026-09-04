/**
 * The temporary world one run builds on a Retell account, and unbuilds.
 *
 * Everything here is the **order** — the part that cannot be got wrong twice.
 * The verbs it is written out of are the ones beside it: number reads in
 * `numbers.ts`, version reads and writes in `versions.ts`, the pure transform
 * in `mock-draft.ts`. Nothing new reaches Retell from here; what is new is the
 * sequence, the guards between its steps, and the record it leaves behind so
 * that somebody else can finish what a crashed run started.
 *
 * ## Egma writes to exactly one thing
 *
 * **One temporary agent version, made by this run and deleted by it.** Nothing
 * here touches the customer's phone numbers, their tags, or any version they
 * made. Egma used to pin a number riding `latest` for the length of a run and
 * put it back afterwards; that is gone (developer ruling, 2026-08-31). Retell's
 * own picker offers Latest Created and Latest Published beside real tags, tags
 * are movable, and an unassigned tag resolves to latest without saying so —
 * too many edges for egma to be editing somebody's inbound routing across them.
 *
 * So the hazard the pin covered is now **said** rather than acted on: a
 * temporary draft is the latest *created* version, and a number or tag pointing
 * at Latest Created reaches it while a mocked run is in flight. The mock-tools
 * screen says that where mocking is turned on, and the developer decides.
 *
 * ## The order, and why each step is where it is
 *
 * 1. **Sweep** — `finishMockedWorld` over what a previous run recorded. Run
 *    before anything new is made, so litter never becomes a hazard.
 * 2. **Bindings** — every number routing to the agent, read by
 *    `bindingDecisionsFor`. Re-read every run, because a customer can rebind
 *    between two of them, and read to choose the version this run tests.
 * 3. **Capture** — the serving version and the serving engine configuration,
 *    written down before anything is changed. The verify step compares against
 *    what is here rather than against what egma remembers sending.
 * 4. **Branch** — Retell forks the engine itself.
 * 5. **Fork guard** — the branch's engine reference must differ from the
 *    serving version's. A branch that still shares the serving engine version
 *    is refused **before the swap**, because writing mocked tools onto a shared
 *    engine version is writing them onto production.
 * 6. **Swap** — the transform's tools and routing defaults, onto the draft's
 *    engine version in one PATCH, naming that version explicitly, and Retell
 *    must answer that it wrote that version and no other.
 * 7. **The read-back guard** — read the draft's own engine back and refuse the
 *    run if any routing default is no longer exactly one space. Retell stores
 *    an empty default as absent, and an absent one leaves the braces literal —
 *    so a trimmed default is every unmocked tool call of the run failing on a
 *    URL that is not a URL, found here rather than mid-conversation.
 * 8. **Verify** — read the serving version's tools back and compare them to the
 *    capture. A difference means the swap landed somewhere it should not have;
 *    the capture is written back and the run fails loudly.
 * 9. **Teardown** — `finishMockedWorld` again: delete the copy, and **prove the
 *    delete**. The proof is a read of the agent's versions, because the
 *    delete's own answer cannot be one: a malformed delete and a version that
 *    was never there both answer 404.
 *
 * ## The record is an obligation, not a report
 *
 * `record` is called at every point where what egma owes the account changes,
 * and each call replaces the whole record. What is written is always the
 * **outstanding** obligation: a `tempMockAgentVersion` that is not null is a
 * version that must be deleted. The teardown flips the cleanup flag to true
 * only once the account owes nothing, and writes the note's proof of deletion
 * the moment it has one — so a sweep that comes later never deletes twice.
 *
 * That is also why the intent is written **before** the write it describes. A
 * crash between "egma says it will branch" and the branch itself leaves a
 * record of a debt that turns out not to exist, and a sweep answers that
 * harmlessly. The other order would leave a real draft nothing knows to delete.
 *
 * ## One mocked world per agent at a time
 *
 * **Two of these lifecycles may never overlap on one agent**, and the control
 * plane refuses the second run rather than queueing it (`claimMockDraftFor`,
 * under an advisory lock keyed on the agent).
 *
 * Two drafts at once on one agent is two runs each conducted against a version
 * the other could be deleting, and a sweep that cannot tell whose litter it is
 * looking at. The version numbers are the account's, not a run's: Retell hands
 * the next branch the lowest free number, so run one's number can be run two's
 * draft the moment run one deletes. Refusing the overlap is what keeps every
 * delete in this file a delete of something this run made.
 *
 * ## One draft per run, and what tells its calls apart
 *
 * A run is one suite against one agent over one connection, so its simulations
 * share one temporary version — and each of them mocks exactly the tools its
 * own test names, which are not the same tools. What tells them apart is not
 * the version and not the URL written on it: **every custom tool's URL carries
 * its own per-call variable**, and Egma decides per call, in the claim, which
 * of them point at Egma and which render to nothing and reach the customer's
 * own backend (ADR-0022).
 *
 * So this file writes one shape for everybody and never rewrites it: the
 * version is written once, before any call of the run exists, and is never
 * touched again while calls are in flight. That is what makes the undocumented
 * question — whether a running call re-reads its version — one this design
 * does not have to answer.
 */

import {
  mockedToolsFor,
  trimmedEgmaDefaults,
  type MockToolVariable,
} from "./mock-draft.ts";
import {
  bindingsFor,
  bindingVerdictOf,
  listRoutedNumbers,
  numbersRouting,
  type BindingVerdict,
  type NumberBinding,
  type RoutedNumber,
} from "./numbers.ts";
import { toolsOf } from "./tools.ts";
import type { RetellCredential, RetellFailure, RetellReach } from "./transport.ts";
import {
  branchAgentVersion,
  deleteAgentVersion,
  engineTypeOf,
  listAgentVersions,
  readEngineConfiguration,
  resolveServingAgentVersion,
  writeEngineTools,
  LATEST_PUBLISHED,
  type EngineConfiguration,
  type EngineReference,
  type VersionReference,
} from "./versions.ts";

/**
 * What one number routing to this agent is bound to.
 *
 * **A reading, never an instruction.** Egma writes to no customer's number
 * bindings (developer ruling, 2026-08-31), so nothing here says what egma will
 * do about a number — it says what the number names, which is how the version a
 * run tests is chosen and what a screen shows a developer so they can decide
 * for themselves.
 *
 * A number can carry several entries for one agent under weighted routing, so
 * every entry's verdict is kept.
 */
export type BindingDecision = {
  /** E.164, exactly as Retell holds it. */
  readonly number: string;
  /** What the customer calls it, or `""`. */
  readonly label: string;
  /** Every verdict this agent's entries on this number produced, in order. */
  readonly verdicts: readonly BindingVerdict[];
  /**
   * **This agent's** entries on the number, in order — the ones the verdicts
   * were read from. What runs against the number is decided from these, and
   * never from a sibling agent's binding: a number two agents share carries the
   * other agent's version too, and a version resolved out of it would be a
   * version nobody's traffic to this agent ever reaches.
   */
  readonly ownBindings: readonly NumberBinding[];
  /** Every binding the number carries, verbatim — other agents' included. */
  readonly bindings: readonly NumberBinding[];
};

/**
 * Every number routing to one agent, read.
 *
 * Read at tick time and again at every run start, and the same function does
 * both: a screen that explains what a mocked run would do and a run that is
 * about to do it must not be able to disagree about which version it lands on.
 */
export function bindingDecisionsFor(
  numbers: readonly RoutedNumber[],
  agentId: string,
): readonly BindingDecision[] {
  return numbersRouting(numbers, agentId).map((number) => {
    const mine = bindingsFor(number, agentId);
    return {
      number: number.number,
      label: number.label,
      verdicts: mine.map(bindingVerdictOf),
      ownBindings: mine,
      bindings: number.bindings,
    };
  });
}

/** The serving engine capture the verify step compares against. */
export type MockEngineNote = {
  readonly type: string;
  readonly engineId: string;
  readonly version: number | null;
  /**
   * The tools that engine declared when this run captured it, in the one
   * spelling a comparison uses (`toolPrint` below).
   *
   * Written down rather than kept in memory so that the comparison outlives
   * the process that made it: a teardown resumed by anybody else can still
   * read the serving version back and say whether it moved — one of the four
   * promises — instead of deleting the copy and hoping. A difference is
   * reported and never repaired: putting the tools back would need the
   * captured document, and this note holds what to put back, not a copy of the
   * customer's configuration.
   */
  readonly toolPrint?: string;
  /**
   * The version of **this same engine** that the run's temporary copy runs on,
   * read from the branch's own response.
   *
   * Kept so a teardown can name what it leaves behind. Never derived from the
   * agent version: the agent-to-flow lockstep at branch time is observed and
   * undocumented, and the only honest source is what Retell answered. Absent on
   * a note written before the branch, and on a run that never branched.
   */
  readonly draftVersion?: number;
};

/** The put-it-back note, and nothing else lives in it. */
export type MockMetadataRecord = {
  readonly engine: MockEngineNote;
  /**
   * Which per-call variable routes which tool on the temporary version.
   *
   * **Written down because the claim cannot work it out.** The claim passes
   * every one of these on every call it creates — the mock URL for a tool the
   * simulation's test names, the empty string for every other — and it knows
   * the test's tools but not the agent's. The map is the whole of what the
   * build learned about the agent that the claim needs, so it rides on the
   * run's own note rather than being read from Retell a second time.
   *
   * Absent on a note written by a run that branched nothing.
   */
  readonly urlVariables?: readonly MockToolVariable[];
  /**
   * Whether the temporary version has been deleted **and the deletion proved**.
   *
   * The one fact that must outlive the teardown that learned it. A teardown can
   * finish the delete and prove it against the version listing, and still leave
   * the world unsettled on something else — the serving version's own read-back
   * failing, say — which the next sweep retries. Without this, that sweep would
   * see a version number on the record and delete it a second time.
   *
   * **A second delete of the same number is not harmless.** Retell hands the
   * next branch the lowest free number, so the number this run branched can
   * belong to somebody else's draft by then. The version number itself stays on
   * the record, because a reader months later still deserves to know what a run
   * branched; this is what says it is no longer standing.
   *
   * Absent on a note written before the delete, and on one whose run never
   * branched anything.
   */
  readonly temporaryVersionGone?: boolean;
  /**
   * The conversation-flow version Retell keeps after the agent version is gone.
   *
   * **Deleting an agent version does not delete its lockstep flow version**
   * (verified live, 2026-08-31, against the developer's own dashboard): Retell
   * removes the agent version, keeps the flow version, and offers no API that
   * removes one — `delete-conversation-flow` takes the whole flow, and a
   * `?version` on it answers 400 "Unknown query parameter". The orphan is
   * invisible in every Retell screen and unroutable, because a binding can only
   * name a live agent version; but it exists over the API and it becomes that
   * flow's `latest`.
   *
   * So it is written down rather than pretended away. This is the one thing a
   * mocked run leaves on a customer's account, and a reader asking what Egma
   * left deserves the number rather than silence. Recorded only once the delete
   * of the agent version is **proved**, because until then nothing is orphaned.
   */
  readonly strayFlowVersion?: number;
};

/**
 * What one run has put onto a Retell account, in the shape the record stores.
 *
 * Structurally the platform-neutral state the control plane writes onto a run.
 * It is spelled again here rather than imported because this package knows
 * Retell and nothing about a database — and a test in the control plane holds
 * the two shapes to each other, so they cannot drift.
 */
export type MockRunRecord = {
  /** The temporary copy that exists right now, or null when none does. */
  readonly tempMockAgentVersion: number | null;
  /** Null = no copy was made; false = cleanup owed; true = account put back. */
  readonly tempMockAgentVersionCleanup: boolean | null;
  readonly mockMetadata: MockMetadataRecord | null;
};

/** How the caller is told what egma currently owes the account. */
export type RecordMockRun = (state: MockRunRecord) => Promise<void>;

/**
 * Which version a run over this agent should be testing.
 *
 * The one a real caller reaches: the first of **this agent's own** bindings on
 * a routed number that names a version — a number or a tag. A number riding
 * `latest` names none, so it is passed over here and answered by `latest`
 * below, which is the same thing it resolves to.
 *
 * **Only this agent's entries are read**, never the whole array. A number two
 * agents share carries the other agent's version too, and resolving out of it
 * would branch, capture, verify and report a version nobody's traffic to this
 * agent reaches — while the tick, which resolves the same way, would read the
 * wrong version's tools.
 *
 * **`latest_published` where no binding names a version** — an agent with no
 * number at all, which is the ordinary case for a chat agent, and an agent
 * every number of which rides `latest`.
 *
 * It used to be `latest`, and that one word is half of the defect this design
 * was rebuilt around — the teardown that deleted nothing is the other half, and
 * neither is dangerous without the other. `latest` is Retell's word for the newest
 * version *created*, drafts included; every mocked run mints a draft; and a
 * teardown that deleted nothing left each run's draft standing. So each run
 * resolved `latest` onto the previous run's leftover and conducted the suite
 * against egma's own mocks instead of against the customer's agent. The
 * teardown is fixed beside this, but the reference is the part that must never
 * have depended on the teardown being right: `latest_published` cannot select a
 * draft even when one exists, because nothing in this package publishes
 * anything.
 *
 * It is also the closer reading of the question. What a run wants is the
 * version real callers reach, and a number riding `latest` is a deploy habit
 * rather than an intent to serve a draft. An agent whose traffic really is
 * pinned to an older published version — an environment tag, a bound number —
 * is answered above, by its own binding, and a run may always name a version
 * outright.
 */
export function versionReferenceIn(
  decisions: readonly BindingDecision[],
): VersionReference {
  for (const decision of decisions) {
    for (const binding of decision.ownBindings) {
      if (typeof binding.agentVersion === "number") return binding.agentVersion;
      if (
        typeof binding.agentVersion === "string" &&
        bindingVerdictOf(binding) === "environment-tag"
      ) {
        return binding.agentVersion;
      }
    }
  }
  return LATEST_PUBLISHED;
}

export type MockedWorldBuild = {
  readonly agentId: string;
  /**
   * Which version the run tests: a number, an environment tag, or `latest`.
   * Whatever it is, it is resolved once and every later step names the number
   * it resolved to — so a tag reassigned mid-run cannot move what is running.
   *
   * Absent means "whatever a real caller reaches", worked out from the numbers
   * by `versionReferenceIn` above.
   */
  readonly versionReference?: VersionReference | undefined;
  readonly record: RecordMockRun;
};

export type BuiltMockedWorld =
  | {
      readonly kind: "built";
      readonly state: MockRunRecord;
      /** The serving version every request of this run names. */
      readonly agentVersion: number;
      /** Which variable routes which tool on the copy this run just wrote. */
      readonly urlVariables: readonly MockToolVariable[];
    }
  /**
   * The world could not be built. `state` is what egma owes the account and is
   * null only when nothing was touched at all; the caller tears it down and
   * fails the run. There is no third answer: a mockable run that cannot build
   * its world never falls back to the real tools.
   */
  | {
      readonly kind: "refused";
      readonly reason: string;
      readonly state: MockRunRecord | null;
    };

/** What a teardown or a sweep could not finish. */
export type FinishedMockedWorld = {
  /** What is still owed. Nothing is owed once the cleanup flag stands true. */
  readonly state: MockRunRecord;
  /** Each step that did not land, in the words a log should carry. */
  readonly unfinished: readonly string[];
};

/** The sentence a failure of any verb is reported as. */
function sentenceOf(failure: RetellFailure, doing: string): string {
  if (failure.kind === "invalid-key") {
    return `Retell would not take this agent's stored key while ${doing}.`;
  }
  if (failure.kind === "gone") {
    return `Retell no longer holds what Egma named while ${doing}.`;
  }
  return `${failure.reason} (while ${doing})`;
}

/**
 * One value, in the one spelling two of them are compared in.
 *
 * Object keys are sorted, arrays are not: the customer's configuration is the
 * values and their order in each array, and the order Retell happens to
 * serialize an object's keys in is the serializer's business. A run that failed
 * because a provider reordered two keys would be a loud failure about nothing,
 * every time.
 *
 * Exported so a proof that reads the account can compare two readings the same
 * way the builder does — a live suite that used `JSON.stringify` instead would
 * cry "changed" the first time Retell reordered a key.
 */
export function canonicalJson(value: unknown): string {
  return canonical(value);
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonical).join(",")}]`;
  }
  if (typeof value === "object" && value !== null) {
    const held = value as Record<string, unknown>;
    return `{${Object.keys(held)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(held[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** Every tool an engine declares, in the one spelling a comparison uses. */
function toolPrint(engine: EngineConfiguration): string {
  return canonical(toolsOf(engine).map((tool) => tool.verbatim));
}

function stateOf(
  tempMockAgentVersion: number | null,
  engine: EngineReference,
  /** What that engine declared when this run captured it. */
  capturedPrint: string,
  /** Which variable routes which tool on the copy this run is writing. */
  urlVariables: readonly MockToolVariable[],
  /** The branch's own version of that engine, once there is a branch. */
  draftVersion?: number,
): MockRunRecord {
  return {
    tempMockAgentVersion,
    // False from the first record to the last: a cleanup is owed from the
    // moment anything has been read for this run until the moment the account
    // is back as it was found.
    tempMockAgentVersionCleanup: false,
    mockMetadata: {
      engine: {
        type: engine.type,
        engineId: engine.engineId,
        version: engine.version,
        toolPrint: capturedPrint,
        ...(draftVersion === undefined ? {} : { draftVersion }),
      },
      // Written from the first record, beside the debt it belongs to: it is
      // what Egma is about to put on the copy, and a crash between here and
      // the write leaves a note about a copy that turns out not to exist,
      // which a sweep answers harmlessly.
      ...(urlVariables.length === 0 ? {} : { urlVariables }),
    },
  };
}

/**
 * Build the run's temporary world, or refuse and say why.
 *
 * Every step below is ordered, and the comments say what each order buys. The
 * caller's only job on a refusal is to tear the world down and fail the run:
 * there is no arrangement of these failures under which conducting a simulation
 * would be honest, because the tools would be the customer's real ones and the
 * record would say otherwise.
 */
export async function buildMockedWorld(
  key: RetellCredential,
  build: MockedWorldBuild,
  reach: RetellReach = {},
): Promise<BuiltMockedWorld> {
  const { agentId, record } = build;

  // 2. Verdicts. Every number routing to this agent, read whole and judged —
  // and read before anything is captured, because a number that appears here
  // is a number the capture has to carry.
  const listed = await listRoutedNumbers(key, reach);
  if (listed.kind !== "numbers") {
    return {
      kind: "refused",
      reason: sentenceOf(listed, "reading the account's phone numbers"),
      state: null,
    };
  }
  const decisions = bindingDecisionsFor(listed.numbers, agentId);

  // 3a. The serving version, resolved once. Everything after this names the
  // number rather than the reference, so a tag reassigned mid-run — or a draft
  // minted by anybody — moves nothing.
  //
  // The reference defaults to `latest_published`, and an agent that has
  // published nothing is refused here rather than conducted against a draft.
  const serving = await resolveServingAgentVersion(
    key,
    agentId,
    build.versionReference ?? versionReferenceIn(decisions),
    reach,
  );
  if (serving.kind === "none-published") {
    return { kind: "refused", reason: serving.reason, state: null };
  }
  if (serving.kind !== "version") {
    return {
      kind: "refused",
      reason: sentenceOf(serving, "resolving the version this agent serves"),
      state: null,
    };
  }
  const servingVersion = serving.agentVersion.version;
  const servingEngine = serving.agentVersion.engine;

  // The serving engine must name a version, and this is refused **before the
  // capture read**, because everything downstream turns on a null one going
  // wrong. `readEngineConfiguration` sends no `?version=` for a null version,
  // which means "Retell's newest" — so the capture would read the newest engine
  // rather than the one this version serves, the verify re-read would land on
  // the copy egma just mocked (a false hijack alarm), and the repair would
  // PATCH the capture onto `servingVersion` used as an engine version, writing
  // real tools onto a version egma never read. One guard here forecloses all
  // three. The copy's side already refuses its own null version below; this is
  // the serving side's matching guard.
  //
  // A custom LLM is exempt and falls through to the capture read below, which
  // answers `not-held` with its own reason: it carries no engine version by
  // nature — its brain and tools live in the customer's own service — and a
  // "name a version" refusal would be the wrong sentence for it.
  if (servingEngine.type !== "custom-llm" && servingEngine.version === null) {
    return {
      kind: "refused",
      reason:
        `The version this agent serves (${servingVersion}) names no response ` +
        "engine version, and Egma never reads or writes an unnamed one: the " +
        "default is Retell's newest, which is not necessarily the one this " +
        "agent serves. Egma stopped before reading or changing anything.",
      state: null,
    };
  }

  // 3b. The serving engine configuration, verbatim. This is both what the
  // copy is built from and what the verification compares against, and it is
  // read once so those two can never be readings of different things.
  const captured = await readEngineConfiguration(key, servingEngine, reach);
  if (captured.kind === "not-held") {
    return { kind: "refused", reason: captured.reason, state: null };
  }
  if (captured.kind !== "engine") {
    return {
      kind: "refused",
      reason: sentenceOf(captured, "reading this agent's tools"),
      state: null,
    };
  }
  // The capture read succeeded, so this is a hosted engine, and the guard above
  // refused a hosted engine with a null version. So the version is present, and
  // the repair below can name it without the agent-version fallback that once
  // corrupted a version egma never read.
  const servingEngineVersion = servingEngine.version;
  if (servingEngineVersion === null) {
    throw new Error(
      "a readable Retell engine configuration reported no version, which the " +
        "serving-version guard should already have refused",
    );
  }
  const before = toolPrint(captured.engine);
  // The transform runs once, here, and every part of its answer is used: the
  // tools and the routing defaults go onto the copy below, and the variable map
  // goes onto the record so the claim can pass every variable. Running it twice
  // would be two chances to read one configuration and write another.
  const mocked = mockedToolsFor(captured.engine);
  // **Refused before anything is written**, and this is why the transform is
  // run before the first record rather than after the branch: two tools that
  // would share one routing variable, or a variable the customer already
  // fills, is a tool call that lands somewhere nobody chose — and nothing has
  // been made yet, so there is nothing to give back.
  if (mocked.kind === "refused") {
    return { kind: "refused", reason: mocked.reason, state: null };
  }
  const { variables } = mocked;

  // 3c. Written down before a single write goes out. The record is an
  // obligation, and from this line on egma owes the account a deletion.
  let state = stateOf(null, servingEngine, before, variables);
  await record(state);

  // 4. Branch. Retell forks the engine document itself, which is why this is a
  // branch and not a hand-copied twin.
  const branched = await branchAgentVersion(key, agentId, servingVersion, reach);
  if (branched.kind !== "branched") {
    return {
      kind: "refused",
      reason: sentenceOf(
        branched,
        `branching a temporary version from version ${servingVersion}`,
      ),
      state,
    };
  }
  const draft = branched.agentVersion;
  state = stateOf(
    draft.version,
    servingEngine,
    before,
    variables,
    // Read from the branch's own response, never derived. It is what the
    // teardown names as the flow version Retell keeps behind.
    draft.engine.version ?? undefined,
  );
  await record(state);

  // 5. **The fork guard**, before any write.
  //
  // Whether branching an agent forks a Retell LLM the way it provably forks a
  // conversation flow is not assumed anywhere in this file. If the copy still
  // points at the serving version's engine document *at the same version*,
  // then writing the mocked tools onto it would be writing them onto the
  // configuration the customer's real callers are served from. So nothing is
  // written, and the run is failed with the reason.
  if (
    draft.engine.engineId === servingEngine.engineId &&
    draft.engine.version === servingEngine.version
  ) {
    return {
      kind: "refused",
      reason:
        `Retell branched version ${draft.version} from version ` +
        `${servingVersion}, but the new version still points at the same ` +
        `response engine version (${draft.engine.type} ` +
        `${draft.engine.engineId} v${String(draft.engine.version)}). Writing ` +
        "the mocked tools onto it would change the version this agent serves, " +
        "so Egma wrote nothing and stopped.",
      state,
    };
  }
  if (draft.engine.version === null) {
    return {
      kind: "refused",
      reason:
        `Retell branched version ${draft.version} without naming a response ` +
        "engine version, and Egma never writes to an unnamed version: the " +
        "default is the latest one, which after a branch is somebody's copy.",
      state,
    };
  }

  // 6. Swap, naming the target version explicitly. The transform is a pure
  // function of the captured configuration, so what is written is what was
  // read with one prefix grown on each intercepted tool's URL — and the
  // routing defaults beside them, in the same PATCH, because a version whose
  // tools name a variable it has no default for is a call with nowhere to go.
  const written = await writeEngineTools(
    key,
    {
      reference: draft.engine,
      version: draft.engine.version,
      tools: mocked.tools,
      defaults: mocked.defaults,
    },
    reach,
  );
  if (written.kind !== "written") {
    return {
      kind: "refused",
      reason: sentenceOf(
        written,
        `writing the mocked tools onto version ${draft.version}`,
      ),
      state,
    };
  }

  // 6b. **The write landed on the version it named, and minted nothing.**
  //
  // Retell's reference says nothing about whether a PATCH edits the named
  // version in place or forks a new one, and only the version it answers with
  // tells the truth per call. That is not a detail: there is no
  // delete-conversation-flow-version anywhere in Retell's API, so an engine
  // version minted here could never be removed — the account would keep it
  // after the run's own version was deleted and proved gone, and no teardown
  // could ever say the panel was as it was found.
  //
  // So the accident fails the run here rather than surviving it. The caller
  // tears the world down, which deletes the agent version this branched; if a
  // stray engine version really was minted, the run's failure is what makes a
  // person look at it while it is still one version rather than a hundred.
  //
  // A **null** answer is refused with the rest. Retell's schema documents the
  // field, so an answer without it is Retell contradicting itself, and the one
  // reading of that contradiction egma may not take is the optimistic one:
  // there is no endpoint that removes a stray engine version, so "probably
  // fine" would be litter nobody can clear.
  if (written.version !== draft.engine.version) {
    return {
      kind: "refused",
      reason:
        `Egma wrote the mocked tools onto ${draft.engine.type} ` +
        `${draft.engine.engineId} v${String(draft.engine.version)}, and Retell ` +
        (written.version === null
          ? "did not say which version it wrote. Egma cannot tell an edit of " +
            "the copy from a new engine version, and Retell has no endpoint " +
            "that deletes one"
          : `answered that it wrote v${String(written.version)} instead. That ` +
            "is a new engine version rather than an edit of the copy, and " +
            "Retell has no endpoint that deletes one") +
        " — so Egma stopped rather than leave behind something nothing can " +
        "clean up.",
      state,
    };
  }

  // 6c. **The read-back guard.** The routing defaults are read off the copy
  // Retell now holds, not off the request Egma sent.
  //
  // Everything turns on each of them being exactly one space. Retell stores an
  // empty default as *absent*, and an absent variable renders as the literal
  // `{{egma_url_book}}` — so a default that was trimmed on the way in makes
  // every call this run does **not** mock fail on a URL that is not a URL,
  // silently, one conversation at a time. The whole run is refused here
  // instead, before a single simulation is conducted. Skipped where there is
  // nothing to route: an agent with no custom tool wrote no defaults.
  if (variables.length > 0) {
    const readBack = await readEngineConfiguration(key, draft.engine, reach);
    if (readBack.kind === "not-held") {
      return { kind: "refused", reason: readBack.reason, state };
    }
    if (readBack.kind !== "engine") {
      return {
        kind: "refused",
        reason: sentenceOf(
          readBack,
          `reading version ${draft.version} back to prove its routing ` +
            "variables were stored as Egma wrote them",
        ),
        state,
      };
    }
    const trimmed = trimmedEgmaDefaults(readBack.engine, variables);
    if (trimmed.length > 0) {
      return {
        kind: "refused",
        reason:
          `Egma wrote ${String(variables.length)} routing variables onto the ` +
          `temporary version, each defaulted to a single space, and Retell ` +
          `read ${String(trimmed.length)} of them back as something else ` +
          `(${trimmed.join(", ")}). A routing default that is not exactly one ` +
          "space is a tool call with nowhere to go on every test that does " +
          "not mock it, so Egma failed the run rather than conduct it.",
        state,
      };
    }
  }

  // 7. Verify. The one check that answers the question a developer actually
  // asks — "is my live agent still exactly as it was?" — by reading the engine
  // the note captured rather than by trusting the request that was just sent.
  const after = await readEngineConfiguration(key, servingEngine, reach);
  if (after.kind === "not-held") {
    return { kind: "refused", reason: after.reason, state };
  }
  if (after.kind !== "engine") {
    return {
      kind: "refused",
      reason: sentenceOf(
        after,
        "reading the serving version back to prove it did not move",
      ),
      state,
    };
  }
  if (toolPrint(after.engine) !== before) {
    // Loud, and repaired: the capture goes back onto the serving version
    // before the run is failed, because a serving version that has been
    // changed is the one failure this whole design exists to prevent.
    const repaired = await writeEngineTools(
      key,
      {
        // The serving engine version, never the agent version standing in for
        // it: the two are different numbers, and the guard above has already
        // refused a null one, so this is always the version the capture was
        // read at.
        reference: servingEngine,
        version: servingEngineVersion,
        tools: toolsWriteOf(captured.engine),
      },
      reach,
    );
    return {
      kind: "refused",
      reason:
        `The version this agent serves (${servingVersion}) changed while Egma ` +
        "was building the mocked world. Egma wrote the configuration it " +
        (repaired.kind === "written"
          ? "captured before it started back onto it"
          : "captured before it started back onto it and that write failed too") +
        ", and failed the run rather than conducting a simulation against a " +
        "version it can no longer vouch for.",
      state,
    };
  }

  return {
    kind: "built",
    state,
    agentVersion: servingVersion,
    urlVariables: variables,
  };
}

/**
 * The captured tools, in the shape a write of them takes.
 *
 * The transform's own body shape with nothing swapped: the same keys, so a
 * repair puts back exactly the arrays the capture holds and touches no other
 * field of the version.
 */
function toolsWriteOf(
  engine: EngineConfiguration,
): Readonly<Record<string, unknown>> {
  const { document } = engine;
  if (engine.reference.type === "conversation-flow") {
    return Array.isArray(document["tools"]) ? { tools: document["tools"] } : {};
  }
  const write: Record<string, unknown> = {};
  if (Array.isArray(document["general_tools"])) {
    write["general_tools"] = document["general_tools"];
  }
  if (Array.isArray(document["states"])) write["states"] = document["states"];
  return write;
}

/**
 * Put the account back: **delete the copy, and prove it.**
 *
 * One function, two callers. A run's own teardown calls it when every
 * simulation is terminal; the next run's claim calls it over whatever a crashed
 * run left recorded. They are the same act, and writing them twice would be two
 * chances to get the order wrong.
 *
 * There is one thing to give back, because there is one thing egma made: the
 * temporary version. Nothing here writes to a number, a tag, or a version the
 * customer made, so a failure leaves exactly one thing outstanding and the next
 * sweep retries exactly that.
 *
 * **The delete is proved and never assumed.** A 404 to egma's own delete is not
 * evidence the version is gone — a request Retell has no route for answers the
 * same way, which is exactly how a teardown that deleted nothing reported an
 * account put back for a week. So the agent's versions are read back, from the
 * current listing endpoint, and "gone" counts only when that read agrees.
 *
 * Each landing is recorded as it happens, so a crash halfway through leaves a
 * record of exactly what is still owed rather than a record of what was owed
 * when it started.
 */
export async function finishMockedWorld(
  key: RetellCredential,
  input: {
    readonly agentId: string;
    readonly state: MockRunRecord;
    readonly record: RecordMockRun;
  },
  reach: RetellReach = {},
): Promise<FinishedMockedWorld> {
  const unfinished: string[] = [];
  let state = input.state;
  /**
   * Whether **this call** is the one that proved the delete.
   *
   * Apart from `alreadyGone` below, which says a previous call proved it. The
   * two are what keep a repeat sweep from writing a record that changes
   * nothing — see the record at the foot of this function.
   */
  let provedNow = false;

  // **The promise, proved again before anything is undone.** A run's own build
  // read the serving version back and compared it to the capture, but that
  // comparison lived in the process that made it — so a teardown that somebody
  // else resumed, days later, could delete the copy and say the account was
  // back without ever having looked at the version real callers are served
  // from. The note carries the comparison value for exactly this, and the read
  // is here — **before the delete** — so what it reads is the account as this
  // run left it.
  //
  // A difference is reported and never repaired. Repairing would mean writing
  // the captured tools back, and the note holds what the tools *looked like*,
  // not the document they came from; a repair out of a print would be a guess
  // at the customer's own configuration. So the sentence says what stands
  // there now, and the world stays unsettled — which is what keeps a resumed
  // teardown's answer honest and stops the next run branching over it.
  const captured = state.mockMetadata?.engine;
  if (captured?.toolPrint !== undefined) {
    const serving = await readEngineConfiguration(
      key,
      {
        type: engineTypeOf(captured.type),
        engineId: captured.engineId,
        version: captured.version,
      },
      reach,
    );
    const naming =
      `${captured.type} ${captured.engineId} v${String(captured.version)}`;
    if (serving.kind === "engine" && toolPrint(serving.engine) !== captured.toolPrint) {
      const names = toolsOf(serving.engine).map((tool) => tool.name);
      unfinished.push(
        `the version this agent serves no longer declares the tools Egma ` +
          `captured before the run (${naming}); it declares ` +
          `${String(names.length)} now: ${names.join(", ")}. Egma changed ` +
          "nothing back — the note says what the tools looked like, not what " +
          "the document held, so a repair would be a guess.",
      );
    } else if (serving.kind === "not-held") {
      unfinished.push(
        `${naming} could not be read back to prove the version this agent ` +
          `serves never moved: ${serving.reason}`,
      );
    } else if (serving.kind !== "engine") {
      unfinished.push(
        sentenceOf(
          serving,
          `reading ${naming} back to prove the version this agent serves ` +
            "never moved",
        ),
      );
    }
  }

  // **A delete already proved is never made twice.** A teardown can finish the
  // delete, prove it against the version listing, and still leave the world
  // unsettled on something after it — and the next sweep retries the whole of
  // this function. Retell hands the next branch the lowest free number, so by
  // then this run's number can belong to somebody else's draft. The note is
  // what carries the proof across those two calls.
  const alreadyGone = state.mockMetadata?.temporaryVersionGone === true;

  if (state.tempMockAgentVersion !== null && !alreadyGone) {
    const temporary = state.tempMockAgentVersion;
    const deleted = await deleteAgentVersion(
      key,
      input.agentId,
      temporary,
      reach,
    );
    if (deleted.kind !== "deleted" && deleted.kind !== "gone") {
      unfinished.push(
        sentenceOf(deleted, `deleting temporary version ${temporary}`),
      );
      // Nothing below this line runs: the copy is still there, and the record
      // must keep saying so.
      return { state, unfinished };
    }

    // **The proof, and the reason this whole function stopped trusting a status
    // code.** Egma sent the delete with the version as a path segment for a
    // week. Retell has no such route, answered 404, and 404 maps to `gone` —
    // "the thing you named is not there" — so every teardown reported the
    // account put back while every draft survived, and the next run resolved
    // one of them. A malformed request and a version that was never there are
    // the same three digits; only a second, different read tells them apart.
    //
    // So the versions are read back, and the account is recorded as put back
    // only when that read agrees. Everything that is not agreement — the read
    // failing, the read being unable to say, the version still standing — is
    // reported as still owed. That is deliberately the expensive direction: an
    // unsettled world blocks the next mocked run of this agent, and a world
    // wrongly called settled is a customer's version panel filling with egma's
    // litter and a suite quietly grading the wrong agent.
    const listed = await listAgentVersions(key, input.agentId, reach);
    if (listed.kind === "gone") {
      unfinished.push(
        `Retell answered 404 when Egma read agent ${input.agentId}'s versions ` +
          `back to prove temporary version ${temporary} is gone. That is not ` +
          "proof: a request Retell has no route for answers exactly the same " +
          "way. Egma left the account as it stands and says so.",
      );
      return { state, unfinished };
    }
    if (listed.kind !== "versions") {
      unfinished.push(
        sentenceOf(
          listed,
          `reading agent ${input.agentId}'s versions back to prove temporary ` +
            `version ${temporary} is gone`,
        ),
      );
      return { state, unfinished };
    }
    if (listed.versions.some((one) => one.version === temporary)) {
      unfinished.push(
        `Retell accepted the delete of temporary version ${temporary} and its ` +
          "versions still hold it, so the account is not back as Egma found " +
          "it and Egma will not say that it is.",
      );
      return { state, unfinished };
    }
    // **Proven absent, and written down before anything else can fail.** The
    // version number stays on the record — it is what this run branched, and a
    // reader asking months later still deserves the answer — and this flag is
    // what says it is no longer standing. Set here rather than at the end
    // because everything below can fail, and a delete proved is a delete that
    // must never be attempted again whatever happens next.
    //
    // **And what Retell keeps.** The agent version is gone; its conversation
    // flow version is not, and no Retell endpoint removes one. Nothing can
    // route to it — a binding names a live agent version, and there is none —
    // so it is residue rather than a hazard, and it is written down rather
    // than pretended away.
    const metadata = state.mockMetadata;
    if (metadata !== null) {
      const stray = metadata.engine.draftVersion;
      state = {
        ...state,
        mockMetadata: {
          ...metadata,
          temporaryVersionGone: true,
          ...(stray === undefined ? {} : { strayFlowVersion: stray }),
        },
      };
      provedNow = true;
    }
  }

  if (unfinished.length > 0) {
    // **Recorded only where what egma owes actually moved.** The one thing that
    // can move on this path is the delete being proved, and it moves once — so
    // a later sweep that reads the flag already stored writes nothing. That is
    // not tidiness: a finished run's header admits a write only where the note
    // or the cleanup flag changed, and a write that changes neither is rejected
    // by the store. The rejection would then stand in for the real failure and
    // a reader would be told about a database error instead of about the
    // account.
    if (provedNow) await input.record(state);
    return { state, unfinished };
  }

  // Nothing left: the copy is gone and proved gone, and the account is as it
  // was found. Egma never touched the customer's number bindings, so there is
  // nothing else it could owe.
  state = { ...state, tempMockAgentVersionCleanup: true };
  await input.record(state);
  return { state, unfinished };
}

/** A record that owes the account nothing, and can be forgotten. */
export function mockRunIsSettled(state: MockRunRecord): boolean {
  return state.tempMockAgentVersionCleanup !== false;
}
