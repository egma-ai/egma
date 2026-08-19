import { newId } from "@egma/ids";
import { eq, inArray, sql } from "drizzle-orm";

import { db, type Transaction } from "../client.ts";
import {
  platformSetting,
  PLATFORM_SETTINGS,
  type PlatformSettingDefinition,
  type PlatformSettingName,
  type PlatformSettingValues,
} from "../schema/platform.ts";
import { openCredentials, sealCredentials } from "../sealing.ts";
import type { AuthContext } from "./context.ts";
import { NotPermittedError, UnprocessableInputError } from "./errors.ts";
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
 * - **Resolving** is the one door to the plaintext, and it opens for the work
 *   order a simulator claims and for nothing else. See
 *   `resolvePlatformSettings`, which is where that argument is written out.
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

/** E.164: a plus, then no more than fifteen digits and no leading zero. */
const E164 = /^\+[1-9]\d{1,14}$/;

/** The phone values supplied at boot, in the order their bundle is named. */
const CARRIER_BUNDLE = [
  "carrier_trunk_address",
  "carrier_trunk_number",
  "carrier_trunk_username",
  "carrier_trunk_password",
] as const satisfies readonly PlatformSettingName[];

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
 *
 * Written on one line and keyed by the settings egma knows, both deliberately:
 * the build rule pins this alias's whole body as the text of what
 * `platformFacts` may answer, so widening it to carry a hint or a secret stops
 * the build rather than quietly widening an exemption.
 */
export type PlatformFacts = Readonly<Partial<Record<PlatformSettingName, string | null>>>;

/**
 * What kind of deployment this is, for the one decision that turns on it.
 *
 * It is the existing `EGMA_SINGLE_ORGANIZATION` flag, which already means "this
 * deployment is one team", handed in rather than read here: the flag belongs to
 * the process's configuration and this module reads no environment. The judge
 * gates on the same flag in the same way, one scope down.
 */
export type DeploymentTenancy = {
  /** Whether this deployment serves exactly one organization. */
  readonly singleOrganization: boolean;
};

/**
 * Who may read and change the settings of this whole platform.
 *
 * **Two conditions, and both are refusals of the same kind.** An organization
 * owner may, on the row of the permission table that already names provider
 * credentials — these are the deployment's own accounts, and which provider it
 * speaks with and whose key it spends is the same kind of decision as retention
 * and billing rather than the same kind as writing a test.
 *
 * **And only while this deployment serves one organization.** That mode is what
 * makes an owner and the platform's operator the same person; without it, every
 * organization's owner would read the hints of a key the others depend on and
 * could point the platform at an account nobody else agreed to. When a
 * deployment serves several customers this becomes a real permission question —
 * whose settings these are, and who is allowed to answer for the deployment —
 * and that question is deliberately not answered here. Until it is, egma
 * refuses everybody rather than picking one of them.
 *
 * The judge's guard is the same guard: the platform's own model credential is
 * given away only on a single-organization deployment, and for the same reason.
 */
function onlyASingleOrganizationsOwner(
  auth: AuthContext,
  deployment: DeploymentTenancy,
): void {
  authorize(auth, "manage_organization", here(auth));
  if (deployment.singleOrganization) return;
  throw new NotPermittedError(auth, "manage_organization", here(auth));
}

