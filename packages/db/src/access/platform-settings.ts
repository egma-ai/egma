import { newId } from "@egma/ids";
import { inArray, sql } from "drizzle-orm";

import { db } from "../client.ts";
import {
  platformSetting,
  PLATFORM_SETTINGS,
  type PlatformSettingDefinition,
  type PlatformSettingName,
  type PlatformSettingValues,
} from "../schema/platform.ts";
import { sealCredentials } from "../sealing.ts";
import type { AuthContext } from "./context.ts";
import { UnprocessableInputError } from "./errors.ts";
import { authorize, here } from "./permissions.ts";

/**
 * The settings this deployment holds: what it was configured with, sealed, and
 * owned by the platform rather than by any customer on it.
 *
 * **This is the judge configuration's idiom, one scope up.** A judge's
 * provider, model and key live in a table owned by a project, sealed with the
 * deployment's encryption key, with a hint kept for display; environment
 * variables seed it once at start and never replace a judge a project has
 * chosen. Everything here is that arrangement applied to the settings that
 * belong to the whole deployment, and nothing about it is new — which is the
 * point. A second idiom for the same job is the thing worth avoiding.
 *
 * Three doors, and the split between them is the design:
 *
 * - **Writing** takes each value in the clear, seals it, and keeps a hint
 *   beside it — the whole value for a setting that is not a secret, the last
 *   four characters for one that is.
 * - **Reading** answers every setting the platform knows about, held or not,
 *   with its label and its hint. It never answers a stored secret, and there is
 *   no argument by which it could be asked to: the sealed column is not among
 *   the ones it selects.
 * - **Seeding** is the deployment configuring itself at start, from its own
 *   environment. It writes only where the platform holds nothing.
 *
 * There is deliberately **no door to the plaintext here yet**. The one caller
 * that needs it is the work order a simulator claims, and opening that door
 * before something goes through it would be a way out with nothing watching it.
 */

/**
 * The floor under a secret, so the stored last-four stays a hint rather than
 * most of the secret it hints at. Real provider keys are tens of characters, so
 * anything this short is a paste gone wrong. The judge's floor, for the judge's
 * reason.
 */
const SHORTEST_SECRET = 8;

/** How much of a secret a hint may be. */
const HINT_CHARACTERS = 4;

/** One setting as anybody but the deployment's own machinery sees it. */
export type PlatformSetting = {
  readonly name: PlatformSettingName;
  /** The words a person calls it by, and the words a refusal names it in. */
  readonly label: string;
  /** Whether the stored value may ever be shown back. */
  readonly secret: boolean;
  /**
   * What may be shown: the whole value where this is not a secret, its last
   * four characters where it is, and `null` where the platform holds no such
   * setting at all. Absent is an ordinary state rather than a fault — it is
   * what every platform is before anybody has set it up.
   */
  readonly hint: string | null;
  /** When it was last changed, or `null` while the platform holds none. */
  readonly updatedAt: Date | null;
};

/**
 * What this deployment has been configured with, as anybody may see it.
 *
 * A setting the platform holds appears here: its value where that value is not
 * a secret, and `null` where it is. A setting it does not hold is absent
 * entirely. That is the whole of what the unauthenticated readiness answer is
 * built from, which is why a secret's *hint* is not in it either — enough to
 * say a key is there, and never any part of the key.
 */
export type PlatformFacts = Readonly<Record<string, string | null>>;

function definitionOf(name: string): PlatformSettingDefinition {
  const known = PLATFORM_SETTINGS.find(
    (candidate) => candidate.name === name,
  ) as PlatformSettingDefinition | undefined;
  if (known === undefined) {
    throw new UnprocessableInputError(
      `"${name}" is not a platform setting egma knows; it holds ${PLATFORM_SETTINGS.map(
        (setting) => setting.name,
      ).join(", ")}`,
    );
  }
  return known;
}

