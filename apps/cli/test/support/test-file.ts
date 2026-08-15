/**
 * A test file for a check that is about something else.
 *
 * Most of the suite writes a file into a folder only so that a verb has
 * something to find there, and cares about two fields of it. Spelling the whole
 * shape out at each of those places would mean every field the format gains is
 * a change to a dozen checks that are not about the format — and the check that
 * *is* about the format would be no easier to read for it.
 *
 * So the defaults here are the empty ones: nothing synced, nothing overridden,
 * nobody named, and one P0 behavior's worth of nothing. A check that is about a
 * field says that field.
 */

import type { TestFile } from "../../src/folder/test-file.ts";

export type PartialTestFile = Partial<TestFile> &
  Pick<TestFile, "name" | "scenario" | "expectedBehaviors">;

export function aTestFile(said: PartialTestFile): TestFile {
  return {
    format: 2,
    description: null,
    personas: [],
    version: null,
    identityRevision: null,
    graders: [],
    requiredCapabilities: [],
    mockTools: [],
    ...said,
  };
}

/** One P0 statement, which is what a behavior with no marker has always meant. */
export function blocking(...statements: readonly string[]): TestFile["expectedBehaviors"] {
  return statements.map((behavior) => ({ behavior, priority: "P0" as const }));
}
