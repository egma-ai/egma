import type {
  GetTestResponse,
  ListCapabilitiesResponse,
  ListTestsResponse,
  ListTestVersionsResponse,
} from "@egma/platform-api/client";

/**
 * The tests of one project, as `GET /v1/tests` answers them.
 *
 * A **test** is one authored specification: the situation to put an agent in,
 * who calls about it, and what should happen. It lives in a project and applies
 * to one or more of that project's agents — never to a copy per agent, because
 * the whole worth of one reusable test is that two agents' results stay
 * comparable.
 *
 * The shapes are the API's own, field names included. Renaming its fields on
 * the way in would put a second vocabulary between the contract and the page,
 * and the two would drift the first time the API grew a field.
 *
 * **The one thing this module holds an opinion about is the three-way split.**
 * A test's live identity, its versioned content and the agents it applies to
 * are edited from one page and saved by three rules, each carrying its own
 * token and getting its own refusal. A page that mixed them up would either
 * fill a history with renames or refuse a rename because somebody else
 * sharpened a scenario. So the split is written down once, here, and every
 * control asks it rather than remembering.
 */

/**
 * One statement about what should happen — a plain sentence, and nothing else.
 *
 * **It carried a P0/P1/P2 priority and does not any more.** The ladder let a
 * failing check be demoted until it stopped meaning anything, which is the
 * false trust this product exists to kill: every behavior has to hold, so
 * there was nothing left for a per-sentence priority to say. How loudly a
 * *grader* speaks is now the running copy's own `required` flag — one place,
 * one decision, and never per sentence.
 *
 * It is an alias rather than an object so that every control that draws a
 * behavior draws a sentence, and the type says so.
 */
export type ExpectedBehavior = string;

/** A persona a test names, or an agent it applies to: identity, and state. */
export type ListedTest = GetTestResponse;
export type Named = ListedTest["agents"][number];
export type TestPage = ListTestsResponse;

/** One frozen version, as the history reader shows it. */
export type TestVersionPage = ListTestVersionsResponse;
export type TestVersionRow = TestVersionPage["versions"][number];

/** One capability a test may require, as the server's own catalog describes it. */
export type CapabilityCatalog = ListCapabilitiesResponse;
export type Capability = CapabilityCatalog["items"][number];

/**
 * The capability catalog, from the route that already served it to the
 * connection forms. A second list would be a second opinion about which keys
 * exist, and the whole worth of the catalog is that a test's requirement and a
 * connection's measurement name the same thing.
 */
/**
 * Which fields of a test are live, which are versioned content, and which are
 * neither.
 *
 * **This is the split the whole editor is built around.** The live ones take
 * effect the moment they are written and change nothing about any verdict
 * already made. The versioned ones are what a run was *judged by*, so an edit
 * to any of them mints an immutable version and applies from then on — last
 * week's run keeps meaning exactly what it meant. The agents a test applies to
 * are a third thing: target coverage, which mints no version and makes no
 * repository copy stale.
 *
 * A page reads this rather than knowing it, so the label beside a control and
 * the request the control sends can never disagree about which kind of change
 * somebody is making.
 */
export const LIVE_FIELDS = ["name", "description"] as const;

export const VERSIONED_FIELDS = [
  "scenario",
  "personas",
  "expectedBehaviors",
  "requiredCapabilities",
  "mockTools",
] as const;

export type VersionedField = (typeof VERSIONED_FIELDS)[number];

export function isVersioned(field: string): field is VersionedField {
  return (VERSIONED_FIELDS as readonly string[]).includes(field);
}

/**
 * Whether a test can enter a run right now.
 *
 * **Two ways to be unavailable, and only one of them is a fault.** An archived
 * test was taken out of circulation on purpose. A test whose every applicable
 * agent has been archived is active and has nowhere to run — a state the
 * product allows and has to say out loud, because the fix is to restore an
 * agent or link another one rather than to re-author the test.
 */
export function availability(test: ListedTest): {
  readonly runnable: boolean;
  readonly why: string | null;
} {
  if (test.archivedAt !== null) {
    return {
      runnable: false,
      why:
        test.archiveReason === "needs_agent"
          ? "Archived during an upgrade, because this project had no active agent to apply it to. Restore it with an agent selected."
          : "Archived. It keeps every version and every run that used it, and cannot enter a new run.",
    };
  }
  if (test.agents.every((applies) => applies.archivedAt !== null)) {
    return {
      runnable: false,
      why:
        "Every agent this test applies to is archived, so no run can use it. Restore one of them, or link an active agent.",
    };
  }
  return { runnable: true, why: null };
}

/** The agents a test applies to that a run could actually use. */
export function activeAgents(test: ListedTest): readonly Named[] {
  return test.agents.filter((applies) => applies.archivedAt === null);
}

/**
 * Whether a set of behaviors may be saved.
 *
 * One rule now, and it is the one that was always doing the work: a test has to
 * be able to fail, so it needs at least one statement to check. The second rule
 * — at least one P0 — went with the ladder itself: every behavior has to hold,
 * so there is no longer a way to demote one until a test can no longer be red.
 */
export function behaviorsAreUsable(
  behaviors: readonly ExpectedBehavior[],
): boolean {
  return behaviors.some((one) => one.trim() !== "");
}

/** Why a set of behaviors cannot be saved, in the words the page shows. */
export function whyBehaviorsRefuse(
  behaviors: readonly ExpectedBehavior[],
): string | null {
  if (behaviors.every((one) => one.trim() === "")) {
    return "A test needs at least one expected behavior, because a test that cannot fail is not a test.";
  }
  return null;
}
