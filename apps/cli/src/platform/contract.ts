/**
 * Which repository-facing contract this egma speaks, and what it says when the
 * platform speaks another one.
 *
 * **The promise: the CLI and the platform ship together.** `/api/tests` is
 * egma's internal surface — not `/api/v1`, and nothing outside egma is invited
 * to build on it — so it changes shape when the product needs it to. What it
 * may not do is change quietly. A client reading a field it no longer
 * understands is told so, in one sentence, before it writes anything.
 *
 * That promise was written down after the cost of not having it was measured.
 * Priorities on expected behaviors turned each entry from text into an object.
 * A CLI built before that reads an object as empty text and drops it, so it
 * pulls a whole folder of tests with no expected behaviors in them — no crash,
 * nothing that looks wrong, just files that quietly say less than they did.
 * What stopped that folder being written back over the real tests was a rule
 * somewhere else entirely: a version has to hold at least one behavior and at
 * least one P0, so the push was refused. Real protection, arrived at by
 * accident, and it reported a sentence about falsifiability to somebody whose
 * actual problem was an out-of-date install.
 *
 * So the check is here, in front of both sync verbs, and it is one integer
 * compared to one integer. It refuses in **both** directions on purpose: a
 * platform ahead of this egma may answer shapes this egma would silently drop,
 * and a platform behind it cannot answer the fields the folder's own file
 * format now writes down. Neither is a merge that could be got right by
 * guessing, and both are fixed by one command.
 */

import { PlatformUnreachableError, type Fetch } from "./device-flow.ts";
import { IDENTITY_TIMEOUT_MS, PLATFORM_IDENTITY_PATH } from "./identity.ts";
import type { SignedIn } from "./signed-in.ts";
import { bodyOf } from "./wire.ts";

/**
 * The contract this build of egma reads and writes.
 *
 * 2 — expected behaviors carry a priority, personas carry a stable id beside
 * their display name, a test carries a description, graders, required
 * capabilities and an identity revision, and a repository write names both the
 * version and the revision it was written against.
 *
 * 3 — the grader redesign, on the wire. An expected behavior is a plain
 * sentence again and the `{behavior, priority}` shape is refused by name; a
 * test names no graders and the `graders` key is refused too. Both are
 * *refusals* rather than fields quietly dropped, which is what makes this
 * number worth having: a client built for 2 sends objects, would be turned away
 * one test at a time with a sentence about a shape it has never heard of, and
 * is told here instead — before it writes anything — that it is the version
 * that is behind.
 */
export const REPOSITORY_CONTRACT = 3;

/**
 * The contract a platform that answers no number at all is speaking: the shape
 * that shipped before the field existed.
 */
export const CONTRACT_BEFORE_THE_FIELD = 1;

/** What the platform speaks, or `null` when this run could not find out. */
export type PlatformContract = number | null;

/**
 * Ask the platform which contract it speaks.
 *
 * **A platform that cannot be asked is not a platform that disagrees.** A
 * timeout, a proxy, a body that is not JSON — none of those say anything about
 * the shape on the other side, and refusing on them would turn every passing
 * network fault into "your egma is out of date". Those come back as `null` and
 * the verb carries on to fail, if it is going to fail, with its own words about
 * the address.
 */
export async function readPlatformContract(
  signedIn: SignedIn,
  fetchImpl: Fetch = fetch,
): Promise<PlatformContract> {
  let response: Response;
  try {
    response = await fetchImpl(`${signedIn.url}${PLATFORM_IDENTITY_PATH}`, {
      method: "GET",
      headers: { accept: "application/json" },
      redirect: "manual",
      // The same budget the identity read takes, for the same reason: this is
      // in front of both sync verbs, and a platform that accepts the connection
      // and then says nothing must not be able to hang them with no output.
      signal: AbortSignal.timeout(IDENTITY_TIMEOUT_MS),
    });
  } catch (cause) {
    // Named rather than swallowed: the caller decides whether an address that
    // does not answer ends the verb here or one request later.
    throw new PlatformUnreachableError(signedIn.url, cause);
  }

  if (!response.ok) return null;
  const body = await bodyOf(response);
  const said = body.repository_contract;
  if (said === undefined) return CONTRACT_BEFORE_THE_FIELD;
  return typeof said === "number" && Number.isInteger(said) && said > 0 ? said : null;
}

/**
 * The refusal for a platform speaking another contract, or `null` when the two
 * agree or when this run never found out.
 *
 * Both halves of the sentence are said: what happened, and the one command that
 * fixes it. Which command that is depends on which side is behind, and getting
 * that backwards is worse than saying nothing — somebody upgrading a CLI that
 * was already newer than their platform learns nothing and loses an hour.
 */
export function contractRefusal(platform: PlatformContract): string | null {
  if (platform === null || platform === REPOSITORY_CONTRACT) return null;

  const behind = platform < REPOSITORY_CONTRACT ? "platform" : "egma";
  return [
    `This egma speaks repository contract ${String(REPOSITORY_CONTRACT)} and this platform speaks ${String(platform)}.`,
    behind === "egma"
      ? "This copy of egma is older than the platform, and it would read only part of what the platform answers. Run npx egma@latest, then run this again."
      : "The platform is older than this copy of egma, and it cannot answer everything a test file now records. Upgrade the platform, or use the egma that shipped with it.",
    "Nothing was read and nothing was uploaded.",
  ].join(" ");
}
