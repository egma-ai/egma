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
 * 8. **Teardown** — `finishMockedWorld` again: **delete the draft first, then
 *    restore any pin**. The reverse order is lethal — restoring `latest` while
 *    the draft exists makes the draft *be* latest.
 *
 * ## The record is an obligation, not a report
 *
 * `record` is called at every point where what egma owes the account changes,
 * and each call replaces the whole record. What is written is always the
 * **outstanding** obligation: a `draftVersion` that is not null is a version
 * that must be deleted, and a number marked `pinned` is a binding that must be
 * put back. Teardown clears each one as it lands, so a record with a null draft
 * and no pinned number is a world that owes nothing.
 *
 * That is also why an intent is written **before** the write it describes. A
 * crash between "egma says it pinned this number" and the pin itself leaves a
 * restore that writes the bindings back exactly as they already are — a no-op.
 * The other order would leave a real pin that nothing knows to undo.
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
  restoreNumberBindings,
  type BindingVerdict,
  type NumberBinding,
  type RoutedNumber,
} from "./numbers.ts";
import { toolsOf, type ToolCoverage } from "./tools.ts";
import type { RetellCredential, RetellFailure, RetellReach } from "./transport.ts";
import {
  branchAgentVersion,
  deleteAgentVersion,
  readEngineConfiguration,
  resolveAgentVersion,
  writeEngineTools,
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
  /** Every binding the number carries, verbatim — other agents' included. */
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
      bindings: number.bindings,
    };
  });
}

/** One number as the record keeps it: what to put back, and whether to. */
export type MockedWorldNumberRecord = {
  readonly number: string;
  /** Whether a pin egma made is still outstanding. */
  readonly pinned: boolean;
  /** The whole `inbound_agents` array as it was read, entry for entry. */
  readonly bindings: readonly Readonly<Record<string, unknown>>[];
};

/**
 * The temporary world, in the shape the record stores.
 *
 * Structurally the platform-neutral `MockedWorld` the control plane writes onto
 * a run. It is spelled again here rather than imported because this package
 * knows Retell and nothing about a database — and a test in the control plane
 * holds the two shapes to each other, so they cannot drift.
 */
export type MockedWorldRecord = {
  readonly servingVersion: number;
  /** The temporary version that exists right now, or null when none does. */
  readonly draftVersion: number | null;
  readonly engine: {
    readonly type: string;
    readonly engineId: string;
    readonly version: number | null;
  };
  readonly numbers: readonly MockedWorldNumberRecord[];
  readonly coverage: ToolCoverage;
};

/** How the caller is told what egma currently owes the account. */
export type RecordMockedWorld = (world: MockedWorldRecord) => Promise<void>;

/**
 * Which version a run over this agent should be testing.
 *
 * The one a real caller reaches: the first binding on a routed number that
 * names a version — a number or a tag. A number riding `latest` names none, so
 * it is passed over here and answered by `latest` below, which is the same
 * thing it resolves to.
 *
 * `latest` where the agent has no number at all, which is the ordinary case for
 * a chat agent and the right answer for it: a conversation created against no
 * named version gets the platform's own default, and this makes the run test
 * what that default is.
 */
export function versionReferenceIn(
  decisions: readonly BindingDecision[],
): VersionReference {
  for (const decision of decisions) {
    for (const binding of decision.bindings) {
      if (typeof binding.agentVersion === "number") return binding.agentVersion;
      if (
        typeof binding.agentVersion === "string" &&
        bindingVerdictOf(binding) === "environment-tag"
      ) {
        return binding.agentVersion;
      }
    }
  }
  return "latest";
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
  readonly record: RecordMockedWorld;
};

export type BuiltMockedWorld =
  | { readonly kind: "built"; readonly world: MockedWorldRecord }
  /**
   * The world could not be built. `world` is what egma owes the account and is
   * null only when nothing was touched at all; the caller tears it down and
   * fails the run. There is no third answer: a mockable run that cannot build
   * its world never falls back to the real tools.
   */
  | {
      readonly kind: "refused";
      readonly reason: string;
      readonly world: MockedWorldRecord | null;
    };

