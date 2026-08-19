/**
 * The receipt: what setup changed in this platform, written down.
 *
 * Every `self-host` command that changes anything leaves a receipt in the
 * platform workspace: what ran, when, and which non-secret settings or local
 * artifacts changed. Normal setup never reaches a carrier account, so a
 * receipt records the carrier values it copied, not work done in Twilio.
 *
 * **A receipt is a public document.** It is written into a working directory
 * that people commit, paste into issues and attach to support threads, so
 * nothing in it may be a secret — not an OpenAI key and not the SIP password
 * supplied by a developer. What it carries instead are setting names,
 * hostnames and the number a call comes from, which are the things a person
 * actually needs and which open nothing.
 *
 * The guard is not a review habit. `sweptOf` is applied to every receipt before
 * it is written, and it refuses to write one that contains any secret the
 * command was holding — so a field added carelessly later fails the write
 * rather than leaking quietly.
 */

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { PLATFORM_DIRECTORY, platformDirectory } from "./workspace.ts";

/** Where receipts pile up, newest last. */
export const RECEIPTS_DIRECTORY = "receipts";

export type Receipt = {
  /** Which command wrote it. */
  readonly command: string;
  readonly at: string;
  readonly result: "applied" | "planned" | "failed";
  /** Non-secret facts, one per line when printed. */
  readonly facts: Readonly<Record<string, string | number | boolean | null>>;
  /** What was done, in order. Non-secret sentences. */
  readonly steps: readonly string[];
};

export class SecretInReceiptError extends Error {
  constructor(field: string) {
    super(
      `Egma refused to write a receipt: ${field} carries a secret this command was given. ` +
        "A receipt is a document people commit and paste into issues, so nothing " +
        "in one may be a credential. This is a bug in Egma, not in your setup — " +
        "nothing was written and nothing leaked.",
    );
    this.name = "SecretInReceiptError";
  }
}

/**
 * Prove a receipt carries none of the secrets the command was holding.
 *
 * Whole-value matching, on the rendered document, because a secret that reaches
 * a receipt reaches it whole — it is copied from a variable, never assembled
 * character by character. Short values are ignored: a two-character "secret" is
 * a typo, and matching one would refuse every receipt that happened to contain
 * those two characters anywhere.
 */
const SHORTEST_MATCHABLE_SECRET = 8;

export function sweptOf(
  document: string,
  secrets: readonly (string | undefined)[],
): void {
  for (const secret of secrets) {
    if (secret === undefined || secret.length < SHORTEST_MATCHABLE_SECRET) continue;
    if (document.includes(secret)) throw new SecretInReceiptError("the receipt");
  }
}

/** Render a receipt as the document it is filed as. */
export function render(receipt: Receipt): string {
  return `${JSON.stringify(receipt, null, 2)}\n`;
}

/**
 * File a receipt, having proved it carries no secret.
 *
 * Named for the moment rather than numbered, so two runs never fight over a
 * name and the order on disk is the order they happened in.
 */
export function fileReceipt(
  workspace: string,
  receipt: Receipt,
  secrets: readonly (string | undefined)[],
): string {
  const document = render(receipt);
  sweptOf(document, secrets);

  // Through the one door that makes the platform directory private, so that
  // whichever write happens to be first cannot decide its mode for good.
  const directory = path.join(platformDirectory(workspace), RECEIPTS_DIRECTORY);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stamp = receipt.at.replace(/[:.]/g, "-");
  const file = path.join(directory, `${stamp}-${receipt.command.replace(/\s+/g, "-")}.json`);
  writeFileSync(file, document, { mode: 0o644 });
  return file;
}

/** Every receipt filed in a workspace, oldest first. Used by the secret sweep. */
export function everyReceipt(workspace: string): readonly string[] {
  const directory = path.join(workspace, PLATFORM_DIRECTORY, RECEIPTS_DIRECTORY);
  try {
    return readdirSync(directory)
      .filter((name) => name.endsWith(".json"))
      .sort()
      .map((name) => path.join(directory, name));
  } catch {
    return [];
  }
}

/** One filed receipt's text, for a sweep that reads what was really written. */
export function receiptText(file: string): string {
  return readFileSync(file, "utf8");
}
