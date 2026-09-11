import { newId } from "@egma/ids";
import { and, eq, sql } from "drizzle-orm";
import { db } from "../client.ts";
import {
  MODEL_PROVIDERS,
  isModelProvider,
  type ModelProvider,
} from "../models/catalog.ts";
import { providerKey } from "../schema/provider-keys.ts";
import { openCredentials, sealCredentials } from "../sealing.ts";
import type { AuthContext } from "./context.ts";
import {
  IdentityConflictError,
  NotPermittedError,
  UnprocessableInputError,
} from "./errors.ts";
import { authorize, here, permits } from "./permissions.ts";

const LABELS: Readonly<Record<ModelProvider, string>> = {
  openai: "OpenAI",
  deepgram: "Deepgram",
  cartesia: "Cartesia",
};
export type ProviderKeyEntry = {
  readonly provider: ModelProvider;
  readonly label: string;
  readonly credential: null | {
    readonly hint: string;
    readonly revision: string;
    readonly updatedAt: Date;
  };
};
const METADATA = {
  provider: providerKey.provider,
  hint: providerKey.hint,
  revision: providerKey.revision,
  updatedAt: providerKey.updatedAt,
};
function providerNamed(value: string): ModelProvider {
  if (!isModelProvider(value))
    throw new UnprocessableInputError("Choose OpenAI, Deepgram, or Cartesia.");
  return value;
}
function entry(
  provider: ModelProvider,
  row?: { hint: string; revision: string; updatedAt: Date },
): ProviderKeyEntry {
  return {
    provider,
    label: LABELS[provider],
    credential: row
      ? { hint: row.hint, revision: row.revision, updatedAt: row.updatedAt }
      : null,
  };
}
export async function readProviderKeys(auth: AuthContext): Promise<{
  providers: readonly ProviderKeyEntry[];
  mayManageProviderKeys: boolean;
}> {
  authorize(auth, "read_organization", here(auth));
  const rows = await db()
    .select(METADATA)
    .from(providerKey)
    .where(eq(providerKey.organizationId, auth.organizationId));
  return {
    providers: MODEL_PROVIDERS.map((provider) =>
      entry(
        provider,
        rows.find((row) => row.provider === provider),
      ),
    ),
    mayManageProviderKeys: permits(auth, "manage_organization", here(auth)),
  };
}
/** Revisions prevent two administrators from silently replacing each other's key. */
export async function putProviderKey(
  auth: AuthContext,
  provider: string,
  key: string,
  expectedRevision: string | null,
): Promise<ProviderKeyEntry> {
  authorize(auth, "manage_organization", here(auth));
  const named = providerNamed(provider);
  const trimmed = key.trim();
  if (!/^[\x21-\x7e]{8,4096}$/.test(trimmed))
    throw new UnprocessableInputError(
      "Enter a provider API key between 8 and 4096 characters, without spaces.",
    );
  return db().transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${JSON.stringify([auth.organizationId, named])},0))`,
    );
    const where = and(
      eq(providerKey.organizationId, auth.organizationId),
      eq(providerKey.provider, named),
    );
    const [held] = await tx
      .select(METADATA)
      .from(providerKey)
      .where(where)
      .for("update");
    if ((held?.revision ?? null) !== expectedRevision)
      throw new IdentityConflictError("provider key", named, {
        expected: expectedRevision ?? "absent",
        current: held?.revision ?? "absent",
      });
    const values = {
      credentials: sealCredentials({ key: trimmed }),
      hint: `••••${trimmed.slice(-4)}`,
      revision: newId("rev"),
      updatedAt: new Date(),
    };
    if (held) await tx.update(providerKey).set(values).where(where);
    else
      await tx.insert(providerKey).values({
        ...values,
        organizationId: auth.organizationId,
        provider: named,
      });
    return entry(named, values);
  });
}
export async function deleteProviderKey(
  auth: AuthContext,
  provider: string,
  expectedRevision: string,
): Promise<ProviderKeyEntry> {
  authorize(auth, "manage_organization", here(auth));
  const named = providerNamed(provider);
  const removed = await db()
    .delete(providerKey)
    .where(
      and(
        eq(providerKey.organizationId, auth.organizationId),
        eq(providerKey.provider, named),
        eq(providerKey.revision, expectedRevision),
      ),
    )
    .returning({ revision: providerKey.revision });
  if (removed.length === 0)
    throw new IdentityConflictError("provider key", named, {
      expected: expectedRevision,
      current: "changed",
    });
  return entry(named);
}
export class ProviderKeyUnavailableError extends Error {
  readonly code = "provider_key_unavailable";
  readonly provider: ModelProvider;
  constructor(provider: ModelProvider) {
    super(
      `The organization's ${LABELS[provider]} API key could not be used. Ask an admin to replace it under Settings → Provider API keys.`,
    );
    this.name = "ProviderKeyUnavailableError";
    this.provider = provider;
  }
}

