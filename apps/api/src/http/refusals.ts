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
   * A live edit written against a state the resource has left behind. Its own
   * code beside `version_conflict` because the two halves of a versioned
   * resource move apart: a rename must not make a rubric edit stale, and a
   * client has to know which of the two to reread and resend.
   */
  identity_conflict: 409,
  /** A versioned edit written against a version the resource has minted past. */
  version_conflict: 409,
  /**
   * A grader an active test names directly, refused Archive. Its own code
   * because the fix is specific — go and take it off those tests — and the
   * refusal names them.
   */
  grader_in_use: 409,
  unprocessable: 422,
  /**
   * A product request that named no project. Its own code because there is one
   * thing to do about it and a page can do it: the selector already knows every
   * project this person may open.
   */
  project_required: 422,
  /**
   * A project's judge pointed at a credential issued by a different provider.
   * Nothing about the request is malformed and nothing is missing — the two
   * settings simply cannot both be true — so it is its own answer.
   */
  judge_credential_provider_mismatch: 422,
  unsignable_reference: 422,
  no_adapter: 422,
  phone_setup_required: 422,
  too_many_requests: 429,
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

  identityConflict: (resource: string, resourceId: string): string =>
    `${resource} ${resourceId} changed after you opened it. Read it again, ` +
    "keep or reapply your edits, and send the update with expected_revision " +
    "set to its new revision.",

  versionConflict: (
    resource: string,
    expected: string,
    current: string,
  ): string =>
    `this ${resource} edit was written against version ${expected}, and it ` +
    `has moved on to ${current}. Read the ${resource} again, keep or reapply ` +
    `your edits, and send them with expected_version_id set to ${current}.`,

  graderInUse: (graderId: string, tests: string): string =>
    `Grader ${graderId} is added directly to active tests ${tests}. Remove ` +
    "it from those tests, or archive the tests, then archive this grader.",

  judgeCredentialProviderMismatch: (
    credentialId: string,
    credentialProvider: string,
    judgeProvider: string,
  ): string =>
    `Judge credential ${credentialId} is for ${credentialProvider}, but this ` +
    `project judge uses ${judgeProvider}. Choose a credential for ` +
    `${judgeProvider} and save the judge setting again.`,
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
 * operational failure and an agent's verdict that this product exists to keep
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
      "Sign in, or send Authorization: Bearer with an egma key.",
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
    "this route hands out simulation work and answers only to egma's own " +
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
