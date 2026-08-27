/**
 * What the signup form says before anybody types in it.
 *
 * A person signing up should be able to accept both names and move on. The
 * organization comes from their email domain and the project is called
 * `Default`, and both are ordinary editable fields — nothing here decides
 * anything, it only saves typing.
 *
 * The API knows the same two rules, because an identity can be created without
 * ever seeing this page and still has to land somewhere sensible. A test holds
 * the two copies to the same answers.
 */

export const DEFAULT_PROJECT_NAME = "Default";

/** The API's copy of this list carries the reasoning for it. */
const PERSONAL_MAIL = new Set([
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
 * `ada@acme.example` becomes `Acme`, and `ada@gmail.com` becomes
 * `Ada's organization`.
 */
export function organizationNameFromEmail(email: string): string {
  const at = email.lastIndexOf("@");
  const domain = at === -1 ? "" : email.slice(at + 1).trim();
  const label = domain.split(".")[0] ?? "";
  const cleaned = label.replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  if (cleaned === "") return "My organization";

  if (PERSONAL_MAIL.has(cleaned.toLowerCase())) {
    const first = email.slice(0, at).split(/[^\p{L}\p{N}]+/u)[0] ?? "";
    return first === "" ? "My organization" : `${capitalized(first)}'s organization`;
  }

  return cleaned.split(" ").map(capitalized).join(" ");
}