/** Open one organization key for an authenticated authoring request. */
export async function resolveProviderKeyForAuthoring(
  auth: AuthContext,
  provider: ModelProvider,
): Promise<{ key: string; credentialRef: string } | undefined> {
  authorize(auth, "read_organization", here(auth));
  const [row] = await db()
    .select({
      credentials: providerKey.credentials,
      revision: providerKey.revision,
    })
    .from(providerKey)
    .where(
      and(
        eq(providerKey.organizationId, auth.organizationId),
        eq(providerKey.provider, provider),
      ),
    )
    .limit(1);
  if (row === undefined) return undefined;
  try {
    const decoded: unknown = openCredentials(row.credentials);
    if (
      typeof decoded !== "object" ||
      decoded === null ||
      !("key" in decoded) ||
      typeof decoded.key !== "string" ||
      decoded.key.length < 8
    ) {
      throw new Error("invalid credential");
    }
    return { key: decoded.key, credentialRef: row.revision };
  } catch {
    throw new ProviderKeyUnavailableError(provider);
  }
}

/** Only contexts derived from internal work claims can open organization keys. */
export async function resolveProviderKeysForWork(
  auth: AuthContext,
  providers: readonly ModelProvider[],
): Promise<
  Partial<Record<ModelProvider, { key: string; credentialRef: string }>>
> {
  if (auth.via !== "simulator" && auth.via !== "engine")
    throw new NotPermittedError(auth, "manage_organization", here(auth));
  const rows = await db()
    .select()
    .from(providerKey)
    .where(eq(providerKey.organizationId, auth.organizationId));
  const found: Partial<
    Record<ModelProvider, { key: string; credentialRef: string }>
  > = {};
  for (const row of rows) {
    const provider = providerNamed(row.provider);
    if (!providers.includes(provider)) continue;
    try {
      const decoded: unknown = openCredentials(row.credentials);
      if (
        typeof decoded !== "object" ||
        decoded === null ||
        !("key" in decoded) ||
        typeof decoded.key !== "string" ||
        decoded.key.length < 8
      )
        throw new Error("invalid credential");
      found[provider] = { key: decoded.key, credentialRef: row.revision };
    } catch {
      throw new ProviderKeyUnavailableError(provider);
    }
  }
  return found;
}

export type ProviderFundingClaim = {
  readonly simulationId: string;
  readonly claimedAt: Date | null;
  readonly provider: string;
};
/** The receipt contains attribution only, never the provider secret. */
export function createProviderFundingReceipt(
  auth: AuthContext,
  claim: ProviderFundingClaim & { readonly credentialRef: string },
): string {
  if (auth.via !== "simulator" || claim.claimedAt === null)
    throw new Error(
      "Only an active simulation claim can issue a provider funding receipt.",
    );
  return sealCredentials({
    purpose: "simulation_provider_key",
    organizationId: auth.organizationId,
    projectId: auth.projectId,
    simulationId: claim.simulationId,
    claimedAt: claim.claimedAt.toISOString(),
    provider: claim.provider,
    credentialRef: claim.credentialRef,
  });
}
/** Match the saved claim lease, so an earlier preflight receipt cannot fund a later claim. */
export function readProviderFundingReceipt(
  auth: AuthContext,
  claim: ProviderFundingClaim,
  receipt: string,
): { paymentSource: "customer"; credentialRef: string } {
  try {
    const value: unknown = openCredentials(receipt);
    if (typeof value !== "object" || value === null)
      throw new Error("invalid receipt");
    const held = value as Record<string, unknown>;
    if (
      held.purpose !== "simulation_provider_key" ||
      held.organizationId !== auth.organizationId ||
      held.projectId !== auth.projectId ||
      held.simulationId !== claim.simulationId ||
      held.claimedAt !== claim.claimedAt?.toISOString() ||
      held.provider !== claim.provider ||
      typeof held.credentialRef !== "string"
    )
      throw new Error("invalid receipt");
    return { paymentSource: "customer", credentialRef: held.credentialRef };
  } catch {
    throw new Error(
      "The provider funding receipt does not match this simulation claim. Keep this usage for repair; do not infer who paid.",
    );
  }
}
