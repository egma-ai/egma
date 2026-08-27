/**
 * The names a person is offered rather than asked for.
 *
 * A form that stops somebody to ask which project they mean, before they have
 * any, is the ten minutes gone in the part of the product it is judged on. So
 * both names arrive filled in — the organization from the email domain, the
 * project called `Default` — and both are editable. Neither blocks: accepting
 * them is one click, and changing them costs nothing.
 *
 * The signup page fills the same two fields in the browser as somebody types,
 * from its own copy of the first rule. A test holds the two copies to the same
 * answers, so the value a person sees in the field is the value they get if
 * they submit it untouched.
 */

/** What the second field says before anybody touches it. */
export const DEFAULT_PROJECT_NAME = "Default";

/**
 * The domains where the first label is a mail provider rather than a company.
 *
 * **A list is the cheap half of this, and it used to be the reason there was
 * none.** The argument against it was that free-mail providers have to be kept
 * up to date forever, so `ada@gmail.com` was offered `Gmail` and the editable
 * field was left to carry it. What that missed is that a wrong default is not
 * neutral: an organization actually called `Gmail` is what a person accepts on
 * the fastest path through the shortest form in the product, and then lives
 * with. Twenty names cover very nearly every personal address, the field still
 * decides, and a provider missing from this list falls back to exactly the
 * behaviour that was there before.
 *
 * The first label, not the whole domain, so `hotmail.co.uk` needs no line of
 * its own. Ambiguous labels a company could also own — `mail`, `email` — are
 * deliberately absent.
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
 * `ada@acme.example` becomes `Acme`. The first label of the domain, because
 * that is what a person calls their company, and title case because that is how
 * they write it down.
 *
 * `ada.lovelace@gmail.com` becomes `Ada's organization`, because a personal
 * address names no company and the person is the only thing in it. The first
 * run of letters and digits in the local part is the given name closely enough
 * for a value somebody is about to read and can change.
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
 * A name as it appears in a URL. Lowercase, and letters and digits separated by
 * single hyphens.
 *
 * A name made entirely of characters that do not survive this — an organization
 * called `!!!` — still needs somewhere to live, so it falls back to a word
 * rather than to the empty string, and the caller's collision handling makes it
 * unique from there. The word says what happened rather than naming a level of
 * the hierarchy: this is used for organizations and for projects alike, and a
 * word borrowed from either would mean the wrong thing half the time.
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
