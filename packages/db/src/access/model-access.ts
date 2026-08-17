import { db } from "../client.ts";
import {
  MODEL_ACCESS_MODES,
  modelAccess,
  modelProviderCredential,
  type ModelAccessMode,
} from "../schema/models.ts";
import { isModelProvider, type ModelProvider } from "../models/catalog.ts";
import { openCredentials } from "../sealing.ts";
import type { AuthContext } from "./context.ts";
import { ManagedAccessNotConnectedError, UnprocessableInputError } from "./errors.ts";
import { authorize, here } from "./permissions.ts";
import { within } from "./within.ts";

/**
 * Who pays for this organization's model traffic, and the one door that opens a
 * provider key for the services that spend it.
 *
 * **One organization-wide value, and changing it changes nothing else.** It
 * decides who supplies the credentials; it does not touch a persona's or a
 * grader's model selections, does not scan anything for completeness, and does
 * not rewrite a version. A run already in flight keeps the access its
 * simulations were claimed with — the value is read when a claim is prepared,
 * so the next unclaimed one gets the new answer and the running one is left
 * alone. That is the whole of what "switching is immediate" means, and it is a
 * property of *when* this is read rather than of anything this module does.
 */

/** The organization's model access as anybody in it reads it. */
export type ModelAccess = {
  readonly mode: ModelAccessMode;
  /** When it was last chosen, or null for an organization that never has. */
  readonly updatedAt: Date | null;
};

/**
 * What every organization has until somebody decides otherwise.
 *
 * **`customer-owned`, and a missing row means exactly this.** An organization
 * that has connected nothing to Egma's provider accounts may not spend from
 * them, and reading a missing row as `managed` would be Egma volunteering its
 * own accounts on behalf of a customer who never asked.
 */
export const DEFAULT_MODEL_ACCESS: ModelAccessMode = "customer-owned";

/**
 * The organization's model access.
 *
 * Readable at every role: which of two words is on this row is not a secret,
 * and a `viewer` looking at a persona's Models form has to be able to see who
 * supplies the key behind it.
 */
export async function readModelAccess(auth: AuthContext): Promise<ModelAccess> {
  authorize(auth, "read", here(auth));

  const [row] = await db()
    .select({ mode: modelAccess.mode, updatedAt: modelAccess.updatedAt })
    .from(modelAccess)
    .where(within(auth, modelAccess))
    .limit(1);

  return row === undefined
    ? { mode: DEFAULT_MODEL_ACCESS, updatedAt: null }
    : { mode: row.mode as ModelAccessMode, updatedAt: row.updatedAt };
}

function validMode(mode: string): ModelAccessMode {
  const known = MODEL_ACCESS_MODES.find((candidate) => candidate === mode);
  if (known === undefined) {
    throw new UnprocessableInputError(
      `"${mode}" is not a model access mode; expected one of ${MODEL_ACCESS_MODES.join(", ")}`,
    );
  }
  return known;
}

/**
 * Choose who supplies the credentials, from now on.
 *
 * **Only an `admin`**, on the same row of the permission table that already
 * names provider credentials: this decides whose provider account every
 * simulation and every verdict in the organization spends from, which is a
 * decision of the same kind as retention rather than one of the same kind as
 * writing a test.
 *
 * **No completeness scan, deliberately.** Egma does not walk the organization's
 * personas and graders looking for a provider whose credential is missing, and
 * does not refuse the switch because one is. A readiness checklist standing
 * between an admin and a setting they can plainly see is exactly the blocked
 * feeling this whole effort removes — and the honest report arrives anyway, per
 * simulation, when the affected claim is prepared and names the provider it
 * could not open.
 *
 * **`managed` is refused while nothing is connected**, and that refusal is the
 * self-hosted rule the specification names: an organization may not select
 * Egma's provider accounts until it holds an inference key for the Egma model
 * gateway. Nothing in this release connects one, so nothing in this release may
 * select managed access — said in a sentence that names what is missing rather
 * than by leaving the value quietly unwritable.
 */
