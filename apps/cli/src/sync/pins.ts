/**
 * What a pinned file is a draft of.
 *
 * A test file carries a *version* id, not a test id. That is deliberate: the
 * version is the fact both verbs need. `pull` needs it to know which file a
 * platform test already lives in, and `push` needs it to know whether the
 * platform has moved since this file was last synced. A test id would answer the
 * first question and not the second.
 *
 * Resolving one is free in the ordinary case — a pin that is some test's
 * current version is answered out of the list already in hand — and costs one
 * request in the case that matters, where the pin is stale and the test it
 * belongs to has to be named in a refusal.
 *
 * **The list handed in is the repository's whole view of the platform**, and it
 * is narrowed to the agent the folder is bound to. So a pin that resolves to a
 * version of a test the list does not hold is its own answer, `elsewhere`, and
 * not a stale pin: the test is there, this repository is simply no longer
 * entitled to write it. Reporting that as "egma has moved on" would send
 * somebody to pull a test their folder would be refused for pushing again.
 */

import {
  getTestVersion,
  type PlatformTest,
  type PlatformTestVersion,
} from "../platform/tests.ts";
import type { Fetch } from "../platform/device-flow.ts";
import type { SignedIn } from "../platform/signed-in.ts";

export type Pinned =
  /** The pin is the current version of a test this repository can see. */
  | { readonly kind: "current"; readonly test: PlatformTest }
  /** The pin is a version this test has since moved past. */
  | {
      readonly kind: "behind";
      readonly testId: string;
      readonly testName: string;
      readonly currentVersionId: string | null;
      /** The frozen content, for deciding whether a file is a faithful copy. */
      readonly version: PlatformTestVersion;
    }
  /** The version is real, and its test is not one this repository can see. */
  | {
      readonly kind: "elsewhere";
      readonly testId: string;
      readonly testName: string;
      readonly version: PlatformTestVersion;
    }
  /** This egma has never issued that version. */
  | { readonly kind: "unknown" };

export type PinResolver = (pin: string) => Promise<Pinned>;

/**
 * A resolver over one list of tests, asking the platform only about pins the
 * list cannot answer, and asking about each one once.
 */
export function pinsAgainst(
  signedIn: SignedIn,
  tests: readonly PlatformTest[],
  fetchImpl?: Fetch,
): PinResolver {
  const byVersion = new Map(tests.map((test) => [test.versionId, test] as const));
  const byId = new Map(tests.map((test) => [test.id, test] as const));
  const asked = new Map<string, Promise<Pinned>>();

  return (pin) => {
    const current = byVersion.get(pin);
    if (current !== undefined) return Promise.resolve({ kind: "current", test: current });

    const already = asked.get(pin);
    if (already !== undefined) return already;

    const answer = (async (): Promise<Pinned> => {
      const version = await getTestVersion(
        signedIn,
        pin,
        ...(fetchImpl === undefined ? [] : ([fetchImpl] as const)),
      );
      if (version === null) return { kind: "unknown" };

      const test = byId.get(version.testId);
      const named =
        version.testName === "" ? (test?.name ?? version.testId) : version.testName;
      if (test === undefined) {
        return { kind: "elsewhere", testId: version.testId, testName: named, version };
      }
      if (version.current) return { kind: "current", test };
      return {
        kind: "behind",
        testId: version.testId,
        testName: named,
        currentVersionId: test.versionId,
        version,
      };
    })();

    asked.set(pin, answer);
    return answer;
  };
}
