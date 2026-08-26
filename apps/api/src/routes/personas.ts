import {
  createPersona,
  deletePersona,
  editPersona,
  forkPersona,
  getPersona,
  getPersonaVersion,
  listPersonas,
  listPersonaVersions,
  NotPermittedError,
  permits,
  PROVIDER_CATALOG,
  EgmaProvidedPersonaError,
  ProjectOutsideOrganizationError,
  RECOMMENDED_PERSONA_MODELS,
  SPEED_RANGE,
  testsUsingPersona,
  UnprocessableInputError,
  validPersonaModels,
  WriteAbortedError,
  type AuthContext,
  type Persona,
  type PersonaVersion,
} from "@egma/db";
import { isId } from "@egma/ids";
import { personaOperations } from "@egma/platform-api/contract";
import type { FastifyInstance, FastifyReply } from "fastify";

import type { SessionIdentityProvider } from "../auth/seam.ts";
import { actingIn, refuseActing, type Acting } from "../http/acting.ts";
import { credentialed, requesterOf } from "../http/credentialed.ts";
import type { RateLimit } from "../http/rate-limit.ts";
import { given, text } from "../http/reading.ts";
import { registerPlatformOperation } from "../http/platform-operation.ts";
import { sendRefusal } from "../http/refusals.ts";

/**
 * The personas available to one project: the shared definitions Egma ships,
 * the Custom definitions a team authors, their history and their uses.
 *
 * A **persona** is the synthetic person who speaks with the agent.
 *
 * Four shapes here are contract rather than convenience.
 *
 * **A persona has two names, and they live different lives.** `name` is the
 * team's word for the library row — shown in lists and pickers, written in
 * place, never spoken. `identityName` is the human name this persona gives the
 * agent, it is pinned on the version a simulation records, and changing it
 * mints the next version. So the same test always hears the same person, and
 * relabeling a library never pollutes the history a result is read against.
 *
 * **Identity is live and behavior is versioned, and the wire says which is
 * which.** Name and description write in place. Identity name, personality,
 * language and models mint an immutable version, and values identical to the
 * current version mint nothing.
 *
 * **No write names an expectation.** A persona write is last-write-wins: there
 * is no revision token and no expected version id on this surface, and none
 * underneath it. Pre-launch, with two authors, the ceremony cost more than the
 * clobber it prevented.
 *
 * **Delete is the word and there is no way back.** One route takes a Custom
 * persona out of every list and picker for good; underneath the row is stamped
 * rather than removed, so every version stays readable and a simulation that
 * pinned one still reads true. Predefined personas — Egma's own — cannot be
 * deleted or changed at all, and Fork is how a team gets a Custom version of
 * one.
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

type Body = Record<string, unknown>;

type Query = {
  readonly projectId?: string;
  readonly pageToken?: string;
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

  /**
   * Egma's own shared persona, refused for a project trying to change one.
   *
   * **Predefined** is the word here, matching graders and matching every
   * screen. The tenancy encoding underneath still says "Egma-provided" and the
   * refusal code still spells it that way, because a code is a promise a client
   * branches on; the sentence is what a person reads.
   */
  predefinedPersona: (personaId: string): string =>
    `Persona ${personaId} is Predefined and cannot be changed or deleted. ` +
    `Fork it to make a Custom persona you can edit.`,

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

/**
 * The keys an authoring body may carry, and no others.
 *
 * **A key this surface does not know is refused rather than dropped.** The
 * shapes this replaced carried a `traits` wrapper, two expectation tokens, an
 * accent, and a background noise; a body still written that way would otherwise
 * be answered `200` with nothing of it applied — a client told its edit landed
 * when the persona never moved. There is no old shape to accept: the sentence
 * names the offending key and lists what a persona body actually carries.
 */
const PERSONA_BODY_FIELDS = [
  "projectId",
  "name",
  "description",
  "identityName",
  "personality",
  "language",
  "models",
] as const;

function unknownBody(body: Body, allowed: readonly string[]): string | undefined {
  const found = Object.keys(body).find((key) => !allowed.includes(key));
  return found === undefined
    ? undefined
    : `a persona has no key "${found}"; a persona body carries ` +
      `${allowed.join(", ")}.`;
}

/**
 * The same rule for a query string, on the two routes that need it.
 *
 * **The list needs it because a parameter was taken away.** `archived=true`
 * used to choose the second list, and there is no second list; ignoring it
 * would answer somebody's question about deleted personas with the living
 * ones and call that success. Delete has it because a route addressed by an id
 * carries one filter and nothing else, which is how every other Delete on this
 * API reads. The plain reads keep no such check: nothing was removed from them,
 * so there is nothing they could quietly ignore.
 */