/** What a teardown or a sweep could not finish. */
export type FinishedMockedWorld = {
  /** What is still owed. Nothing is owed when the draft is null and no number is pinned. */
  readonly world: MockedWorldRecord;
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
 */
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

function recordOf(
  servingVersion: number,
  draftVersion: number | null,
  engine: EngineReference,
  numbers: readonly MockedWorldNumberRecord[],
  coverage: ToolCoverage,
): MockedWorldRecord {
  return {
    servingVersion,
    draftVersion,
    engine: {
      type: engine.type,
      engineId: engine.engineId,
      version: engine.version,
    },
    numbers,
    coverage,
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
      world: null,
    };
  }
  const decisions = bindingDecisionsFor(listed.numbers, agentId);

  // 3a. The serving version, resolved once. Everything after this names the
  // number rather than the reference, so a tag reassigned mid-run moves
  // nothing.
  const serving = await resolveAgentVersion(
    key,
    agentId,
    build.versionReference ?? versionReferenceIn(decisions),
    reach,
  );
  if (serving.kind !== "version") {
    return {
      kind: "refused",
      reason: sentenceOf(serving, "resolving the version this agent serves"),
      world: null,
    };
  }
  const servingVersion = serving.agentVersion.version;
  const servingEngine = serving.agentVersion.engine;

  // 3b. The serving engine configuration, verbatim. This is both what the
  // draft is built from and what the verification compares against, and it is
  // read once so those two can never be readings of different things.
  const captured = await readEngineConfiguration(key, servingEngine, reach);
  if (captured.kind === "not-held") {
    return { kind: "refused", reason: captured.reason, world: null };
  }
  if (captured.kind !== "engine") {
    return {
      kind: "refused",
      reason: sentenceOf(captured, "reading this agent's tools"),
      world: null,
    };
  }
  const before = toolPrint(captured.engine);
  // The transform runs once, here, and both halves of its answer are used: the
  // coverage stamp goes into the record before anything is branched, and the
  // tools go onto the draft below. Running it twice would be two chances to
  // stamp one configuration and write another.
  const mocked = mockedToolsFor(captured.engine, build.target);
  const { coverage } = mocked;

  // 3c. Written down before a single write goes out, and written with the pins
  // egma is **about to** make already marked. See the note at the top of this
  // file: a claimed pin that never happened restores bytes that are already
  // there, and an unclaimed pin that did happen is a number nobody puts back.
  const numbers: MockedWorldNumberRecord[] = decisions.map((decision) => ({
    number: decision.number,
    pinned: decision.pin,
    bindings: decision.bindings.map((binding) => binding.verbatim),
  }));
  let world = recordOf(
    servingVersion,
    null,
    servingEngine,
    numbers,
    coverage,
  );
  await record(world);

  // 3d. The pins themselves. A number already pinned, riding a tag, or riding
  // the published pointer is recorded and never touched — the tag assignment
  // in particular is the customer's and egma has no business in it.
  //
  // **A pin preserves today's behaviour and never changes it**, so the version
  // it pins to is the one that binding resolves to *now* — which for `latest`
  // and for an unset binding is whatever `latest` names at this moment. It is
  // deliberately not the run's serving version: an agent whose tagged number
  // serves 105 while its `latest` number serves 110 would otherwise have its
  // second number quietly moved back five versions for the length of a run.
  if (decisions.some((decision) => decision.pin)) {
    const newest = await resolveAgentVersion(key, agentId, "latest", reach);
    if (newest.kind !== "version") {
      return {
        kind: "refused",
        reason: sentenceOf(
          newest,
          "resolving the version a number riding `latest` reaches right now",
        ),
        world,
      };
    }
    const pinVersion = newest.agentVersion.version;
    for (const decision of decisions) {
      if (!decision.pin) continue;
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
          world,
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
      world,
    };
  }
  const draft = branched.agentVersion;
  world = recordOf(servingVersion, draft.version, draft.engine, numbers, coverage);
  await record(world);

  // 5. **The fork guard**, before any write.
  //
  // Whether branching an agent forks a Retell LLM the way it provably forks a
  // conversation flow is not assumed anywhere in this file. If the draft still
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
      world,
    };
  }
  if (draft.engine.version === null) {
    return {
      kind: "refused",
      reason:
        `Retell branched version ${draft.version} without naming a response ` +
        "engine version, and Egma never writes to an unnamed version: the " +
        "default is the latest one, which after a branch is somebody's draft.",
      world,
    };
  }

  // 6. Swap, naming the target version explicitly. The transform is a pure
  // function of the captured configuration, so what is written is what was
  // read with exactly two fields moved per intercepted tool.
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
      world,
    };
  }

  // 7. Verify. The one check that answers the question a developer actually
  // asks — "is my live agent still exactly as it was?" — by reading it rather
  // than by trusting the request that was just sent.
  const after = await readEngineConfiguration(key, servingEngine, reach);
  if (after.kind === "not-held") {
    return { kind: "refused", reason: after.reason, world };
  }
  if (after.kind !== "engine") {
    return {
      kind: "refused",
      reason: sentenceOf(
        after,
        "reading the serving version back to prove it did not move",
      ),
      world,
    };
  }
  if (toolPrint(after.engine) !== before) {
    // Loud, and repaired: the capture goes back onto the serving version
    // before the run is failed, because a serving version that has been
    // changed is the one failure this whole design exists to prevent.
    const repaired = await writeEngineTools(
      key,
      {
        reference: servingEngine,
        version: servingEngine.version ?? servingVersion,
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
      world,
    };
  }

  return { kind: "built", world };
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
 * Put the account back: **delete the draft first, then restore any pin.**
 *
 * One function, two callers. A run's own teardown calls it when every
 * simulation is terminal; the next run's sweep calls it over whatever a crashed
 * run left recorded. They are the same act, and writing them twice would be two
 * chances to get the order wrong.
 *
 * The order is the safety property. Restoring a `latest` binding while the
 * draft still exists makes the draft *be* latest, and every real caller reaches
 * the mocked agent until the delete lands. In this order every failure is
 * benign: a failed delete leaves a real version pinned with a stray draft, and
 * a failed restore leaves a real version pinned. The next sweep finishes
 * either.
 *
 * Each landing is recorded as it happens, so a crash halfway through leaves a
 * record of exactly what is still owed rather than a record of what was owed
 * when it started.
 */
export async function finishMockedWorld(
  key: RetellCredential,
  input: {
    readonly agentId: string;
    readonly world: MockedWorldRecord;
    readonly record: RecordMockedWorld;
  },
  reach: RetellReach = {},
): Promise<FinishedMockedWorld> {
  const unfinished: string[] = [];
  let world = input.world;

  if (world.draftVersion !== null) {
    const deleted = await deleteAgentVersion(
      key,
      input.agentId,
      world.draftVersion,
      reach,
    );
    // `gone` is a success here and nowhere else in this file: a version that is
    // not there is a version serving nobody, which is the whole of what the
    // delete is for.
    if (deleted.kind === "deleted" || deleted.kind === "gone") {
      world = { ...world, draftVersion: null };
      await input.record(world);
    } else {
      unfinished.push(
        sentenceOf(deleted, `deleting temporary version ${world.draftVersion}`),
      );
      // Nothing below this line runs. The pin is what keeps real callers off
      // the draft, and the draft is still there.
      return { world, unfinished };
    }
  }

  for (const number of world.numbers) {
    if (!number.pinned) continue;
    const restored = await restoreNumberBindings(
      key,
      {
        number: number.number,
        // Rebuilt into the binding shape the write takes, out of the bytes that
        // were recorded — never out of anything read again since.
        bindings: number.bindings.map((verbatim) => ({
          agentId: String(verbatim["agent_id"] ?? ""),
          agentVersion: null,
          verbatim,
        })),
      },
      reach,
    );
    if (restored.kind === "written") {
      world = {
        ...world,
        numbers: world.numbers.map((one) =>
          one.number === number.number ? { ...one, pinned: false } : one,
        ),
      };
      await input.record(world);
    } else {
      unfinished.push(
        sentenceOf(restored, `restoring ${number.number}'s routing`),
      );
    }
  }

  return { world, unfinished };
}

/** A world that owes the account nothing, and can be forgotten. */
export function mockedWorldIsSettled(world: MockedWorldRecord): boolean {
  return (
    world.draftVersion === null &&
    !world.numbers.some((number) => number.pinned)
  );
}
