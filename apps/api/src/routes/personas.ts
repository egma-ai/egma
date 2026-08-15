import {
  archivePersona,
  clonePersona,
  createPersona,
  DefaultPersonaReplacementError,
  editPersona,
  getPersona,
  getPersonaVersion,
  IdentityConflictError,
  listPersonas,
  listPersonaVersions,
  NotPermittedError,
  permits,
  PersonaNamedByTestsError,
  ProjectOutsideOrganizationError,
  restorePersona,
  testsUsingPersona,
  UnprocessableInputError,
  VersionConflictError,
  VOICE_PROVIDERS,
  type AuthContext,
  type Persona,
  type PersonaTraits,
  type PersonaVersion,
} from "@egma/db";
import { isId } from "@egma/ids";
import type { FastifyInstance, FastifyReply } from "fastify";

import type { SessionIdentityProvider } from "../auth/seam.ts";
import { actingIn, refuseActing, type Acting } from "../http/acting.ts";
import { credentialed, requesterOf } from "../http/credentialed.ts";
import type { RateLimit } from "../http/rate-limit.ts";
import { given, text } from "../http/reading.ts";
import { sendRefusal } from "../http/refusals.ts";

/**
 * The personas of one project: the list, one of them, their history, what
 * uses them, and the six writes.
 *
 * A **persona** is the synthetic person who calls the agent — manner,
 * patience, accent, speech rate, background noise, and what they do when
 * things go wrong. They belong to the project rather than to an agent or to a
 * test, which is what lets one persona call about forty different situations
 * and lets two prompt variants be compared against the same caller.
 *
 * Three shapes here are contract rather than convenience.
 *
 * **Identity is live and content is versioned, and the wire says which is
 * which.** Name, description and archive state are written in place. Traits
 * mint an immutable version, and traits byte-identical to the current version
 * mint nothing. So a write names *two* expectations where it touches both:
 * `expected_revision` for the identity and `expected_version_id` for the
 * content, refused separately because they are separately recoverable.
 *
 * **A persona is never deleted.** Archive takes them out of the lists somebody
 * authors from and leaves every row where it was; Restore is an ordinary write.
 * The two rules that can refuse an Archive — an active test naming them, and
 * the project's default pointer — each get their own sentence, because the fix
 * for each is somewhere else.
 *
 * **Names are not unique, so nothing here is addressed by one.** Every address
 * and every reference is a stable `prs_` identifier. Two personas called
 * "Impatient caller" is an ordinary thing for a project to hold, and a surface
 * that resolved a name would have to pick one of them.
 */

export type PersonaRoutesOptions = {
  readonly provider: SessionIdentityProvider;
  readonly rateLimit: RateLimit;
};

export const PERSONAS_PATH = "/api/personas";
export const PERSONA_PATH = "/api/personas/:personaId";
export const PERSONA_VERSIONS_PATH = "/api/personas/:personaId/versions";
export const PERSONA_USAGE_PATH = "/api/personas/:personaId/usage";
export const PERSONA_CLONE_PATH = "/api/personas/:personaId/clone";
export const PERSONA_ARCHIVE_PATH = "/api/personas/:personaId/archive";
export const PERSONA_RESTORE_PATH = "/api/personas/:personaId/restore";
export const PERSONA_VERSION_PATH = "/api/persona-versions/:versionId";
export const PERSONA_FORM_PATH = "/api/persona-form";

type Body = Record<string, unknown>;

type Query = {
  readonly project?: string;
  readonly cursor?: string;
  readonly archived?: string;
};

/* ---------------------------------------------------------------- refusals */

/**
 * The sentences this group answers with, written out here because they are the
 * contract.
 *
 * Each is the exact template the effort settled on, with its placeholders
 * filled and the sentence around them untouched. They live together rather
 * than at their call sites so that a reader can see the whole vocabulary of
 * this surface at once, and so that improving one is one edit.
 */