function definitionOf(name: string): PlatformSettingDefinition {
  const known = PLATFORM_SETTINGS.find(
    (candidate) => candidate.name === name,
  );
  if (known === undefined) {
    throw new UnprocessableInputError(
      `"${name}" is not a platform setting Egma knows; it holds ${PLATFORM_SETTINGS.map(
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
        "Egma does here: a platform that held one and then held none would " +
        "report itself as never having been set up.",
    );
  }
  if (definition.secret && trimmed.length < SHORTEST_SECRET) {
    throw new UnprocessableInputError(
      `${definition.label} is at least ${SHORTEST_SECRET} characters, and ` +
        "this one is shorter than any provider issues",
    );
  }
  if (definition.name === "carrier_trunk_number" && !E164.test(trimmed)) {
    throw new UnprocessableInputError(
      "the source number must be an E.164 phone number such as +15551234567",
    );
  }
  if (definition.name === "carrier_trunk_address") {
    let address: URL;
    try {
      address = new URL(`sip://${trimmed}`);
    } catch {
      throw new UnprocessableInputError(
        "the carrier trunk must be a SIP hostname such as trunk.example.com",
      );
    }
    if (
      address.hostname === "" ||
      address.username !== "" ||
      address.password !== "" ||
      address.pathname !== "" ||
      address.search !== "" ||
      address.hash !== ""
    ) {
      throw new UnprocessableInputError(
        "the carrier trunk must be a SIP hostname such as trunk.example.com, " +
          "with no scheme, credentials or path",
      );
    }
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

/**
 * Carrier values are one route, not four unrelated settings.
 *
 * Two values are a complete source-IP-authenticated route. Four values are a
 * complete credential-authenticated route. Every other subset can only mix an
 * old route with part of a new one, so both the API writer and boot seeder
 * refuse it before either stores a row.
 */
function requireWholeCarrier(
  values: PlatformSettingValues,
  action: "write" | "seed",
): void {
  const named = CARRIER_BUNDLE.filter((name) => values[name] !== undefined);
  if (named.length === 0) return;

  const ipAuthenticated =
    values.carrier_trunk_address !== undefined &&
    values.carrier_trunk_number !== undefined &&
    values.carrier_trunk_username === undefined &&
    values.carrier_trunk_password === undefined;
  const credentialAuthenticated = named.length === CARRIER_BUNDLE.length;
  if (ipAuthenticated || credentialAuthenticated) return;

  const missing = CARRIER_BUNDLE.filter((name) => values[name] === undefined);
  throw new UnprocessableInputError(
    `a carrier ${action} is either its trunk address and source number for IP ` +
      "authentication, or all four trunk and SIP credential values for " +
      `credential authentication; this ${action} is missing ${missing.join(" and ")}`,
  );
}

/** Every setting named, validated and sealed, in the order they were named. */
function rowsFor(values: PlatformSettingValues, now: Date) {
  const named = Object.keys(values) as PlatformSettingName[];
  if (named.length === 0) {
    throw new UnprocessableInputError(
      `a write names at least one setting to change; Egma holds ${PLATFORM_SETTINGS.map(
        (setting) => setting.name,
      ).join(", ")}`,
    );
  }
  requireWholeCarrier(values, "write");
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
 * What this platform holds, and what it is missing. Refused to anybody but a
 * single organization's owner — see `onlyASingleOrganizationsOwner`, which is
 * the whole of who may be here and why.
 */
export async function readPlatformSettings(
  auth: AuthContext,
  deployment: DeploymentTenancy,
): Promise<readonly PlatformSetting[]> {
  onlyASingleOrganizationsOwner(auth, deployment);
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
  deployment: DeploymentTenancy,
  values: PlatformSettingValues,
): Promise<readonly PlatformSetting[]> {
  onlyASingleOrganizationsOwner(auth, deployment);

  await db().transaction(async (tx) => {
    // What the provider being replaced takes with it, before anything is
    // written — read inside the transaction so the comparison is against the
    // row this write is really replacing.
    const stale = await staleUnder(tx, values);

    // One statement for however many settings were named, so a form that
    // changes three of them cannot land one and then fail: each row carries
    // its own new value, and `excluded` is how the conflicting row's own
    // values are taken rather than the same value being written to every one
    // of them.
    await tx
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

    // Writing the two-value form chooses source-IP authentication. Remove a
    // credential pair the previous route used in the same transaction, or the
    // result would still be a four-value route with two old credential halves.
    if (
      values.carrier_trunk_address !== undefined &&
      values.carrier_trunk_number !== undefined &&
      values.carrier_trunk_username === undefined &&
      values.carrier_trunk_password === undefined
    ) {
      await tx.delete(platformSetting).where(
        inArray(platformSetting.name, [
          "carrier_trunk_username",
          "carrier_trunk_password",
        ]),
      );
    }

    // In the same transaction as the change that stranded them, so there is
    // no moment where the new provider is stored beside the old provider's
    // model.
    if (stale.length > 0) {
      await tx
        .delete(platformSetting)
        .where(inArray(platformSetting.name, stale));
    }
  });

  return answer(await heldSettings());
}

/**
 * Which settings a provider change has just stranded, and why they go.
 *
 * **A model name and a voice id belong to the provider that coined them.**
 * `sonic-3.5` means nothing to OpenAI and `alloy` means nothing to Cartesia,
 * and a reasoning effort a model accepts is refused outright by one that has
 * never heard of the field. So the moment the provider beside them changes,
 * those values stop being configuration and become a trap: the simulator asks
 * the newly chosen provider for the old one's model and is refused at the
 * first word — which reads as a broken deployment rather than as a setting
 * nobody updated.
 *
 * Nothing else could clear them. Writing a setting is writing a *value*, and
 * an empty one is refused precisely so that a half-filled form cannot wipe a
 * key — so without this an operator who changed provider had no way back to
 * the working state through the API at all.
 *
 * **Only ever a narrowing, and only on a real change.** A write that does not
 * name a provider strands nothing; a write that names the provider already
 * stored strands nothing; and a write that names the dependent value itself
 * strands nothing, because supplying the new provider's model in the same
 * breath is exactly the careful thing to do and must not then delete it.
 */
const DEPENDS_ON: Readonly<
  Partial<Record<PlatformSettingName, readonly PlatformSettingName[]>>
> = {
  persona_model: ["persona_model_reasoning_effort"],
  speech_to_text_provider: ["speech_to_text_model"],
  text_to_speech_provider: ["text_to_speech_model", "text_to_speech_voice"],
};

async function staleUnder(
  tx: Transaction,
  values: PlatformSettingValues,
): Promise<PlatformSettingName[]> {
  const stale: PlatformSettingName[] = [];

  for (const [chosen, dependents] of Object.entries(DEPENDS_ON) as [
    PlatformSettingName,
    readonly PlatformSettingName[],
  ][]) {
    const wanted = values[chosen];
    if (wanted === undefined) continue;

    const [held] = await tx
      .select({ value: platformSetting.value })
      .from(platformSetting)
      .where(eq(platformSetting.name, chosen));
    // Nothing stored is a first write rather than a change, and there is no
    // older provider for anything to be stale under.
    if (held === undefined) continue;
    if (openCredentials(held.value) === wanted) continue;

    for (const dependent of dependents) {
      // Named in this same write, so it is the new provider's own value and
      // the whole point of it is that it survives.
      if (values[dependent] !== undefined) continue;
      stale.push(dependent);
    }
  }

  return stale;
}

/**
 * What this deployment has been configured with, in the clear, for the work
 * order a simulator claims.
 *
 * **This is the same door a connection's credentials come through, and it is
 * guarded the same way.** `resolveSimulationConnection` unseals for egma's own
 * simulator and refuses every other kind of context; so does this, on the same
 * sentence and for the same reason. The settings and the connection's
 * credentials then ride one answer, with one authority behind it, which is what
 * keeps the simulator's arrows all pointing outward: it talks to the API and to
 * nothing else, and never to Postgres.
 *
 * **A claim's context is the only one that can be here**, and a claim mints it
 * — `auth.via` is `simulator` on a context nothing but `claimSimulations`
 * produces. There is no argument by which a person's session, an API key or a
 * grading claim could reach these values, because the refusal is on the kind of
 * context rather than on anything a caller passes.
 *
 * **It takes the context and reads nothing from it**, which is not the loophole
 * it looks like: these settings belong to the deployment and to no customer, so
 * there is no tenancy to narrow by and no row here a narrowing could hide. The
 * context is what says *who is asking*, and that is the whole question this door
 * has to answer.
 *
 * Read for each simulation, deliberately, and not cached. A key an operator
 * changes applies to the next simulation with no restart, and one more small
 * select is nothing beside conducting a conversation over a telephone
 * connection. A measurement may ask for caching later; nothing has yet.
 */
export async function resolvePlatformSettings(
  auth: AuthContext,
): Promise<PlatformSettingValues> {
  authorize(auth, "read", here(auth));

  if (auth.via !== "simulator") {
    throw new Error(
      "the platform's settings are unsealed for Egma's own simulator and for nothing else, because conducting is the only thing Egma does with them",
    );
  }

  const held = await db()
    .select({ name: platformSetting.name, value: platformSetting.value })
    .from(platformSetting)
    .where(
      inArray(
        platformSetting.name,
        PLATFORM_SETTINGS.map((setting) => setting.name),
      ),
    );

  const resolved: Partial<Record<PlatformSettingName, string>> = {};
  for (const row of held) {
    const opened = openCredentials(row.value);
    if (typeof opened !== "string" || opened === "") {
      throw new Error(
        `the platform setting ${row.name} holds a value in a shape Egma never writes; the row needs repairing before anybody can conduct with it`,
      );
    }
    resolved[row.name as PlatformSettingName] = opened;
  }
  return resolved;
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
  const facts: Partial<Record<PlatformSettingName, string | null>> = {};
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
 * **It never overwrites a complete configuration.** A setting somebody has
 * changed has been changed, and a restart is not an occasion to put a script's
 * copy of the old key back. The one repair is a complete two-value IP route or
 * four-value credential route offered to a platform that holds only an invalid
 * part of one. The old part is removed and the new route is written together.
 * Once either complete shape exists, every later boot leaves it alone like
 * every other setting.
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
  requireWholeCarrier(values, "seed");

  const now = new Date();
  const rows = named
    .filter((name) => values[name] !== undefined)
    .map((name) => rowFor(name, values[name], now));
  if (rows.length === 0) return [];

  const offeredCarrier = CARRIER_BUNDLE.filter(
    (name) => values[name] !== undefined,
  );

  if (offeredCarrier.length > 0) {
    return db().transaction(async (tx) => {
      // A carrier route has either two rows or four. Hold this small settings
      // table while deciding whether the stored route is absent, valid or a
      // legacy partial, so two API starts and a settings write cannot
      // interleave the rows.
      await tx.execute(
        sql`lock table ${platformSetting} in share row exclusive mode`,
      );

      const heldCarrier = await tx
        .select({ name: platformSetting.name })
        .from(platformSetting)
        .where(inArray(platformSetting.name, CARRIER_BUNDLE));
      const carrierNames = new Set<PlatformSettingName>(CARRIER_BUNDLE);
      const otherRows = rows.filter(
        (row) => !carrierNames.has(row.name as PlatformSettingName),
      );
      const written: { name: string }[] = [];

      if (otherRows.length > 0) {
        written.push(
          ...(await tx
            .insert(platformSetting)
            .values(otherRows)
            .onConflictDoNothing({ target: platformSetting.name })
            .returning({ name: platformSetting.name })),
        );
      }

      const heldCarrierNames = new Set(heldCarrier.map((row) => row.name));
      const heldIpRoute =
        heldCarrierNames.has("carrier_trunk_address") &&
        heldCarrierNames.has("carrier_trunk_number") &&
        !heldCarrierNames.has("carrier_trunk_username") &&
        !heldCarrierNames.has("carrier_trunk_password");
      const heldCredentialRoute = CARRIER_BUNDLE.every((name) =>
        heldCarrierNames.has(name),
      );

      if (!heldIpRoute && !heldCredentialRoute) {
        // An empty platform and an invalid legacy partial take the same path:
        // remove every old member, then insert exactly the complete two- or
        // four-value route this environment supplied. This also removes an
        // orphan credential when the environment selects source-IP auth.
        await tx
          .delete(platformSetting)
          .where(inArray(platformSetting.name, CARRIER_BUNDLE));
        const carrierRows = rows.filter((row) =>
          carrierNames.has(row.name as PlatformSettingName),
        );
        written.push(
          ...(await tx
            .insert(platformSetting)
            .values(carrierRows)
            .returning({ name: platformSetting.name })),
        );
      }

      return written.map((row) => row.name as PlatformSettingName);
    });
  }

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
