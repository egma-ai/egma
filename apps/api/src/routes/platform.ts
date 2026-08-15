import { platformFacts, platformInstanceId } from "@egma/db";
import type { FastifyPluginAsync } from "fastify";

import { phoneReadiness } from "../phone-readiness.ts";
import { platformReadiness } from "../platform-readiness.ts";

export type PlatformRouteOptions = {
  /** The one browser/API origin configured for this platform. */
  readonly origin: string;
};

/**
 * Where this contract answers.
 *
 * The CLI reads it at the origin a self-hoster was given, which is the web
 * process rather than this one, so the web rewrites have to carry the same
 * path. It is a constant here so the agreement between the three can be
 * checked rather than remembered.
 */
export const PLATFORM_IDENTITY_PATH = "/api/platform";

/**
 * Which repository-facing contract this platform speaks.
 *
 * **The promise this project makes about `/api/tests` is that the CLI and the
 * platform ship together, and that a mismatch is loud.** That surface is
 * internal — it is not `/api/v1` and nothing outside egma is invited to build
 * on it — so it is free to change shape when the product needs it to. What it
 * is not free to do is change shape quietly: a client reading a field it no
 * longer understands must be told that, in one sentence, before it writes
 * anything.
 *
 * The cost of not saying it was measured rather than imagined. Priorities on
 * expected behaviors turned each entry from text into an object; a CLI built
 * before that reads the objects as empty text and drops them, so it pulls a
 * folder of tests with no behaviors at all. Nothing crashed and nothing looked
 * wrong. What stopped the emptied folder being written back was a rule in a
 * different part of the product — a version holds at least one behavior and at
 * least one P0 — so the push was refused, correctly, with a sentence about
 * falsifiability that had nothing to do with what had actually happened.
 * Protection by accident, reported as the wrong problem.
 *
 * So: one integer, monotonic, bumped whenever a shape a repository client reads
 * or writes changes. A client compares it with the number it was built for and
 * refuses on any difference, naming which side is behind and the one command
 * that fixes it. A platform that answers no number at all is contract 1 — the
 * shape that shipped before this field existed.
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

/** Public platform facts used before device login and repository binding. */
export const platformRoutes: FastifyPluginAsync<PlatformRouteOptions> = async (
  app,
  options,
) => {
  app.get(PLATFORM_IDENTITY_PATH, async (_request, reply) => {
    // Read from the store on every request rather than held from start, which
    // is the whole point of the settings living there: an operator who supplies
    // a missing key stops being `setup required` at once, without a restart.
    // It is a select and never an insert, on the identity read's own reasoning
    // — this door is public and anybody who can reach the platform may knock as
    // often as they like.
    //
    // One read for both answers. They are two facts about one deployment, and
    // reading twice would let them be two facts about two moments.
    const held = await platformFacts();
    const setup = platformReadiness(held);
    const phone = phoneReadiness(held);

    return reply.send({
      instance_id: await platformInstanceId(),
      origin: options.origin,
      // Which shape this platform speaks to a repository. Read before either
      // sync verb does anything, so an egma older or newer than this one says
      // so plainly instead of quietly reading half of what came back.
      repository_contract: REPOSITORY_CONTRACT,
      // What the whole platform is still missing, in the words a person would
      // use, and never a secret — see `platform-readiness.ts`.
      setup: { state: setup.state, missing: setup.missing },
      // Two facts, never one: a platform is ready for text work long before
      // anybody has given it a carrier, and a single "ready" that waited for
      // the carrier would make the first-run story impossible to tell.
      phone: { state: phone.state, missing: phone.missing },
    });
  });
};
