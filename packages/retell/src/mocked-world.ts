/**
 * The temporary world one run builds on a Retell account, and unbuilds.
 *
 * Everything here is the **order** — the part that cannot be got wrong twice.
 * The verbs it is written out of are the ones beside it: number reads and
 * binding writes in `numbers.ts`, version reads and writes in `versions.ts`,
 * the pure transform in `mock-draft.ts`. Nothing new reaches Retell from here;
 * what is new is the sequence, the guards between its steps, and the record it
 * leaves behind so that somebody else can finish what a crashed run started.
 *
 * ## The order, and why each step is where it is
 *
 * 1. **Sweep** — `finishMockedWorld` over what a previous run recorded, deletes
 *    before restores. Run before anything new is made, so litter never becomes
 *    a hazard.
 * 2. **Verdicts** — every number routing to the agent, judged by
 *    `bindingVerdictOf`. Re-read every run, because a customer can rebind
 *    between two of them.
 * 3. **Capture** — the serving version, the serving engine configuration, and
 *    every touched number's bindings **verbatim**, written down before
 *    anything is changed. A teardown restores what is here rather than
 *    rebuilding it out of the two fields egma happened to read.
 * 4. **Branch** — Retell forks the engine itself.
 * 5. **Fork guard** — the branch's engine reference must differ from the
 *    serving version's. A branch that still shares the serving engine version
 *    is refused **before the swap**, because writing mocked tools onto a shared
 *    engine version is writing them onto production.
 * 6. **Swap** — the transform's tools, onto the draft's engine version, naming
 *    that version explicitly.
 * 7. **Verify** — read the serving version's tools back and compare them to the
 *    capture. A difference means the swap landed somewhere it should not have;
 *    the capture is written back and the run fails loudly.
 * 8. **Teardown** — `finishMockedWorld` again: **delete the copy first, prove
 *    the delete, then restore any pin**, and **never restore blind** — a
 *    restore reads where the number points now and writes only where it still
 *    points at what this run pinned it to. The reverse order is lethal:
 *    restoring `latest` while the copy exists makes the copy *be* latest. The
 *    proof is a read of the agent's versions, because the delete's own answer
 *    cannot be one: a malformed delete and a version that was never there both
 *    answer 404.
 *
 * ## The record is an obligation, not a report
 *
 * `record` is called at every point where what egma owes the account changes,
 * and each call replaces the whole record. What is written is always the
 * **outstanding** obligation: a `tempMockAgentVersion` that is not null is a
 * version that must be deleted, and a number in the note is a binding that must
 * be put back. Teardown clears each one as it lands, and flips the cleanup flag
 * to true only once the account owes nothing.
 *
 * That is also why an intent is written **before** the write it describes. A
 * crash between "egma says it pinned this number" and the pin itself leaves a
 * restore that writes the bindings back exactly as they already are — a no-op.
 * The other order would leave a real pin that nothing knows to undo.
 *
 * ## One mocked world per agent at a time
 *
 * **Two of these lifecycles may never overlap on one agent**, and the control
 * plane refuses the second run rather than queueing it (`claimMockDraftFor`,
 * under an advisory lock keyed on the agent).
 *
 * The reason is this teardown. Delete-before-restore protects a run from **its
 * own** draft and can see no other. Let run one pin a number riding `latest` to
 * numeric version V and record the verbatim `latest` it owes back. Run two then
 * starts, reads that number as *numeric* — a safe verdict, no pin needed — and
 * branches its own draft. Run one finishes, deletes its draft, and restores
 * `latest` exactly as promised. But run two's draft still exists and, being the
 * most recently minted version, is what `latest` now resolves to: every real
 * caller reaches a mocked agent. The restore was correct and the outcome is the
 * exact hijack this whole design exists to prevent.
 *
 * No ordering inside one lifecycle can fix that, because the hazard is a
 * relationship between two of them. So the overlap is what is forbidden, and
 * the run that arrives second is refused before it writes anything.
 *
 * The sweep is the one thing that still crosses runs, and deliberately: it
 * settles only worlds whose runs have **finished or died**, and it runs before
 * the sweeping run branches — so a restore it performs can never resolve
 * `latest` onto a draft that does not exist yet.
 *
 * ## One draft per run, and the fallback if that ever stops being true
 *
 * A run is one suite against one agent over one connection, so its simulations
 * share one temporary version and the run's frozen snapshot is the one world
 * they all see. What tells them apart is the URL: the transform writes
 * `{{egma_simulation}}` into the path, and Retell renders it per call from the
 * variables call creation was given.
 *
 * **The one empirical check left is the developer's**, and it is that same
 * rendering on a live *voice* call. Per-call rendering into a custom-function
 * URL is proven on a real agent in text mode (2026-08-27); the response engine
 * is what renders, so voice is expected to be identical, and a mock request
 * arriving at the simulation-id path during the live proof is the whole of the
 * evidence needed.
 *
 * **If it ever says no, the fallback costs this file nothing.** Write the
 * simulation's identifier into the URL at transform time rather than as a
 * variable, and branch one draft per simulation instead of one per run. Every
 * step above keeps its exact shape and its exact order — capture, branch, fork
 * guard, swap, verify, delete-before-restore — with `buildMockedWorld` called
 * once per simulation instead of once per run, and the record growing a list of
 * temporary versions where it holds one. It is written down here rather than
 * built, because building it would be paying for a branch nobody expects to
 * take.
 */

