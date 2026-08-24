/**
 * What a refused start means, in plain words, and what to do about it.
 *
 * The platform writes a sentence for every refusal and Egma relays it word for
 * word — that is the house rule (ADR-0007) and it is not being broken here.
 * What this adds is the half a relay cannot carry: the platform answers about
 * *its* rows, and the developer is standing in a repository. So both are said.
 * Egma's own sentence names what happened and the next move; the platform's own
 * sentence rides beside it for whatever is reading rather than looking.
 *
 * Every reason is written out. A default sentence would be the one a new
 * refusal reason silently inherits, and inheriting somebody else's advice is
 * worse than saying nothing.
 */

import type { StartRefusalReason } from "../platform/monitoring.ts";

/** Egma's own sentence per reason: what happened, and what to do. */
export function refusalLine(reason: StartRefusalReason): string {
  switch (reason) {
    case "contested":
      return (
        "Another Egma agent is already watching that agent on the platform. " +
        "One Egma agent watches one platform agent, so turn that agent's " +
        "switch off first, or start monitoring from it instead."
      );
    case "name_taken":
      return (
        "This project already has an Egma agent with the name this one would " +
        "take. Rename one of them, then run this again."
      );
    case "not_found":
      return (
        "Egma has no such agent in this project. Check which project you are " +
        "signed in to, then choose the agent from the account list again."
      );
    case "archived":
      return (
        "That Egma agent is archived, and an archived agent watches nothing. " +
        "Restore it in Egma, then start monitoring it."
      );
  }
}

/**
 * The whole of what one refusal says: Egma's sentence, then the platform's.
 *
 * Two lines and not one, because they answer different questions and a reader
 * skimming for the second must not have to unpick a sentence to find it.
 */
export function refusalLines(refusal: {
  readonly reason: StartRefusalReason;
  readonly message: string;
}): readonly string[] {
  return refusal.message.trim() === ""
    ? [refusalLine(refusal.reason)]
    : [refusalLine(refusal.reason), refusal.message.trim()];
}
