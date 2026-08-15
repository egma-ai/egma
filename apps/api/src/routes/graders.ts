import {
  authorize,
  deleteGrader,
  listGraders,
  NotPermittedError,
  ProjectOutsideOrganizationError,
  UnknownGraderLibraryEntryError,
  UnprocessableInputError,
  useLibraryEntry,
  type Grader,
} from "@egma/db";
import { isId } from "@egma/ids";
import type { FastifyInstance } from "fastify";

import type { SessionIdentityProvider } from "../auth/seam.ts";
import { actingIn, refuseActing } from "../http/acting.ts";
import { credentialed, requesterOf } from "../http/credentialed.ts";
import {
  invalid,
  notFound,
  notPermitted,
  REFUSALS,
  unprocessable,
} from "../http/refusals.ts";
import type { RateLimit } from "../http/rate-limit.ts";
import { given, text } from "../http/reading.ts";

/**
 * The running graders: the copies a project actually judges with, the one act
 * that makes another — pressing **Use** on a library entry — and the one act
 * that stops one.
 *
 * **Three verbs, and the missing one is the product decision.** There is no
 * create taking a type and criteria, because a grader is always a copy *of*
 * something: the entry decides what kind of judgment it is and what the form
 * asks for, and the copy holds the answers. The custom-grader authoring surface
 * that the grading effort designed is shelved with this change — the machinery
 * behind it stays, versioning and all, and hosts egma's own two entries — so a
 * team meets a small shelf of graders that already work rather than a blank
 * form on their first day.
 *
 * **Delete is not part of that authoring surface, and it took a wave to notice
 * that it was being treated as though it were.** ADR-0009 shelved *defining*
 * graders; it made switching one off the plainest act in the area — "dormant is
 * no copy at all; there is no enable switch and no `none` value". The data
 * access module has said so since the redesign landed, the start-up backfill is
 * built around a person having taken that decision, and the door that would let
 * anybody take it was never registered. So a product whose only loudness
 * control is delete had no delete, and the screens that displayed the running
 * copies could only display them. It is a verb here now. Edit is still absent,
 * because editing a copy's values is the authoring surface, and that is what
 * was shelved.
 *
 * **A copy's definition never crosses this door.** What a read answers is the
 * pointer, the filled-in values, and where the grader applies. The judge prompt
 * is on the library entry and is read from `/api/grader-library`, which is the
 * same place the engine reads it at judging time — so the words on screen and
 * the words a model is sent are one row.
 *
 * The addresses follow the standing rule: nothing is rooted at a project and
 * the organization is never in a path. A write may name a project in its body
 * and a read may filter by one; neither has to, and in a single-project
 * organization nothing ever does.
 */

export type GraderRoutesOptions = {
  readonly provider: SessionIdentityProvider;
  readonly rateLimit: RateLimit;
};

export const GRADERS_PATH = "/api/graders";
export const GRADER_PATH = "/api/graders/:graderId";

type Body = Record<string, unknown>;

type Query = {
  readonly project?: string;
  readonly cursor?: string;
};

const USE_KEYS = [
  "library_id",
  "params",
  "name",
  "description",
  "required",
  "scope",
  "production_sample_rate",
  "project",
] as const;

/**
 * The unknown-key gate, the agent group's for the agent group's reason — and
 * with one more of its own here: every key in this body decides what a project
 * is judged by or how loudly, so a typo quietly ignored would be a grader
 * somebody believes they configured and did not.
 */
function unknownKeyIn(body: Body): string | undefined {
  for (const key of Object.keys(body)) {
    if ((USE_KEYS as readonly string[]).includes(key)) continue;
    return `Use takes no key "${key}"; it takes ${USE_KEYS.join(", ")}`;
  }
  return undefined;
}

/**
 * One running copy as every read of one describes it.
 *
 * `library_id` rides at the front because it is what this row *is*: everything
 * a person wants to know about how it judges is read through it. The config is
 * the copy's own filled-in values and nothing else — no prompt, no criteria,
 * because those are the entry's and are never written down here.
 */
function described(one: Grader): Record<string, unknown> {
  return {
    id: one.id,
    library_id: one.libraryId,
    project_id: one.projectId,
    name: one.name,
    description: one.description,
    type: one.type,
    required: one.required,
    scope: one.scope,
    production_sample_rate: one.productionSampleRate,
    version: one.version,
    version_id: one.versionId,
    config: one.config,
    created_at: one.createdAt.toISOString(),
    updated_at: one.updatedAt.toISOString(),
  };
}

