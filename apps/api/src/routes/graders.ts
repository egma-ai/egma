import {
  authorize,
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
import { invalid, notPermitted, unprocessable } from "../http/refusals.ts";
import type { RateLimit } from "../http/rate-limit.ts";
import { given, text } from "../http/reading.ts";

/**
 * The running graders: the copies a project actually judges with, and the one
 * act that makes another — pressing **Use** on a library entry.
 *
 * **Two verbs, and the missing ones are the product decision.** There is no
 * create taking a type and criteria, because a grader is always a copy *of*
 * something: the entry decides what kind of judgment it is and what the form
 * asks for, and the copy holds the answers. The custom-grader authoring surface
 * that the grading effort designed is shelved with this change — the machinery
 * behind it stays, versioning and all, and hosts egma's own two entries — so a
 * team meets a small shelf of graders that already work rather than a blank
 * form on their first day.
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
      ...(typeof body.production_sample_rate === "number"
        ? { productionSampleRate: body.production_sample_rate }
        : {}),
    });

    return reply.code(201).send(described(created));
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