const REFUSALS = {
  notFound: (resource: string, resourceId: string): string =>
    `There is no ${resource} ${resourceId} available in this project. ` +
    `Check the link, or choose it from the current project.`,

  notPermitted: (role: string, action: string): string =>
    `Your ${role} role cannot ${action}. Ask an organization admin to change ` +
    `your role, then try again.`,

  projectRequired: (): string =>
    "This request did not name a project. Choose a project from the selector " +
    "and try again.",

  personaInUse: (personaId: string, tests: string): string =>
    `Persona ${personaId} is used by active tests ${tests}. Select another ` +
    `persona on those tests, or archive the tests, then archive this persona.`,

  defaultPersonaRequired: (personaId: string): string =>
    `Persona ${personaId} is this project's default. Select an active ` +
    `replacement persona in the Archive action and try again.`,

  identityConflict: (resource: string, resourceId: string): string =>
    `${resource} ${resourceId} changed after you opened it. Read it again, ` +
    `keep or reapply your edits, and send the update with expected_revision ` +
    `set to its new revision.`,

  versionConflict: (
    resource: string,
    expected: string,
    current: string,
  ): string =>
    `this ${resource} edit was written against version ${expected}, and it ` +
    `has moved on to ${current}. Read the ${resource} again, keep or reapply ` +
    `your edits, and send them with expected_version_id set to ${current}.`,

  invalidCursor: (cursor: string): string =>
    `Cursor ${cursor} is not valid for this list. Remove it and start from ` +
    `the first page.`,
} as const;

/** How a refusal names a persona nobody here can see. */
function noSuchPersona(reply: FastifyReply, personaId: string): FastifyReply {
  return sendRefusal(reply, "not_found", REFUSALS.notFound("persona", personaId));
}

/**
 * Whether this credential may author here, answered before anything is read.
 *
 * **The server is the boundary and the browser is not.** A viewer's write is
 * refused here whether or not a page ever offered them a control, and the
 * data-access module refuses it again underneath — this one exists so that the
 * refusal carries the sentence a person can act on rather than the factory's
 * internal one.
 *
 * It is checked *first*, before the persona is looked for, so that a viewer is
 * refused for being a viewer rather than told which personas exist.
 */
function mayAuthor(
  reply: FastifyReply,
  auth: AuthContext,
  action: string,
): FastifyReply | undefined {
  if (
    permits(auth, "author_definitions", {
      organizationId: auth.organizationId,
      projectId: auth.projectId,
    })
  ) {
    return undefined;
  }
  return sendRefusal(
    reply,
    "not_permitted",
    REFUSALS.notPermitted(auth.role, action),
  );
}

/* -------------------------------------------------------------- the shapes */

/** A persona, as every read of one describes it. */
function describedPersona(one: Persona): Record<string, unknown> {
  return {
    id: one.id,
    project_id: one.projectId,
    name: one.name,
    description: one.description,
    version: one.version,
    version_id: one.versionId,
    traits: one.traits,
    // The two expectations a write can name, always answered, so that reading
    // a persona is always enough to edit one.
    revision: one.revision,
    archived_at: one.archivedAt?.toISOString() ?? null,
    is_default: one.isDefault,
    created_at: one.createdAt.toISOString(),
    updated_at: one.updatedAt.toISOString(),
  };
}

/** One frozen version of one, as history and the older-version read show it. */
function describedVersion(one: PersonaVersion): Record<string, unknown> {
  return {
    id: one.id,
    persona_id: one.personaId,
    version: one.version,
    traits: one.traits,
    created_at: one.createdAt.toISOString(),
  };
}

/**
 * The traits a body carries, as the factory takes them.
 *
 * Almost nothing is judged here. Which voice providers exist, what a speaking
 * speed may be, and which fields a persona cannot be written without are the
 * factory's rules, and a second opinion at this door could come to disagree
 * with the one that decides. What this owns is the envelope: that traits are an
 * object with a voice in them, and that a body which is not that shape is
 * refused rather than quietly read as an empty persona.
 */
type WrittenTraits =
  | { readonly traits: PersonaTraits }
  | { readonly refusal: string };

