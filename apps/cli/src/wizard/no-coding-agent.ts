/**
 * The machine with no coding agent on it.
 *
 * egma drives the coding agent the developer already has. On a machine that has
 * none — or one egma cannot start — there is nothing to drive and nothing to
 * wait for, so egma stops and hands over the one thing that still works: the
 * words to paste into whatever coding agent the developer does use. A message,
 * not a second product.
 *
 * The words ask for the same facts the step itself asks for, because they are
 * built from the same list. A message that drifted from the step would send a
 * developer back with an answer egma cannot read.
 */

import { factsAsked } from "./facts.ts";

/** Wide enough to read, narrow enough that no terminal folds it itself. */
const WIDTH = 70;

/** The text as lines no wider than `WIDTH`, broken between words. */
function wrap(text: string, width: number): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/).filter((part) => part !== "")) {
    if (line === "") line = word;
    else if (`${line} ${word}`.length > width) {
      lines.push(line);
      line = word;
    } else line = `${line} ${word}`;
  }
  if (line !== "") lines.push(line);
  return lines;
}

/** The block a developer copies: indented, so it reads as one thing to take. */
function toPaste(): string[] {
  const asked = [
    `Find the voice agent in this repository and tell me ${factsAsked()}.`,
    "Look at the dependency list first — retell-sdk, vapi, livekit-agents and",
    "pipecat are the ones to expect. Give me the file paths as this repository",
    "holds them, and change nothing.",
  ].join(" ");
  return wrap(asked, WIDTH - 2).map((line) => `  ${line}`);
}

/** What a developer with no drivable coding agent is given instead. */
export function pasteFallbackMessage(): string {
  return [
    "Egma could not reach a coding agent on this machine that it can drive.",
    "",
    "Open the coding agent you use, and paste this into it:",
    "",
    ...toPaste(),
    "",
    "Then run egma again from a machine with a coding agent it can start. Egma",
    "drives Claude Code and Codex today, and every agent the protocol registry",
    "publishes as a package.",
  ].join("\n");
}