/** The filled-in values a body sent, or a refusal saying what shape they take. */
type WrittenParams =
  | { readonly params: Readonly<Record<string, unknown>> | undefined }
  | { readonly refusal: string };

function paramsIn(body: Body): WrittenParams {
  if (!("params" in body) || body.params === undefined || body.params === null) {
    return { params: undefined };
  }
  const params = body.params;
  if (typeof params !== "object" || Array.isArray(params)) {
    return {
      refusal:
        "params is what the library entry's form asked for, filled in — an " +
        'object like {"metric": "turn_response_latency", "bound": 2000}. Read ' +
        "the library entry to see what it asks for; some ask for nothing.",
    };
  }
  return { params: params as Readonly<Record<string, unknown>> };
}

/** A flag a body sent, refused rather than coerced: `"false"` is not false. */
type WrittenFlag =
  | { readonly value: boolean | undefined }
  | { readonly refusal: string };

function requiredIn(body: Body): WrittenFlag {
  if (!("required" in body) || body.required === undefined) {
    return { value: undefined };
  }
  if (typeof body.required !== "boolean") {
    return {
      refusal:
        "required says whether a test can pass while this grader does not: " +
        "true blocks, false makes it a diagnostic that reports and never " +
        `fails anything. Send it as true or false, and this request sent ${typeof body.required}.`,
    };
  }
  return { value: body.required };
}

/** A number a body sent, refused rather than dropped: `"10"` is not 10. */
type WrittenRate =
  | { readonly value: number | undefined }
  | { readonly refusal: string };

/**
 * How much production traffic this grader judges, as a body sends it.
 *
 * **Refused rather than ignored**, on the unknown-key gate's exact terms and
 * for a worse version of its reason. A rate that arrived as text and was
 * quietly dropped leaves the copy judging *all* of production while the team
 * that sent `"10"` believes it judges a tenth — every live conversation asked
 * of a model, and billed, on a setting somebody thinks they chose. The shape is
 * checked here; whether the number is a whole percentage is the factory's rule,
 * refused in the factory's own words, because this door has no business holding
 * a second opinion about that.
 */
function sampleRateIn(body: Body): WrittenRate {
  if (
    !("production_sample_rate" in body) ||
    body.production_sample_rate === undefined
  ) {
    return { value: undefined };
  }
  if (typeof body.production_sample_rate !== "number") {
    return {
      refusal:
        "production_sample_rate is what share of live traffic this grader " +
        "judges, as a whole percentage between 0 and 100. Send it as a " +
        `number, and this request sent ${typeof body.production_sample_rate}.`,
    };
  }
  return { value: body.production_sample_rate };
}

