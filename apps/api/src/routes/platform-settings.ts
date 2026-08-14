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
import { credentialed, requesterOf } from "../http/credentialed.ts";
import { notPermitted, unprocessable } from "../http/refusals.ts";
import type { RateLimit } from "../http/rate-limit.ts";

/**
 * The settings this deployment holds, as an organization owner reads and
 * changes them.
 *
 * Four things about this group are contract rather than convenience.
 *
 * **No read ever answers a stored secret.** What comes back for a setting is a
 * *hint*: the whole value where the setting is not a secret — a provider's
 * name, a model's name — and the last four characters where it is, so that two
 * keys can be told apart without either being handed to a browser. There is no
 * query, no header and no role that widens that, because the sealed column is
 * not among the ones the read selects at all. A stolen browser record is
 * therefore not a stolen provider account.
 *
 * **An edit changes what it names and nothing else.** One row per setting is
 * what makes that structural: changing the model on a settings form cannot drop
 * the key beside it, and a value is replaced whole or left alone — there is no
 * shape in which one could be edited in place, because the envelope is sealed
 * over the whole value.
 *
 * **Only a single organization's owner may knock, on both doors.** These are
 * the deployment's own provider credentials, which is the row of the permission
 * table that already names provider credentials — so a `member` and a `viewer`
 * are refused the read as firmly as the write, because reading is how you learn
 * whose account this platform spends from. And the whole group is refused on a
 * deployment serving more than one organization, where these settings belong to
 * none of them; the factory holds both halves and says why.
 *
 * **Unknown keys are refused by name, once.** The body is small and every key
 * in it changes what the platform will speak with, so a typo quietly ignored
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
        "the settings of this platform are read and changed by an " +
          "organization owner, and only while this egma serves one " +
          "organization. They are the deployment's own provider credentials — " +
          "whose account every simulation is conducted on — which is a " +
          "decision of the same kind as billing rather than of the same kind " +
          "as writing a test; and where several organizations share a platform " +
          "they belong to none of them, so egma refuses everybody rather than " +
          "picking one.",
      );
    }

    throw error;
  });
}
