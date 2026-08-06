/**
 * The machine with no coding agent on it.
 *
 * egma drives the coding agent the developer already has. On a machine that has
 * none — or one egma cannot start — there is nothing to drive and nothing to
 * wait for, so egma stops and hands over the one thing that still works: the
 * words to paste into whatever coding agent the developer does use. A message,
 * not a second product.
 */

/** What a developer with no drivable coding agent is given instead. */
export function pasteFallbackMessage(): string {
  return [
    "egma could not reach a coding agent on this machine that it can drive.",
    "",
    "Open the coding agent you use, and paste this into it:",
    "",
    "  Find the voice agent in this repository and tell me four things: which",
    "  framework runs it, where its prompts live, where its tools are defined,",
    "  and how it reaches production. Look at the dependency list first —",
    "  retell-sdk, vapi, livekit-agents and pipecat are the ones to expect.",
    "  Give me the file paths as this repository holds them, and change nothing.",
    "",
    "Then run egma again from a machine with a coding agent it can start. egma",
    "drives Claude Code and Codex today, and every agent the protocol registry",
    "publishes as a package.",
  ].join("\n");
}
