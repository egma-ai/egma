import {
  archivePersona,
  createPersona,
  DefaultPersonaReplacementError,
  editPersona,
  forkPersona,
  getPersona,
  getPersonaVersion,
  IdentityConflictError,
  listPersonas,
  listPersonaVersions,
  NotPermittedError,
  permits,
  PersonaNamedByTestsError,
  PROVIDER_CATALOG,
  EgmaProvidedPersonaError,
  ProjectOutsideOrganizationError,
  RECOMMENDED_PERSONA_MODELS,
  restorePersona,
  setDefaultPersona,
  SPEED_RANGE,
  testsUsingPersona,
  UnprocessableInputError,
  validPersonaModels,
  VersionConflictError,
  WriteAbortedError,
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
import { identityConflict, sendRefusal } from "../http/refusals.ts";

/**
 * The personas available to one project: the shared definitions Egma ships,
 * the project-owned definitions a team authors, their history and their uses.
 *
 * A **persona** is the synthetic person who speaks with the agent. Name and
 * Description identify them. Personality is human behavior. Models are the
 * complete technical selection used to bring that behavior to life.
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
 * **A project-owned persona is never deleted.** Archive takes them out of the
 * authoring list and leaves every version in place. Egma-provided personas
 * have no project lifecycle and cannot be changed; Fork is how a team gets a
 * Custom version of one.
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
export const PERSONA_FORK_PATH = "/api/personas/:personaId/fork";
export const PERSONA_DEFAULT_PATH = "/api/personas/:personaId/default";
export const PERSONA_ARCHIVE_PATH = "/api/personas/:personaId/archive";
export const PERSONA_RESTORE_PATH = "/api/personas/:personaId/restore";
export const PERSONA_VERSION_PATH = "/api/persona-versions/:versionId";
export const PERSONA_FORM_PATH = "/api/persona-form";

type Body = Record<string, unknown>;

type Query = {
  readonly project?: string;
  readonly cursor?: string;
  readonly archived?: string;
  readonly search?: string;
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

  egmaProvidedPersona: (personaId: string): string =>
    `Persona ${personaId} is Egma-provided and cannot be changed. ` +
    `Fork it to make a Custom persona you can edit.`,

  // The agent group answers this refusal too, so the sentence is written once
  // in `http/refusals.ts` and each group names its own resource word.
  identityConflict,

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

  writeAborted: (): string =>
    "Egma could not finish this change because another change to the same " +
    "project was being made at the same time. Nothing was written; try again.",
} as const;

/** How a refusal names a persona nobody here can see. */
function noSuchPersona(reply: FastifyReply, personaId: string): FastifyReply {
  return sendRefusal(
    reply,
    "not_found",
    REFUSALS.notFound("persona", personaId),
  );
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
    // Human behavior and technical execution have one owner each. The complete
    // model selection is on this same immutable version, with technical voice
    // only under TTS.
    traits: one.traits,
    models: one.models,
    owner: one.owner,
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
    models: one.models,
    created_at: one.createdAt.toISOString(),
  };
}

/**
 * The human behavior a body carries, as the factory takes it.
 *
 * Model selection is the adjacent `models` value. Technical voice exists only
 * at `models.tts`. Refusing any other trait is important: silently dropping
 * one would say a control worked when no simulator behavior exists for it.
 */
type WrittenTraits =
  | { readonly traits: PersonaTraits }
  | { readonly refusal: string };

const HUMAN_TRAIT_FIELDS = [
  "personality",
  "language",
  "manner",
  "patience",
  "accent",
  "backgroundNoise",
  "underFriction",
] as const;

