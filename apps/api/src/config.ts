export type Config = {
  readonly databaseUrl: string;
  readonly host: string;
  readonly port: number;
  /**
   * The origin a person's browser reaches egma on, and the one the session
   * cookie is scoped to. The pages and the API are served from a single origin
   * in every deployment, so this is both of them.
   *
   * A self-hoster's own instance, always. Nothing about logging in may depend
   * on a domain egma runs.
   */
  readonly baseUrl: string;
  /** What sessions are signed with. Absent means the service will not start. */
  readonly authSecret: string;
  /**
   * One organization on this deployment, and the first person to sign up claims
   * it. Sentry's flag, and Sentry's reason: without it anyone who can reach the
   * URL signs up, joins the only organization, and — because everyone defaults
   * to `admin` — administers somebody else's egma.
   *
   * On by default, because the default deployment is a self-hosted one. A
   * multi-tenant deployment turns it off; nothing derives from which one this
   * is.
   */
  readonly singleOrganization: boolean;
  /**
   * Whether `x-forwarded-proto` and `x-forwarded-host` may be believed. Off by
   * default, because believing them without a proxy in front lets any client
   * claim any origin.
   */
  readonly trustProxy: boolean;
};

function flag(
  environment: NodeJS.ProcessEnv,
  name: string,
  fallback: boolean,
): boolean {
  const raw = environment[name]?.trim().toLowerCase();
  if (raw === undefined || raw === "") return fallback;
  if (["1", "true", "yes", "on"].includes(raw)) return true;
  if (["0", "false", "no", "off"].includes(raw)) return false;
  throw new Error(`${name} is not a yes or a no: ${environment[name]}`);
}

/**
 * The service refuses to start rather than run misconfigured, so a bad
 * self-host is loud instead of silent.
 */
export function loadConfig(
  environment: NodeJS.ProcessEnv = process.env,
): Config {
  const databaseUrl = environment.DATABASE_URL?.trim();
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required and was not set");
  }

  const authSecret = environment.EGMA_AUTH_SECRET?.trim();
  if (!authSecret) {
    throw new Error(
      "EGMA_AUTH_SECRET is required and was not set. It signs session " +
        "cookies; starting without one would either log everybody out on " +
        "every restart or sign nothing at all.",
    );
  }

  const port = Number(environment.PORT ?? 3100);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`PORT is not a usable port number: ${environment.PORT}`);
  }

  const baseUrl = environment.EGMA_BASE_URL?.trim() || "http://localhost:3101";
  try {
    new URL(baseUrl);
  } catch {
    throw new Error(`EGMA_BASE_URL is not a URL: ${baseUrl}`);
  }

  return {
    databaseUrl,
    host: environment.HOST?.trim() || "0.0.0.0",
    port,
    baseUrl: baseUrl.replace(/\/+$/, ""),
    authSecret,
    singleOrganization: flag(environment, "EGMA_SINGLE_ORGANIZATION", true),
    trustProxy: flag(environment, "EGMA_TRUST_PROXY", false),
  };
}
