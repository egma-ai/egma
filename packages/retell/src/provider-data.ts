/**
 * Omit only known transport credentials from Retell call documents:
 * - top-level access_token;
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

/**
 * One call document, ready to become evidence.
 *
 * Shallow on purpose: both rules name a position in Retell's own document, so
 * there is nothing to recurse into and nothing further down that could match by
 * accident. Values that stay are the same values — not copies rebuilt key by
 * key — so what the provider sent is what is written down.
 */
export function safeRetellProviderData<T>(value: T): T {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return value;
  }

  const held = value as Readonly<Record<string, unknown>>;
  const kept: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(held)) {
    if (key === ACCESS_TOKEN) continue;
    kept[key] =
      key === CUSTOM_SIP_HEADERS ? withoutAuthenticationHeaders(field) : field;
  }
  return kept as T;
}
