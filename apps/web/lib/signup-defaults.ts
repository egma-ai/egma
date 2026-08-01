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

/** `ada@acme.example` becomes `Acme`. */
export function organizationNameFromEmail(email: string): string {
  const at = email.lastIndexOf("@");
  const domain = at === -1 ? "" : email.slice(at + 1).trim();
  const label = domain.split(".")[0] ?? "";
  const cleaned = label.replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  if (cleaned === "") return "My organization";
  return cleaned
    .split(" ")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}
