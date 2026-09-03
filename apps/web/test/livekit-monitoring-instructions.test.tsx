// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";

import { LiveKitMonitoringInstructions } from "../app/projects/[projectId]/agents/livekit-monitoring-instructions.tsx";
import type { LiveKitWorkerLanguage } from "../lib/agent-setup-flow.ts";

afterEach(cleanup);

function MonitoringInstructions() {
  const [language, setLanguage] = useState<LiveKitWorkerLanguage>("python");
  return (
    <LiveKitMonitoringInstructions
      projectId="prj_1"
      language={language}
      onLanguageChange={setLanguage}
    />
  );
}

describe("LiveKit monitoring instructions", () => {
  it("shows only the worker changes that the person must make", () => {
    const { container } = render(<MonitoringInstructions />);

    expect(
      screen.getByRole("heading", {
        name: "Add monitoring to your LiveKit agent",
      }),
    ).toBeTruthy();
    expect(screen.getByText("Install the Egma SDK")).toBeTruthy();
    expect(screen.getAllByRole("button", { name: /^Copy / })).toHaveLength(3);
    expect(screen.getByRole("link", { name: "API keys" })).toBeTruthy();
    expect(
      screen.getByRole("tab", { name: "Python" }).getAttribute("aria-selected"),
    ).toBe("true");
    expect(
      screen
        .getByRole("tab", { name: "JavaScript" })
        .getAttribute("aria-selected"),
    ).toBe("false");

    expect(screen.getByText("Install the Egma SDK")).toBeTruthy();
    expect(
      screen.getByText("Make the hook the first line of entrypoint"),
    ).toBeTruthy();
    expect(screen.getByText("Set the environment values")).toBeTruthy();
    expect(
      screen.getByText("What language is your LiveKit worker?"),
    ).toBeTruthy();
    expect(screen.getAllByRole("button", { name: /^Copy / })).toHaveLength(3);
    expect(
      screen.getByRole("tab", { name: "Python" }).getAttribute("aria-selected"),
    ).toBe("true");
    expect(screen.getByRole("tablist").getAttribute("data-variant")).toBe(
      "default",
    );

    const copy = container.textContent ?? "";
    expect(copy).toContain("pip install egma");
    expect(copy).not.toContain("egma>=");
    expect(copy).toContain("from egma import monitor_livekit");
    expect(copy.indexOf("monitor_livekit(ctx)")).toBeLessThan(
      copy.indexOf("await ctx.connect()"),
    );
    expect(copy.indexOf("await ctx.connect()")).toBeLessThan(
      copy.indexOf("await session.start(...)"),
    );
    expect(copy.indexOf("monitor_livekit(ctx)")).toBeLessThan(
      copy.indexOf("await session.start(...)"),
    );
    expect(copy).toContain("EGMA_URL=<your-public-egma-url>");
    expect(copy).toContain(
      "the public Egma API URL that your deployed LiveKit worker can reach",
    );
    expect(copy).not.toContain("localhost");
    expect(copy).toContain("EGMA_API_KEY=<your-project-api-key>");
    expect(
      screen.getByRole("link", { name: "API keys" }).getAttribute("href"),
    ).toBe("/projects/prj_1/settings/keys");
    expect(copy).not.toContain("Not verified yet");
    expect(copy).not.toContain("Egma creates or matches the agent");
    expect(copy).not.toContain("mockable");
    expect(copy).not.toMatch(/monitoring (ready|configured|on)/i);
  });

  it("shows the JavaScript package and keeps the hook first", () => {
    const { container } = render(<MonitoringInstructions />);

    fireEvent.click(screen.getByRole("tab", { name: "JavaScript" }));

    const copy = container.textContent ?? "";
    expect(
      screen
        .getByRole("tab", { name: "JavaScript" })
        .getAttribute("aria-selected"),
    ).toBe("true");
    expect(screen.getAllByRole("button", { name: /^Copy / })).toHaveLength(3);
    expect(copy).toContain("npm install @egma/livekit");
    expect(copy).toContain(
      "LiveKit Agents 1.5.5 or newer in the 1.x line",
    );
    expect(copy).toContain(
      'import { monitorLiveKit } from "@egma/livekit"',
    );
    expect(copy.indexOf("monitorLiveKit(ctx)")).toBeLessThan(
      copy.indexOf("await ctx.connect()"),
    );
    expect(copy.indexOf("await ctx.connect()")).toBeLessThan(
      copy.indexOf("await session.start(...)"),
    );
    expect(copy.indexOf("monitorLiveKit(ctx)")).toBeLessThan(
      copy.indexOf("await session.start(...)"),
    );
    expect(copy).toContain("EGMA_URL=<your-public-egma-url>");
    expect(copy).toContain("EGMA_API_KEY=<your-project-api-key>");
    expect(copy).not.toContain("pip install");
    expect(copy).not.toContain("monitor_livekit");
    expect(copy).not.toContain("is available on npm");
  });
});
