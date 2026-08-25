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
import { openCredentials, sealCredentials } from "../sealing.ts";
import type { AuthContext } from "./context.ts";
import { NotPermittedError, UnprocessableInputError } from "./errors.ts";
import { authorize, here } from "./permissions.ts";

/**
 * The one live route this deployment owns: how a phone simulation reaches its
 * carrier. Model choices belong to immutable persona and grader versions, and
 * provider keys belong to deployment credential custody. Neither is accepted
 * by this module or by the four-name catalog behind it.
 *
 * Four doors, and the split between them is the design:
 *
 * - **Writing** takes each value in the clear, seals it, and keeps a hint
 *   beside it — the whole value for a setting that is not a secret, the last
 *   four characters for one that is.
 * - **Reading** answers every setting the platform knows about, held or not,
 *   with its label and its hint. It never answers a stored secret, and there is
 *   no argument by which it could be asked to: the sealed column is not among
 *   the ones it selects.
 * - **Seeding** is the deployment configuring itself at start. It writes a
 *   complete route only where the platform holds no valid route.
 * - **Resolving** is the one door to the plaintext, and it opens for the work
 *   order a simulator claims and for nothing else.
 */

/**
 * The floor under the SIP password, so its last four stay a hint rather than
 * most of the secret. Anything shorter is a paste error.
 */
const SHORTEST_PASSWORD = 8;

/** How much of a secret a hint may be. */
const HINT_CHARACTERS = 4;

/** E.164: a plus, then no more than fifteen digits and no leading zero. */
const E164 = /^\+[1-9]\d{1,14}$/;

/** Twilio account authority is not a trunk Credential List username. */
const TWILIO_ACCOUNT_SID = /^AC[0-9a-f]{32}$/iu;

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
 * What this deployment has been configured with, for internal preconditions.
 *
 * A setting the platform holds appears here: its value where that value is not
 * a secret, and `null` where it is. A setting it does not hold is absent
 * entirely. A secret's *hint* is not in it either: platform code can decide
 * whether a setting exists without receiving any part of the secret.
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
 * It is the existing `EGMA_SINGLE_ORGANIZATION` flag, which means "this
 * deployment is one team", handed in rather than read here. The flag belongs to
 * process configuration and this module reads no environment.
 */
export type DeploymentTenancy = {
  /** Whether this deployment serves exactly one organization. */
  readonly singleOrganization: boolean;
};

/**
 * Who may read and change the settings of this whole platform.
 *
 * **Two conditions, and both are refusals of the same kind.** An organization
 * owner may. A phone route is deployment configuration, not test or persona
 * content.
 *
 * **And only while this deployment serves one organization.** That mode is what
 * makes an owner and the platform's operator the same person; without it, every
 * organization's owner would read the hints of a key the others depend on and
 * could point the platform at an account nobody else agreed to. When a
 * deployment serves several customers this becomes a real permission question —
 * whose settings these are, and who is allowed to answer for the deployment —
 * and that question is deliberately not answered here. Until it is, egma
 * refuses everybody rather than picking one of them.
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
 * Trim before sealing. A trunk or SIP password pasted with whitespace can pass
 * shape checks and still fail at the carrier.
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
        "Egma does here: replace it with one complete route instead.",
    );
  }
  if (definition.secret && trimmed.length < SHORTEST_PASSWORD) {
    throw new UnprocessableInputError(
      `${definition.label} is at least ${SHORTEST_PASSWORD} characters, and ` +
        "this one is shorter than a valid SIP credential",
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
  if (
    definition.name === "carrier_trunk_username" &&
    TWILIO_ACCOUNT_SID.test(trimmed)
  ) {
    throw new UnprocessableInputError(
      "the SIP username looks like a Twilio Account SID. Use the username and " +
        "password from the Credential List attached to the trunk, not the " +
        "Twilio Account SID and Auth Token",
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
  action: "write" | "seed" | "reconciliation",
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
 * Write one complete source-IP or credential-authenticated carrier route.
 * Validation finishes before any row changes. The SIP password replaces whole
 * or stays sealed; there is no partial edit of its envelope.
 */
