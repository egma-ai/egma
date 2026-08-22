import type { FastifyReply } from "fastify";

/**
 * The refusal vocabulary of this API, written once.
 *
 * Every refusal is `{ error, message }`: a stable snake_case code a client
 * branches on, and a plain sentence saying what happened and what to do next.
 * The codes are contract and never change; the sentences improve deliberately.
 *
 * These live in one module because a code is a promise. A route group that
 * spelled its own `{ error: "not_permitted" }` would be free to spell it
 * `not-permitted` on a Tuesday, and nothing would notice until a client's
 * branch stopped matching. `CODES` below is the whole vocabulary and the only
 * place a code is spelled beside its status; everything that answers a refusal
 * — the senders here, the door's two in `credentialed.ts`, and the agent
 * group's refusal values — derives from it, so an unlisted code cannot
 * compile, let alone ship.
 */

export const CODES = {
  invalid_request: 400,
  not_authenticated: 401,
  not_permitted: 403,
  not_found: 404,
  project_outside_organization: 404,
  conflict: 409,
  name_taken: 409,
  /**
   * A slug an admin typed that a living project of the same organization
   * already holds. Its own code beside `name_taken` because the two name
   * different fields and have different fixes: a project's name is free and its
   * slug is what has to be unique, so the refusal points at the one control the
   * person can change.
   */
  project_slug_taken: 409,
  // A stale write, told apart from a plain conflict by which of the two things
  // moved: the resource's identity, or the content of its current version.
  // The caller's next move differs — one is retyped, the other is reapplied —
  // so a client that could not tell them apart could not offer either.
  identity_conflict: 409,
  version_conflict: 409,
  parent_agent_archived: 409,
  // A persona an active test still names, and the persona a project points at
  // by default. Two rules that refuse one Archive, and two sentences, because
  // the fix for each is somewhere else.
  persona_in_use: 409,
  default_persona_required: 409,
  // Egma owns this shared persona definition. A project can use it as-is or
  // fork it, but cannot change its definition or lifecycle for every customer.
  egma_provided_persona: 422,
  // The store rolled a write back because another one got in its way. Its own
  // code because it is the one refusal that is about nothing the caller did:
  // the request was valid on the way in, nothing was written, and sending it
  // again is the whole of the fix — which a client can do by itself.
  write_aborted: 409,
  /**
   * A file naming a persona by a name two living personas answer to. Its own
   * code because the fix belongs to a file rather than to a form: put the
   * stable identifier in the file. Nothing picks one by list order, ever.
   */
  persona_name_ambiguous: 422,
  unprocessable: 422,
  credential_required: 422,
  credential_forbidden: 422,
  credential_choice_required: 422,
  no_capability_adapter: 422,
  // A product request that named no project. Its own code because a browser
  // reading this has a selector on screen, and the sentence names it.
  project_required: 422,
  // A cursor this list never issued. Its own code so a client can drop it and
  // start again rather than showing somebody a broken page forever.
  invalid_cursor: 422,
  /** A provider needed for setup did not answer. The customer may retry. */
  provider_unavailable: 503,
  /**
   * A start action that named no idempotency key. 422 rather than 409: nothing
   * conflicts, something required is missing, and the fix is to send one.
   */
  idempotency_key_required: 422,
  /**
   * A key reused over a different request. Answering the original run would
   * tell somebody their new selection had started when it had not, so the
   * third answer is the only honest one.
   */
  idempotency_conflict: 409,
  /**
   * A Retry that could not be derived, because something the earlier run used
   * is no longer active or no longer applies. Its own code rather than a plain
   * conflict because the fix is a specific one and a page can offer it: the
   * refusal names the resource, and the next move is the run builder, where
   * every substitution is the person's to make out loud.
   */
  retry_unavailable: 409,
  /** The selected simulation cannot be used as a source for a new run. */
  simulation_rerun_unavailable: 409,
  unsignable_reference: 422,
  no_adapter: 422,
  phone_setup_required: 422,
  too_many_requests: 429,
  /**
   * A fault, answered without relaying whatever the fault said.
   *
   * Every other code here is a sentence somebody wrote to be read. This one is
   * for what nobody wrote — a driver error, a constraint name, a query layer's
   * wrapper — on the routes where the query that failed is one that selected a
   * sealed envelope. Echoing such a message would put ciphertext and SQL into a
   * browser response, so the caller gets a sentence this module chose and the
   * detail goes to the log.
   */
  unavailable: 500,
  capability_check_failed: 502,
  no_object_store: 503,
} as const;

export type RefusalCode = keyof typeof CODES;

function refuse(
  reply: FastifyReply,
  error: RefusalCode,
  message: string,
): FastifyReply {
  return reply.code(CODES[error]).send({ error, message });
}

/**
 * A refusal whose code was decided somewhere else — by a module that answers
 * "a value or a refusal" and hands the pair back rather than a reply.
 *
 * The status still comes off `CODES` and the body still has exactly two
 * fields, so a caller choosing the code cannot also choose the shape.
 */
export function sendRefusal(
  reply: FastifyReply,
  error: RefusalCode,
  message: string,
): FastifyReply {
  return refuse(reply, error, message);
}

