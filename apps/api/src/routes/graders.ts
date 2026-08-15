import {
  authorize,
  cloneGrader,
  createGrader,
  deleteGrader,
  editGrader,
  getGrader,
  GraderNamedByTestsError,
  IdentityConflictError,
  listGraderVersions,
  listGraders,
  NotPermittedError,
  ProjectOutsideOrganizationError,
  restoreGrader,
  testsNamingGrader,
  UnprocessableInputError,
  VersionConflictError,
  EXPECTED_BEHAVIORS_GRADER,
  GRADER_READS,
  GRADER_SCOPES,
  GRADER_TYPE_REGISTRY,
  PRIORITIES,
  type AuthContext,
  type Grader,
  type GraderVersion,
} from "@egma/db";
import { isId } from "@egma/ids";
import type { FastifyInstance, FastifyReply } from "fastify";

import type { SessionIdentityProvider } from "../auth/seam.ts";
import { actingIn, cannotActIn, refuseActing } from "../http/acting.ts";
import { credentialed, requesterOf } from "../http/credentialed.ts";
import type { RateLimit } from "../http/rate-limit.ts";
import { given, text } from "../http/reading.ts";
import {
  invalid,
  notPermitted,
  sendRefusal,
  unprocessable,
  REFUSALS,
} from "../http/refusals.ts";

/**
 * The graders of one project, as the browser authors them — plus the shelf of
 * everything egma can judge with, which is a larger thing than the rows.
 *
 * Three shapes here are contract rather than convenience.
 *
 * **The built-in is described and is never a row.** The expected-behaviors
 * grader judges every simulation against its own test's written-down
 * expectations, and applying it is part of what running a test *means* — so it
 * is never attached, never detached, never archived, and has no identity to
 * name (ADR-0004). It reaches the browser through the registry below, marked
 * for what it is, so that a project with no authored graders is never presented
 * as a project that makes no judgments.
 *
 * **Live and versioned are two different edits, refused apart.** The name, the
 * description, the priority, the scope, the sampling rate and the archive state
 * take effect everywhere the moment they are written and change nothing about
 * any verdict already made. The config, the judge-model override, the reads and
 * the modalities are what a verdict was *decided by*, so an edit to any of them
 * mints an immutable version and takes effect from now on. A write carries
 * `expected_revision` for the first and `expected_version_id` for the second,
 * and gets two different refusals — because renaming a grader must not make a
 * rubric edit somebody is still typing stale.
 *
 * **The type is set at create and never edited.** Every version of a grader
 * holds a config its type shapes, so changing it would leave the versions
 * behind holding parameters for a kind of judgment this grader no longer makes.
 * Clone exists for exactly that: a new identity, current settings and content,
 * and no shared history.
 */

export type GraderRoutesOptions = {
  readonly provider: SessionIdentityProvider;
  readonly rateLimit: RateLimit;
};

export const GRADER_REGISTRY_PATH = "/api/grader-registry";
export const GRADERS_PATH = "/api/graders";
export const GRADER_PATH = "/api/graders/:graderId";
export const GRADER_VERSIONS_PATH = "/api/graders/:graderId/versions";
export const GRADER_USAGE_PATH = "/api/graders/:graderId/usage";
export const GRADER_CLONE_PATH = "/api/graders/:graderId/clone";
export const GRADER_ARCHIVE_PATH = "/api/graders/:graderId/archive";
export const GRADER_RESTORE_PATH = "/api/graders/:graderId/restore";

type Body = Record<string, unknown>;

type Query = {
  readonly project?: string;
  readonly cursor?: string;
  readonly archived?: string;
};

/**
 * The keys a grader body may carry.
 *
 * Refused by name rather than ignored, on the agent and mock-tool groups'
 * terms: every key here changes what a verdict comes to mean, so a typo that
 * was quietly dropped would be a check somebody believes they configured and
 * did not. `type` is accepted on a create and refused on an edit, which the
 * edit handler says in its own words rather than through this list.
 */
const GRADER_KEYS = [
  "name",
  "description",
  "type",
  "priority",
  "scope",
  "production_sample_rate",
  "config",
  "judge_model",
  "reads",
  "modalities",
  "project",
  "expected_revision",
  "expected_version_id",
] as const;

function unknownKeyIn(body: Body): string | undefined {
  for (const key of Object.keys(body)) {
    if ((GRADER_KEYS as readonly string[]).includes(key)) continue;
    return `a grader has no key "${key}"; it holds ${GRADER_KEYS.join(", ")}`;
  }
  return undefined;
}

