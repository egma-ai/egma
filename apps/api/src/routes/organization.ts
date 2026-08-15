import {
  NotPermittedError,
  permits,
  readOrganization,
  UnprocessableInputError,
  updateOrganization,
  type Organization,
} from "@egma/db";
import type { FastifyInstance } from "fastify";

import type { SessionIdentityProvider } from "../auth/seam.ts";
import { credentialed, requesterOf } from "../http/credentialed.ts";
import type { RateLimit } from "../http/rate-limit.ts";
import { text } from "../http/reading.ts";
import {
  invalid,
  notPermitted,
  sendRefusal,
  unprocessable,
  REFUSALS,
} from "../http/refusals.ts";

/**
 * The customer itself: what it is called, and the one field an admin may
 * change.
 *
 * **It names no project and takes none, which is the whole reason it is its own
 * route group.** Membership, invitations, retention, API keys and this row all
 * belong to the organization; a Settings page that reached them through a
 * project-scoped door would be saying they belong to whichever project happened
 * to be selected, and somebody would eventually believe it.
 *
 * **The name and not the slug.** Renaming the customer breaks nothing: the slug
 * is what invitation links and the deployment's own uniqueness were written
 * against, and letting it move is a different decision with a different blast
 * radius. So the read answers both and the write takes one.
 */

export type OrganizationRoutesOptions = {
  readonly provider: SessionIdentityProvider;
  readonly rateLimit: RateLimit;
};

export const ORGANIZATION_PATH = "/api/organization";

type Body = Record<string, unknown>;

const EDIT_KEYS = ["name"] as const;

function described(
  organization: Organization,
  mayManage: boolean,
): Record<string, unknown> {
  return {
    id: organization.id,
    name: organization.name,
    slug: organization.slug,
    created_at: organization.createdAt.toISOString(),
    // So a page renders the controls it may offer rather than offering
    // everything and finding out. Never the boundary; the write below checks
    // again, and so does the data-access module.
    may_manage_organization: mayManage,
  };
}

export async function organizationRoutes(
  app: FastifyInstance,
  options: OrganizationRoutesOptions,
): Promise<void> {
  credentialed(app, {
    provider: options.provider,
    rateLimit: options.rateLimit,
  });

  /** Everybody may see which organization they are in. */
  app.get(ORGANIZATION_PATH, async (request, reply) => {
    const { auth } = requesterOf(request);
    const organization = await readOrganization(auth);

    if (organization === undefined) {
      return sendRefusal(
        reply,
        "not_found",
        "This session resolves to no organization. Sign in again, and ask an " +
          "admin if it keeps happening.",
      );
    }

    return reply.send(
      described(
        organization,
        permits(auth, "manage_organization", {
          organizationId: auth.organizationId,
          projectId: auth.projectId,
        }),
      ),
    );
  });

  app.patch(ORGANIZATION_PATH, async (request, reply) => {
    const { auth } = requesterOf(request);
    const body = (request.body ?? {}) as Body;

    if (auth.role !== "admin") {
      return sendRefusal(
        reply,
        "not_permitted",
        REFUSALS.notPermitted(auth.role, "change organization settings"),
      );
    }

    for (const key of Object.keys(body)) {
      if ((EDIT_KEYS as readonly string[]).includes(key)) continue;
      return invalid(
        reply,
        `an organization has no editable key "${key}"; it holds ${EDIT_KEYS.join(", ")}`,
      );
    }

    const edited = await updateOrganization(auth, { name: text(body.name) });
    if (edited === undefined) {
      return sendRefusal(
        reply,
        "not_found",
        "This session resolves to no organization. Sign in again, and ask an " +
          "admin if it keeps happening.",
      );
    }

    return reply.send(described(edited, true));
  });

  app.setErrorHandler(async (error, _request, reply) => {
    if (error instanceof UnprocessableInputError) {
      return unprocessable(reply, error.message);
    }
    if (error instanceof NotPermittedError) {
      return notPermitted(reply, error.message);
    }
    throw error;
  });
}
