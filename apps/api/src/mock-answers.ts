import type { TestMockTool } from "@egma/db";

/**
 * One mock tool's answer as the mock-tool exchange carries it: a value handed
 * back to the model, or a failure raised at it. JSON has no undefined, so an
 * absent answer is null and the tag is never dropped. The claim's work order
 * and the SDK seam's tool answer are built here, so they cannot spell one
 * authored answer two ways.
 */
export function taggedMockAnswer(
  mock: TestMockTool,
): { readonly answer: unknown } | { readonly error: string } {
  return "error" in mock ? { error: mock.error } : { answer: mock.answer ?? null };
}