import {
  mockedToolsFor,
  type MockEndpointTarget,
} from "./mock-draft.ts";
import {
  bindingsFor,
  bindingVerdictOf,
  listRoutedNumbers,
  numbersRouting,
  pinNumberBinding,
  restoreNumberBinding,
  type BindingVerdict,
  type NumberBinding,
  type RoutedNumber,
} from "./numbers.ts";
import { toolsOf, type ToolCoverage } from "./tools.ts";
import type { RetellCredential, RetellFailure, RetellReach } from "./transport.ts";
import {
  branchAgentVersion,
  deleteAgentVersion,
  engineTypeOf,
  listAgentVersions,
  readEngineConfiguration,
  resolveAgentVersion,
  resolveServingAgentVersion,
  writeEngineTools,
  LATEST_PUBLISHED,
  type EngineConfiguration,
  type EngineReference,
  type VersionReference,
} from "./versions.ts";

/**
 * What one number means for a run that is about to mint a version, and what
 * egma will do about it.
 *
 * A number can carry several entries for one agent under weighted routing, so
 * every entry's verdict is kept and the decision is taken over all of them: one
 * hijackable entry is enough to need a pin, because one entry is enough to send
 * a real caller to the draft.
 */
export type BindingDecision = {
  /** E.164, exactly as Retell holds it. */
  readonly number: string;
  /** What the customer calls it, or `""`. */
  readonly label: string;
  /** Every verdict this agent's entries on this number produced, in order. */
  readonly verdicts: readonly BindingVerdict[];
  /** Whether egma must pin this number for the run and restore it after. */
  readonly pin: boolean;
  /**
   * **This agent's** entries on the number, in order — the ones the verdicts
   * were read from. What runs against the number is decided from these, and
   * never from a sibling agent's binding: a number two agents share carries the
   * other agent's version too, and a version resolved out of it would be a
   * version nobody's traffic to this agent ever reaches.
   */
  readonly ownBindings: readonly NumberBinding[];
  /**
   * Every binding the number carries, verbatim — **other agents' included**.
   * This is the whole array a restore writes back, so it must never lose an
   * entry; the reading of *this* agent's version is `ownBindings` above.
   */
  readonly bindings: readonly NumberBinding[];
};

/**
 * Every number routing to one agent, judged.
 *
 * Read at tick time and again at every run start, and the same function does
 * both: a screen that explains what ticking will do and a run that is about to
 * do it must not be able to disagree about which numbers need a pin.
 */
export function bindingDecisionsFor(
  numbers: readonly RoutedNumber[],
  agentId: string,
): readonly BindingDecision[] {
  return numbersRouting(numbers, agentId).map((number) => {
    const mine = bindingsFor(number, agentId);
    const verdicts = mine.map(bindingVerdictOf);
    return {
      number: number.number,
      label: number.label,
      verdicts,
      pin: verdicts.includes("hijackable"),
      ownBindings: mine,
      bindings: number.bindings,
    };
  });
}

