/** The visible value left where Retell supplied a credential. */
export const RETELL_REDACTED = "[REDACTED]";

function normalKey(value: string): string {
  return value.trim().toLowerCase().replaceAll(/[_\s]+/gu, "-");
}

function isAccessToken(key: string): boolean {
  return normalKey(key) === "access-token";
}

/** A header name whose value can authorize a request or prove its sender. */
function isAuthenticationHeader(key: string): boolean {
  const name = normalKey(key);
  if (
    name === "authorization" ||
    name === "proxy-authorization" ||
    name === "cookie" ||
    name === "set-cookie" ||
    name === "api-key" ||
    name === "x-api-key"
  ) {
    return true;
  }
  return /(?:^|-)(?:auth|authorization|credential|password|secret|signature|token)(?:-|$)/u.test(
    name,
  );
}

function isHeaderCollection(key: string): boolean {
  return /(?:^|-)(?:header|headers)(?:-|$)/u.test(normalKey(key));
}

function headerNameIn(row: Readonly<Record<string, unknown>>): string {
  for (const key of ["name", "key", "header", "header_name"]) {
    const value = row[key];
    if (typeof value === "string" && value.trim() !== "") return value;
  }
  return "";
}

function copied(value: unknown, insideHeaders: boolean): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => copied(entry, insideHeaders));
  }
  if (typeof value !== "object" || value === null) return value;

  const row = value as Readonly<Record<string, unknown>>;
  const namedHeader = insideHeaders ? headerNameIn(row) : "";
  const redactEntryValue =
    namedHeader !== "" && isAuthenticationHeader(namedHeader);
  const safe: Record<string, unknown> = {};

  for (const [key, held] of Object.entries(row)) {
    const normalized = normalKey(key);
    const isValue =
      normalized === "value" ||
      normalized === "values" ||
      normalized === "header-value";
    if (
      isAccessToken(key) ||
      (insideHeaders && isAuthenticationHeader(key)) ||
      (redactEntryValue && isValue)
    ) {
      safe[key] = RETELL_REDACTED;
      continue;
    }
    safe[key] = copied(held, insideHeaders || isHeaderCollection(key));
  }

  return safe;
}

/**
 * Copy provider data after removing values that can grant access.
 *
 * Retell web calls can carry an `access_token`. Phone calls can carry custom
 * SIP headers, including authorization values. The marker stays in place so a
 * later reader can tell that Retell supplied a value and Egma removed it.
 */
export function safeRetellProviderData<T>(value: T): T {
  return copied(value, false) as T;
}
