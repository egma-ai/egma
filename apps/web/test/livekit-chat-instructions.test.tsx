// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  JAVASCRIPT_CHAT_SETUP_PROMPT,
  JAVASCRIPT_CHAT_SETUP_SNIPPET,
  JAVASCRIPT_TESTING_SETUP_INSTALL,
  LiveKitTestingInstructions,
  PYTHON_CHAT_SETUP_PROMPT,
  PYTHON_TESTING_SETUP_INSTALL,
} from "../app/projects/[projectId]/agents/livekit-testing-instructions.tsx";

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
      <LiveKitTestingInstructions
        language="python"
        modality="chat"
        onLanguageChange={vi.fn()}
      />,
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
    expect(copy).toContain("from egma import simulation");
    expect(copy).toContain("await simulation(agent, ctx, session)");
    expect(copy.indexOf("await simulation(agent, ctx, session)")).toBeLessThan(
      copy.indexOf("await session.start"),
    );
    // The prompt carries the worker's name as well: dispatching by name is
    // what puts the one agent under test in the marked room.
    expect(copy).toContain("agent_name in its WorkerOptions");
    expect(copy).toContain(PYTHON_TESTING_SETUP_INSTALL);
    expect(copy).not.toContain("integrate-egma");
    expect(copy).not.toContain("egma livekit");
    expect(copy).not.toMatch(/egma[>=~^]/);

    // The mirror of the monitoring surface's promise: the web explains work it
    // cannot perform, so it claims no completion for it.
    expect(copy).not.toMatch(/chat (is )?(ready|configured|on)\b/i);
    expect(copy).not.toContain("Verified");
    expect(copy).toContain("Egma cannot see this change from here");
  });

  it("keeps the setup visible and explains a clipboard failure", async () => {
    const writeText = vi.fn(async () => {
      throw new Error("Clipboard permission was denied.");
    });
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    render(
      <LiveKitTestingInstructions
        language="python"
        modality="chat"
        onLanguageChange={vi.fn()}
      />,
    );

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
    expect(document.body.textContent).toContain(PYTHON_CHAT_SETUP_PROMPT);
  });

  it("hands over the complete JavaScript chat setup", () => {
    const { container } = render(
      <LiveKitTestingInstructions
        language="javascript"
        modality="chat"
        onLanguageChange={vi.fn()}
      />,
    );

    const copy = container.textContent ?? "";
    expect(copy).toContain(JAVASCRIPT_CHAT_SETUP_PROMPT);
    expect(copy).toContain(JAVASCRIPT_CHAT_SETUP_SNIPPET);
    expect(copy).toContain(JAVASCRIPT_TESTING_SETUP_INSTALL);
    expect(copy).toContain("LiveKit Agents 1.5.5 or newer in the 1.x line");
    expect(copy).toContain('import { simulation } from "@egma/livekit"');
    expect(copy).toContain(
      'ctx.job.room?.name?.startsWith("egma-sim-chat-")',
    );
    expect(copy).toContain("inputOptions: { audioEnabled: false }");
    expect(copy).toContain("outputOptions:");
    expect(copy).toContain("syncTranscription: false");
    expect(copy.indexOf("await simulation(agent, ctx, session)")).toBeLessThan(
      copy.indexOf("await session.start"),
    );
    expect(copy).not.toContain("pip install");
    expect(copy).not.toContain("from egma import simulation");
    expect(copy).not.toMatch(/unsupported/i);
  });
});
