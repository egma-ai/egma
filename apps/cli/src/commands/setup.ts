/**
 * The bare `egma` command: hand the repository to the developer's coding
 * agent.
 *
 * This is intentionally a small bootstrap. Repository inspection, source
 * edits, provider setup, test authoring, monitoring, and runs belong to the
 * public skills plus the promptless CLI commands. Keeping those actions out of
 * this module means every coding agent can use the same path without Egma
 * needing to discover, start, supervise, or authorize it. The coding agent
 * runs `egma login`; the developer approves that request in the browser.
 */

export const SKILLS_INSTALL_COMMAND =
  "npx --yes skills add egma-ai/egma --skill integrate-egma --skill write-egma-tests --skill egma";

export const INTEGRATION_HANDOFF =
  "Use the integrate-egma skill to complete the requested Egma simulation testing, production monitoring, or both for this repository's voice agent end to end.";

export type SetupCommandOptions = {
  readonly platformUrl?: string | null;
  readonly out: (line: string) => void;
};

export function runSetupCommand(options: SetupCommandOptions): number {
  options.out("setup: skills-and-cli");
  options.out(
    "note: Your coding agent will do the full integration through the public skills and promptless commands.",
  );
  const platform = options.platformUrl?.trim() ?? "";
  if (platform !== "") options.out(`platform: ${platform}`);
  options.out(`skills: ${SKILLS_INSTALL_COMMAND}`);
  options.out(
    "note: If integrate-egma is already available to this coding agent, keep it and do not reinstall it.",
  );
  options.out(
    `next: ${INTEGRATION_HANDOFF}${
      platform === "" ? "" : ` Use ${platform} as the Egma platform URL.`
    }`,
  );
  options.out("status: ready-for-agent");
  return 0;
}
