/**
 * A browser that never opens: the stand-in egma starts in place of a real one.
 *
 * egma starts whatever `BROWSER` names, handing it the address to open. A check
 * points `BROWSER` at this, so the whole of login runs with no window on the
 * screen of whoever is running the suite — and the address egma really passed
 * is written down where the check can read it.
 *
 * What it then does is what a person would have done in the window: approve,
 * deny, or nothing at all. `FIXTURE_BROWSER_DOES` says which.
 *
 * Run as: node approving-browser.ts <address>
 */

import { appendFile } from "node:fs/promises";
import process from "node:process";

const address = process.argv[2] ?? "";
const does = process.env.FIXTURE_BROWSER_DOES ?? "approve";
const writeTo = process.env.FIXTURE_BROWSER_WRITES_TO;

if (writeTo !== undefined && writeTo !== "") {
  await appendFile(writeTo, `${address}\n`, "utf8");
}

if (does !== "nothing" && address !== "") {
  const at = new URL(address);
  const code = at.searchParams.get("user_code") ?? "";
  await fetch(`${at.origin}/fixture/${does}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ user_code: code }),
  });
}
