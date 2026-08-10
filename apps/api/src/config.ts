import { SERVICE_TOKEN_PREFIX } from "./auth/service-token.ts";
import type { SmtpSettings } from "./auth/email.ts";

export type Config = {
  readonly databaseUrl: string;
  /**
   * Where the trace store is. Required on the same terms as `databaseUrl`:
   * ClickHouse is the floor rather than an upgrade, there is no second
   * analytical path to fall back to, and an instance that started without it
   * would accept a trace it had nowhere to put.
   */
  readonly clickhouseUrl: string;
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
   * 32 random bytes as 64 hex characters (`openssl rand -hex 32`). Malformed
   * or absent means the service will not start: a deployment that stored
   * customers' provider keys under a weak or missing key would be quietly
   * under-encrypted, which is the one failure nobody notices until the
   * database leaks.
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
   * What the simulator shows this API to claim simulation work — `egma_st_`
   * and then a secret, the same value both containers read. Absent means the
   * service will not start: the claim answers carry customers' live provider
   * credentials, port 3100 is published on the host, and a claim door that
   * quietly served whoever asked would hand those credentials to the LAN.
   * The compose file has a development default on the `EGMA_AUTH_SECRET`
   * pattern, so `docker compose up` still works with zero setup.
   */
  readonly simulatorServiceToken: string;
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

  const clickhouseUrl = environment.CLICKHOUSE_URL?.trim();
  if (!clickhouseUrl) {
    throw new Error("CLICKHOUSE_URL is required and was not set");
  }
  let clickhouse: URL;
  try {
    clickhouse = new URL(clickhouseUrl);
  } catch {
    throw new Error(
      `CLICKHOUSE_URL is not a URL: ${clickhouseUrl}. It looks like http://user:password@host:8123/database`,
    );
  }
  if (!["http:", "https:"].includes(clickhouse.protocol)) {
    throw new Error(
      `CLICKHOUSE_URL speaks ${clickhouse.protocol} and egma reaches ClickHouse over http: or https:`,
    );
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

  const simulatorServiceToken =
    environment.EGMA_SIMULATOR_SERVICE_TOKEN?.trim();
  if (!simulatorServiceToken) {
    throw new Error(
      "EGMA_SIMULATOR_SERVICE_TOKEN is required and was not set. It is what " +
        "the simulator shows this API to claim simulation work, and claim " +
        "answers carry customers' live connection credentials — so the door " +
        "refuses to exist unguarded. Set the same value on the api and " +
        `simulator containers: ${SERVICE_TOKEN_PREFIX} followed by ` +
        "`openssl rand -hex 32`.",
    );
  }
  // The prefix is checked at startup rather than discovered as a mystery
  // 401: the claim door only reads bearers that start with it, so a token
  // without it would be configured and yet never match anything.
  if (!simulatorServiceToken.startsWith(SERVICE_TOKEN_PREFIX)) {
    throw new Error(
      `EGMA_SIMULATOR_SERVICE_TOKEN must start with ${SERVICE_TOKEN_PREFIX}, ` +
        "so a leaked service token is recognisable to secret scanners and " +
        "can never be mistaken for a customer key. Use " +
        `${SERVICE_TOKEN_PREFIX} followed by \`openssl rand -hex 32\`.`,
    );
  }

  const givenBaseUrl = environment.EGMA_BASE_URL?.trim() || "http://localhost:3101";
  // Keep this check at the service boundary. The CLI is a public package that
  // is compiled, not bundled, so shared runtime code would also have to be
  // published. The platform-origin agreement test keeps both checks aligned.
  let parsedBaseUrl: URL;
  try {
    parsedBaseUrl = new URL(givenBaseUrl);
  } catch {
    throw new Error("EGMA_BASE_URL is not a URL");
  }
  if (!["http:", "https:"].includes(parsedBaseUrl.protocol)) {
    throw new Error("EGMA_BASE_URL is not an HTTP origin");
  }
  if (
    parsedBaseUrl.username !== "" ||
    parsedBaseUrl.password !== "" ||
    (parsedBaseUrl.pathname !== "" && parsedBaseUrl.pathname !== "/") ||
    parsedBaseUrl.search !== "" ||
    parsedBaseUrl.hash !== ""
  ) {
    // Named part by part, and with the value it should be, because this is a
    // narrowing: a deployment that has run happily on a base URL with a path
    // meets it for the first time on an upgrade, and "must be only the origin"
    // is not something to have to work out at three in the morning. The
    // password is never repeated back; only the fact that one is there is.
    const wrong = [
      parsedBaseUrl.username !== "" || parsedBaseUrl.password !== ""
        ? "a username or password"
        : "",
      parsedBaseUrl.pathname !== "" && parsedBaseUrl.pathname !== "/"
        ? `the path ${parsedBaseUrl.pathname}`
        : "",
      parsedBaseUrl.search !== "" ? "a query" : "",
      parsedBaseUrl.hash !== "" ? "a fragment" : "",
    ].filter((part) => part !== "");
    throw new Error(
      `EGMA_BASE_URL must be only the address egma is reached at — scheme, host and port, nothing else — and this one carries ${wrong.join(
        " and ",
      )}. Set it to ${parsedBaseUrl.origin} and start egma again. Egma serves its whole public surface, including the platform identity the CLI reads, at the root of this address; anything after the port cannot be honoured and is a sign that a proxy is putting egma under a subpath, which is not supported.`,
    );
  }
  const baseUrl = parsedBaseUrl.origin;

  return {
    smtp: smtpSettings(environment, baseUrl),
    databaseUrl,
    clickhouseUrl,
    host: environment.HOST?.trim() || "0.0.0.0",
    port,
    baseUrl,
    authSecret,
    encryptionKey,
    singleOrganization: flag(environment, "EGMA_SINGLE_ORGANIZATION", true),
    trustProxy: flag(environment, "EGMA_TRUST_PROXY", false),
    rateLimitPerMinute,
    simulatorServiceToken,
  };
}
