import type { FastifyReply } from "fastify";

/**
 * API refusals pair a stable snake_case error code with an editable message.
 * CODES centralizes code/status pairs for the typed senders in this module.
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
  // A guarded API-key mint found an active project key whose name already
  // starts with the requested prefix. The response never describes that row.
  active_key_name_conflict: 409,
  // A stale write, told apart from a plain conflict by which of the two things
  // moved: the resource's identity, or the content of its current version.
  // The caller's next move differs — one is retyped, the other is reapplied —
  // so a client that could not tell them apart could not offer either.
  identity_conflict: 409,
  version_conflict: 409,
  parent_agent_archived: 409,
  /**
   * Egma owns this shared persona definition — **Predefined**, in the word
   * every screen and sentence uses. A project can use it as-is or fork it, but
   * cannot change or delete it for every customer.
   *
   * The code keeps the older spelling deliberately: a code is a promise a
   * client branches on, and the rename was a rename of the product word rather
   * than of the tenancy rule underneath it.
   */
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
  /**
   * A test requires mock tools but its temporary agent version could not be
   * built. Refuse the run instead of executing those tools against real backends.
   */
  mock_tools_unbuildable: 422,
  /**
   * Another run holds this agent's mock-draft claim. Retry after it finishes
   * and cleanup succeeds; concurrent mock-draft lifecycles are refused.
   */
  mock_tools_agent_in_use: 409,
  too_many_requests: 429,
  /**
   * Return a fixed internal-error message instead of exposing driver details,
   * SQL, or credential envelopes in the response.
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
 * Format stale-revision errors with the route's resource name. The error
 * provides IDs and revisions; the caller must reread before retrying.
 * Persona edits do not use revision tokens.
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

  identityConflictOnDelete: (resource: string, resourceId: string): string =>
    `${resource} ${resourceId} changed after you opened it. Read it again ` +
    "before deciding whether to delete it.",

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
 * A stored recording reference is invalid. Keep this separate from expected
 * audio absence so the UI can report the defect.
 */
export function unsignableReference(
  reply: FastifyReply,
  message: string,
): FastifyReply {
  return refuse(reply, "unsignable_reference", message);
}

/**
 * A run over a connection type whose simulator adapter has not shipped.
 *
 * Its own code rather than an `unprocessable`, because the caller's next move
 * is different in kind: nothing about the request can be fixed, and the answer
 * is to run over something else or to wait for the adapter.
 */
export function noAdapter(reply: FastifyReply, message: string): FastifyReply {
  return refuse(reply, "no_adapter", message);
}

/**
 * Phone execution is supported but this deployment lacks carrier settings.
 * Reject before creating the run; no_adapter instead means unsupported execution.
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
 * Recording playback is not configured on this deployment. Check access and
 * recording eligibility first, then name the missing configuration.
 * A configuration error must not appear as a missing recording.
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