/**
 * Trimmed before it is sealed, like every credential this codebase stores: a
 * key pasted with whitespace would pass every check, seal the padding, and fail
 * at the provider with nothing to say the stored value was the problem.
 */
function validValue(
  definition: PlatformSettingDefinition,
  value: unknown,
): string {
  if (typeof value !== "string") {
    throw new UnprocessableInputError(
      `${definition.label} is written as text, and this request sent ${typeof value}`,
    );
  }
  const trimmed = value.trim();
  if (trimmed === "") {
    throw new UnprocessableInputError(
      `${definition.label} needs a value. Clearing a setting is not something ` +
        "egma does here: a platform that held one and then held none would " +
        "report itself as never having been set up.",
    );
  }
  if (definition.secret && trimmed.length < SHORTEST_SECRET) {
    throw new UnprocessableInputError(
      `${definition.label} is at least ${SHORTEST_SECRET} characters, and ` +
        "this one is shorter than any provider issues",
    );
  }
  return trimmed;
}

/** What a person may be shown of a stored value. See `PlatformSetting.hint`. */
function hintOf(definition: PlatformSettingDefinition, value: string): string {
  return definition.secret ? value.slice(-HINT_CHARACTERS) : value;
}

/** One row, validated and sealed, ready to insert. Shared by both writers. */
function rowFor(name: PlatformSettingName, value: unknown, now: Date) {
  const definition = definitionOf(name);
  const settled = validValue(definition, value);
  return {
    id: newId("pfs"),
    name,
    // Sealed per row rather than once for many: the envelope carries its own
    // initialisation vector, and reusing one across rows is the mistake this
    // repeats a cheap operation to avoid.
    value: sealCredentials(settled),
    hint: hintOf(definition, settled),
    updatedAt: now,
  };
}

/** Every setting named, validated and sealed, in the order they were named. */
function rowsFor(values: PlatformSettingValues, now: Date) {
  const named = Object.keys(values) as PlatformSettingName[];
  if (named.length === 0) {
    throw new UnprocessableInputError(
      `a write names at least one setting to change; egma holds ${PLATFORM_SETTINGS.map(
        (setting) => setting.name,
      ).join(", ")}`,
    );
  }
  return named.map((name) => rowFor(name, values[name], now));
}

/** The columns a read answers from. The sealed value is not among them. */
const SHOWN = {
  name: platformSetting.name,
  hint: platformSetting.hint,
  updatedAt: platformSetting.updatedAt,
} as const;

/** Every setting egma knows about, against what this platform actually holds. */
function answer(
  held: readonly { name: string; hint: string; updatedAt: Date }[],
): readonly PlatformSetting[] {
  return PLATFORM_SETTINGS.map((definition) => {
    const row = held.find((candidate) => candidate.name === definition.name);
    return {
      name: definition.name,
      label: definition.label,
      secret: definition.secret,
      hint: row?.hint ?? null,
      updatedAt: row?.updatedAt ?? null,
    };
  });
}

async function heldSettings(): Promise<
  readonly { name: string; hint: string; updatedAt: Date }[]
> {
  return db()
    .select(SHOWN)
    .from(platformSetting)
    .where(
      inArray(
        platformSetting.name,
        PLATFORM_SETTINGS.map((setting) => setting.name),
      ),
    );
}

/**
 * What this platform holds, and what it is missing.
 *
 * **Only an organization owner may ask**, on the row of the permission table
 * that already names provider credentials. These are the deployment's own
 * accounts: which provider it speaks with and whose key it spends is the same
 * kind of decision as retention and billing, rather than the same kind as
 * writing a test — and a `viewer` who could read them would be reading the
 * hints of the platform's secrets.
 *
 * While a deployment serves one organization, which it does by default and does
 * on every self-host, its owner and the platform's operator are the same
 * person. A deployment serving several organizations makes this a real
 * permission question, and that question is deliberately not answered here.
 */
