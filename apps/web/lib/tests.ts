import type {
  CreateTestResponse,
  ListTestsResponse,
} from "@egma/platform-api/client";

/**
 * Test wire shapes, as the generated platform contract returns them.
 *
 * **What is left is what still has a reader.** The test full page and the
 * write-a-test sheet retired on 2026-08-24, and everything this file held for
 * them went with them: the address of a test's own page, the persona-overflow
 * cell, the live/versioned field lists that told a two-save form which half it
 * was saving, and the behavior checks that form ran before its Save. The grid
 * asks those questions of its own cells, and the version shapes have no reader
 * at all while versioning stays hidden from the interface.
 */
export type ListedTest = CreateTestResponse;
export type TestPage = ListTestsResponse;
