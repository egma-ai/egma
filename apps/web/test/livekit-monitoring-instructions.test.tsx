// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { LiveKitMonitoringInstructions } from "../app/projects/[projectId]/agents/livekit-monitoring-instructions.tsx";

afterEach(cleanup);

describe("LiveKit monitoring instructions", () => {
  it("shows only the worker changes that the person must make", () => {
    const { container } = render(
      <LiveKitMonitoringInstructions projectId="prj_1" />,
    );

    expect(
      screen.getByRole("heading", {
        name: "Add monitoring to your LiveKit agent",
      }),
    ).toBeTruthy();
    expect(screen.getByText("Install the Egma SDK")).toBeTruthy();
    expect(
      screen.getByText("Add the hook before AgentSession.start"),
    ).toBeTruthy();
    expect(screen.getByText("Set the environment values")).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "Copy" })).toHaveLength(3);

    const copy = container.textContent ?? "";
    expect(copy).toContain("pip install 'egma>=0.2.0'");
    expect(copy).toContain("from egma import monitor_livekit");
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
    expect(copy).not.toContain("ctx.connect()");
    expect(copy).not.toContain("mockable");
    expect(copy).not.toMatch(/monitoring (ready|configured|on)/i);
  });
});
