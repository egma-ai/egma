/**
 * Model providers, as `GET /api/model-access` and `GET /api/model-catalog`
 * answer them: who supplies the keys this organization's model traffic spends,
 * and which providers do which model job.
 *
 * **Nothing in this file can hold a key**, and that is deliberate rather than
 * incidental: the API's read shape has no field a secret could travel in, so
 * neither does this. What a page ever has is a provider and four characters —
 * enough to tell two keys apart, and not enough to be one.
 *
 * A stored secret goes in one direction only. Replacing a key is sending a new
 * value; it is never reading the old one and writing it back.
 *
 * **The catalog is the server's and this file restates none of it.** A browser
 * that kept its own provider list would be a list that can disagree with the
 * one the claim path executes from, and the disagreement is a provider somebody
 * can select and nothing can run.
 */

/** One organization-wide choice, and the only two values it has. */
export type ModelAccessMode = "managed" | "customer-owned";

/** One role a model performs for a persona: what it thinks, hears, speaks with. */
export type ModelJob = "llm" | "stt" | "tts";

export type ModelProviderCredential = {
  readonly provider: string;
  /** The last characters of the key. Never enough of it to use. */
  readonly hint: string;
  readonly revision: string;
  readonly updated_at: string;
};

/**
 * The organization's connection to the Egma model gateway, as a self-hosted
 * deployment holds it.
 *
 * **Connected, a hint, and which Egma Cloud organization it is bound to. Never
 * the key.** There is no field here a secret could travel in, because there is
 * none in the answer either: a connected key is sealed and there is no route
 * that reads one back.
 */
export type ManagedConnection = {
  readonly connected: boolean;
  /** The last characters of the connected key, or null where none is. */
  readonly hint: string | null;
  readonly cloud_organization_id: string | null;
  readonly connected_at: string | null;
};

export type ModelAccess = {
  readonly mode: ModelAccessMode;
  /** When the choice was last made, or null where nobody has made one. */
  readonly updated_at: string | null;
  readonly modes: readonly ModelAccessMode[];
  /**
   * Whether managed access can be chosen on this deployment at all.
   *
   * **A fact about the deployment and this organization's connection, never
   * about the organization's current choice.** A form that offered a mode the
   * server refuses would let somebody decide before telling them the decision
   * cannot land.
   */
  readonly managed_available: boolean;
  /**
   * Whether this is hosted Egma, which operates the gateway.
   *
   * It decides which of two managed shapes the screen draws: a state to read,
   * or a key to connect. A page that guessed from `managed_available` would
   * draw a Connect form on a deployment with nothing to connect.
   */
  readonly hosted: boolean;
  readonly managed: ManagedConnection;
  readonly credentials: readonly ModelProviderCredential[];
};

export type CatalogEntry = {
  readonly provider: string;
  readonly job: ModelJob;
  /** What a person calls it, in a form and in an error alike. */
  readonly label: string;
  readonly recommended_model: string;
  readonly recommended_voice_id?: string;
  readonly model_is_free_text: boolean;
};

export type ModelCatalog = {
  readonly jobs: readonly ModelJob[];
  readonly providers: readonly CatalogEntry[];
  /** Pairs the product intends and this release has not proved. Not selectable. */
  readonly reserved: readonly { readonly provider: string; readonly job: ModelJob }[];
};

export const MODEL_ACCESS_PATH = "/api/model-access";
export const MODEL_CATALOG_PATH = "/api/model-catalog";
export const MODEL_PROVIDER_CREDENTIALS_PATH = "/api/model-provider-credentials";
export const MANAGED_ACCESS_PATH = "/api/managed-access";

export function modelProviderCredentialPath(provider: string): string {
  return `${MODEL_PROVIDER_CREDENTIALS_PATH}/${encodeURIComponent(provider)}`;
}

/**
 * The connection an answer actually carried, and not connected at all when it
 * carried something this page cannot read.
 *
 * The same guard `credentialsIn` makes one field over, for the same reason: a
 * read whose shape is not the expected one is a deployment mid-upgrade, and
 * trusting it costs the whole settings page rather than one row.
 */
export function managedIn(access: ModelAccess | undefined): ManagedConnection {
  const said = access?.managed;
  return typeof said === "object" && said !== null
    ? said
    : { connected: false, hint: null, cloud_organization_id: null, connected_at: null };
}

/** What a person calls each mode, said the way the settings screen says it. */
export const MODE_LABEL: Readonly<Record<ModelAccessMode, string>> = {
  managed: "Managed by Egma",
  "customer-owned": "Customer-owned",
};

/** What a person calls each model job, said once so no screen invents a second word. */
export const JOB_LABEL: Readonly<Record<ModelJob, string>> = {
  llm: "Language model",
  stt: "Speech to text",
  tts: "Text to speech",
};

/**
 * The credentials an answer actually carried, and none at all when it carried
 * something this page cannot read.
 *
 * A read whose shape is not the expected one is a deployment mid-upgrade or a
 * proxy answering for something else. The cost of trusting it is not a wrong
 * list — it is `undefined.map`, which takes the whole settings page down and
 * with it the credential somebody came to replace.
 */
export function credentialsIn(
  access: ModelAccess | undefined,
): readonly ModelProviderCredential[] {
  return Array.isArray(access?.credentials) ? access.credentials : [];
}

/** Every provider the catalog can execute, once, in catalog order. */
export function providersIn(
  catalog: ModelCatalog | undefined,
): readonly string[] {
  if (!Array.isArray(catalog?.providers)) return [];
  const seen: string[] = [];
  for (const entry of catalog.providers) {
    if (!seen.includes(entry.provider)) seen.push(entry.provider);
  }
  return seen;
}

/**
 * What a person calls one provider, as the catalog named it.
 *
 * **The catalog's own label, never the stored word.** `openai` is an
 * identifier: it is what a work order carries and what a credential is filed
 * under, and showing it on a screen makes a person read Egma's storage rather
 * than the name their provider goes by. The word itself is the fallback for a
 * provider the catalog no longer ships, because a row that named nothing at all
 * would be worse than one naming its identifier.
 */
export function labelOfProvider(
  catalog: ModelCatalog | undefined,
  provider: string,
): string {
  if (!Array.isArray(catalog?.providers)) return provider;
  return (
    catalog.providers.find((entry) => entry.provider === provider)?.label ??
    provider
  );
}

/** Which model jobs one provider does, so a row can say what its key is for. */
export function jobsOfProvider(
  catalog: ModelCatalog | undefined,
  provider: string,
): readonly ModelJob[] {
  if (!Array.isArray(catalog?.providers)) return [];
  return catalog.providers
    .filter((entry) => entry.provider === provider)
    .map((entry) => entry.job);
}

/** The stored credential for one provider, or nothing where none is held. */
export function credentialFor(
  credentials: readonly ModelProviderCredential[],
  provider: string,
): ModelProviderCredential | undefined {
  return credentials.find((one) => one.provider === provider);
}

/** The entries for one model job, which is what a persona's form asks about. */
export function entriesForJob(
  catalog: ModelCatalog | undefined,
  job: ModelJob,
): readonly CatalogEntry[] {
  if (!Array.isArray(catalog?.providers)) return [];
  return catalog.providers.filter((entry) => entry.job === job);
}