/**
 * A project named by a browser that the signed-in organization does not hold.
 *
 * **404 and not 403, and the sentence says "there is no", because to this
 * organization there is not.** A project of somebody else's and a project id
 * that was never minted are one answer, so following a stranger's link never
 * tells you whether the thing on the other end exists. The reader is a page
 * with a selector on it, so the sentence names the selector.
 */
export function projectOutsideOrganization(projectId: string): string {
  return (
    `There is no project ${projectId} available to this organization. ` +
    "Choose a project from the selector and try again."
  );
}

/**
 * An edit that named the revision it was written against, refused because the
 * resource has moved since.
 *
 * **The sentence is composed here, by the layer that answers, rather than
 * carried on the error.** Two route groups answer this refusal now — agents
 * and connections in one, personas in the other — and each names its own
 * resource word, lower case where the API spells the resource that way and
 * capitalised where it does not. An error that baked one sentence in would
 * make the other group either relay the wrong word or paraphrase, and the
 * wording is contract: a coding agent reads it off a terminal.
 *
 * What the error carries is the data — which resource, which one, and the two
 * revisions — which is what a caller needs to read the thing again and send
 * the edit against the revision it names now.
 */
export function identityConflict(resource: string, resourceId: string): string {
  return (
    `${resource} ${resourceId} changed after you opened it. Read it again, ` +
    `keep or reapply your edits, and send the update with expectedRevision ` +
    `set to its new revision.`
  );
}

/**
 * The exact sentences the product surface answers with, written once.
 *
 * **These are contract.** A page shows them word for word and a client branches
 * on the code beside them, so the wording is filled in rather than composed:
 * every placeholder is a value dropped into a fixed sentence, and the sentence
 * around it never changes shape. Two copies of one of these is two things to
 * keep in step, which is the whole reason they are here and not in each route.
 */
export const REFUSALS = {
  projectRequired:
    "This request did not name a project. Choose a project from the " +
    "selector and try again.",

  /**
   * Missing and cross-organization data get the same sentence, because to this
   * caller they are the same thing: following a stranger's link must never
   * reveal whether the thing on the other end exists.
   */
  notFound: (resource: string, resourceId: string): string =>
    `There is no ${resource} ${resourceId} available in this project. ` +
    "Check the link, or choose it from the current project.",

  notPermitted: (role: string, action: string): string =>
    `Your ${role} role cannot ${action}. Ask an organization admin to change ` +
    "your role, then try again.",

  /**
   * The same sentence the free function above composes, reached through this
   * table so the route groups that read their wording off it do not carry a
   * second copy of a sentence that is contract.
   */
  identityConflict,

  versionConflict: (
    resource: string,
    expected: string,
    current: string,
  ): string =>
    `this ${resource} edit was written against version ${expected}, and it ` +
    `has moved on to ${current}. Read the ${resource} again, keep or reapply ` +
    `your edits, and send them with expectedVersionId set to ${current}.`,

  personaNameAmbiguous: (name: string): string =>
    `Persona name ${name} matches more than one active persona in this ` +
    "project. Put the intended persona's stable ID in the file and try again; " +
    "for a pinned file, egma pull can write the IDs after the file is safe to " +
    "migrate.",

  invalidCursor: (cursor: string): string =>
    `Cursor ${cursor} is not valid for this list. Remove it and start from ` +
    "the first page.",

  projectSlugTaken: (slug: string): string =>
    `Project slug ${slug} is already in use in this organization. Choose a ` +
    "different slug and save the project again.",

  idempotencyKeyRequired:
    "Starting a run requires an idempotency key. Send one stable key for " +
    "this start action and try again.",

  idempotencyConflict: (key: string): string =>
    `Idempotency key ${key} already started a different run. Reuse the ` +
    "original request, or send a new key for this run.",

} as const;

/** The body could never be written, whatever is there. */
export function invalid(reply: FastifyReply, message: string): FastifyReply {
  return refuse(reply, "invalid_request", message);
}

/** Who is asking may not, whatever they asked for. */
export function notPermitted(
  reply: FastifyReply,
  message: string,
): FastifyReply {
  return refuse(reply, "not_permitted", message);
}

/**
 * There is nothing there — and existence is never confirmed to somebody who
 * could not have seen the thing anyway, so another customer's id and a
 * made-up one always get the same sentence.
 */
export function notFound(reply: FastifyReply, message: string): FastifyReply {
  return refuse(reply, "not_found", message);
}

/** Somebody got there first, or the thing has moved on. */
export function conflict(reply: FastifyReply, message: string): FastifyReply {
  return refuse(reply, "conflict", message);
}

/** A name a living thing in the same place already holds. */
export function nameTaken(reply: FastifyReply, message: string): FastifyReply {
  return refuse(reply, "name_taken", message);
}

/** The body was read and what it says cannot be acted on. */
export function unprocessable(
  reply: FastifyReply,
  message: string,
): FastifyReply {
  return refuse(reply, "unprocessable", message);
}

