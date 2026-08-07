/**
 * The person at the browser, for a check that has nobody at the keyboard.
 *
 * A terminal asking to be let in is only half of the device flow; the other
 * half is a human on the instance's own pages, signing up and pressing
 * Approve. More than one check needs that half, and it is a sequence of clicks
 * against real markup — so it lives once, here, and a page that changes breaks
 * one file rather than several in different ways.
 *
 * Nothing in here asserts anything. The check that owns those pages as its
 * subject makes its own claims about what they say; for every other check this
 * is a step on the way, and a step that quietly held opinions about somebody
 * else's screens would fail for reasons that are not its own.
 */

import type { Page } from "playwright-core";

/**
 * A browser egma must not open.
 *
 * egma starts whatever `BROWSER` names and hands it the address. A check that
 * let it start the real one would open a window on the machine of whoever ran
 * the suite, so it is pointed at a command that does nothing and the check
 * drives its own browser instead.
 */
export const NO_BROWSER = "/usr/bin/true";

/** Long enough for the signup form, and the same one in every check. */
export const PASSWORD = "a-long-enough-password";

/** The signup that happens inside the approval page, for a brand-new account. */
export async function signUpAndApprove(page: Page, approveUrl: string): Promise<void> {
  await page.goto(approveUrl);
  await page.click('button[type="submit"]');
  await page.waitForURL(/\/signup\?next=/u);

  await page.fill("#email", "ada@acme.example");
  await page.fill("#password", PASSWORD);
  await page.fill("#organizationName", "Acme");
  await page.fill("#projectName", "Default");
  await page.click('button[type="submit"]');

  await page.waitForURL(/\/device\/approve\?user_code=/u);
  await page.getByRole("button", { name: "Approve" }).click();
  await page.waitForURL(/\/device\/success/u);
}

/** The second time round, when the browser already holds the sign-in. */
export async function approveOnly(page: Page, approveUrl: string): Promise<void> {
  await page.goto(approveUrl);
  // The address lands on the page that claims the code; it is only after that
  // that there is anything to approve.
  await page.click('button[type="submit"]');
  await page.waitForURL(/\/device\/approve\?user_code=/u);
  await page.getByRole("button", { name: "Approve" }).click();
  await page.waitForURL(/\/device\/success/u);
}