export async function readPlatformSettings(
  auth: AuthContext,
): Promise<readonly PlatformSetting[]> {
  authorize(auth, "manage_organization", here(auth));
  return answer(await heldSettings());
}

/**
 * A setting written, or several. What a write does not name, the platform
 * keeps.
 *
 * One row per setting is what makes that true without an argument for it: a
 * write touches the rows it names and no others, so changing the model on a
 * settings form cannot drop the key beside it. A value replaces whole or is
 * left alone; there is no shape in which one could be edited in place, because
 * the envelope is sealed over the whole value.
 */
export async function writePlatformSettings(
  auth: AuthContext,
  values: PlatformSettingValues,
): Promise<readonly PlatformSetting[]> {
  authorize(auth, "manage_organization", here(auth));

  // One statement for however many settings were named, so a form that changes
  // three of them cannot land one and then fail: each row carries its own new
  // value, and `excluded` is how the conflicting row's own values are taken
  // rather than the same value being written to every one of them.
  await db()
    .insert(platformSetting)
    .values(rowsFor(values, new Date()))
    .onConflictDoUpdate({
      target: platformSetting.name,
      set: {
        value: sql`excluded.value`,
        hint: sql`excluded.hint`,
        updatedAt: sql`excluded.updated_at`,
      },
    });

  return answer(await heldSettings());
}

/**
 * What this deployment has been configured with, for the answer it gives before
 * anybody has logged in.
 *
 * It takes nothing, so there is no customer it could be asked about, and it
 * returns non-secret facts only — a provider's name, a model's name, and `null`
 * standing in for every secret it holds. That is what lets it skip the
 * `AuthContext` every read of a customer's data requires: the readiness answer
 * is read by the CLI in front of every command, before login and before a
 * repository identifier is ever sent, exactly as the platform's own identity
 * is.
 */
export async function platformFacts(): Promise<PlatformFacts> {
  const held = await heldSettings();
  const facts: Record<string, string | null> = {};
  for (const definition of PLATFORM_SETTINGS) {
    const row = held.find((candidate) => candidate.name === definition.name);
    if (row === undefined) continue;
    facts[definition.name] = definition.secret ? null : row.hint;
  }
  return facts;
}

/**
 * Give the platform every setting its environment names and it does not
 * already hold.
 *
 * **This is the second way in, and the operator chooses which.** One is an
 * interview: `egma self-host setup` asks for each setting in turn and writes it
 * through the API. The other is this — an automated deployment answers no
 * questions, so it puts the settings in its environment and the platform reads
 * them on start.
 *
 * **It never overwrites.** A setting somebody has changed has been changed, and
 * a restart is not an occasion to put a script's copy of the old key back. So
 * this is safe to run on every boot, and running it on every boot is what makes
 * a setting added to the environment later arrive at the next start rather than
 * never.
 *
 * Not authorized against an `AuthContext` on purpose, exactly as the default
 * judge's seeding is not: there is no user here. This is the deployment acting
 * on its own configuration, in the same breath as applying its migrations, and
 * there is no session it could be doing it under.
 */
export async function seedPlatformSettings(
  values: PlatformSettingValues,
): Promise<readonly PlatformSettingName[]> {
  const named = Object.keys(values) as PlatformSettingName[];
  if (named.length === 0) return [];

  const now = new Date();
  const rows = named
    .filter((name) => values[name] !== undefined)
    .map((name) => rowFor(name, values[name], now));
  if (rows.length === 0) return [];

  const written = await db()
    .insert(platformSetting)
    .values(rows)
    // The setting a person had already written stays exactly as they wrote it,
    // and this is the whole safety of running on every boot. Nothing here is a
    // race worth locking for either: the losing side is the environment's copy,
    // which is exactly the side that should lose.
    .onConflictDoNothing({ target: platformSetting.name })
    .returning({ name: platformSetting.name });

  return written.map((row) => row.name as PlatformSettingName);
}