/** The one sentence a grader nobody can see gets, whichever way it is absent. */
function noSuchGrader(reply: FastifyReply, graderId: string): FastifyReply {
  return sendRefusal(reply, "not_found", REFUSALS.notFound("grader", graderId));
}

function refuseRole(
  reply: FastifyReply,
  auth: AuthContext,
  action: string,
): FastifyReply {
  return sendRefusal(
    reply,
    "not_permitted",
    REFUSALS.notPermitted(auth.role, action),
  );
}

/** One version, as the wire carries it — its content, and nothing live. */
function describedVersion(version: GraderVersion): Record<string, unknown> {
  return {
    id: version.id,
    version: version.version,
    type: version.type,
    config: version.config,
    judge_model: version.judgeModel,
    reads: version.reads,
    modalities: version.modalities,
    created_at: version.createdAt.toISOString(),
  };
}

/**
 * A grader as every read describes it, with the live half and the versioned
 * half **named apart on the wire**.
 *
 * A page has to be able to say which of a person's edits will mint history and
 * which will not, and a flat object of fields cannot say it. So the shape says
 * it: `revision` covers everything outside `version`, `version_id` covers
 * everything inside it, and the two are sent back on the two kinds of write.
 */
function described(grader: Grader): Record<string, unknown> {
  return {
    id: grader.id,
    project_id: grader.projectId,
    name: grader.name,
    description: grader.description,
    type: grader.type,
    priority: grader.priority,
    scope: grader.scope,
    production_sample_rate: grader.productionSampleRate,
    revision: grader.revision,
    archived_at: grader.archivedAt === null ? null : grader.archivedAt.toISOString(),
    version: grader.version,
    version_id: grader.versionId,
    config: grader.config,
    judge_model: grader.judgeModel,
    reads: grader.reads,
    modalities: grader.modalities,
    created_at: grader.createdAt.toISOString(),
    updated_at: grader.updatedAt.toISOString(),
  };
}

/** A list of text a body sent, or nothing at all when it sent something else. */
function stringList(value: unknown, field: string): readonly string[] | string {
  if (!Array.isArray(value)) {
    return `${field} is a list of text, and this request sent ${typeof value}.`;
  }
  for (const entry of value) {
    if (typeof entry !== "string") {
      return `every entry in ${field} is text, and one of them is ${typeof entry}.`;
    }
  }
  return value as readonly string[];
}

/**
 * The judge a grader insists on instead of the project's default, as a body
 * writes one — provider and model, and **never a key**.
 *
 * There is no field here a secret could travel in, which is what stops a grader
 * moving a project's judging onto an account nobody configured. `null` clears
 * the override and returns the grader to the project's judge.
 */