function unknownQuery(
  query: Query,
  allowed: readonly string[],
): string | undefined {
  const found = Object.keys(query).find((key) => !allowed.includes(key));
  if (found === undefined) return undefined;

  const carries = `this query carries ${allowed.join(", ")}.`;
  // The one retired parameter gets its own next move. Told only that there is
  // no such key, somebody would go looking for the right spelling of a list
  // that does not exist — so the sentence says the thing they actually have to
  // learn: there is nowhere to ask.
  return found === "archived"
    ? `the persona query has no key "archived"; ${carries} A deleted persona ` +
      `leaves every list for good, so there is no archived list to ask for.`
    : `the persona query has no key "${found}"; ${carries}`;
}

/**
 * A persona, as every read of one describes it.
 *
 * The authored person is flat: the name they give the agent, who they are, and
 * the language they speak, each a value of its own beside the team's `name` for
 * the row. The complete model selection sits on the same immutable version,
 * with technical voice only under TTS.
 */
function describedPersona(one: Persona): Record<string, unknown> {
  return {
    id: one.id,
    projectId: one.projectId,
    name: one.name,
    description: one.description,
    version: one.version,
    versionId: one.versionId,
    identityName: one.identityName,
    personality: one.personality,
    language: one.language,
    models: one.models,
    owner: one.owner,
    archivedAt: one.archivedAt?.toISOString() ?? null,
    createdAt: one.createdAt.toISOString(),
    updatedAt: one.updatedAt.toISOString(),
  };
}

