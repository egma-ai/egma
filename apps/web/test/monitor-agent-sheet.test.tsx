// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import StartMonitoringAlias from "../app/projects/[projectId]/monitoring/start/page.tsx";
import MonitoringTranscriptsPage from "../app/projects/[projectId]/monitoring/transcripts/page.tsx";
import { observeRequest, type FetchInput } from "./platform-request.ts";

/**
 * Monitoring owns no setup form. Every entry states the Monitoring goal and
 * opens the shared Connect agent flow on Agents. The old query and route
 * forward to the same address, so copied links cannot reopen a second flow.
 */

const routed = vi.hoisted(() => ({
  replace: vi.fn(),
  redirect: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  usePathname: () => "/projects/prj_2/monitoring/transcripts",
  useRouter: () => ({ push: vi.fn(), replace: routed.replace, back: vi.fn() }),
  useParams: () => ({ projectId: "prj_2" }),
  useSearchParams: () => new URLSearchParams(globalThis.location.search),
  redirect: routed.redirect,
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

let seenRole: "admin" | "viewer" = "admin";

function meIs() {
  return {
    user: { id: "usr_1", email: "ada@acme.example" },
    organizations: [{ id: "org_1", name: "Acme", slug: "acme", role: seenRole }],
    projects: [{ id: "prj_2", name: "Outbound", slug: "outbound" }],
  };
}

type Seen = {
  readonly path: string;
  readonly method: string;
};

function stub(): { readonly seen: Seen[] } {
  const seen: Seen[] = [];
  vi.stubGlobal("scrollTo", vi.fn());
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: FetchInput) => {
      const asked = await observeRequest(input);
      seen.push({ path: asked.path, method: asked.method });

      const body =
        asked.path === "/api/me"
          ? meIs()
          : asked.path === "/v1/traces"
            ? { traces: [], nextPageToken: null }
            : asked.path === "/v1/graders"
              ? { graders: [], nextPageToken: null }
              : asked.path === "/v1/keys"
                ? { keys: [] }
                : null;

      if (body === null) throw new Error(`nothing stubbed for ${asked.path}`);
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }),
  );
  return { seen };
}

const TRANSCRIPTS = "/projects/prj_2/monitoring/transcripts";
const MONITORING_SETUP =
  "/projects/prj_2/agents?sheet=connect&goal=monitoring";

function at(address: string): void {
  globalThis.history.replaceState({}, "", address);
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  routed.replace.mockClear();
  routed.redirect.mockClear();
  seenRole = "admin";
  at(TRANSCRIPTS);
});

describe("the Monitoring entry", () => {
  it("opens Connect agent with Monitoring selected", async () => {
    const { seen } = stub();
    render(<MonitoringTranscriptsPage />);

    await screen.findByRole("heading", { level: 1, name: "Traces" });
    await screen.findByRole("heading", { name: "No production traces yet" });
    const actions = screen.getAllByRole("link", {
      name: "Set up monitoring",
    });
    expect(actions).toHaveLength(1);
    for (const action of actions) {
      expect(action.getAttribute("href")).toBe(MONITORING_SETUP);
    }

    expect(screen.queryByRole("dialog", { name: "Monitor an agent" })).toBeNull();
    expect(seen.some((request) => request.path === "/v1/agents")).toBe(false);
  });

  it("keeps the action visible but disabled for a viewer", async () => {
    seenRole = "viewer";
    stub();
    render(<MonitoringTranscriptsPage />);

    await screen.findByRole("heading", { name: "No production traces yet" });
    const actions = screen.getAllByRole("button", {
      name: "Set up monitoring",
    });
    expect(actions).toHaveLength(1);
    for (const action of actions) {
      expect((action as HTMLButtonElement).disabled).toBe(true);
    }
    expect(
      screen.queryByRole("link", { name: "Set up monitoring" }),
    ).toBeNull();
  });

  it("forwards a copied legacy sheet query and carries its agent", async () => {
    at(`${TRANSCRIPTS}?sheet=monitor&agent=agt_2`);
    stub();
    render(<MonitoringTranscriptsPage />);

    await waitFor(() => {
      expect(routed.replace).toHaveBeenCalledWith(
        "/projects/prj_2/agents?sheet=connect&agent=agt_2&goal=monitoring",
      );
    });
    expect(screen.queryByRole("dialog", { name: "Monitor an agent" })).toBeNull();
  });
});

describe("the retired Start-monitoring address", () => {
  it("forwards to the same shared flow", async () => {
    await StartMonitoringAlias({
      params: Promise.resolve({ projectId: "prj_2" }),
      searchParams: Promise.resolve({}),
    });

    expect(routed.redirect).toHaveBeenCalledWith(MONITORING_SETUP);
  });

  it("carries an agent named by an old link", async () => {
    await StartMonitoringAlias({
      params: Promise.resolve({ projectId: "prj_2" }),
      searchParams: Promise.resolve({ agent: "agt_2" }),
    });

    expect(routed.redirect).toHaveBeenCalledWith(
      "/projects/prj_2/agents?sheet=connect&agent=agt_2&goal=monitoring",
    );
  });
});