function judgeModelIn(
  value: unknown,
): { readonly provider: string; readonly model: string } | null | string {
  if (value === null) return null;
  if (typeof value !== "object" || Array.isArray(value)) {
    return "judge_model names a provider and a model, or is null to use the project's judge.";
  }
  const held = value as Record<string, unknown>;
  for (const key of Object.keys(held)) {
    if (key === "provider" || key === "model") continue;
    return `judge_model has no key "${key}"; it names a provider and a model, and never a key.`;
  }
  const provider = text(held.provider);
  const model = text(held.model);
  if (provider === "" || model === "") {
    return "judge_model names a provider and a model, or is null to use the project's judge.";
  }
  return { provider, model };
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
   * Everything egma can judge with, and what each kind is made of.
   *
   * **One registry, on the server.** A form holding its own copy of these would
   * be a second vocabulary free to disagree with the engine about what a
   * `metric_threshold` reads — and the disagreement would arrive as a grader
   * that reads a transcript and judges a measure, which is a check that can
   * never fire. So the browser is told, rather than knowing.
   *
   * The built-in comes back beside the authored types and is marked implicit,
   * always active, and neither editable nor removable — the three facts a shelf
   * has to state so that nobody looks for the row or tries to take it off.
   */
  app.get(GRADER_REGISTRY_PATH, async (_request, reply) => {
    return reply.send({
      types: Object.values(GRADER_TYPE_REGISTRY).map((definition) => ({
        type: definition.type,
        reads: definition.reads,
        reads_are_fixed: definition.readsAreFixed,
        modalities: definition.modalities,
        judged: definition.judged,
      })),
      reads: GRADER_READS,
      priorities: PRIORITIES,
      scopes: GRADER_SCOPES,
      built_in: [
        {
          key: EXPECTED_BEHAVIORS_GRADER.key,
          name: EXPECTED_BEHAVIORS_GRADER.name,
          description: EXPECTED_BEHAVIORS_GRADER.description,
          reads: EXPECTED_BEHAVIORS_GRADER.reads,
          modalities: EXPECTED_BEHAVIORS_GRADER.modalities,
          judged: EXPECTED_BEHAVIORS_GRADER.judged,
          implicit: true,
          always_active: true,
          editable: false,
          removable: false,
        },
      ],
    });
  });

  /** The project's authored graders, newest first, one page at a time. */
  app.get(GRADERS_PATH, async (request, reply) => {
    const { auth } = requesterOf(request);
    const query = (request.query ?? {}) as Query;

    const acting = await namingAProject(auth, given(query.project));
    if ("refusal" in acting) return refuseActing(reply, acting);

    const cursor = given(query.cursor);
    if (cursor !== undefined && !isId("grd", cursor)) {
      return invalid(
        reply,
        `"${cursor}" is not a cursor this list issued. Send the next_cursor an ` +
          "earlier page answered with, or leave it out to start at the newest " +
          "grader.",
      );
    }

    const page = await listGraders(acting.auth, {
      ...(cursor === undefined ? {} : { cursor }),
      archived: given(query.archived) === "true",
    });

    return reply.send({
      items: page.items.map(described),
      next_cursor: page.nextCursor ?? null,
    });
  });

  app.post(GRADERS_PATH, async (request, reply) => {
    const { auth } = requesterOf(request);
    const body = (request.body ?? {}) as Body;

    // The role is answered before anything is read, which is the factory's own
    // stance: a viewer is refused for being a viewer rather than after a read
    // that tells them what is there.
    if (auth.role === "viewer") return refuseRole(reply, auth, "create graders");

    const unknown = unknownKeyIn(body);
    if (unknown !== undefined) return invalid(reply, unknown);

    const shaped = shapedContent(body);
    if (typeof shaped === "string") return unprocessable(reply, shaped);

    const acting = await namingAProject(auth, given(text(body.project)));
    if ("refusal" in acting) return refuseActing(reply, acting);

    const created = await createGrader(acting.auth, {
      name: text(body.name),
      ...(body.description === undefined
        ? {}
        : { description: text(body.description) }),
      ...(body.priority === undefined ? {} : { priority: body.priority as never }),
      ...(body.scope === undefined ? {} : { scope: body.scope as never }),
      ...(body.production_sample_rate === undefined
        ? {}
        : { productionSampleRate: body.production_sample_rate as number }),
      ...(shaped.judgeModel == null ? {} : { judgeModel: shaped.judgeModel }),
      ...(shaped.reads === undefined ? {} : { reads: shaped.reads }),
      ...(shaped.modalities === undefined ? {} : { modalities: shaped.modalities }),
      type: text(body.type) as never,
      config: body.config as never,
    });

    return reply.code(201).send(described(created));
  });

  app.get(GRADER_PATH, async (request, reply) => {
    const { auth } = requesterOf(request);
    const { graderId } = request.params as { graderId: string };
    const query = (request.query ?? {}) as Query;

    const acting = await namingAProject(auth, given(query.project));
    if ("refusal" in acting) return refuseActing(reply, acting);

    // An archived grader stays readable: a run pinned it and a verdict names
    // it, so a record that vanished when somebody tidied up would make removal
    // destroy evidence.
    const grader = await getGrader(acting.auth, graderId, {
      includeArchived: true,
    });
    if (grader === undefined) return noSuchGrader(reply, graderId);

    return reply.send(described(grader));
  });

  /** Every version of one grader, newest first. */
  app.get(GRADER_VERSIONS_PATH, async (request, reply) => {
    const { auth } = requesterOf(request);
    const { graderId } = request.params as { graderId: string };
    const query = (request.query ?? {}) as Query;

    const acting = await namingAProject(auth, given(query.project));
    if ("refusal" in acting) return refuseActing(reply, acting);

    const versions = await listGraderVersions(acting.auth, graderId);
    if (versions === undefined) return noSuchGrader(reply, graderId);

    return reply.send({ items: versions.map(describedVersion) });
  });

  /**
   * Who uses this grader, and the distinction the answer exists to make.
   *
   * **A direct use blocks Archive; the project-wide default does not.** Every
   * active grader in a project applies to every one of its tests already — that
   * is the product's promise and it is not a usage anybody has to be warned
   * about. A test that names this grader in its *own* list has made a
   * scenario-specific decision, and archiving out from under it would leave
   * that test quietly checking one thing fewer than it says it checks.
   */
  app.get(GRADER_USAGE_PATH, async (request, reply) => {
    const { auth } = requesterOf(request);
    const { graderId } = request.params as { graderId: string };
    const query = (request.query ?? {}) as Query;

    const acting = await namingAProject(auth, given(query.project));
    if ("refusal" in acting) return refuseActing(reply, acting);

    const tests = await testsNamingGrader(acting.auth, graderId);
    if (tests === undefined) return noSuchGrader(reply, graderId);

    return reply.send({
      direct_tests: tests.map((test) => ({ id: test.id, name: test.name })),
      // Said rather than expanded into a row per test: a project with four
      // hundred tests would otherwise answer with four hundred rows saying one
      // thing, and the one thing is the thing worth saying.
      applies_to_every_test_by_default: true,
    });
  });

  app.patch(GRADER_PATH, async (request, reply) => {
    const { auth } = requesterOf(request);
    const { graderId } = request.params as { graderId: string };
    const body = (request.body ?? {}) as Body;

    if (auth.role === "viewer") return refuseRole(reply, auth, "edit graders");

    const unknown = unknownKeyIn(body);
    if (unknown !== undefined) return invalid(reply, unknown);

    if ("type" in body) {
      return unprocessable(
        reply,
        "a grader's type is set when it is created and cannot be changed: " +
          "every version of it holds a config that type shapes. Clone this " +
          "grader, or create a new one, to judge a different way.",
      );
    }

    const shaped = shapedContent(body);
    if (typeof shaped === "string") return unprocessable(reply, shaped);

    const acting = await namingAProject(auth, given(text(body.project)));
    if ("refusal" in acting) return refuseActing(reply, acting);

    const edited = await editGrader(
      acting.auth,
      graderId,
      {
        ...("name" in body ? { name: text(body.name) } : {}),
        ...("description" in body
          ? { description: body.description === null ? null : text(body.description) }
          : {}),
        ...("priority" in body ? { priority: body.priority as never } : {}),
        ...("scope" in body ? { scope: body.scope as never } : {}),
        ...("production_sample_rate" in body
          ? { productionSampleRate: body.production_sample_rate as number }
          : {}),
        ...("config" in body ? { config: body.config as never } : {}),
        ...("judge_model" in body ? { judgeModel: shaped.judgeModel } : {}),
        ...(shaped.reads === undefined ? {} : { reads: shaped.reads }),
        ...(shaped.modalities === undefined
          ? {}
          : { modalities: shaped.modalities }),
      },
      {
        ...(given(text(body.expected_revision)) === undefined
          ? {}
          : { expectedRevision: text(body.expected_revision) }),
        ...(given(text(body.expected_version_id)) === undefined
          ? {}
          : { expectedVersionId: text(body.expected_version_id) }),
      },
    );

    if (edited === undefined) return noSuchGrader(reply, graderId);
    return reply.send(described(edited));
  });

  /**
   * The same grader again under a new identity, and **no shared history**.
   *
   * Copying the lineage would make two identities share a past, and the first
   * question anybody asks of a version history — what did this check mean when
   * that run was judged — would then have two answers.
   */
  app.post(GRADER_CLONE_PATH, async (request, reply) => {
    const { auth } = requesterOf(request);
    const { graderId } = request.params as { graderId: string };
    const body = (request.body ?? {}) as Body;

    if (auth.role === "viewer") return refuseRole(reply, auth, "clone graders");

    const acting = await namingAProject(auth, given(text(body.project)));
    if ("refusal" in acting) return refuseActing(reply, acting);

    const cloned = await cloneGrader(acting.auth, graderId, {
      ...(given(text(body.name)) === undefined ? {} : { name: text(body.name) }),
    });
    if (cloned === undefined) return noSuchGrader(reply, graderId);

    return reply.code(201).send(described(cloned));
  });

  app.post(GRADER_ARCHIVE_PATH, async (request, reply) => {
    const { auth } = requesterOf(request);
    const { graderId } = request.params as { graderId: string };
    const body = (request.body ?? {}) as Body;

    if (auth.role === "viewer") return refuseRole(reply, auth, "archive graders");

    const acting = await namingAProject(auth, given(text(body.project)));
    if ("refusal" in acting) return refuseActing(reply, acting);

    const archived = await deleteGrader(acting.auth, graderId, {
      ...(given(text(body.expected_revision)) === undefined
        ? {}
        : { expectedRevision: text(body.expected_revision) }),
    });
    if (archived === undefined) return noSuchGrader(reply, graderId);

    const grader = await getGrader(acting.auth, graderId, {
      includeArchived: true,
    });
    if (grader === undefined) return noSuchGrader(reply, graderId);
    return reply.send(described(grader));
  });

  app.post(GRADER_RESTORE_PATH, async (request, reply) => {
    const { auth } = requesterOf(request);
    const { graderId } = request.params as { graderId: string };
    const body = (request.body ?? {}) as Body;

    if (auth.role === "viewer") return refuseRole(reply, auth, "restore graders");

    const acting = await namingAProject(auth, given(text(body.project)));
    if ("refusal" in acting) return refuseActing(reply, acting);

    const restored = await restoreGrader(acting.auth, graderId, {
      ...(given(text(body.expected_revision)) === undefined
        ? {}
        : { expectedRevision: text(body.expected_revision) }),
    });
    if (restored === undefined) return noSuchGrader(reply, graderId);

    return reply.send(described(restored));
  });

  /**
   * The refusals this group owns, each carrying the sentence a page shows.
   *
   * The two conflicts are answered apart because a client's next move differs:
   * one says reread the identity and resend with a new revision, the other says
   * reread the content and resend with a new version.
   */
  app.setErrorHandler(async (error, _request, reply) => {
    if (error instanceof IdentityConflictError) {
      return sendRefusal(
        reply,
        "identity_conflict",
        REFUSALS.identityConflict(error.resource, error.resourceId),
      );
    }

    if (error instanceof VersionConflictError) {
      return sendRefusal(
        reply,
        "version_conflict",
        REFUSALS.versionConflict(error.resource, error.expected, error.current),
      );
    }

    if (error instanceof GraderNamedByTestsError) {
      return sendRefusal(
        reply,
        "grader_in_use",
        REFUSALS.graderInUse(
          error.graderId,
          error.tests.map((test) => `${test.id} "${test.name}"`).join(", "),
        ),
      );
    }

    if (error instanceof UnprocessableInputError) {
      return unprocessable(reply, error.message);
    }

    // Reachable only in a race — the project was checked before the write, and
    // this is what a delete landing in between looks like from inside it.
    if (error instanceof ProjectOutsideOrganizationError) {
      return notPermitted(reply, cannotActIn(error.projectId));
    }

    if (error instanceof NotPermittedError) {
      return notPermitted(reply, error.message);
    }

    // The factory's own write-door refusals are plain errors carrying a
    // sentence a person can act on — a rubric with no criteria, a threshold
    // naming a measure the catalog does not. Answered as what they are rather
    // than as a fault, and word for word.
    if (error instanceof Error && !("statusCode" in error)) {
      return unprocessable(reply, error.message);
    }

    throw error;
  });
}

