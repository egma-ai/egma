/**
 * BROWSER test replacement that records the verification URL without opening a window.
 * FIXTURE_BROWSER_DOES selects approval, denial, or no action.
 * Usage: node approving-browser.ts <address>
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
