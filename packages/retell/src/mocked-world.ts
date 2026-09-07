/**
 * Build and remove one temporary Retell agent version for a run.
 *
 * The control plane must exclude overlapping runs with mock tools for one agent.
 * Retell can reuse deleted version numbers, so persist cleanup proof and never
 * repeat a proved deletion. Record intent before writes so cleanup can resume.
 *
 * Resolve the serving version and capture its engine before branching. Reject
 * a branch that shares the serving engine. Write tool URLs and defaults together,
 * then verify the draft version and exact single-space defaults by reading them back.
 * Compare the serving tools to the capture; if changed during build, attempt
 * restoration to the captured engine version and fail the run.
 *
 * Each simulation supplies routing variables from its own pinned test. Do not
 * rewrite the shared draft while simulations run. Number bindings and tags are
 * read only; bindings to Latest Created can reach the temporary version.
 *
 * Teardown verifies serving tools, deletes the draft, and proves absence through
 * the version listing. Persist each result, including retained flow-version residue.
 * Resumed cleanup cannot restore serving tools from a comparison print alone.
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
 * Read-only decisions for every binding of a number to this agent.
 * Keep multiple weighted entries; they inform version selection and UI warnings.
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
   * Canonical tool print captured for comparison during resumed cleanup.
   * It is not the original engine document; a mismatch can be reported but cannot
   * be safely restored from this print.
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
   * Persist tool-to-variable mappings so claims can set every routing variable:
   * a mock URL for covered tools, an empty prefix for others. Absent without a draft.
   */
  readonly urlVariables?: readonly MockToolVariable[];
  /**
   * Deletion proved by the version listing. Persist immediately so later cleanup
   * does not delete the same number after Retell has reused it for another draft.
   * Keep the original version number as run history.
   */
  readonly temporaryVersionGone?: boolean;
  /**
   * Flow version retained after agent-version deletion, observed live on 2026-08-31.
   * Retell's flow deletion API deletes the whole flow, not one version. Record
   * this residue only after the agent version is proved absent.
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
 * Select the first numeric or tag binding belonging to this agent.
 * Otherwise use latest_published, including bindings that follow Latest Created.
 * This avoids selecting temporary drafts when no binding pins a version.
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
 * Canonical comparison: sort object keys while preserving array order.
 * Use the same serialization in account checks so provider key order is irrelevant.
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

  // Require an explicit serving-engine version before capture, verification, or repair.
  // A null version would read latest and could target another draft. Custom LLMs
  // reach the separate unsupported-engine check because they have no hosted version.
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

  // Require the PATCH response to name the requested engine version.
  // A missing or different version may mean a new flow version was created,
  // which this lifecycle cannot remove. Fail the run and retain cleanup state.
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

  // Read back each routing default and require exactly one space.
  // An absent or trimmed default leaves literal braces and breaks unmocked calls.
  // Skip when there are no custom-tool routing variables.
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
 * Resume cleanup from the persisted run record. Verify serving tools, delete
 * the temporary agent version, and prove absence through a complete version listing.
 * Persist each completed step so a retry does not repeat a proved deletion.
 * This cleanup does not alter number bindings, tags, or customer versions.
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

  // Verify serving tools before deleting the draft, including on resumed cleanup.
  // A mismatch stays unresolved: the persisted print cannot reconstruct the captured
  // engine document needed for safe restoration.
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

    // Prove deletion through the version listing. A DELETE 404 can also mean a bad route.
    // Any failed, ambiguous, or still-present listing keeps cleanup outstanding.
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
    // Persist proved deletion before later steps can fail; never delete this number again.
    // Also record the flow version Retell retains after agent-version removal.
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