/**
 * The acting project, with the browser's own missing-project refusal.
 *
 * Every product page carries its project in the address and therefore in the
 * request. A session that named none is not a request to be answered about
 * whichever project happens to be oldest — it is a page that lost its context,
 * and the one thing to do about it is the one thing the sentence names.
 *
 * A key is a different matter and keeps the old rule: one minted for a project
 * acts in that project, and one for the whole organization resolves the single
 * project a v1 organization has.
 */
async function namingAProject(auth: AuthContext, named: string | undefined) {
  if (auth.via === "session" && named === undefined) {
    return { refusal: REFUSALS.projectRequired, code: "project_required" as const };
  }
  return actingIn(auth, named);
}

/**
 * The parts of a body that need shaping before the factory sees them, checked
 * together so a request carrying two mistakes is told about the first rather
 * than about neither.
 */
function shapedContent(body: Body):
  | {
      readonly judgeModel:
        | { readonly provider: string; readonly model: string }
        | null;
      readonly reads: readonly string[] | undefined;
      readonly modalities: readonly string[] | undefined;
    }
  | string {
  const judgeModel = "judge_model" in body ? judgeModelIn(body.judge_model) : null;
  if (typeof judgeModel === "string") return judgeModel;

  let reads: readonly string[] | undefined;
  if ("reads" in body) {
    const shaped = stringList(body.reads, "reads");
    if (typeof shaped === "string") return shaped;
    reads = shaped;
  }

  let modalities: readonly string[] | undefined;
  if ("modalities" in body) {
    const shaped = stringList(body.modalities, "modalities");
    if (typeof shaped === "string") return shaped;
    modalities = shaped;
  }

  return { judgeModel, reads, modalities };
}
