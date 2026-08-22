/**
 * Retell's own call document, with the two transport fields that are
 * credentials taken out of it — and nothing else touched.
 *
 * **This is omission, not replacement, and it is exact-field rather than
 * heuristic.** Two rules, both of them a rule about *where* a value sits rather
 * than about what it looks like:
 *
 * 1. The top-level `access_token` field, which is how Retell hands back the
 *    short-lived credential a web call was joined with.
 * 2. Inside Retell's own `custom_sip_headers` map, the values of six exact
 *    header names — `authorization`, `proxy-authorization`, `cookie`,
 *    `set-cookie`, `api-key`, `x-api-key` — compared case-insensitively,
 *    because HTTP header names are.
 *
 * Nothing else is looked at. Not a field whose name contains `token`, not a
 * string that starts with `Bearer`, not a nested object anywhere at any depth.
 * A transcript is evidence: a customer saying *my password is hunter2* on a
 * recorded call is what a team is later going to argue about, and a scanner
 * that rewrote it would have edited the one thing the product exists to show
 * them. The same is true of a tool argument called `credential`, of a metadata
 * field a customer named `secret`, and of a provider field Retell adds next
 * month. **Preserved by default** is the rule; another omission is a versioned
 * change to this contract with a round-trip test proving nothing else moved.
 *
 * And an omitted field is *gone*, with no marker written where it was. A marker
 * is a value, values are evidence, and `"[REDACTED]"` is a string a customer
 * can legitimately say — so a reader meeting one could never tell whether Egma
 * put it there or the caller did.
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
