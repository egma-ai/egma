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
  // Recovery commands print this origin as a quoted argument. Keep the host
  // within ordinary DNS, local-host and IP syntax so a repository binding can
  // never smuggle shell expansion characters into that command.
  const ordinaryHost = /^[A-Za-z0-9_.-]+$/u.test(parsed.hostname);
  const ipv6Host = /^\[[0-9A-Fa-f:.]+\]$/u.test(parsed.hostname);
  if (!ordinaryHost && !ipv6Host) {
    throw new Error("an origin host contains unsupported characters");
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