function traitsIn(value: unknown): WrittenTraits {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {
      refusal:
        "traits describe who the persona is. Send them as an object, with " +
        "personality, language and a voice in it.",
    };
  }
  const held = value as Body;
  const voice = held.voice;
  if (typeof voice !== "object" || voice === null || Array.isArray(voice)) {
    return {
      refusal:
        "a persona's voice is an object naming its provider, that provider's " +
        "voice id, and the speaking speed.",
    };
  }
  const spoken = voice as Body;

  const described = (key: string): Record<string, string> => {
    const written = held[key];
    return typeof written === "string" ? { [key]: written } : {};
  };

  return {
    traits: {
      personality: text(held.personality),
      language: text(held.language),
      voice: {
        // Handed on as they arrived: the factory names a provider egma does
        // not know and a speed outside the intelligible range in its own
        // words, and those are the words worth relaying.
        provider: spoken.provider as PersonaTraits["voice"]["provider"],
        voiceId: text(spoken.voiceId),
        speed: spoken.speed as number,
      },
      ...described("manner"),
      ...described("patience"),
      ...described("accent"),
      ...described("backgroundNoise"),
      ...described("underFriction"),
    } as PersonaTraits,
  };
}

/* ------------------------------------------------------------ the project */

/**
 * Which project this request is about.
 *
 * **A browser names it every time.** The project a tab is looking at lives in
 * that tab's address and nowhere else, so a session that named none is a
 * request egma cannot answer — and answering it about *some* project would be
 * the silent narrowing this codebase has already had to find once. An API key
 * is different: one minted for a project already names it, and
 * `actingIn` resolves that without the caller repeating it.
 */
async function projectFor(
  auth: AuthContext,
  named: string | undefined,
): Promise<Acting> {
  if (auth.via === "session" && named === undefined) {
    return { refusal: REFUSALS.projectRequired(), code: "project_required" };
  }
  return actingIn(auth, named);
}

/* -------------------------------------------------------------- the routes */

