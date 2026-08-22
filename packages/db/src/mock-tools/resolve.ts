/**
 * The mocked world a simulation runs in, worked out from the snapshot its run
 * froze at creation.
 *
 * It is here rather than on the data-access surface because it reaches nothing:
 * it is handed a snapshot a caller already holds and returns arithmetic over
 * it, so there is no tenancy to stamp and no `AuthContext` to take. Exported,
 * because it is the **one** place a project default and a test override are
 * merged. A second implementation — in the claim path, in a route, in the
 * simulator — is a second answer that can disagree with this one, and a
 * disagreement about which answer a tool was served is exactly the thing no
 * record could settle afterwards.
 */

/**
 * What egma serves when the agent calls a mocked tool: the value the tool
 * returns, or the failure it raises.
 *
 * Two shapes rather than one with a nullable failure, because `null` is a
 * perfectly good answer for a tool to give and a shape that could not tell it
 * from "no answer" would make an authored `null` unserveable. Exactly one of
 * the two keys is ever written.
 */
export type MockToolAnswer =
  | { readonly answer: unknown; readonly error?: undefined }
  | { readonly error: string; readonly answer?: undefined };

/** Whether an answer is the failure branch — the one place the tag is read. */
export function isErrorAnswer(
  answer: MockToolAnswer,
): answer is { readonly error: string; readonly answer?: undefined } {
  return typeof answer.error === "string";
}

/** What one mock tool serves, as a run's snapshot keeps it. */
export type SnapshotEntry = {
  /** The agent's own name for the tool, verbatim. */
  readonly toolName: string;
  readonly answer: MockToolAnswer;
  readonly delayMilliseconds: number;
};

/**
 * A project mock tool as the run froze it — with the identity of the row it
 * came from, so a served answer can name what answered on the record.
 */
export type SnapshotDefault = SnapshotEntry & {
  readonly mockToolId: string;
};

/**
 * The frozen mocked world of one run: the project's mock tools that apply to
 * the agent this run is conducted against, and what each pinned test version
 * overrode, keyed by version id.
 */
export type MockToolSnapshot = {
  readonly defaults: readonly SnapshotDefault[];
  readonly overrides: Readonly<Record<string, readonly SnapshotEntry[]>>;
};

/** A run that mocks nothing, which is what most runs are. */
export const NO_MOCK_TOOLS: MockToolSnapshot = { defaults: [], overrides: {} };

/**
 * One answer a simulation will be served, and where it came from.
 *
 * `mockToolId` is null exactly when a test overrode the tool: an override is
 * the test's own content and has no identity of its own to name, which is the
 * whole of why overrides version with the test and project defaults do not.
 */
export type ResolvedMockTool = SnapshotEntry & {
  readonly mockToolId: string | null;
};

/**
 * The answers a simulation of one pinned test version is served, in the order
 * they will be offered.
 *
 * **A test override beats the project default of the same name**, and that is
 * the branching mechanism: "the calendar has no free slots" is the same test
 * with one tool answered differently. An override for a tool no default covers
 * is an answer in its own right and joins the set. Everything else is the
 * project's world, exactly as the run froze it — scoping was applied then, so
 * nothing here reads an agent.
 *
 * The defaults keep their order and an override takes the place of the default
 * it replaces, so the set a caller reads is stable across runs of one project
 * rather than reordering itself whenever a test overrides something.
 */
export function resolveMockTools(
  snapshot: MockToolSnapshot,
  testVersionId: string,
): readonly ResolvedMockTool[] {
  const overriding = snapshot.overrides[testVersionId] ?? [];
  const overridden = new Map(
    overriding.map((entry) => [entry.toolName, entry] as const),
  );

  const resolved: ResolvedMockTool[] = snapshot.defaults.map((entry) => {
    const override = overridden.get(entry.toolName);
    return override === undefined
      ? entry
      : { ...override, mockToolId: null };
  });

  const covered = new Set(snapshot.defaults.map((entry) => entry.toolName));
  for (const entry of overriding) {
    if (covered.has(entry.toolName)) continue;
    resolved.push({ ...entry, mockToolId: null });
  }

  return resolved;
}
