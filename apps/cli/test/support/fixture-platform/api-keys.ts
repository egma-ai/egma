/**
 * Minting a key, as the fixture platform answers it.
 *
 * One route, and the whole of what matters about it is in the answer: the
 * secret exists exactly once, in the 201 body, and no read ever says it again.
 * A key minted for a project is scoped to that project — the request names the
 * project and the scope is derived, because there is no scope field to send.
 *
 * The key it mints is a real key of this instance: it is added to the list the
 * other groups authorize against, so a check can prove that what the terminal
 * wrote into a `.env` is a credential this platform would actually take.
 */

import { given, newId, NOT_AUTHENTICATED, text } from "./reading.ts";
import type { FixtureAnswer, RouteGroup } from "./server.ts";

/** One key this instance minted, as everything but the mint itself sees it. */
export type MintedKey = {
  readonly id: string;
  readonly name: string | null;
  readonly scope: "organization" | "project";
  readonly projectId: string | null;
  /** The secret, kept so a check can prove where it did and did not land. */
  readonly secret: string;
};

export type ApiKeyControls = {
  /** Every key minted through the API, oldest first. */
  readonly minted: readonly MintedKey[];
};

export function apiKeyRoutes(options: {
  readonly holdsKey: (key: string) => boolean;
  /** Adds a minted secret to the keys this instance will authorize. */
  readonly accept: (key: string) => void;
  readonly organizationId: string;
  readonly projectId: string;
}): { readonly group: RouteGroup; readonly controls: ApiKeyControls } {
  const minted: MintedKey[] = [];

  const authorized = (headers: Record<string, string | undefined>): boolean => {
    const offered = (headers["authorization"] ?? "").replace(/^Bearer\s+/iu, "");
    return offered !== "" && options.holdsKey(offered);
  };

  const notAuthenticated: FixtureAnswer = {
    status: 401,
    body: NOT_AUTHENTICATED,
  };

  const group: RouteGroup = {
    name: "api-keys",
    routes: [
      {
        method: "POST",
        path: "/v1/keys",
        handle: (request) => {
          if (!authorized(request.headers)) return notAuthenticated;
          const body = request.body ?? {};
          const named = given(text(body["projectId"])) ?? null;
          if (named !== null && named !== options.projectId) {
            return {
              status: 403,
              body: {
                error: "project_outside_organization",
                message:
                  "that project belongs to a different organization, and the " +
                  "organization on a key comes from the credential rather than " +
                  "from the request",
              },
            };
          }

          const id = newId("key");
          // The one time this string exists outside the terminal that holds it.
          const secret = `egma_sk_${id.slice(-20)}`;
          const key: MintedKey = {
            id,
            name: given(text(body["name"])) ?? null,
            scope: named === null ? "organization" : "project",
            projectId: named,
            secret,
          };
          minted.push(key);
          options.accept(secret);

          return {
            status: 201,
            body: {
              id: key.id,
              name: key.name,
              scope: key.scope,
              organizationId: options.organizationId,
              projectId: key.projectId,
              looksLike: `egma_sk_…${secret.slice(-4)}`,
              createdByUserId: newId("usr"),
              createdAt: new Date().toISOString(),
              lastUsedAt: null,
              revokedAt: null,
              secret,
            },
          };
        },
      },
    ],
  };

  return { group, controls: { minted } };
}
