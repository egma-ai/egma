// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import MonitoringSetupPage from "../app/projects/[projectId]/monitoring/setup/page.tsx";
import { observeRequest, type FetchInput } from "./platform-request.ts";

vi.mock("next/navigation", () => ({
  usePathname: () => "/projects/prj_2/monitoring/setup",
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
  useParams: () => ({ projectId: "prj_2" }),
}));

vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    ...rest
  }: {
    href: string;
    children: unknown;
  }) => <a href={href} {...rest}>{children as never}</a>,
}));

vi.mock("next/image", () => ({
  default: ({ alt }: { alt: string }) => <img alt={alt} />,
}));

const ME = {
  user: { id: "usr_1", email: "ada@acme.example" },
  organizations: [{ id: "org_1", name: "Acme", slug: "acme", role: "admin" }],
  projects: [{ id: "prj_2", name: "Outbound", slug: "outbound" }],
};

/** Answer the shell's own read, and record every address the page asks for. */
function watchedFetch(asked: string[]): void {
  vi.stubGlobal("scrollTo", vi.fn());
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: FetchInput) => {
      const { path } = await observeRequest(input);
      asked.push(path);
      return new Response(JSON.stringify(path === "/api/me" ? ME : {}), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }),
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/**
 * There is no monitoring setup object to configure any more (ADR-0015).
 * Configuration collapsed into the agent: one per-agent switch turns pull on,
 * and push is never configured at all. This address is kept as the signpost
 * that says so, and the start-monitoring flow is built on it separately.
 *
 * So what is worth holding here is the *absence*: the page must consult no
 * server state, because a page that read one would be this screen quietly
 * becoming a second place monitoring is configured.
 */
describe("the start-monitoring address", () => {
  it("says where the choice lives and sends the reader to the agents", async () => {
    const asked: string[] = [];
    watchedFetch(asked);

    render(<MonitoringSetupPage />);

    expect(
      await screen.findByText("Monitoring is set up on the agent."),
    ).toBeDefined();
    expect(
      screen.getByText(/turn on Pull production calls/),
    ).toBeDefined();
    // Push needs nothing at all, and the page says so rather than offering a
    // switch there is no server-side off for.
    expect(screen.getByText(/needs no setup at all/)).toBeDefined();

    const toAgents = screen.getByRole("link", { name: "Open agents" });
    expect(toAgents.getAttribute("href")).toBe("/projects/prj_2/agents");
  });

  it("reads no server state and offers nothing to save", async () => {
    const asked: string[] = [];
    watchedFetch(asked);

    render(<MonitoringSetupPage />);
    await screen.findByText("Monitoring is set up on the agent.");

    expect(asked.filter((path) => path.startsWith("/v1/monitoring"))).toEqual(
      [],
    );
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
    expect(screen.queryByLabelText("Retell API key")).toBeNull();
    expect(screen.queryByLabelText("Agent platform")).toBeNull();
  });
});