/** One frozen version of one, as history and the older-version read show it. */
function describedVersion(one: PersonaVersion): Record<string, unknown> {
  return {
    id: one.id,
    personaId: one.personaId,
    version: one.version,
    identityName: one.identityName,
    personality: one.personality,
    language: one.language,
    models: one.models,
    createdAt: one.createdAt.toISOString(),
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
   * **One list, because there is only one lifecycle worth listing.** A deleted
   * persona is gone as far as anybody authoring is concerned, so there is no
   * archived list to ask for and no flag to ask for it with — and a request
   * that still asks for one is refused rather than quietly handed the live
   * list.
   */
  registerPlatformOperation(app, personaOperations.listPersonas, async (request, reply) => {
    const { auth } = requesterOf(request);
    const query = (request.query ?? {}) as Query;

    const unexpected = unknownQuery(query, ["projectId", "pageToken", "search"]);
    if (unexpected !== undefined) {
      return sendRefusal(reply, "unprocessable", unexpected);
    }

    const acting = await projectFor(auth, given(query.projectId));
    if ("refusal" in acting) return refuseActing(reply, acting);

    const pageToken = given(query.pageToken);
    if (pageToken !== undefined && !isId("prs", pageToken)) {
      return sendRefusal(
        reply,
        "invalid_cursor",
        REFUSALS.invalidCursor(pageToken),
      );
    }

    const page = await listPersonas(acting.auth, {
      cursor: pageToken,
      search: given(text(query.search)),
    });

    return reply.send({
      personas: page.items.map(describedPersona),
      // Null rather than absent, so a client can tell "there is no next page"
      // from "this answer is an older shape that never had one".
      nextPageToken: page.nextCursor ?? null,
    });
  });

  /**
   * The one catalog used by both authoring forms.
   *
   * The browser does not keep another provider/model list. This response is a
   * safe projection of the closed adapter catalog and the release defaults.
   * It contains no provider key and no deployment setting.
   */
  registerPlatformOperation(app, personaOperations.getPersonaForm, async (request, reply) => {
    const { auth } = requesterOf(request);
    const query = (request.query ?? {}) as Query;

    const acting = await projectFor(auth, given(query.projectId));
    if ("refusal" in acting) return refuseActing(reply, acting);

    return reply.send({
      modelCatalog: PROVIDER_CATALOG.map((entry) => ({
        provider: entry.provider,
        job: entry.job,
        model: entry.model,
        label: entry.label,
        ...("modelLabel" in entry ? { modelLabel: entry.modelLabel } : {}),
        ...("recommendedVoiceId" in entry
          ? { recommendedVoiceId: entry.recommendedVoiceId }
          : {}),
      })),
      recommendedModels: RECOMMENDED_PERSONA_MODELS,
      speedRange: SPEED_RANGE,
    });
  });

  /**
   * One persona, live or deleted.
   *
   * A deleted persona reads exactly as a live one does, carrying the stamp that
   * says they have gone. They are absent from every list and picker, and a
   * simulation that pinned one still has to be able to say who the agent heard.
   */
  registerPlatformOperation(app, personaOperations.getPersona, async (request, reply) => {
    const { auth } = requesterOf(request);
    const { personaId } = request.params as { personaId: string };
    const query = (request.query ?? {}) as Query;

    const acting = await projectFor(auth, given(query.projectId));
    if ("refusal" in acting) return refuseActing(reply, acting);

    const one = await getPersona(acting.auth, personaId);
    if (one === undefined) return noSuchPersona(reply, personaId);

    return reply.send(describedPersona(one));
  });

  /**
   * Every version of one, newest first.
   *
   * Readable for a deleted persona exactly as for a live one: a run that
   * pinned one of these versions is still on the record and still has to be
   * interpretable.
   */
  registerPlatformOperation(app, personaOperations.listPersonaVersions, async (request, reply) => {
    const { auth } = requesterOf(request);
    const { personaId } = request.params as { personaId: string };
    const query = (request.query ?? {}) as Query;

    const acting = await projectFor(auth, given(query.projectId));
    if ("refusal" in acting) return refuseActing(reply, acting);

    const pageToken = given(query.pageToken);
    if (pageToken !== undefined && !isId("prsv", pageToken)) {
      return sendRefusal(
        reply,
        "invalid_cursor",
        REFUSALS.invalidCursor(pageToken),
      );
    }

    // Whether the persona is reachable is answered before the page, so an
    // identifier that names nobody is a refusal rather than an empty history.
    const one = await getPersona(acting.auth, personaId);
    if (one === undefined) return noSuchPersona(reply, personaId);

    const page = await listPersonaVersions(acting.auth, personaId, {
      cursor: pageToken,
    });
    return reply.send({
      versions: page.items.map(describedVersion),
      nextPageToken: page.nextCursor ?? null,
    });
  });

  /**
   * Which active tests currently name them.
   *
   * **It no longer stands between anybody and a Delete.** Delete asks nothing
   * and refuses nothing but a Predefined persona. What this answers is the
   * question somebody about to press it wants answered — who goes quiet if I do
   * — and the page shows it beside the button rather than after it.
   */
  registerPlatformOperation(app, personaOperations.getPersonaUsage, async (request, reply) => {
    const { auth } = requesterOf(request);
    const { personaId } = request.params as { personaId: string };
    const query = (request.query ?? {}) as Query;

    const acting = await projectFor(auth, given(query.projectId));
    if ("refusal" in acting) return refuseActing(reply, acting);

    const using = await testsUsingPersona(acting.auth, personaId);
    if (using === undefined) return noSuchPersona(reply, personaId);

    return reply.send({
      tests: using.map((one) => ({ id: one.id, name: one.name })),
    });
  });

  /** One frozen version by its own `prsv_` id — the older-version read. */
  registerPlatformOperation(app, personaOperations.getPersonaVersion, async (request, reply) => {
    const { auth } = requesterOf(request);
    const { versionId } = request.params as { versionId: string };
    const query = (request.query ?? {}) as Query;

    const acting = await projectFor(auth, given(query.projectId));
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

  /**
   * A new persona, at version 1 and live.
   *
   * The body is flat: the team's `name`, the `identityName` the agent will
   * hear, a `personality`, a `language`, and one complete `models` selection,
   * with `description` the only optional field. Every one of those is required
   * because a simulator handed an absent one would be deciding who the agent
   * heard.
   */
  registerPlatformOperation(app, personaOperations.createPersona, async (request, reply) => {
    const { auth } = requesterOf(request);
    const body = (request.body ?? {}) as Body;

    const refused = mayAuthor(reply, auth, "create personas");
    if (refused !== undefined) return refused;

    const unexpected = unknownBody(body, PERSONA_BODY_FIELDS);
    if (unexpected !== undefined) {
      return sendRefusal(reply, "unprocessable", unexpected);
    }

    if (!("models" in body)) {
      return sendRefusal(
        reply,
        "unprocessable",
        "a persona needs one complete models value with llm, stt and tts",
      );
    }
    const models = validPersonaModels(body.models);

    const acting = await projectFor(auth, given(text(body.projectId)));
    if ("refusal" in acting) return refuseActing(reply, acting);

    const created = await createPersona(acting.auth, {
      name: text(body.name),
      ...(given(text(body.description)) === undefined
        ? {}
        : { description: text(body.description) }),
      identityName: text(body.identityName),
      personality: text(body.personality),
      language: text(body.language),
      models,
    });

    return reply.code(201).send(describedPersona(created));
  });

  /**
   * A partial edit — the same shape with every field optional.
   *
   * What the body leaves out, the persona keeps. A name or a description is
   * identity and writes in place; the identity name, personality, language and
   * models mint a version unless they are identical to the current one, in
   * which case nothing is written at all and a nervous re-save leaves no
   * history behind.
   *
   * **It names no expectation, and that is the decision rather than an
   * omission.** Persona writes are last-write-wins. A body still carrying an
   * `expectedRevision` or an `expectedVersionId` is refused as an unknown key,
   * because a client sending one believes in a guard that is not there.
   */
  registerPlatformOperation(app, personaOperations.updatePersona, async (request, reply) => {
    const { auth } = requesterOf(request);
    const { personaId } = request.params as { personaId: string };
    const body = (request.body ?? {}) as Body;

    const refused = mayAuthor(reply, auth, "edit personas");
    if (refused !== undefined) return refused;

    const unexpected = unknownBody(body, PERSONA_BODY_FIELDS);
    if (unexpected !== undefined) {
      return sendRefusal(reply, "unprocessable", unexpected);
    }

    const models = "models" in body ? validPersonaModels(body.models) : undefined;

    const acting = await projectFor(auth, given(text(body.projectId)));
    if ("refusal" in acting) return refuseActing(reply, acting);

    const edited = await editPersona(acting.auth, personaId, {
      ...("name" in body ? { name: text(body.name) } : {}),
      ...("description" in body
        ? { description: given(text(body.description)) ?? null }
        : {}),
      ...("identityName" in body
        ? { identityName: text(body.identityName) }
        : {}),
      ...("personality" in body
        ? { personality: text(body.personality) }
        : {}),
      ...("language" in body ? { language: text(body.language) } : {}),
      ...(models === undefined ? {} : { models }),
    });

    if (edited === undefined) return noSuchPersona(reply, personaId);
    return reply.send(describedPersona(edited));
  });

  /**
   * A Custom persona carrying the source's current name, description, authored
   * person, and model selections. A fork starts its own history and is editable
   * even when the source is a Predefined persona.
   */
  registerPlatformOperation(app, personaOperations.forkPersona, async (request, reply) => {
    const { auth } = requesterOf(request);
    const { personaId } = request.params as { personaId: string };
    const body = (request.body ?? {}) as Body;

    const refused = mayAuthor(reply, auth, "fork personas");
    if (refused !== undefined) return refused;

    const acting = await projectFor(auth, given(text(body.projectId)));
    if ("refusal" in acting) return refuseActing(reply, acting);

    const fork = await forkPersona(acting.auth, personaId);
    if (fork === undefined) return noSuchPersona(reply, personaId);

    return reply.code(201).send(describedPersona(fork));
  });

  /**
   * Delete: they leave every list and picker, and nothing else changes.
   *
   * **One route, one confirmation, and nothing to nominate.** It replaces an
   * Archive that asked for a revision and sometimes for a successor, and a
   * Restore that put somebody back. Underneath, the row is stamped rather than
   * removed, so every version stays readable and a simulation that pinned one
   * still reads true — but no surface here offers a way back.
   *
   * **Only a Predefined persona refuses it.** A live test naming this persona
   * does not: that protection sits where the loss would happen — a run for such
   * a test is refused, and the test's next write has to name somebody alive.
   *
   * Deleting somebody already deleted answers the same `204`. Two tabs pressing
   * Delete is an ordinary thing to happen, and the second one has nothing to
   * complain about.
   */
  registerPlatformOperation(app, personaOperations.deletePersona, async (request, reply) => {
    const { auth } = requesterOf(request);
    const { personaId } = request.params as { personaId: string };
    const query = (request.query ?? {}) as Query;

    const refused = mayAuthor(reply, auth, "delete personas");
    if (refused !== undefined) return refused;

    const unexpected = unknownQuery(query, ["projectId"]);
    if (unexpected !== undefined) {
      return sendRefusal(reply, "unprocessable", unexpected);
    }

    const acting = await projectFor(auth, given(query.projectId));
    if ("refusal" in acting) return refuseActing(reply, acting);

    const deleted = await deletePersona(acting.auth, personaId);
    if (deleted === undefined) return noSuchPersona(reply, personaId);
    return reply.code(204).send();
  });

  /**
   * The refusals this group owns, each answered as an answer rather than as a
   * fault.
   */
  app.setErrorHandler(async (error, _request, reply) => {
    if (error instanceof EgmaProvidedPersonaError) {
      return sendRefusal(
        reply,
        "egma_provided_persona",
        REFUSALS.predefinedPersona(error.personaId),
      );
    }

    /**
     * The store rolled the write back because another one got in its way.
     *
     * **Answered rather than thrown, which is the whole point of it having a
     * class.** A deadlock or a serialization failure escaping here would reach
     * whoever pressed Delete as an internal failure on a request that was
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