export async function personaRoutes(
  app: FastifyInstance,
  options: PersonaRoutesOptions,
): Promise<void> {
  credentialed(app, {
    provider: options.provider,
    rateLimit: options.rateLimit,
  });

  /**
   * The project's personas, newest first, one page at a time.
   *
   * **Two lists, chosen by `archived`, never one with a column saying which.**
   * An authoring list that mixed archived rows into active ones is a list
   * somebody picks the wrong row out of.
   */
  app.get(PERSONAS_PATH, async (request, reply) => {
    const { auth } = requesterOf(request);
    const query = (request.query ?? {}) as Query;

    const acting = await projectFor(auth, given(query.project));
    if ("refusal" in acting) return refuseActing(reply, acting);

    const cursor = given(query.cursor);
    if (cursor !== undefined && !isId("prs", cursor)) {
      return sendRefusal(
        reply,
        "invalid_cursor",
        REFUSALS.invalidCursor(cursor),
      );
    }

    const page = await listPersonas(acting.auth, {
      cursor,
      archived: query.archived === "true",
    });

    return reply.send({
      items: page.items.map(describedPersona),
      // Null rather than absent, so a client can tell "there is no next page"
      // from "this answer is an older shape that never had one".
      next_cursor: page.nextCursor ?? null,
    });
  });

  /**
   * The safe projection of what the persona form is allowed to offer.
   *
   * **The list of voices egma can ask for is the server's, and the browser
   * gets it from here rather than keeping a copy.** A hand-written copy is
   * wrong the day the list grows and wrong silently: the form goes on offering
   * yesterday's providers, and the one that arrived is unreachable from the
   * only place a persona is authored. It is the same rule the connection form
   * follows, one resource earlier.
   *
   * It is a read like any other, so it names a project like any other — not
   * because the answer differs per project, but because a surface with one
   * request that skips the project check is a surface with one hole in it.
   */
  app.get(PERSONA_FORM_PATH, async (request, reply) => {
    const { auth } = requesterOf(request);
    const query = (request.query ?? {}) as Query;

    const acting = await projectFor(auth, given(query.project));
    if ("refusal" in acting) return refuseActing(reply, acting);

    return reply.send({ voice_providers: VOICE_PROVIDERS });
  });

  /** One persona, active or archived — a detail page has to render both. */
  app.get(PERSONA_PATH, async (request, reply) => {
    const { auth } = requesterOf(request);
    const { personaId } = request.params as { personaId: string };
    const query = (request.query ?? {}) as Query;

    const acting = await projectFor(auth, given(query.project));
    if ("refusal" in acting) return refuseActing(reply, acting);

    const one = await getPersona(acting.auth, personaId);
    if (one === undefined) return noSuchPersona(reply, personaId);

    return reply.send(describedPersona(one));
  });

  /**
   * Every version of one, newest first.
   *
   * Readable for an archived persona exactly as for an active one: a run that
   * pinned one of these versions is still on the record and still has to be
   * interpretable.
   */
  app.get(PERSONA_VERSIONS_PATH, async (request, reply) => {
    const { auth } = requesterOf(request);
    const { personaId } = request.params as { personaId: string };
    const query = (request.query ?? {}) as Query;

    const acting = await projectFor(auth, given(query.project));
    if ("refusal" in acting) return refuseActing(reply, acting);

    const cursor = given(query.cursor);
    if (cursor !== undefined && !isId("prsv", cursor)) {
      return sendRefusal(
        reply,
        "invalid_cursor",
        REFUSALS.invalidCursor(cursor),
      );
    }

    // Whether the persona is reachable is answered before the page, so an
    // identifier that names nobody is a refusal rather than an empty history.
    const one = await getPersona(acting.auth, personaId);
    if (one === undefined) return noSuchPersona(reply, personaId);

    const page = await listPersonaVersions(acting.auth, personaId, { cursor });
    return reply.send({
      items: page.items.map(describedVersion),
      next_cursor: page.nextCursor ?? null,
    });
  });

  /**
   * Which active tests currently name them.
   *
   * **The same question the Archive asks, answered by the same function**, so
   * a page saying "nothing uses them" can never be followed by a refusal
   * saying three tests do.
   */
  app.get(PERSONA_USAGE_PATH, async (request, reply) => {
    const { auth } = requesterOf(request);
    const { personaId } = request.params as { personaId: string };
    const query = (request.query ?? {}) as Query;

    const acting = await projectFor(auth, given(query.project));
    if ("refusal" in acting) return refuseActing(reply, acting);

    const using = await testsUsingPersona(acting.auth, personaId);
    if (using === undefined) return noSuchPersona(reply, personaId);

    return reply.send({
      tests: using.map((one) => ({ id: one.id, name: one.name })),
    });
  });

  /** One frozen version by its own `prsv_` id — the older-version read. */
  app.get(PERSONA_VERSION_PATH, async (request, reply) => {
    const { auth } = requesterOf(request);
    const { versionId } = request.params as { versionId: string };
    const query = (request.query ?? {}) as Query;

    const acting = await projectFor(auth, given(query.project));
    if ("refusal" in acting) return refuseActing(reply, acting);

    const version = await getPersonaVersion(acting.auth, versionId);
    if (version === undefined) {
      return sendRefusal(
        reply,
        "not_found",
        REFUSALS.notFound("persona version", versionId),
      );
    }

    return reply.send(describedVersion(version));
  });

  /** A new persona, at version 1, active, and nobody's default. */
  app.post(PERSONAS_PATH, async (request, reply) => {
    const { auth } = requesterOf(request);
    const body = (request.body ?? {}) as Body;

    const refused = mayAuthor(reply, auth, "create personas");
    if (refused !== undefined) return refused;

    const written = traitsIn(body.traits ?? {});
    if ("refusal" in written) {
      return sendRefusal(reply, "unprocessable", written.refusal);
    }

    const acting = await projectFor(auth, given(text(body.project)));
    if ("refusal" in acting) return refuseActing(reply, acting);

    const created = await createPersona(acting.auth, {
      name: text(body.name),
      ...(given(text(body.description)) === undefined
        ? {}
        : { description: text(body.description) }),
      traits: written.traits,
    });

    return reply.code(201).send(describedPersona(created));
  });

  /**
   * A partial edit, carrying whichever expectations it needs.
   *
   * What the body leaves out, the persona keeps. A name or a description is
   * identity and writes in place; traits mint a version unless they are
   * byte-identical to the current one, in which case nothing is written at all
   * and a nervous re-save leaves no history behind.
   *
   * Both expectations are **required from a browser** and each guards its own
   * half. A write that named neither would land on top of whatever somebody
   * else did in the meantime, which is the one outcome nothing here can
   * recover from.
   */
  app.patch(PERSONA_PATH, async (request, reply) => {
    const { auth } = requesterOf(request);
    const { personaId } = request.params as { personaId: string };
    const body = (request.body ?? {}) as Body;

    const refused = mayAuthor(reply, auth, "edit personas");
    if (refused !== undefined) return refused;

    const expectedRevision = given(text(body.expected_revision));
    if (expectedRevision === undefined) {
      return sendRefusal(
        reply,
        "unprocessable",
        "an edit says which revision of the persona it was written against, " +
          "and this one named no expected_revision. Read the persona again " +
          "and send the revision it names now.",
      );
    }

    const written = "traits" in body ? traitsIn(body.traits) : undefined;
    if (written !== undefined && "refusal" in written) {
      return sendRefusal(reply, "unprocessable", written.refusal);
    }

    const expectedVersionId = given(text(body.expected_version_id));
    if (written !== undefined && expectedVersionId === undefined) {
      return sendRefusal(
        reply,
        "unprocessable",
        "a traits edit says which version it was written against, and this " +
          "one named no expected_version_id. Read the persona again and send " +
          "the version_id it names now.",
      );
    }

    const acting = await projectFor(auth, given(text(body.project)));
    if ("refusal" in acting) return refuseActing(reply, acting);

    const edited = await editPersona(acting.auth, personaId, {
      expectedRevision,
      ...(expectedVersionId === undefined ? {} : { expectedVersionId }),
      ...("name" in body ? { name: text(body.name) } : {}),
      ...("description" in body
        ? { description: given(text(body.description)) ?? null }
        : {}),
      ...(written === undefined ? {} : { traits: written.traits }),
    });

    if (edited === undefined) return noSuchPersona(reply, personaId);
    return reply.send(describedPersona(edited));
  });

  /**
   * A new persona carrying this one's current authoring fields and current
   * traits — and none of its history, and no link back to it.
   */
  app.post(PERSONA_CLONE_PATH, async (request, reply) => {
    const { auth } = requesterOf(request);
    const { personaId } = request.params as { personaId: string };
    const body = (request.body ?? {}) as Body;

    const refused = mayAuthor(reply, auth, "clone personas");
    if (refused !== undefined) return refused;

    const acting = await projectFor(auth, given(text(body.project)));
    if ("refusal" in acting) return refuseActing(reply, acting);

    const clone = await clonePersona(acting.auth, personaId);
    if (clone === undefined) return noSuchPersona(reply, personaId);

    return reply.code(201).send(describedPersona(clone));
  });

  /**
   * Archive: they leave the authoring lists, and nothing else changes.
   *
   * `replacement_persona_id` is the persona who takes the project's default
   * pointer, and it is required exactly when this persona is holding it. The
   * pointer moves in the same transaction, so there is never an instant in
   * which a test authored naming nobody has nobody to be given.
   */
  app.post(PERSONA_ARCHIVE_PATH, async (request, reply) => {
    const { auth } = requesterOf(request);
    const { personaId } = request.params as { personaId: string };
    const body = (request.body ?? {}) as Body;

    const refused = mayAuthor(reply, auth, "archive personas");
    if (refused !== undefined) return refused;

    const expectedRevision = given(text(body.expected_revision));
    if (expectedRevision === undefined) {
      return sendRefusal(
        reply,
        "unprocessable",
        "Archive says which revision of the persona it was written against, " +
          "and this one named no expected_revision. Read the persona again " +
          "and send the revision it names now.",
      );
    }

    const acting = await projectFor(auth, given(text(body.project)));
    if ("refusal" in acting) return refuseActing(reply, acting);

    const archived = await archivePersona(acting.auth, personaId, {
      expectedRevision,
      ...(given(text(body.replacement_persona_id)) === undefined
        ? {}
        : { replacementPersonaId: text(body.replacement_persona_id) }),
    });

    if (archived === undefined) return noSuchPersona(reply, personaId);
    return reply.send(describedPersona(archived));
  });

  /** Restore: they are offered again. Nothing refuses this one. */
  app.post(PERSONA_RESTORE_PATH, async (request, reply) => {
    const { auth } = requesterOf(request);
    const { personaId } = request.params as { personaId: string };
    const body = (request.body ?? {}) as Body;

    const refused = mayAuthor(reply, auth, "restore personas");
    if (refused !== undefined) return refused;

    const expectedRevision = given(text(body.expected_revision));
    if (expectedRevision === undefined) {
      return sendRefusal(
        reply,
        "unprocessable",
        "Restore says which revision of the persona it was written against, " +
          "and this one named no expected_revision. Read the persona again " +
          "and send the revision it names now.",
      );
    }

    const acting = await projectFor(auth, given(text(body.project)));
    if ("refusal" in acting) return refuseActing(reply, acting);

    const restored = await restorePersona(acting.auth, personaId, {
      expectedRevision,
    });

    if (restored === undefined) return noSuchPersona(reply, personaId);
    return reply.send(describedPersona(restored));
  });

  /**
   * The refusals this group owns, each answered as an answer rather than as a
   * fault.
   *
   * The two stale-write refusals are separate codes because the caller's next
   * move differs: an identity conflict is recovered by reading and retyping a
   * name, and a version conflict by reading and *reapplying* work that may
   * have taken an afternoon. A client that could not tell them apart could
   * offer neither.
   */
  app.setErrorHandler(async (error, _request, reply) => {
    if (error instanceof PersonaNamedByTestsError) {
      return sendRefusal(
        reply,
        "persona_in_use",
        REFUSALS.personaInUse(
          error.personaId,
          error.tests.map((one) => one.id).join(", "),
        ),
      );
    }

    if (error instanceof DefaultPersonaReplacementError) {
      return sendRefusal(
        reply,
        "default_persona_required",
        REFUSALS.defaultPersonaRequired(error.personaId),
      );
    }

    if (error instanceof IdentityConflictError) {
      return sendRefusal(
        reply,
        "identity_conflict",
        REFUSALS.identityConflict("Persona", error.resourceId),
      );
    }

    if (error instanceof VersionConflictError) {
      return sendRefusal(
        reply,
        "version_conflict",
        REFUSALS.versionConflict(
          error.resource,
          error.expected,
          error.current,
        ),
      );
    }

    // The factory turned the write away at its door, in its own words —
    // relayed rather than rewritten, because the sentence is written for
    // whoever has to fix the body.
    if (error instanceof UnprocessableInputError) {
      return sendRefusal(reply, "unprocessable", error.message);
    }

    // Reachable only in a race: the project was checked before the write, and
    // this is what a project deleted in between looks like from inside it.
    if (error instanceof ProjectOutsideOrganizationError) {
      return sendRefusal(
        reply,
        "project_outside_organization",
        REFUSALS.notFound("project", error.projectId),
      );
    }

    // The data-access module refusing what this door already refused. It is
    // the boundary that matters, and reaching here means something got past
    // the door — so the answer is the same one, in the same words.
    if (error instanceof NotPermittedError) {
      return sendRefusal(
        reply,
        "not_permitted",
        REFUSALS.notPermitted(error.role, "author personas"),
      );
    }

    throw error;
  });
}
