/**
 * Omit only known transport credentials from Retell call documents:
 * - top-level access_token;
 * - username and credential entries in top-level ice_servers;
 * - authorization, proxy-authorization, cookie, set-cookie, api-key, and x-api-key
 *   entries in custom_sip_headers, matched case-insensitively.
 *
 * Preserve all other fields and evidence. Do not scan values heuristically or insert
 * redaction markers. Additional omissions require a contract change and round-trip tests.
 */

/** The six exact names, lower-cased. HTTP header names are case-insensitive. */
const AUTHENTICATION_HEADERS: ReadonlySet<string> = new Set([
  "authorization",
  "proxy-authorization",
  "cookie",
  "set-cookie",
  "api-key",
  "x-api-key",
]);

/** Retell's own name for the map a phone call's custom SIP headers arrive in. */
const CUSTOM_SIP_HEADERS = "custom_sip_headers";

/** The top-level field a web call's join credential arrives in. */
const ACCESS_TOKEN = "access_token";

/** The top-level list containing WebRTC relay credentials. */
const ICE_SERVERS = "ice_servers";

/** The named map with the six names dropped out of it, or whatever it was. */
function withoutAuthenticationHeaders(value: unknown): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return value;
  }
  const held = value as Readonly<Record<string, unknown>>;
  const kept: Record<string, unknown> = {};
  for (const [name, header] of Object.entries(held)) {
    if (AUTHENTICATION_HEADERS.has(name.toLowerCase())) continue;
    kept[name] = header;
  }
  return kept;
}

/** Keep relay addresses and omit the TURN authentication pair. */
function withoutIceCredentials(value: unknown): unknown {
  if (!Array.isArray(value)) return value;
  return value.map((server: unknown) => {
    if (typeof server !== "object" || server === null || Array.isArray(server)) {
      return server;
    }
    return Object.fromEntries(
      Object.entries(server).filter(
        ([name]) => name !== "username" && name !== "credential",
      ),
    );
  });
}

/**
 * One call document, ready to become evidence.
 *
 * Each rule names a position in Retell's own document. Customer fields further
 * down are preserved, even when they use the same names.
 */
export function safeRetellProviderData<T>(value: T): T {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return value;
  }

  const held = value as Readonly<Record<string, unknown>>;
  const kept: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(held)) {
    if (key === ACCESS_TOKEN) continue;
    if (key === CUSTOM_SIP_HEADERS) {
      kept[key] = withoutAuthenticationHeaders(field);
    } else if (key === ICE_SERVERS) {
      kept[key] = withoutIceCredentials(field);
    } else {
      kept[key] = field;
    }
  }
  return kept as T;
}