export async function setModelAccess(
  auth: AuthContext,
  mode: string,
): Promise<ModelAccess> {
  authorize(auth, "manage_organization", here(auth));

  const valid = validMode(mode);
  if (valid === "managed") {
    throw new ManagedAccessNotConnectedError();
  }

  const now = new Date();
  const [row] = await db()
    .insert(modelAccess)
    .values({
      organizationId: auth.organizationId,
      mode: valid,
      updatedBy: auth.userId,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: modelAccess.organizationId,
      set: { mode: valid, updatedBy: auth.userId, updatedAt: now },
    })
    .returning({ mode: modelAccess.mode, updatedAt: modelAccess.updatedAt });

  if (row === undefined) {
    throw new Error("the organization's model access was not written");
  }
  return { mode: row.mode as ModelAccessMode, updatedAt: row.updatedAt };
}

/**
 * What one claim asked for and what it got: the keys for the providers the
 * pinned selections name, and the providers that hold none.
 *
 * **Two lists rather than a throw**, because a missing credential is one
 * simulation's problem and never the batch's. The caller lands this simulation
 * as an infrastructure error naming the provider, and conducts every other
 * claim in the same answer.
 */
export type ResolvedProviderKeys = {
  /** Provider to plaintext key, for the providers that hold one. */
  readonly keys: ReadonlyMap<ModelProvider, string>;
  /** The providers that were asked for and hold no credential, in ask order. */
  readonly missing: readonly ModelProvider[];
};

/**
 * The one door to a model-provider key's plaintext, and **Egma's own two
 * services are the only things that may knock.**
 *
 * The gate is narrower than a role, on purpose, exactly as the connection
 * credential's and the judge key's are: the only thing Egma does with a
 * provider key is conduct a simulation or judge one, and the only things that
 * do either are the simulator and the grading engine. So the check is on how
 * the caller came to exist rather than on what their role permits — a context
 * built from a simulation claim says `simulator` on its face and one built from
 * a grading claim says `engine`, and every other context in the product, a
 * person's session and an `admin` alike, is refused. There is no product
 * surface that hands a customer their own key back, and this is what keeps it
 * that way while roles move around.
 *
 * **Only the providers asked for.** The caller passes the providers its pinned
 * selections actually name, so a work order carries the two keys it needs and
 * never the third one the organization happens to hold. Unrelated secrets do
 * not travel, and that is enforced by the argument rather than by the caller
 * remembering to filter afterwards.
 */
export async function resolveModelProviderKeys(
  auth: AuthContext,
  providers: readonly string[],
): Promise<ResolvedProviderKeys> {
  authorize(auth, "read", here(auth));

  if (auth.via !== "simulator" && auth.via !== "engine") {
    throw new Error(
      "a model-provider key is opened for Egma's simulator or its grading engine and for nothing else, because conducting and judging are the only things Egma does with one",
    );
  }

  const asked: ModelProvider[] = [];
  for (const provider of providers) {
    if (!isModelProvider(provider)) {
      throw new Error(
        `"${provider}" is not a model provider Egma stores credentials for; a selection naming it should never have been written`,
      );
    }
    if (!asked.includes(provider)) asked.push(provider);
  }
  if (asked.length === 0) return { keys: new Map(), missing: [] };

  const rows = await db()
    .select({
      provider: modelProviderCredential.provider,
      credentials: modelProviderCredential.credentials,
    })
    .from(modelProviderCredential)
    .where(within(auth, modelProviderCredential));

  const held = new Map<string, string>(
    rows.map((row) => [row.provider, row.credentials]),
  );

  const keys = new Map<ModelProvider, string>();
  const missing: ModelProvider[] = [];
  for (const provider of asked) {
    const sealed = held.get(provider);
    if (sealed === undefined) {
      missing.push(provider);
      continue;
    }
    keys.set(provider, openedKey(provider, sealed));
  }

  return { keys, missing };
}

/**
 * One envelope opened, or a fault naming the provider whose row is broken.
 *
 * A row that will not open is Egma being broken rather than the customer being
 * unconfigured, so it throws rather than joining `missing` — which would tell
 * an admin to add a credential they already added.
 */
function openedKey(provider: ModelProvider, sealed: string): string {
  const opened = openCredentials(sealed);
  const key =
    typeof opened === "object" && opened !== null && !Array.isArray(opened)
      ? (opened as Record<string, unknown>)["key"]
      : undefined;

  if (typeof key !== "string" || key === "") {
    throw new Error(
      `the ${provider} model-provider credential holds a key in a shape Egma never writes; the row needs repairing before anybody can use it`,
    );
  }
  return key;
}