/** One number Egma pinned, and everything it takes to put it back. */
export type MockNumberNote = {
  readonly number: string;
  /**
   * Where this agent's binding pointed before Egma touched it, verbatim.
   *
   * Under weighted routing an agent can carry several entries on one number,
   * and only the hijackable ones are pinned — `latest` or unset by definition
   * of the verdict — so one value puts every one of them back.
   */
  readonly was: string | number | null;
  /** The numeric version Egma pinned it to for the length of the run. */
  readonly pinnedTo: number;
};

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
};

/** The put-it-back note, and nothing else lives in it. */
export type MockMetadataRecord = {
  readonly engine: MockEngineNote;
  readonly numbers: readonly MockNumberNote[];
  /**
   * Whether the temporary version has been deleted **and the deletion proved**.
   *
   * The one fact that must outlive the teardown that learned it. A teardown can
   * finish the delete, prove it against the version listing, and then fail a
   * restore — which leaves the world unsettled and the next sweep retrying it.
   * Without this, that sweep would see a version number on the record and
   * delete it again.
   *
   * **A second delete of the same number is not harmless.** Retell hands the
   * next branch the lowest free number, so the number this run branched can
   * belong to somebody else's draft by then — the customer's own, made in the
   * window while Egma still owed a restore. The version number itself stays on
   * the record, because a reader months later still deserves to know what a run
   * branched; this is what says it is no longer standing.
   *
   * Absent on a note written before the delete, and on one whose run never
   * branched anything.
   */
  readonly temporaryVersionGone?: boolean;
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
  /** Where the swapped tool URLs point. */
  readonly target: MockEndpointTarget;
  readonly record: RecordMockRun;
};

