/**
 * Default test-file fixture for command tests. Leave sync tokens, mocks, env,
 * and personas empty unless the test supplies them.
 */

import type { TestFile } from "../../src/folder/test-file.ts";

export type PartialTestFile = Partial<TestFile> &
  Pick<TestFile, "name" | "scenario" | "expectedBehaviors">;

export function aTestFile(said: PartialTestFile): TestFile {
  return {
    format: 5,
    description: null,
    personas: [],
    version: null,
    identityRevision: null,
    mockTools: [],
    env: null,
    ...said,
  };
}

/**
 * The statements, as the format now holds them: plain sentences.
 *
 * It used to wrap each one in `{behavior, priority: "P0"}`, and the name it
 * kept is the point — every expected behavior blocks, so the whole list is
 * "blocking" and there is no longer a second kind to tell it apart from.
 */
export function blocking(
  ...statements: readonly string[]
): TestFile["expectedBehaviors"] {
  return [...statements];
}
