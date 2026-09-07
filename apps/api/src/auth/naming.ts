/**
 * Editable signup defaults: derive the organization name from the email and
 * use Default for the project. Tests keep the browser's copy of this rule
 * consistent with the server.
 */

/** What the second field says before anybody touches it. */
export const DEFAULT_PROJECT_NAME = "Default";

/**
 * Recognized personal-email provider labels use the local part for naming.
 * Compare the first domain label so hotmail.co.uk needs no separate entry.
 * Omit ambiguous labels such as mail and email.
 */
export const PERSONAL_MAIL = new Set([
  "gmail",
  "googlemail",
  "outlook",
  "hotmail",
  "live",
  "msn",
  "yahoo",
  "ymail",
  "icloud",
  "me",
  "mac",
  "aol",
  "proton",
  "protonmail",
  "pm",
  "gmx",
  "zoho",
  "yandex",
  "fastmail",
  "hey",
]);

function capitalized(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1);
}

/**
 * Suggest Acme for ada@acme.example, or Ada's organization for
 * ada.lovelace@gmail.com. The user can edit the result.
 */
export function organizationNameFromEmail(email: string): string {
  const at = email.lastIndexOf("@");
  const domain = at === -1 ? "" : email.slice(at + 1).trim();
  const label = domain.split(".")[0] ?? "";
  const cleaned = label.replaceAll(/[^\p{L}\p{N}]+/gu, " ").trim();
  if (cleaned === "") return "My organization";

  if (PERSONAL_MAIL.has(cleaned.toLowerCase())) {
    // Lowercased first, so a name shouted in the address bar is not
    // shouted back: ADA@GMAIL.COM is Ada, not ADA.
    const first = email.slice(0, at).toLowerCase().split(/[^\p{L}\p{N}]+/u)[0] ?? "";
    return first === "" ? "My organization" : `${capitalized(first)}'s organization`;
  }

  return cleaned.split(" ").map(capitalized).join(" ");
}

/** How long a slug is allowed to get before it stops being readable. */
const SLUG_LIMIT = 48;

/**
 * Create a lowercase, hyphen-separated slug. Use a fallback if no characters
 * survive; callers handle collisions.
 */
export function slugify(value: string): string {
  const slug = value
    .normalize("NFKD")
    .replaceAll(/[̀-ͯ]/gu, "")
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/gu, "-")
    .replaceAll(/^-+|-+$/gu, "")
    .slice(0, SLUG_LIMIT)
    .replaceAll(/-+$/gu, "");
  return slug === "" ? "unnamed" : slug;
}
