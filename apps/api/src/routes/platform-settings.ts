import {
  authorize,
  NotPermittedError,
  readPlatformSettings,
  UnprocessableInputError,
  writePlatformSettings,
  type PlatformSetting,
  type PlatformSettingValues,
} from "@egma/db";
import type { FastifyInstance } from "fastify";

import type { SessionIdentityProvider } from "../auth/seam.ts";
import type { CarrierSettingsSource } from "../config.ts";
import { credentialed, requesterOf } from "../http/credentialed.ts";
import { notPermitted, unprocessable } from "../http/refusals.ts";
import type { RateLimit } from "../http/rate-limit.ts";

/**
 * The settings this deployment holds, as an organization owner reads and
 * changes them.
 *
 * This door owns only the deployment carrier route. Provider credentials come
 * from the deployment environment, while persona and grader versions own
 * model choices.
 *
 * **No read ever answers a stored secret.** What comes back for a setting is a
 * *hint*: the whole value where the setting is not a secret, and the last four
 * characters of the SIP password. There is no query, header or role that
 * returns the stored password.
 *
 * **A route changes as one supported shape.** It is either an address and
 * source number, or those two values plus a paired SIP username and password.
 *
 * **Only a single organization's owner may knock, on both doors.** These are
 * deployment configuration, so a `member` and a `viewer` are refused the read
 * as firmly as the write. The whole group is also refused on a deployment that
 * serves more than one organization, where no one organization owns the route.
 *
 * **Unknown keys are refused by name, once.** The body is small and every key
 * in it changes how the platform places calls, so a typo quietly ignored
 * would be an operator believing they had set something they had not. That
 * refusal is the factory's — this door does not check the same thing a second
 * time, because one condition answered two ways is a contract with two faces.
 *
 * The address follows the standing rule: nothing is rooted at a project and the
 * organization is never in a path. Neither appears here at all, because these
 * settings belong to the deployment rather than to any customer on it.
 */

export type PlatformSettingsRoutesOptions = {
  readonly provider: SessionIdentityProvider;
  readonly rateLimit: RateLimit;
  /**
   * Whether this deployment serves one organization. Handed to the factory on
   * every call: it is what decides whether anybody at all may be here, and the
   * flag lives in this process's configuration rather than in the store.
   */
  readonly singleOrganization: boolean;
  /** Which operator surface is allowed to change the carrier route. */
  readonly carrierSettingsSource: CarrierSettingsSource;
};

export const PLATFORM_SETTINGS_PATH = "/api/platform/settings";

type Body = Record<string, unknown>;

/** One setting as every read of one describes it. */
function described(setting: PlatformSetting): Record<string, unknown> {
  return {
    name: setting.name,
    label: setting.label,
    secret: setting.secret,
    // Null rather than absent, so a client can tell "the platform holds none of
    // this" from "this answer is an older shape that never carried one" — and
    // so a setup interview knows exactly what is left to ask for.
    hint: setting.hint,
    updated_at: setting.updatedAt?.toISOString() ?? null,
  };
}

function answer(held: readonly PlatformSetting[]): Record<string, unknown> {
  return { settings: held.map(described) };
}

export async function platformSettingsRoutes(
  app: FastifyInstance,
  options: PlatformSettingsRoutesOptions,
): Promise<void> {
  credentialed(app, {
    provider: options.provider,
    rateLimit: options.rateLimit,
  });

  /**
   * Every setting this platform knows about, held or not.
   *
   * The ones it does not hold are answered too, with a null hint, because the
   * question anybody asks here is *what is still missing* — a list of only what
   * is present would answer it by omission, which is how a setting gets
   * forgotten.
   */
  app.get(PLATFORM_SETTINGS_PATH, async (request, reply) => {
    const { auth } = requesterOf(request);
    const held = await readPlatformSettings(auth, {
      singleOrganization: options.singleOrganization,
    });
    return reply.send(answer(held));
  });

  /**
   * A setting written, or several.
   *
   * The role is checked before anything in the body is looked at, which is the
   * stance every write in this API takes: somebody who may not do this is
   * refused for who they are, rather than after a refusal that has read what
   * they sent. The factory checks it again — and checks the deployment's mode
   * with it — because a factory that trusted its callers would be one route
   * away from not being checked at all.
   */
  app.patch(PLATFORM_SETTINGS_PATH, async (request, reply) => {
    const { auth } = requesterOf(request);
    const body = (request.body ?? {}) as Body;

    authorize(auth, "manage_organization", {
      organizationId: auth.organizationId,
      projectId: auth.projectId,
    });

    if (options.carrierSettingsSource === "environment") {
      throw new UnprocessableInputError(
        "this deployment's carrier route is owned by the EGMA_PHONE_* values " +
          "in its environment. Change the complete route there and restart " +
          "the deployment; the settings API is read-only while the environment " +
          "owns the route.",
      );
    }

    const written = await writePlatformSettings(
      auth,
      { singleOrganization: options.singleOrganization },
      body as PlatformSettingValues,
    );
    return reply.send(answer(written));
  });

  /**
   * The refusals this group owns, each answered as an answer rather than as a
   * fault. A factory's sentence is relayed word for word — a client puts it in
   * front of whoever is holding the terminal, so the wording is the contract.
   *
   * **The permission refusal is the one exception, and deliberately.** Every
   * other group relays `NotPermittedError`'s own message, which reads "a member
   * may not manage_organization" — the name of a row in the permission table,
   * written for whoever is reading the code rather than for the colleague who
   * just tried to look at the platform's settings. One action stands behind
   * this whole group, so the sentence names both of the ways a caller can meet
   * it — the role they hold, and the kind of deployment this is — and lets them
   * see which of the two is theirs.
   */
  app.setErrorHandler(async (error, _request, reply) => {
    if (error instanceof UnprocessableInputError) {
      return unprocessable(reply, error.message);
    }

    if (error instanceof NotPermittedError) {
      return notPermitted(
        reply,
        "the carrier route of this platform is read and changed by an " +
        "organization owner, and only while this Egma instance serves one " +
          "organization. It is deployment configuration, not project content; " +
          "where several organizations share a platform it belongs to none of " +
          "them, so Egma refuses everybody rather than picking one.",
      );
    }

    throw error;
  });
}
