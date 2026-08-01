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
 * `ada@acme.example` becomes `Acme`. The first label of the domain, because
 * that is what a person calls their company, and title case because that is how
 * they write it down.
 *
 * A personal address becomes `Gmail`, which is wrong and does not matter: the
 * field is editable, and the alternative is a list of free-mail providers to
 * keep up to date forever.
 */
export function organizationNameFromEmail(email: string): string {
  const at = email.lastIndexOf("@");
  const domain = at === -1 ? "" : email.slice(at + 1).trim();
  const label = domain.split(".")[0] ?? "";
  const cleaned = label.replaceAll(/[^\p{L}\p{N}]+/gu, " ").trim();
  if (cleaned === "") return "My organization";
  return cleaned
    .split(" ")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
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
