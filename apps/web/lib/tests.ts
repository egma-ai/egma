/**
 * The tests of one project, as `GET /api/tests` answers them.
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

export type Priority = "P0" | "P1" | "P2";

export const PRIORITIES: readonly Priority[] = ["P0", "P1", "P2"];

/** What each priority means, in the words a page shows beside the control. */
export const PRIORITY_MEANING: Readonly<Record<Priority, string>> = {
  P0: "Blocks. A failure here stops the release.",
  P1: "Warns. A failure here is reported and does not block.",
  P2: "Informs. A failure here is recorded and nothing else.",
};

export type ExpectedBehavior = {
  readonly behavior: string;
  readonly priority: Priority;
};

/** A persona a test names, or an agent it applies to: identity, and state. */
export type Named = {
  readonly id: string;
  readonly name: string;
  readonly archived_at?: string | null;
};

export type ListedTest = {
  readonly id: string;
  readonly project_id: string;
  readonly name: string;
  readonly description: string | null;
  readonly version: number;
  readonly version_id: string;
  readonly scenario: string;
  readonly expected_behaviors: readonly ExpectedBehavior[];
  readonly personas: readonly Named[];
  readonly graders: readonly Named[];
  readonly required_capabilities: readonly string[];
  /**
   * How many tools this test answers for itself.
   *
   * **A count, never the overrides.** This browser does not author mock tools
   * and its form does not send them, which is exactly what stops a partial
   * form erasing hidden versioned content — so what it shows is that they are
   * there, and clone carries them.
   */
  readonly override_count: number;
  readonly agents: readonly Named[];
  readonly revision: string;
  readonly applicability_revision: string;
  readonly archived_at: string | null;
  readonly archive_reason: string | null;
  readonly created_at: string;
  readonly updated_at: string;
};

export type TestPage = {
  readonly items: readonly ListedTest[];
  readonly next_cursor: string | null;
};

/** One frozen version, as the history reader shows it. */
export type TestVersionRow = {
  readonly id: string;
  readonly test_id: string;
  readonly test_name: string;
  readonly version: number;
  readonly current: boolean;
  readonly scenario: string;
  readonly expected_behaviors: readonly ExpectedBehavior[];
  readonly personas: readonly Named[];
  readonly graders: readonly Named[];
  readonly required_capabilities: readonly string[];
  readonly override_count: number;
  readonly created_at: string;
};

export type TestVersionPage = {
  readonly items: readonly TestVersionRow[];
  readonly next_cursor: string | null;
};

/** One capability a test may require, as the server's own catalog describes it. */
export type Capability = {
  readonly key: string;
  readonly label: string;
  readonly description: string;
};

export type CapabilityCatalog = { readonly items: readonly Capability[] };

export const TESTS_PATH = "/api/tests";

/**
 * The capability catalog, from the route that already served it to the
 * connection forms. A second list would be a second opinion about which keys
 * exist, and the whole worth of the catalog is that a test's requirement and a
 * connection's measurement name the same thing.
 */
export const CAPABILITIES_PATH = "/api/capabilities";

export function testsPath(options: {
  readonly archived?: boolean;
  readonly agent?: string;
  readonly name?: string;
  readonly cursor?: string;
}): string {
  const query = new URLSearchParams();
  if (options.archived === true) query.set("archived", "true");
  if (options.agent !== undefined && options.agent !== "") {
    query.set("agent", options.agent);
  }
  if (options.name !== undefined && options.name.trim() !== "") {
    query.set("name", options.name.trim());
  }
  if (options.cursor !== undefined) query.set("cursor", options.cursor);
  const search = query.toString();
  return search === "" ? TESTS_PATH : `${TESTS_PATH}?${search}`;
}

export function testPath(testId: string): string {
  return `${TESTS_PATH}/${encodeURIComponent(testId)}`;
}

export function testVersionsPath(testId: string): string {
  return `${testPath(testId)}/versions`;
}

export function testAgentsPath(testId: string): string {
  return `${testPath(testId)}/agents`;
}

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
  "expected_behaviors",
  "graders",
  "required_capabilities",
  "mock_tools",
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
  if (test.archived_at !== null) {
    return {
      runnable: false,
      why:
        test.archive_reason === "needs_agent"
          ? "Archived during an upgrade, because this project had no active agent to apply it to. Restore it with an agent selected."
          : "Archived. It keeps every version and every run that used it, and cannot enter a new run.",
    };
  }
  if (test.agents.every((applies) => applies.archived_at !== null)) {
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
  return test.agents.filter((applies) => (applies.archived_at ?? null) === null);
}

/**
 * Whether a set of behaviors may be saved.
 *
 * Two rules, and they are the same rule: a test has to be able to fail. One
 * with nothing to check can never be red, and one whose every statement has
 * been demoted is one nothing can hold back — which is how falsifiability gets
 * downgraded away one edit at a time.
 */
export function behaviorsAreUsable(
  behaviors: readonly ExpectedBehavior[],
): boolean {
  const written = behaviors.filter((one) => one.behavior.trim() !== "");
  return (
    written.length > 0 && written.some((one) => one.priority === "P0")
  );
}

/** Why a set of behaviors cannot be saved, in the words the page shows. */
export function whyBehaviorsRefuse(
  behaviors: readonly ExpectedBehavior[],
): string | null {
  const written = behaviors.filter((one) => one.behavior.trim() !== "");
  if (written.length === 0) {
    return "A test needs at least one expected behavior, because a test that cannot fail is not a test.";
  }
  if (!written.some((one) => one.priority === "P0")) {
    return "A test needs at least one P0 behavior. Falsifiability cannot be downgraded away.";
  }
  return null;
}