export async function graderRoutes(
  app: FastifyInstance,
  options: GraderRoutesOptions,
): Promise<void> {
  credentialed(app, {
    provider: options.provider,
    rateLimit: options.rateLimit,
  });

  /**
   * The project's running graders, newest first, one page at a time.
   *
   * `{ items, next_cursor }` is the envelope every list in this API answers
   * with, and the cursor is the last id of the page rather than a count of rows
   * to skip.
   */
  app.get(GRADERS_PATH, async (request, reply) => {
    const { auth } = requesterOf(request);
    const query = (request.query ?? {}) as Query;

    const acting = await actingIn(auth, given(query.project));
    if ("refusal" in acting) return refuseActing(reply, acting);

    const cursor = given(query.cursor);
    if (cursor !== undefined && !isId("grd", cursor)) {
      return invalid(
        reply,
        `"${cursor}" is not a cursor this list issued. Send the next_cursor ` +
          `an earlier page answered with, or leave it out to start at the ` +
          `newest grader.`,
      );
    }

    const page = await listGraders(acting.auth, { cursor });

    return reply.send({
      items: page.items.map(described),
      // Null rather than absent, so a client can tell "there is no next page"
      // from "this response is an older shape that never had one".
      next_cursor: page.nextCursor ?? null,
    });
  });

  /**
   * **Use**: start judging with a library entry.
   *
   * The copy and its first version land in one transaction, and the values are
   * checked against what the entry actually asks for — so a bound sent for an
   * entry that asks for none, or a measure egma does not compute, is refused
   * here rather than becoming a grader that is `skipped` forever.
   *
   * The role is checked before anything is read, which is the stance the
   * factory takes for the same reason: a viewer is refused for being a viewer,
   * rather than after a read that tells them what is there.
   */
  app.post(GRADERS_PATH, async (request, reply) => {
    const { auth } = requesterOf(request);
    const body = (request.body ?? {}) as Body;

    authorize(auth, "author_definitions", {
      organizationId: auth.organizationId,
      projectId: auth.projectId,
    });

    // Everything answerable without reading anything is answered first, so a
    // body that could never be written is refused before it can learn what
    // this project holds.
    const unknown = unknownKeyIn(body);
    if (unknown !== undefined) return invalid(reply, unknown);

    const libraryId = text(body.library_id);
    if (!isId("grl", libraryId)) {
      return invalid(
        reply,
        "library_id names the grader on the shelf to start judging with, as " +
          "its grl_ identifier. Read the library to see what egma ships.",
      );
    }

    const params = paramsIn(body);
    if ("refusal" in params) return unprocessable(reply, params.refusal);

    const required = requiredIn(body);
    if ("refusal" in required) return unprocessable(reply, required.refusal);

    const sampleRate = sampleRateIn(body);
    if ("refusal" in sampleRate) return unprocessable(reply, sampleRate.refusal);

    const acting = await actingIn(auth, given(text(body.project)));
    if ("refusal" in acting) return refuseActing(reply, acting);

    const created = await useLibraryEntry(acting.auth, {
      libraryId,
      ...(params.params === undefined ? {} : { params: params.params }),
      ...(given(text(body.name)) === undefined ? {} : { name: text(body.name) }),
      ...(given(text(body.description)) === undefined
        ? {}
        : { description: text(body.description) }),
      ...(required.value === undefined ? {} : { required: required.value }),
      ...(given(text(body.scope)) === undefined
        ? {}
        : { scope: text(body.scope) as Grader["scope"] }),
      ...(sampleRate.value === undefined
        ? {}
        : { productionSampleRate: sampleRate.value }),
    });

    return reply.code(201).send(described(created));
  });

  /**
   * Stop judging with a copy.
   *
   * **This is the whole of the off switch, and there is deliberately no
   * other.** A copy that exists judges everything in its scope; there is no
   * enabled flag to clear and no `none` scope to choose, so switching a grader
   * off is deleting the row that was doing the judging. Pressing Use on the
   * same library entry starts a new copy whenever somebody wants one back.
   *
   * **What has already been judged does not move.** The copy is marked deleted
   * rather than removed: its version rows stay exactly where they are, so every
   * verdict that named one stays interpretable for as long as it is kept, and a
   * run that froze this copy into its plan keeps judging with what it froze.
   * The row simply stops entering new plans.
   *
   * **Including the seeded expected-behaviors copy**, which is the sentence
   * this door exists to make true. A project may end up judged by nothing at
   * all — the run door lets that project start runs, and they come back with
   * nothing judged — because a copy somebody may delete cannot also be a thing
   * every run is assumed to carry.
   *
   * A copy this credential cannot see reads exactly as one that is not there:
   * to this caller those are the same thing, and confirming that somebody
   * else's row exists is itself a leak.
   */
  app.delete(GRADER_PATH, async (request, reply) => {
    const { auth } = requesterOf(request);
    const { graderId } = request.params as { graderId: string };
    const query = (request.query ?? {}) as Query;

    // The role first, before anything is read — the factory's own stance, so a
    // viewer is refused for being a viewer rather than after a read that tells
    // them what is there.
    authorize(auth, "author_definitions", {
      organizationId: auth.organizationId,
      projectId: auth.projectId,
    });

    const acting = await actingIn(auth, given(query.project));
    if ("refusal" in acting) return refuseActing(reply, acting);

    const removed = await deleteGrader(acting.auth, graderId);
    if (removed === undefined) {
      return notFound(reply, REFUSALS.notFound("grader", graderId));
    }

    return reply.send({
      id: removed.id,
      name: removed.name,
      deleted_at: removed.deletedAt.toISOString(),
    });
  });

  /**
   * This group's refusals. A body naming an entry that is not on this caller's
   * shelf and a body whose values the entry never asked for are both **422**:
   * nothing about the request is malformed, and what it says cannot be done.
   */
  app.setErrorHandler(async (error, _request, reply) => {
    if (error instanceof NotPermittedError) {
      return notPermitted(reply, error.message);
    }
    if (error instanceof UnknownGraderLibraryEntryError) {
      return unprocessable(reply, error.message);
    }
    if (error instanceof UnprocessableInputError) {
      return unprocessable(reply, error.message);
    }
    if (error instanceof ProjectOutsideOrganizationError) {
      return unprocessable(reply, error.message);
    }
    throw error;
  });
}