function traitsIn(value: unknown): WrittenTraits {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {
      refusal:
        "traits describe who the persona is. Send them as an object with a " +
        "personality and language.",
    };
  }
  const held = value as Body;
  const supported = new Set<string>(HUMAN_TRAIT_FIELDS);
  const unsupported = Object.keys(held).filter((field) => !supported.has(field));
  if (unsupported.length > 0) {
    return {
      refusal:
        `persona traits have unsupported fields ${unsupported.join(", ")}. ` +
        "Provider, model, voice id, and speed belong in models.",
    };
  }

  const optional = Object.fromEntries(
    HUMAN_TRAIT_FIELDS.slice(2).flatMap((field) =>
      Object.hasOwn(held, field) ? [[field, text(held[field])]] : [],
    ),
  );
  return {
    traits: {
      personality: text(held.personality),
      language: text(held.language),
      ...optional,
    },
  } as WrittenTraits;
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
      search: given(text(query.search)),
    });

    return reply.send({
      items: page.items.map(describedPersona),
      // Null rather than absent, so a client can tell "there is no next page"
      // from "this answer is an older shape that never had one".
      next_cursor: page.nextCursor ?? null,
    });
  });

  /**
   * The one catalog used by both authoring forms.
   *
   * The browser does not keep another provider/model list. This response is a
   * safe projection of the closed adapter catalog and the release defaults.
   * It contains no provider key and no deployment setting.
   */
  app.get(PERSONA_FORM_PATH, async (request, reply) => {
    const { auth } = requesterOf(request);
    const query = (request.query ?? {}) as Query;

    const acting = await projectFor(auth, given(query.project));
    if ("refusal" in acting) return refuseActing(reply, acting);

    return reply.send({
      model_catalog: PROVIDER_CATALOG.map((entry) => ({
        provider: entry.provider,
        job: entry.job,
        model: entry.model,
        label: entry.label,
        ...("recommendedVoiceId" in entry
          ? { recommended_voice_id: entry.recommendedVoiceId }
          : {}),
      })),
      recommended_models: RECOMMENDED_PERSONA_MODELS,
      speed_range: SPEED_RANGE,
    });
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
    if (!("models" in body)) {
      return sendRefusal(
        reply,
        "unprocessable",
        "a persona needs one complete models value with llm, stt and tts",
      );
    }
    const models = validPersonaModels(body.models);

    const acting = await projectFor(auth, given(text(body.project)));
    if ("refusal" in acting) return refuseActing(reply, acting);

    const created = await createPersona(acting.auth, {
      name: text(body.name),
      ...(given(text(body.description)) === undefined
        ? {}
        : { description: text(body.description) }),
      traits: written.traits,
      models,
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
    const models =
      "models" in body ? validPersonaModels(body.models) : undefined;

    const expectedVersionId = given(text(body.expected_version_id));
    if (
      (written !== undefined || models !== undefined) &&
      expectedVersionId === undefined
    ) {
      return sendRefusal(
        reply,
        "unprocessable",
        "a traits or models edit says which version it was written " +
          "against, and this one named no expected_version_id. Read the " +
          "persona again and send the version_id it names now.",
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
      ...(models === undefined ? {} : { models }),
    });

    if (edited === undefined) return noSuchPersona(reply, personaId);
    return reply.send(describedPersona(edited));
  });

  /**
   * A project-owned persona carrying this one's current Name, Description and
   * Personality. A fork starts its own history and is editable even when the
   * source is an Egma-provided persona.
   */
  app.post(PERSONA_FORK_PATH, async (request, reply) => {
    const { auth } = requesterOf(request);
    const { personaId } = request.params as { personaId: string };
    const body = (request.body ?? {}) as Body;

    const refused = mayAuthor(reply, auth, "fork personas");
    if (refused !== undefined) return refused;

    const acting = await projectFor(auth, given(text(body.project)));
    if ("refusal" in acting) return refuseActing(reply, acting);

    const fork = await forkPersona(acting.auth, personaId);
    if (fork === undefined) return noSuchPersona(reply, personaId);

    return reply.code(201).send(describedPersona(fork));
  });

  /**
   * Make this active persona the project's default.
   *
   * This is a project choice, not a persona type. The same action works for an
   * Egma-provided persona and for a Custom persona, and changes no version.
   */
  app.post(PERSONA_DEFAULT_PATH, async (request, reply) => {
    const { auth } = requesterOf(request);
    const { personaId } = request.params as { personaId: string };
    const body = (request.body ?? {}) as Body;

    const refused = mayAuthor(reply, auth, "change the project default persona");
    if (refused !== undefined) return refused;

    const acting = await projectFor(auth, given(text(body.project)));
    if ("refusal" in acting) return refuseActing(reply, acting);

    const selected = await setDefaultPersona(acting.auth, personaId);
    if (selected === undefined) return noSuchPersona(reply, personaId);
    return reply.send(describedPersona(selected));
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

    if (error instanceof EgmaProvidedPersonaError) {
      return sendRefusal(
        reply,
        "egma_provided_persona",
        REFUSALS.egmaProvidedPersona(error.personaId),
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
        REFUSALS.versionConflict(error.resource, error.expected, error.current),
      );
    }

    /**
     * The store rolled the write back because another one got in its way.
     *
     * **Answered rather than thrown, which is the whole point of it having a
     * class.** A deadlock or a serialization failure escaping here would reach
     * whoever pressed Archive as an internal failure on a request that was
     * valid — a fault they cannot act on and cannot reproduce. As a refusal it
     * says the true thing: nothing was written, and pressing it again works.
     */
    if (error instanceof WriteAbortedError) {
      return sendRefusal(reply, "write_aborted", REFUSALS.writeAborted());
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
