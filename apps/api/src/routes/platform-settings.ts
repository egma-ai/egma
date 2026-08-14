import {
  authorize,
  NotPermittedError,
  PLATFORM_SETTINGS,
  readPlatformSettings,
  UnprocessableInputError,
  writePlatformSettings,
  type PlatformSetting,
  type PlatformSettingValues,
} from "@egma/db";
import type { FastifyInstance } from "fastify";

import type { SessionIdentityProvider } from "../auth/seam.ts";
import { credentialed, requesterOf } from "../http/credentialed.ts";
import { invalid, notPermitted, unprocessable } from "../http/refusals.ts";
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
 * **Only an owner may knock, on both doors.** These are the deployment's own
 * provider credentials, which is the row of the permission table that already
 * names provider credentials. A `member` and a `viewer` are refused the read as
 * firmly as the write: reading is how you learn whose account this platform
 * spends from.
 *
 * **Unknown keys are refused by name.** The body is small and every key in it
 * changes what the platform will speak with, so a typo quietly ignored would be
 * an operator believing they had set something they had not. The agent group's
 * gate, for the agent group's reason.
 *
 * The address follows the standing rule: nothing is rooted at a project and the
 * organization is never in a path. Neither appears here at all, because these
 * settings belong to the deployment rather than to any customer on it.
 */

export type PlatformSettingsRoutesOptions = {
  readonly provider: SessionIdentityProvider;
  readonly rateLimit: RateLimit;
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

/**
 * The unknown-key gate. Refusing by name rather than ignoring is what turns a
 * typo into an answer a person can act on: a misspelled setting that was
 * silently dropped would leave the platform reporting `setup required` for
 * something its operator is certain they supplied.
 */
function unknownKeyIn(body: Body): string | undefined {
  const known = PLATFORM_SETTINGS.map((setting) => setting.name);
  for (const key of Object.keys(body)) {
    if ((known as readonly string[]).includes(key)) continue;
    return (
      `this egma has no platform setting "${key}"; it holds ` +
      `${known.join(", ")}`
    );
  }
  return undefined;
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
    return reply.send(answer(await readPlatformSettings(auth)));
  });

  /**
   * A setting written, or several.
   *
   * The role is checked before anything in the body is looked at, which is the
   * stance every write in this API takes and which matters here for a reason of
   * its own: the unknown-key refusal below names every setting this platform
   * holds, and somebody who may not read the settings must not learn their
   * names by misspelling one.
   */
  app.patch(PLATFORM_SETTINGS_PATH, async (request, reply) => {
    const { auth } = requesterOf(request);
    const body = (request.body ?? {}) as Body;

    authorize(auth, "manage_organization", {
      organizationId: auth.organizationId,
      projectId: auth.projectId,
    });

    const unknown = unknownKeyIn(body);
    if (unknown !== undefined) return invalid(reply, unknown);

    const written = await writePlatformSettings(
      auth,
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
   * just tried to look at the platform's settings. There is one action behind
   * this whole group, so there is exactly one thing that sentence could ever be
   * about, and it is worth saying in words.
   */
  app.setErrorHandler(async (error, _request, reply) => {
    if (error instanceof UnprocessableInputError) {
      return unprocessable(reply, error.message);
    }

    if (error instanceof NotPermittedError) {
      return notPermitted(
        reply,
        "the settings of this platform are read and changed by an " +
          "organization owner. They are the deployment's own provider " +
          "credentials — whose account every simulation is conducted on — " +
          "which is a decision of the same kind as billing rather than of the " +
          "same kind as writing a test.",
      );
    }

    throw error;
  });
}
