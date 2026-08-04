import type { SmtpSettings } from "./auth/email.ts";

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
   * What connection credentials are sealed under before they touch a row —
   * 32 random bytes as 64 hex characters (`openssl rand -hex 32`), per
   * ADR-0003. Malformed or absent means the service will not start: a
   * deployment that stored customers' provider keys under a weak or missing
   * key would be quietly under-encrypted, which is the one failure nobody
   * notices until the database leaks.
   */
  readonly encryptionKey: string;
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
  /**
   * How many credentialed requests one **organization** may make per minute.
   *
   * The organization rather than the key, so that rotating a key — mint,
   * deploy, revoke — cannot reset a budget, and so that ten deployments sharing
   * one account do not get ten budgets. The default is generous enough that
   * nobody using the product notices it and low enough that a runaway loop
   * stops being everybody else's problem.
   */
  readonly rateLimitPerMinute: number;
  /**
   * Where to post mail, if anywhere. **Absent is the ordinary case and is never
   * an error**: with no transport configured, signup asks for no verification
   * and an invitation hands its link back to the person who created it. Setting
   * it is one step in the self-hosting documentation and never a prerequisite.
   *
   * There is no second setting saying "and now require verification" or "and
   * now send invitations", because two settings can disagree and one cannot.
   */
  readonly smtp: SmtpSettings | undefined;
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
 * Mail, if it was configured. Unset is the ordinary case and returns nothing;
 * set-but-unusable refuses to start, because a transport egma believes in and
 * cannot reach is worse than no transport at all — it turns verification on and
 * stops handing invitation links back, and then delivers neither.
 *
 * The from address defaults to something derived from the instance's own
 * origin, so configuring mail is genuinely one variable.
 */
function smtpSettings(
  environment: NodeJS.ProcessEnv,
  baseUrl: string,
): SmtpSettings | undefined {
  const url = environment.EGMA_SMTP_URL?.trim();
  if (!url) return undefined;

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(
      `EGMA_SMTP_URL is not a URL: ${url}. It looks like smtp://user:password@host:587`,
    );
  }
  if (!["smtp:", "smtps:"].includes(parsed.protocol)) {
    throw new Error(
      `EGMA_SMTP_URL speaks ${parsed.protocol} and egma posts mail over smtp: or smtps:`,
    );
  }

  return {
    url,
    from:
      environment.EGMA_MAIL_FROM?.trim() || `egma <egma@${new URL(baseUrl).hostname}>`,
  };
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

  // Length and alphabet, not just presence: a 32-character passphrase has the
  // right byte count and a fraction of the entropy, and must be refused
  // rather than accepted quietly.
  const encryptionKey = environment.EGMA_ENCRYPTION_KEY?.trim();
  if (!encryptionKey || !/^[0-9a-f]{64}$/i.test(encryptionKey)) {
    throw new Error(
      "EGMA_ENCRYPTION_KEY is required: 32 random bytes written as 64 hex " +
        "characters — `openssl rand -hex 32` makes one. Connection " +
        "credentials are sealed under it before they touch the database. " +
        "Back it up alongside the database; a backup of one without the " +
        "other is half a backup.",
    );
  }

  const port = Number(environment.PORT ?? 3100);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`PORT is not a usable port number: ${environment.PORT}`);
  }

  const rateLimitPerMinute = Number(
    environment.EGMA_RATE_LIMIT_PER_MINUTE ?? 600,
  );
  if (!Number.isInteger(rateLimitPerMinute) || rateLimitPerMinute <= 0) {
    throw new Error(
      `EGMA_RATE_LIMIT_PER_MINUTE is not a number of requests: ${environment.EGMA_RATE_LIMIT_PER_MINUTE}`,
    );
  }

  const baseUrl = environment.EGMA_BASE_URL?.trim() || "http://localhost:3101";
  try {
    new URL(baseUrl);
  } catch {
    throw new Error(`EGMA_BASE_URL is not a URL: ${baseUrl}`);
  }

  return {
    smtp: smtpSettings(environment, baseUrl),
    databaseUrl,
    host: environment.HOST?.trim() || "0.0.0.0",
    port,
    baseUrl: baseUrl.replace(/\/+$/, ""),
    authSecret,
    encryptionKey,
    singleOrganization: flag(environment, "EGMA_SINGLE_ORGANIZATION", true),
    trustProxy: flag(environment, "EGMA_TRUST_PROXY", false),
    rateLimitPerMinute,
  };
}
