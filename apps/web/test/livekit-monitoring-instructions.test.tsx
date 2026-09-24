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
  it("passes the JavaScript session to monitoring before connecting or starting it", () => {
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
      'import { monitor } from "@egma/livekit"',
    );
    expect(copy).toContain("const session = new voice.AgentSession(...);");
    expect(copy).toContain("monitor(ctx, { session });");
    expect(copy).not.toContain("Make the hook the first line of entrypoint");
    expect(copy.indexOf("const session = new voice.AgentSession(...);")).toBeLessThan(
      copy.indexOf("monitor(ctx, { session });"),
    );
    expect(copy.indexOf("monitor(ctx, { session });")).toBeLessThan(
      copy.indexOf("await ctx.connect()"),
    );
    expect(copy.indexOf("await ctx.connect()")).toBeLessThan(
      copy.indexOf("await session.start(...)"),
    );
    expect(copy.indexOf("monitor(ctx, { session });")).toBeLessThan(
      copy.indexOf("await session.start(...)"),
    );
    expect(copy).toContain("EGMA_URL=<your-public-egma-url>");
    expect(copy).toContain("EGMA_API_KEY=<your-project-api-key>");
    expect(copy).not.toContain("pip install");
    expect(copy).not.toContain("from egma import");
    expect(copy).not.toContain("monitorLiveKit");
    expect(copy).not.toContain("is available on npm");
  });
});
