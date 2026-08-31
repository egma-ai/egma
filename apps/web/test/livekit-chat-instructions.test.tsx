// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CHAT_SETUP_PROMPT,
  CHAT_SETUP_SNIPPET,
  LiveKitTestingInstructions,
  TESTING_SETUP_INSTALL,
  VOICE_SETUP_PROMPT,
  VOICE_SETUP_SNIPPET,
} from "../app/projects/[projectId]/agents/livekit-testing-instructions.tsx";

/**
 * The code root, read off the runner rather than off this file's own URL.
 *
 * A jsdom test's `import.meta.url` is an `http:` address, which
 * `fileURLToPath` refuses; Vitest still runs from the repository root, so that
 * is what names the path here.
 */
const CODE_ROOT = process.cwd();

afterEach(() => {
  cleanup();
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: undefined,
  });
});

describe("LiveKit testing instructions", () => {
  it("hands over the complete chat setup and claims nothing about it", () => {
    const { container } = render(
      <LiveKitTestingInstructions modality="chat" />,
    );

    expect(
      screen.getByRole("heading", {
        name: "Add simulation testing to your LiveKit agent",
      }),
    ).toBeTruthy();
    expect(screen.getByText("Give this to your coding agent")).toBeTruthy();
    expect(
      screen.getByText("Install the latest Egma SDK"),
    ).toBeTruthy();
    expect(screen.getByText("Apply the Python testing contract")).toBeTruthy();
    expect(screen.getAllByRole("button", { name: /^Copy / })).toHaveLength(3);

    const copy = container.textContent ?? "";
    expect(copy).toContain(
      'chat = ctx.job.room.name.startswith("egma-sim-chat-")',
    );
    expect(copy).toContain("audio_input=False");
    expect(copy).toContain("TextOutputOptions(sync_transcription=False)");
    expect(copy).toContain("from egma import mockable");
    expect(copy).toContain("await mockable(agent, ctx, session)");
    expect(copy.indexOf("await mockable(agent, ctx, session)")).toBeLessThan(
      copy.indexOf("await session.start"),
    );
    // The prompt carries the worker's name as well: dispatching by name is
    // what puts the one agent under test in the marked room.
    expect(copy).toContain("agent_name in its WorkerOptions");
    expect(copy).toContain(TESTING_SETUP_INSTALL);
    expect(copy).not.toMatch(/egma[>=~^]/);

    // The mirror of the monitoring surface's promise: the web explains work it
    // cannot perform, so it claims no completion for it.
    expect(copy).not.toMatch(/chat (is )?(ready|configured|on)\b/i);
    expect(copy).not.toContain("Verified");
    expect(copy).toContain("Egma cannot see this change from here");
  });

  it("gives voice workers the testing hook without chat-only room changes", () => {
    const { container } = render(
      <LiveKitTestingInstructions modality="voice" />,
    );

    const copy = container.textContent ?? "";
    expect(copy).toContain(VOICE_SETUP_PROMPT);
    expect(copy).toContain(VOICE_SETUP_SNIPPET);
    expect(copy).toContain("from egma import mockable");
    expect(copy).toContain("await mockable(agent, ctx, session)");
    expect(copy).toContain("agent_name in its WorkerOptions");
    expect(copy).not.toContain("egma-sim-chat-");
    expect(copy).not.toContain("independent audio publisher");
  });

  it("keeps the setup visible and explains a clipboard failure", async () => {
    const writeText = vi.fn(async () => {
      throw new Error("Clipboard permission was denied.");
    });
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    render(<LiveKitTestingInstructions modality="chat" />);

    fireEvent.click(
      screen.getByRole("button", { name: "Copy coding-agent prompt" }),
    );

    expect((await screen.findByRole("alert")).textContent).toBe(
      "Could not copy the coding-agent prompt. Select the text and copy it manually.",
    );
    expect(
      screen.getByRole("button", {
        name: "Try to copy coding-agent prompt again",
      }),
    ).toBeTruthy();
    expect(document.body.textContent).toContain(CHAT_SETUP_PROMPT);
  });

  /**
   * The reference and this surface are one piece of knowledge in two places.
   *
   * A coding agent reads the reference and a person reads this panel, and the
   * day the two blocks differ is the day one of them puts the wrong lines in a
   * worker. This is the only assertion in the web tests that reads a source
   * file, and it is here rather than beside the sheet's tests for that reason.
   */
  it("follows the versioned LiveKit source contract", () => {
    const contract = readFileSync(
      path.join(
        CODE_ROOT,
        "apps",
        "cli",
        "src",
        "commands",
        "livekit.ts",
      ),
      "utf8",
    );

    expect(contract).toContain('chat_room_prefix: egma-sim-chat-');
    expect(contract).toContain("python_testing_import: from egma import mockable");
    expect(contract).toContain(
      "python_testing_call: await mockable(agent, ctx, session)",
    );
    expect(contract).toContain(
      "disable AgentSession audio input, audio output, and transcription sync",
    );
    expect(contract).toContain("do not start any independent audio publisher");
    expect(contract).toContain("dispatch_name:");
    expect(CHAT_SETUP_SNIPPET).toContain(
      'ctx.job.room.name.startswith("egma-sim-chat-")',
    );
    expect(CHAT_SETUP_PROMPT).toContain("transcription sync off");
    expect(CHAT_SETUP_PROMPT).toContain("await mockable(agent, ctx, session)");
    expect(CHAT_SETUP_PROMPT).toContain("agent_name in its WorkerOptions");
    expect(CHAT_SETUP_PROMPT).toContain("independent audio publisher");
  });
});