export type BuiltMockedWorld =
  | {
      readonly kind: "built";
      readonly state: MockRunRecord;
      /** The serving version every request of this run names. */
      readonly agentVersion: number;
      /** The three classes of that version's tools, read before any turn. */
      readonly coverage: ToolCoverage;
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

/** What a teardown or a sweep could not finish, and what it chose not to do. */
export type FinishedMockedWorld = {
  /** What is still owed. Nothing is owed once the cleanup flag stands true. */
  readonly state: MockRunRecord;
  /** Each step that did not land, in the words a log should carry. */
  readonly unfinished: readonly string[];
  /**
   * Each restore that was deliberately not made, and why.
   *
   * Not a debt: a binding that has moved since this run pinned it is a binding
   * egma must not touch, so nothing is owed and nothing is retried. It is
   * reported so a reader can see the decision rather than infer it from
   * silence.
   */
  readonly leftAlone: readonly string[];
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
  numbers: readonly MockNumberNote[],
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
      },
      numbers: numbers.map((one) => ({ ...one })),
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
  // The transform runs once, here, and both halves of its answer are used: the
  // coverage classes go back to the caller and the tools go onto the copy below.
  // Running it twice would be two chances to read one configuration and write
  // another.
  const mocked = mockedToolsFor(captured.engine, build.target);
  const { coverage } = mocked;

  // 3c. Written down before a single write goes out, and — where a pin is
  // coming — written with the pin egma is **about to** make already noted. See
  // the note at the top of this file: a claimed pin that never happened is a
  // restore that finds the binding untouched and leaves it alone, and an
  // unclaimed pin that did happen is a number nobody puts back.
  let numbers: MockNumberNote[] = [];
  let state = stateOf(null, servingEngine, before, numbers);
  await record(state);

  // 3d. The pins themselves. A number already pinned, riding a tag, or riding
  // the published pointer is passed over and never touched — the tag assignment
  // in particular is the customer's and egma has no business in it.
  //
  // **A pin preserves today's behaviour and never changes it**, so the version
  // it pins to is the one that binding resolves to *now* — which for `latest`
  // and for an unset binding is whatever `latest` names at this moment. It is
  // deliberately not the run's serving version: an agent whose tagged number
  // serves 105 while its `latest` number serves 110 would otherwise have its
  // second number quietly moved back five versions for the length of a run.
  //
  // **This `latest` is not the serving read's, and it is not a leftover.** The
  // serving read above asks for `latest_published`, because a run must never be
  // conducted against a draft. This read asks the opposite question — *where
  // does this number send a real caller right now* — and the honest answer to
  // that includes a draft, because a draft is where the number really goes.
  // Moving this to the published pointer would take a customer's live number
  // off the version it reaches today, which is a change to their production
  // routing that egma has no business making for the length of a test run.
  const pinning = decisions.filter((decision) => decision.pin);
  if (pinning.length > 0) {
    const newest = await resolveAgentVersion(key, agentId, "latest", reach);
    if (newest.kind !== "version") {
      return {
        kind: "refused",
        reason: sentenceOf(
          newest,
          "resolving the version a number riding `latest` reaches right now",
        ),
        state,
      };
    }
    const pinVersion = newest.agentVersion.version;
    numbers = pinning.map((decision) => ({
      number: decision.number,
      was: hijackableBindingOf(decision),
      pinnedTo: pinVersion,
    }));
    state = stateOf(null, servingEngine, before, numbers);
    await record(state);

    for (const decision of pinning) {
      const pinned = await pinNumberBinding(
        key,
        {
          number: decision.number,
          agentId,
          version: pinVersion,
          bindings: decision.bindings,
        },
        reach,
      );
      if (pinned.kind !== "written") {
        return {
          kind: "refused",
          reason: sentenceOf(
            pinned,
            `pinning ${decision.number} to version ${pinVersion}`,
          ),
          state,
        };
      }
    }
  }

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
  state = stateOf(draft.version, servingEngine, before, numbers);
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
  // read with exactly three fields moved per intercepted tool.
  const written = await writeEngineTools(
    key,
    {
      reference: draft.engine,
      version: draft.engine.version,
      tools: mocked.tools,
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
  if (
    written.version !== null &&
    written.version !== draft.engine.version
  ) {
    return {
      kind: "refused",
      reason:
        `Egma wrote the mocked tools onto ${draft.engine.type} ` +
        `${draft.engine.engineId} v${String(draft.engine.version)}, and Retell ` +
        `answered that it wrote v${String(written.version)} instead. That is a ` +
        "new engine version rather than an edit of the copy, and Retell has no " +
        "endpoint that deletes one — so Egma stopped rather than leave behind " +
        "something nothing can clean up.",
      state,
    };
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

  return { kind: "built", state, agentVersion: servingVersion, coverage };
}

/**
 * Where this agent's hijackable entries on one number point right now.
 *
 * Every hijackable entry is `latest`, `""` or unset by the verdict's own
 * definition, so one value is the honest answer for all of them — and it is
 * read off the first rather than invented, because `null` and `"latest"` are
 * different bytes and a restore writes back what was there.
 */
function hijackableBindingOf(
  decision: BindingDecision,
): string | number | null {
  for (const binding of decision.ownBindings) {
    if (bindingVerdictOf(binding) === "hijackable") return binding.agentVersion;
  }
  return null;
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
 * Put the account back: **delete the copy, prove it, then restore any pin.**
 *
 * One function, two callers. A run's own teardown calls it when every
 * simulation is terminal; the next run's claim calls it over whatever a crashed
 * run left recorded. They are the same act, and writing them twice would be two
 * chances to get the order wrong.
 *
 * The order is the safety property. Restoring a `latest` binding while the copy
 * still exists makes the copy *be* latest, and every real caller reaches the
 * mocked agent until the delete lands. In this order every failure is benign: a
 * failed delete leaves a real version pinned with a stray copy, and a failed
 * restore leaves a real version pinned. The next sweep finishes either.
 *
 * **The delete is proved and never assumed.** A 404 to egma's own delete is not
 * evidence the version is gone — a request Retell has no route for answers the
 * same way, which is exactly how a teardown that deleted nothing reported an
 * account put back for a week. So the agent's versions are read back, from the
 * current listing endpoint, and "gone" counts only when that read agrees.
 *
 * **A restore never writes blind.** It reads where the number points now and
 * writes only where it still points at what this run's own note says it pinned
 * — so a retry that arrives after the customer rebound the number, or after a
 * newer run pinned it, does nothing and says why.
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
  const leftAlone: string[] = [];
  let state = input.state;

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
  // unsettled on a restore that failed — and the next sweep retries the whole
  // of this function. Retell hands the next branch the lowest free number, so
  // by then this run's number can belong to somebody else's draft: the
  // customer's own, made in the window while Egma still owed a restore. The
  // note is what carries the proof across those two calls.
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
      // Nothing below this line runs. The pin is what keeps real callers off
      // the copy, and the copy is still there.
      return { state, unfinished, leftAlone };
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
      return { state, unfinished, leftAlone };
    }
    if (listed.kind !== "versions") {
      unfinished.push(
        sentenceOf(
          listed,
          `reading agent ${input.agentId}'s versions back to prove temporary ` +
            `version ${temporary} is gone`,
        ),
      );
      return { state, unfinished, leftAlone };
    }
    if (listed.versions.some((one) => one.version === temporary)) {
      unfinished.push(
        `Retell accepted the delete of temporary version ${temporary} and its ` +
          "versions still hold it. Egma did not restore anything on the " +
          "strength of a delete that did not happen; the pin is what keeps " +
          "real callers off that version, and it stays.",
      );
      return { state, unfinished, leftAlone };
    }
    // **Proven absent, and written down before anything else can fail.** The
    // version number stays on the record — it is what this run branched, and a
    // reader asking months later still deserves the answer — and this flag is
    // what says it is no longer standing. Set here rather than at the end
    // because everything below can fail, and a delete proved is a delete that
    // must never be attempted again whatever happens next.
    const metadata = state.mockMetadata;
    if (metadata !== null) {
      state = { ...state, mockMetadata: { ...metadata, temporaryVersionGone: true } };
    }
  }

  const notes = state.mockMetadata?.numbers ?? [];
  const outstanding: MockNumberNote[] = [];
  for (const note of notes) {
    const restored = await restoreNumberBinding(
      key,
      {
        number: note.number,
        agentId: input.agentId,
        pinnedTo: note.pinnedTo,
        was: note.was,
      },
      reach,
    );
    if (restored.kind === "left-alone") {
      leftAlone.push(restored.reason);
      continue;
    }
    if (restored.kind !== "restored") {
      unfinished.push(
        sentenceOf(restored, `restoring ${note.number}'s routing`),
      );
      outstanding.push(note);
      continue;
    }
  }

  if (unfinished.length > 0) {
    // Only the notes that still owe a write survive, so a retry does not walk
    // past the numbers already settled.
    const metadata = state.mockMetadata;
    const settledSome = outstanding.length < notes.length;
    state = {
      ...state,
      mockMetadata:
        metadata === null ? null : { ...metadata, numbers: outstanding },
    };
    // Recorded where what egma owes actually moved — the record is an
    // obligation, and a write that changes nothing is not a change in it. Two
    // things can have moved: a number was put back, or the copy was deleted and
    // proved gone. **The second matters most on this path**, because it is the
    // one a retry must not undo by deleting a number Retell has since given to
    // somebody else's draft.
    //
    // Both live in the note, which is one of the two columns a finished run's
    // header still admits a write to — the version number beside it is frozen,
    // and deliberately: it is what this run branched, and that never changes.
    const provedGone = metadata?.temporaryVersionGone === true;
    if (settledSome || provedGone) await input.record(state);
    return { state, unfinished, leftAlone };
  }

  // Nothing left: the copy is gone, every pin is settled one way or the other,
  // and the account is as it was found.
  state = { ...state, tempMockAgentVersionCleanup: true };
  await input.record(state);
  return { state, unfinished, leftAlone };
}

/** A record that owes the account nothing, and can be forgotten. */
export function mockRunIsSettled(state: MockRunRecord): boolean {
  return state.tempMockAgentVersionCleanup !== false;
}