/**
 * A recording whose reference egma will not sign.
 *
 * **Its own code rather than an `unprocessable`, and the distinction is what a
 * reader does next.** Every other 422 on the recording route is a settled fact
 * about the conversation — *a chat has no audio and never will* — and a surface
 * that asks about every conversation it shows answers those by offering
 * nothing, because there is nothing and there never was. This one is a *defect*:
 * a row is carrying a reference no simulator could have written, and the audio
 * it points at may well exist. Sharing a code with the honest absences would
 * make a corrupt row invisible on exactly the surface that would meet it most —
 * a data fault dressed as a conversation that was never recorded.
 */
export function unsignableReference(
  reply: FastifyReply,
  message: string,
): FastifyReply {
  return refuse(reply, "unsignable_reference", message);
}

/**
 * A run over a connection kind whose simulator adapter has not shipped.
 *
 * Its own code rather than an `unprocessable`, because the caller's next move
 * is different in kind: nothing about the request can be fixed, and the answer
 * is to run over something else or to wait for the adapter.
 */
export function noAdapter(reply: FastifyReply, message: string): FastifyReply {
  return refuse(reply, "no_adapter", message);
}

/**
 * A phone run asked of a platform whose phone half has never been set up.
 *
 * **Its own code, and the distinction is the whole reason it exists.**
 * `no_adapter` is about the build — this egma cannot conduct that kind of
 * conversation at all, and no configuration will change it. This one is about
 * *this deployment*: the software dials fine, and the person who runs the
 * platform has not given it a carrier yet. The two have different readers and
 * different next moves — one waits for a release, the other runs one command —
 * and a client that could not tell them apart would tell a developer to wait
 * for something that already shipped.
 *
 * **It is refused before the run row exists, which is the point.** A phone run
 * that were accepted here would be queued, claimed, and only then discovered to
 * have nowhere to dial from — a failed simulation on the record that says
 * nothing about the agent under test, which is exactly the confusion between an
 * operational failure and a low grade that this product exists to keep
 * apart.
 */
export function phoneSetupRequired(
  reply: FastifyReply,
  message: string,
): FastifyReply {
  return refuse(reply, "phone_setup_required", message);
}

/**
 * No session and no usable key. Written here so the door in `credentialed.ts`
 * and this list can never disagree about the one sentence every group behind
 * the door answers with.
 */
export function notAuthenticated(reply: FastifyReply): FastifyReply {
  return refuse(
    reply,
    "not_authenticated",
    "this request carried no session and no usable API key. " +
      "Sign in, or send Authorization: Bearer with an Egma key.",
  );
}

/**
 * No usable service token, on the routes egma's own simulator claims work
 * through. The same code as the door above and a different sentence, because
 * the caller's next move is different in kind: no sign-in and no customer key
 * can ever open this one — the deployment's own secret is the whole gate.
 */
export function notTheService(reply: FastifyReply): FastifyReply {
  return refuse(
    reply,
    "not_authenticated",
    "this route hands out simulation work and answers only to Egma's own " +
      "simulator. Send Authorization: Bearer with the deployment's " +
      "EGMA_SIMULATOR_SERVICE_TOKEN — the same value the api and simulator " +
      "containers were started with. A customer API key can never open it.",
  );
}

/**
 * A bearer wearing the service prefix that is not this deployment's secret, on
 * the one door that serves the service token beside customer credentials. Its
 * own sentence because the general one would say "sign in", and the reader is
 * a simulator's log: the prefix means this was never a customer key, and the
 * fix is the token, not a session.
 */
export function wrongServiceToken(reply: FastifyReply): FastifyReply {
  return refuse(
    reply,
    "not_authenticated",
    "this bearer starts egma_st_ and is not this deployment's " +
      "EGMA_SIMULATOR_SERVICE_TOKEN. The api and simulator containers read " +
      "the same value — restart whichever holds a stale one. A customer key " +
      "starts egma_sk_ and files under its own account instead.",
  );
}

/**
 * The reader may have this, and this deployment has nowhere to get it from.
 *
 * The only 5xx in this vocabulary, and it earns that: every other refusal here
 * is about the request, and this one is about the installation. A recording
 * exists, the person asking is entitled to it, and the control plane has not
 * been told where a browser reaches the store — so the honest answer is that
 * egma is not able to serve this right now, with the variable to set. Answering
 * 404 would tell a reader their recording is gone, which is the one thing that
 * is not true.
 *
 * It is deliberately the **last** refusal a route makes, after every question
 * about who is asking and what they asked for. A configuration answer that
 * arrived first would let a stranger learn whether a simulation exists by
 * watching which sentence comes back.
 */
export function noObjectStore(
  reply: FastifyReply,
  message: string,
): FastifyReply {
  return refuse(reply, "no_object_store", message);
}

/** The organization's request budget is spent; the header says when to retry. */
export function tooManyRequests(
  reply: FastifyReply,
  retryAfterSeconds: number,
): FastifyReply {
  reply.header("retry-after", String(retryAfterSeconds));
  return refuse(
    reply,
    "too_many_requests",
    "this organization has made too many requests. The budget belongs " +
      "to the organization, so a new key will not reset it.",
  );
}
