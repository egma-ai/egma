import {
  GetSecretValueCommand,
  SecretsManagerClient,
  type GetSecretValueCommandOutput,
} from "@aws-sdk/client-secrets-manager";

/** Provider accounts for which this release can execute model work. */
export const PROVIDER_ACCOUNTS = ["openai", "deepgram", "cartesia"] as const;
export type ProviderAccount = (typeof PROVIDER_ACCOUNTS)[number];

/**
 * The current provider keys available to one unit of work.
 *
 * A bundle may be partial. A chat simulation only needs its LLM provider, and
 * a deployment can add a provider before any persona selects it. The caller
 * must fail the work if the provider it selected is absent.
 */
export type ProviderCredentialBundle = Readonly<
  Partial<Record<ProviderAccount, string>>
>;

/**
 * The operational source of provider credentials.
 *
 * `load` means "read the current bundle now". Implementations keep no bundle
 * cache, so rotating the AWS secret changes the next unit of work without a
 * process restart.
 */
export interface ProviderCredentialSource {
  load(): Promise<ProviderCredentialBundle>;
}

/**
 * The one deployment selector shared by the API and grader.
 *
 * Naming the Egma-specific secret id and region selects AWS Secrets Manager.
 * Naming neither selects the self-host environment. A half-named AWS source is
 * refused at startup. Generic AWS variables do not change this decision.
 */
export function providerCredentialSource(
  environment: NodeJS.ProcessEnv,
): ProviderCredentialSource {
  const secretId = environment.EGMA_PROVIDER_CREDENTIALS_SECRET_ID?.trim() ?? "";
  const region = environment.EGMA_PROVIDER_CREDENTIALS_REGION?.trim() ?? "";

  if ((secretId === "") !== (region === "")) {
    const missing = secretId === ""
      ? "EGMA_PROVIDER_CREDENTIALS_SECRET_ID"
      : "EGMA_PROVIDER_CREDENTIALS_REGION";
    throw new Error(
      `cloud provider credentials need both EGMA_PROVIDER_CREDENTIALS_SECRET_ID and EGMA_PROVIDER_CREDENTIALS_REGION; this deployment is missing ${missing}`,
    );
  }

  return secretId === ""
    ? environmentProviderCredentialSource(environment)
    : secretsManagerProviderCredentialSource({ secretId, region });
}

/** The current provider bundle could not be read or decoded safely. */
export class ProviderCredentialSourceUnavailableError extends Error {
  constructor() {
    super("the current model-provider credential bundle could not be read");
    this.name = "ProviderCredentialSourceUnavailableError";
  }
}

/** A unit of work selected a provider that the current bundle cannot fund. */
export class ProviderCredentialMissingError extends Error {
  readonly provider: string;

  constructor(provider: string) {
    const account = providerAccountFor(provider);
    super(
      account === undefined
        ? `model provider ${provider} has no credential-account mapping in this release`
        : `the current provider credential bundle has no ${account} key`,
    );
    this.name = "ProviderCredentialMissingError";
    this.provider = provider;
  }
}

/** One provider account named by the executable model catalog. */
export function providerAccountFor(
  provider: string,
): ProviderAccount | undefined {
  return PROVIDER_ACCOUNTS.find((account) => account === provider);
}

/** One selected provider's key, with no fallback to another account. */
export function credentialFor(
  bundle: ProviderCredentialBundle,
  executionProvider: string,
): string {
  const account = providerAccountFor(executionProvider);
  const key = account === undefined ? undefined : bundle[account];
  if (key === undefined) throw new ProviderCredentialMissingError(executionProvider);
  return key;
}

const ENVIRONMENT_KEY: Readonly<Record<ProviderAccount, string>> = {
  openai: "EGMA_OPENAI_API_KEY",
  deepgram: "EGMA_DEEPGRAM_API_KEY",
  cartesia: "EGMA_CARTESIA_API_KEY",
};

/** Provider keys supplied directly by a self-host operator. */
export function environmentProviderCredentialSource(
  environment: NodeJS.ProcessEnv,
): ProviderCredentialSource {
  return {
    async load(): Promise<ProviderCredentialBundle> {
      const credentials: Partial<Record<ProviderAccount, string>> = {};
      for (const account of PROVIDER_ACCOUNTS) {
        const value = environment[ENVIRONMENT_KEY[account]]?.trim();
        if (value) credentials[account] = value;
      }
      return credentials;
    },
  };
}

type SecretsManager = {
  send(
    command: GetSecretValueCommand,
  ): Promise<Pick<GetSecretValueCommandOutput, "SecretString">>;
};

export type SecretsManagerProviderCredentialSourceOptions = {
  readonly secretId: string;
  readonly region: string;
  /** A test seam. Production constructs the AWS client for `region`. */
  readonly client?: SecretsManager;
};

const SECRET_FIELD: Readonly<Record<ProviderAccount, string>> = {
  openai: "openai_api_key",
  deepgram: "deepgram_api_key",
  cartesia: "cartesia_api_key",
};

/** The current Egma-owned bundle from AWS Secrets Manager. */
export function secretsManagerProviderCredentialSource(
  options: SecretsManagerProviderCredentialSourceOptions,
): ProviderCredentialSource {
  const client = options.client ?? new SecretsManagerClient({ region: options.region });

  return {
    async load(): Promise<ProviderCredentialBundle> {
      try {
        const response = await client.send(
          new GetSecretValueCommand({ SecretId: options.secretId }),
        );
        if (response.SecretString === undefined) {
          throw new ProviderCredentialSourceUnavailableError();
        }
        return bundleFromSecret(response.SecretString);
      } catch {
        // AWS diagnostics and malformed secret bytes can contain values the
        // credential boundary must never repeat. The type is the useful fact.
        throw new ProviderCredentialSourceUnavailableError();
      }
    },
  };
}

function bundleFromSecret(secret: string): ProviderCredentialBundle {
  const decoded: unknown = JSON.parse(secret);
  if (typeof decoded !== "object" || decoded === null || Array.isArray(decoded)) {
    throw new ProviderCredentialSourceUnavailableError();
  }

  const held = decoded as Record<string, unknown>;
  const credentials: Partial<Record<ProviderAccount, string>> = {};
  for (const account of PROVIDER_ACCOUNTS) {
    const field = SECRET_FIELD[account];
    const value = held[field];
    if (value === undefined || value === null || value === "") continue;
    if (typeof value !== "string" || value.trim() === "") {
      throw new ProviderCredentialSourceUnavailableError();
    }
    credentials[account] = value.trim();
  }
  return credentials;
}
