/**
 * Minting a key, as the fixture platform answers it.
 *
 * The mint route's whole secret is in its answer: it exists exactly once, in
 * the 201 body, and no read ever says it again. The revoke route proves that a
 * failed local setup can retire that exact key without knowing its secret.
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
  revokedAt: string | null;
};

export type ApiKeyControls = {
  /** Every key minted through the API, oldest first. */
  readonly minted: readonly MintedKey[];
  revoke(apiKeyId: string): void;
};

export function apiKeyRoutes(options: {
  readonly holdsKey: (key: string) => boolean;
  /** Adds a minted secret to the keys this instance will authorize. */
  readonly accept: (key: string) => void;
  /** Removes a revoked secret from the keys this instance will authorize. */
  readonly reject: (key: string) => void;
  readonly bindMonitoringExportKey: (
    agentId: string,
    projectId: string,
    apiKeyId: string,
  ) =>
    | { readonly kind: "bound"; readonly previous: string | null }
    | { readonly kind: "already-bound"; readonly apiKeyId: string }
    | undefined;
  readonly unbindMonitoringExportKey: (apiKeyId: string) => void;
  /** Model an older platform that accepts but ignores monitoringAgentId. */
  readonly ignoreMonitoringAgentId?: boolean;
  readonly organizationId: string;
  readonly projectId: string;
}): { readonly group: RouteGroup; readonly controls: ApiKeyControls } {
  const minted: MintedKey[] = [];

  const revoke = (apiKeyId: string): MintedKey | undefined => {
    const held = minted.find((key) => key.id === apiKeyId);
    if (held === undefined || held.revokedAt !== null) return undefined;
    held.revokedAt = new Date().toISOString();
    options.reject(held.secret);
    options.unbindMonitoringExportKey(apiKeyId);
    return held;
  };

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
            revokedAt: null,
          };
          const monitoringAgentId = given(text(body["monitoringAgentId"])) ?? null;
          if (monitoringAgentId !== null && options.ignoreMonitoringAgentId !== true) {
            if (named === null) {
              return {
                status: 422,
                body: {
                  error: "invalid_monitoring_agent",
                  message:
                    "monitoringAgentId must name a living LiveKit agent in the key's project",
                },
              };
            }
            const binding = options.bindMonitoringExportKey(
              monitoringAgentId,
              named,
              key.id,
            );
            if (binding === undefined) {
              return {
                status: 422,
                body: {
                  error: "invalid_monitoring_agent",
                  message:
                    "monitoringAgentId must name a living LiveKit agent in the key's project",
                },
              };
            }
            if (binding.kind === "already-bound") {
              return {
                status: 409,
                body: {
                  error: "monitoring_key_already_bound",
                  message:
                    "this LiveKit agent already has an active monitoring key; no key was rotated",
                },
              };
            }
          }
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
      {
        method: "POST",
        path: "/v1/keys/:apiKeyId/revoke",
        handle: (request) => {
          if (!authorized(request.headers)) return notAuthenticated;
          const key = revoke(request.params["apiKeyId"] ?? "");
          if (key === undefined) {
            return {
              status: 404,
              body: {
                error: "no_such_key",
                message: "no key of yours by that name is still live",
              },
            };
          }
          return {
            status: 200,
            body: {
              id: key.id,
              name: key.name,
              scope: key.scope,
              organizationId: options.organizationId,
              projectId: key.projectId,
              looksLike: `egma_sk_…${key.secret.slice(-4)}`,
              createdByUserId: newId("usr"),
              createdAt: new Date().toISOString(),
              lastUsedAt: null,
              revokedAt: key.revokedAt,
            },
          };
        },
      },
    ],
  };

  return {
    group,
    controls: {
      minted,
      revoke(apiKeyId) {
        revoke(apiKeyId);
      },
    },
  };
}
