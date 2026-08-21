/** One platform-origin shape for selection, bindings, and credential lookup. */
export function normalizePlatformOrigin(candidate: string): string {
  let parsed: URL;
  try {
    parsed = new URL(candidate.trim());
  } catch {
    throw new Error("not a web address");
  }
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error("not an HTTP web address");
  }
  if (parsed.username !== "" || parsed.password !== "") {
    throw new Error("an origin cannot contain a username or password");
  }
  if (
    (parsed.pathname !== "" && parsed.pathname !== "/") ||
    parsed.search !== "" ||
    parsed.hash !== ""
  ) {
    throw new Error("an origin cannot contain a path, query, or fragment");
  }
  return parsed.origin;
}