export async function writePlatformSettings(
  auth: AuthContext,
  deployment: DeploymentTenancy,
  values: PlatformSettingValues,
): Promise<readonly PlatformSetting[]> {
  onlyASingleOrganizationsOwner(auth, deployment);

  await db().transaction(async (tx) => {
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
  });

  return answer(await heldSettings());
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
 * Read for each simulation, deliberately, and not cached. A route an operator
 * changes applies to the next simulation with no restart.
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
 * What this deployment has been configured with, for an internal precondition.
 *
 * It takes nothing, so there is no customer it could be asked about, and it
 * returns non-secret carrier facts only, with `null` standing in for the SIP
 * password. The run-start path uses this answer to refuse phone work before it
 * creates a run when the deployment has no complete carrier route. It needs no
 * `AuthContext` because the carrier route belongs to the deployment, not to a
 * customer.
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
 * Give the platform the complete carrier route its environment names.
 *
 * A deployment supplies a complete route through its environment. This seed
 * path writes it only when no route exists; environment-owned deployments use
 * reconciliation below to apply later changes.
 *
 * **It never overwrites a configuration.** A setting somebody has changed has
 * been changed, and a restart is not an occasion to put a script's old copy
 * back. An empty store receives one complete two-value IP route or four-value
 * credential route. Any stored partial is invalid data and stops startup; this
 * function does not contain a repair path for an older shape.
 *
 * It has no `AuthContext` because there is no user here. This is the deployment
 * acting on its own configuration while it starts.
 */
export async function seedPlatformSettings(
  values: PlatformSettingValues,
): Promise<readonly PlatformSettingName[]> {
  const named = Object.keys(values) as PlatformSettingName[];
  requireWholeCarrier(values, "seed");

  const now = new Date();
  const rows = named
    .filter((name) => values[name] !== undefined)
    .map((name) => rowFor(name, values[name], now));
  return db().transaction(async (tx) => {
    // A carrier route has either two rows or four. Hold this small table while
    // deciding whether the stored route is absent or valid, so two API starts
    // and a settings write cannot interleave the rows.
    await tx.execute(
      sql`lock table ${platformSetting} in share row exclusive mode`,
    );

    const held = await tx
      .select({ name: platformSetting.name })
      .from(platformSetting)
      .where(inArray(platformSetting.name, CARRIER_BUNDLE));
    const heldNames = new Set(held.map((row) => row.name));
    const heldIpRoute =
      heldNames.has("carrier_trunk_address") &&
      heldNames.has("carrier_trunk_number") &&
      !heldNames.has("carrier_trunk_username") &&
      !heldNames.has("carrier_trunk_password");
    const heldCredentialRoute = CARRIER_BUNDLE.every((name) =>
      heldNames.has(name),
    );
    if (heldIpRoute || heldCredentialRoute) return [];
    if (heldNames.size > 0) {
      throw new UnprocessableInputError(
        "the stored carrier route is incomplete. Replace it with one complete " +
          "source-IP or SIP-credential route before this platform starts.",
      );
    }
    if (named.length === 0) return [];

    // Only an empty platform reaches this write.
    const written = await tx
      .insert(platformSetting)
      .values(rows)
      .returning({ name: platformSetting.name });
    return written.map((row) => row.name as PlatformSettingName);
  });
}

/**
 * Make the stored carrier route match this deployment's environment.
 *
 * **This is not ordinary boot seeding.** `seedPlatformSettings` preserves a
 * complete route because a restart must not undo a choice an operator made.
 * A deployment can choose a different, explicit contract: its environment is
 * the source of truth, so a rollout must copy a supplied complete route into
 * the platform store when the two differ. No carrier values leaves a stored
 * route unchanged. The explicit `clear` option removes that retained route.
 * This compatibility rule prevents an upgrade from deleting a SIP password
 * which the sealed store cannot export; fresh self-hosted deployments still
 * have no route until `.env` supplies one.
 *
 * The four carrier names are still one route. Validation finishes before the
 * transaction starts. Inside the transaction, the small settings table is
 * held while the stored plaintext is compared with the offered plaintext. A
 * changed route is then removed and inserted as one unit. A validation error,
 * an envelope that cannot be opened, or a failed insert therefore leaves the
 * old complete route untouched.
 *
 * The four carrier names are the complete catalog. Model choices and provider
 * credentials have no path into this store.
 */
export async function reconcileDeploymentCarrierSettings(
  values: PlatformSettingValues,
  options: { readonly clear?: boolean } = {},
): Promise<readonly PlatformSettingName[]> {
  const offered: Partial<Record<PlatformSettingName, string>> = {};
  for (const name of CARRIER_BUNDLE) {
    const value = values[name];
    if (value !== undefined) offered[name] = value;
  }

  const offeredNames = CARRIER_BUNDLE.filter(
    (name) => offered[name] !== undefined,
  );
  requireWholeCarrier(offered, "reconciliation");
  if (options.clear === true) {
    if (offeredNames.length > 0) {
      throw new UnprocessableInputError(
        "a carrier reconciliation cannot supply a route and clear it at the " +
          "same time",
      );
    }
    return db().transaction(async (tx) => {
      await tx.execute(
        sql`lock table ${platformSetting} in share row exclusive mode`,
      );
      const held = await tx
        .select({ name: platformSetting.name })
        .from(platformSetting)
        .where(inArray(platformSetting.name, CARRIER_BUNDLE));
      if (held.length === 0) return [];
      await tx
        .delete(platformSetting)
        .where(inArray(platformSetting.name, CARRIER_BUNDLE));
      return held.map((row) => row.name as PlatformSettingName);
    });
  }
  if (offeredNames.length === 0) return [];

  // Settle every value before a transaction can remove the working route.
  // `rowsFor` repeats these cheap checks when it seals the insert rows; doing
  // them here is what makes the no-write-on-validation-error rule visible.
  const settled: Partial<Record<PlatformSettingName, string>> = {};
  for (const name of offeredNames) {
    settled[name] = validValue(definitionOf(name), offered[name]);
  }
  const rows = rowsFor(settled, new Date());

  return db().transaction(async (tx) => {
    await tx.execute(
      sql`lock table ${platformSetting} in share row exclusive mode`,
    );

    const held = await tx
      .select({ name: platformSetting.name, value: platformSetting.value })
      .from(platformSetting)
      .where(inArray(platformSetting.name, CARRIER_BUNDLE));
    const heldInClear = new Map(
      held.map((row) => [
        row.name as PlatformSettingName,
        openCredentials(row.value),
      ]),
    );
    const changed = CARRIER_BUNDLE.filter(
      (name) => heldInClear.get(name) !== settled[name],
    );
    const unchanged = changed.length === 0;
    if (unchanged) return [];

    await tx
      .delete(platformSetting)
      .where(inArray(platformSetting.name, CARRIER_BUNDLE));
    await tx.insert(platformSetting).values(rows);

    return changed;
  });
}
