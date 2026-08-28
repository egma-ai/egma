// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import {
  CHAT_SETUP_PROMPT,
  CHAT_SETUP_SNIPPET,
  LiveKitChatInstructions,
} from "../app/projects/[projectId]/agents/livekit-chat-instructions.tsx";

/**
 * The code root, read off the runner rather than off this file's own URL.
 *
 * A jsdom test's `import.meta.url` is an `http:` address, which
 * `fileURLToPath` refuses; Vitest still runs from the repository root, so that
 * is what names the path here.
 */
const CODE_ROOT = process.cwd();

afterEach(cleanup);

describe("LiveKit chat instructions", () => {
  it("hands over the setup and claims nothing about it", () => {
    const { container } = render(<LiveKitChatInstructions />);

    expect(
      screen.getByRole("heading", {
        name: "Add the chat setup to your LiveKit agent",
      }),
    ).toBeTruthy();
    expect(screen.getByText("Give this to your coding agent")).toBeTruthy();
    expect(
      screen.getByText("Or add these lines to the worker yourself"),
    ).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "Copy" })).toHaveLength(2);

    const copy = container.textContent ?? "";
    expect(copy).toContain('context = json.loads(ctx.job.metadata or "{}")');
    expect(copy).toContain("audio_input=False");
    expect(copy).toContain("TextOutputOptions(sync_transcription=False)");
    // The prompt carries the worker's name as well, because a worker Egma
    // cannot dispatch cannot be told the simulation is typed either.
    expect(copy).toContain("agent_name in its WorkerOptions");
    // Nothing Egma has to install is asked for.
    expect(copy).not.toContain("pip install");
    expect(copy).not.toContain("from egma import");

    // The mirror of the monitoring surface's promise: the web explains work it
    // cannot perform, so it claims no completion for it.
    expect(copy).not.toMatch(/chat (is )?(ready|configured|on)\b/i);
    expect(copy).not.toContain("Verified");
    expect(copy).toContain("Egma cannot see this change from here");
  });

  /**
   * The reference and this surface are one piece of knowledge in two places.
   *
   * A coding agent reads the reference and a person reads this panel, and the
   * day the two blocks differ is the day one of them puts the wrong lines in a
   * worker. This is the only assertion in the web tests that reads a source
   * file, and it is here rather than beside the sheet's tests for that reason.
   */
  it("shows the same lines the LiveKit reference teaches", () => {
    const reference = readFileSync(
      path.join(
        CODE_ROOT,
        "skills",
        "integrate-egma",
        "references",
        "integrate-livekit.md",
      ),
      "utf8",
    );

    expect(reference).toContain(`\`\`\`python\n${CHAT_SETUP_SNIPPET}\n\`\`\``);
    // And the prompt asks for exactly the two changes the reference teaches
    // for a chat connection, in its own words.
    expect(CHAT_SETUP_PROMPT).toContain(
      "text_output=TextOutputOptions(sync_transcription=False)",
    );
    expect(CHAT_SETUP_PROMPT).toContain("agent_name in its WorkerOptions");
  });
});
