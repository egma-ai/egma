// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  JAVASCRIPT_CHAT_SETUP_PROMPT,
  JAVASCRIPT_CHAT_SETUP_SNIPPET,
  JAVASCRIPT_TESTING_SETUP_INSTALL,
  JAVASCRIPT_VOICE_SETUP_PROMPT,
  JAVASCRIPT_VOICE_SETUP_SNIPPET,
  LiveKitTestingInstructions,
  PYTHON_CHAT_SETUP_PROMPT,
  PYTHON_CHAT_SETUP_SNIPPET,
  PYTHON_TESTING_SETUP_INSTALL,
  PYTHON_VOICE_SETUP_PROMPT,
  PYTHON_VOICE_SETUP_SNIPPET,
} from "../app/projects/[projectId]/agents/livekit-testing-instructions.tsx";

afterEach(() => {
  cleanup();
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: undefined,
  });
});

describe("LiveKit testing instructions", () => {
  function InstructionsPicker() {
    const [language, setLanguage] = useState<"javascript" | "python">(
      "python",
    );
    return (
      <LiveKitTestingInstructions
        language={language}
        modality="voice"
        onLanguageChange={setLanguage}
      />
    );
  }

  it("starts with one valid instruction view and lets the person switch it", () => {
    render(<InstructionsPicker />);

    expect(screen.getByText("Show instructions for")).toBeTruthy();
    expect(
      screen.getByRole("tab", { name: "Python" }).getAttribute("aria-selected"),
    ).toBe("true");
    expect(screen.getByRole("tab", { name: "JavaScript" })).toBeTruthy();
    expect(screen.getByText("Install the latest Egma SDK")).toBeTruthy();
    expect(document.body.textContent).toContain(PYTHON_TESTING_SETUP_INSTALL);

    fireEvent.click(screen.getByRole("tab", { name: "JavaScript" }));

    expect(
      screen
        .getByRole("tab", { name: "JavaScript" })
        .getAttribute("aria-selected"),
    ).toBe("true");
    expect(document.body.textContent).toContain(JAVASCRIPT_TESTING_SETUP_INSTALL);
    expect(document.body.textContent).not.toContain(PYTHON_TESTING_SETUP_INSTALL);
  });

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
    expect(copy).toContain("from egma import mockable");
    expect(copy).toContain("await mockable(agent, ctx, session)");
    expect(copy.indexOf("await mockable(agent, ctx, session)")).toBeLessThan(
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

  it("gives voice workers the testing hook without chat-only room changes", () => {
    const { container } = render(
      <LiveKitTestingInstructions
        language="python"
        modality="voice"
        onLanguageChange={vi.fn()}
      />,
    );

    const copy = container.textContent ?? "";
    expect(copy).toContain(PYTHON_VOICE_SETUP_PROMPT);
    expect(copy).toContain(PYTHON_VOICE_SETUP_SNIPPET);
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
    expect(copy).toContain("LiveKit Agents 1.5.0 or newer in the 1.x line");
    expect(copy).toContain('import { mockable } from "@egma/livekit"');
    expect(copy).toContain(
      'ctx.job.room?.name?.startsWith("egma-sim-chat-")',
    );
    expect(copy).toContain("inputOptions: { audioEnabled: false }");
    expect(copy).toContain("outputOptions:");
    expect(copy).toContain("syncTranscription: false");
    expect(copy.indexOf("await mockable(agent, ctx, session)")).toBeLessThan(
      copy.indexOf("await session.start"),
    );
    expect(copy).not.toContain("pip install");
    expect(copy).not.toContain("from egma import mockable");
    expect(copy).not.toMatch(/unsupported/i);
  });

  it("gives JavaScript voice workers no chat-only room changes", () => {
    const { container } = render(
      <LiveKitTestingInstructions
        language="javascript"
        modality="voice"
        onLanguageChange={vi.fn()}
      />,
    );

    const copy = container.textContent ?? "";
    expect(copy).toContain(JAVASCRIPT_VOICE_SETUP_PROMPT);
    expect(copy).toContain(JAVASCRIPT_VOICE_SETUP_SNIPPET);
    expect(copy).toContain('import { mockable } from "@egma/livekit"');
    expect(copy).toContain("await mockable(agent, ctx, session)");
    expect(copy).not.toContain("egma-sim-chat-");
    expect(copy).not.toContain("independent audio publisher");
    expect(copy).not.toContain("inputOptions");
  });

  it("keeps the language-specific testing rules in its copied prompts", () => {
    expect(PYTHON_CHAT_SETUP_SNIPPET).toContain(
      'ctx.job.room.name.startswith("egma-sim-chat-")',
    );
    expect(PYTHON_CHAT_SETUP_PROMPT).toContain("transcription sync off");
    expect(PYTHON_CHAT_SETUP_PROMPT).toContain(
      "await mockable(agent, ctx, session)",
    );
    expect(PYTHON_CHAT_SETUP_PROMPT).toContain(
      "agent_name in its WorkerOptions",
    );
    expect(PYTHON_CHAT_SETUP_PROMPT).toContain("independent audio publisher");
    expect(JAVASCRIPT_CHAT_SETUP_SNIPPET).toContain(
      'ctx.job.room?.name?.startsWith("egma-sim-chat-")',
    );
    expect(JAVASCRIPT_CHAT_SETUP_PROMPT).toContain("transcription sync off");
    expect(JAVASCRIPT_CHAT_SETUP_PROMPT).toContain(
      "await mockable(agent, ctx, session)",
    );
    expect(JAVASCRIPT_CHAT_SETUP_PROMPT).toContain(
      "agentName in its WorkerOptions",
    );
    expect(JAVASCRIPT_CHAT_SETUP_PROMPT).toContain(
      "independent audio publisher",
    );
  });
});
