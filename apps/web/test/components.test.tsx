// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import AgentsPage from "../app/projects/[projectId]/agents/page.tsx";
import type { Me } from "../lib/me.ts";
import { useUnsavedChanges } from "../ui/settings-read.ts";
import { AppShell } from "../ui/shell.tsx";
import { observeRequest, type FetchInput } from "./platform-request.ts";

/**
 * Drive shared component behavior in jsdom. Browser layout and independent
 * tabs require separate browser tests.
 */

/**
 * The router, and **one** of it.
 *
 * `useRouter` is stable in Next: a component may depend on it in an effect and
 * the effect runs once. Answering with a fresh object per call makes that
 * effect run on every render, and a page whose effect sets state then reads,
 * renders, reads again, for ever — a hang that says nothing about the page.
 * So the object is made once here, the way the real one is.
 */
const routed = vi.hoisted(() => {
  const push = vi.fn();
  const replace = vi.fn();
  const back = vi.fn();
  return {
    push,
    replace,
    back,
    router: { push, replace, back },
    pathname: "/projects/prj_1/agents",
    /*
     * Which side sheet the agents screen has open is in the address and
     * nowhere else, so a page rendered here needs the query as well as the
     * path. Empty is the plain list with no panel over it.
     */
    search: "",
    projectId: "prj_1" as string | undefined,
  };
});

vi.mock("next/navigation", () => ({
  usePathname: () => routed.pathname,
  useRouter: () => routed.router,
  useSearchParams: () => new URLSearchParams(routed.search),
  useParams: () => ({ projectId: routed.projectId }),
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

const PROJECTS = [
  { id: "prj_1", name: "Default", slug: "default" },
  { id: "prj_2", name: "Outbound", slug: "outbound" },
];

const ACME = { id: "org_1", name: "Acme", slug: "acme", role: "admin" };

function meWith(role: string): Me {
  return {
    user: { id: "usr_1", email: "ada@acme.example" },
    organizations: [{ ...ACME, role }],
    projects: PROJECTS,
  };
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

type Stubbed = { status: number; body: unknown } | "never";

/**
 * Whatever egma is standing in for, answered as the API would answer it.
 *
 * A path may be given a list, which is answered in order and then repeats its
 * last entry — that is how a read that fails and then succeeds is written.
 */
function apiAnswers(answers: Record<string, Stubbed | readonly Stubbed[]>): void {
  const asked: Record<string, number> = {};

  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: FetchInput, init?: RequestInit) => {
      const { path } = await observeRequest(input, init);
      const held = answers[path];
      if (held === undefined) throw new Error(`nothing stubbed for ${path}`);

      const turn = asked[path] ?? 0;
      asked[path] = turn + 1;
      const answer = Array.isArray(held)
        ? ((held[Math.min(turn, held.length - 1)] ?? "never") as Stubbed)
        : (held as Stubbed);

      if (answer === "never") return new Promise<Response>(() => undefined);
      return json(answer.status, answer.body);
    }),
  );
}

beforeEach(() => {
  routed.push.mockReset();
  routed.replace.mockReset();
  routed.back.mockReset();
  routed.pathname = "/projects/prj_1/agents";
  routed.projectId = "prj_1";
  // The shell returns to the top on every navigation; jsdom has no scrolling.
  vi.stubGlobal("scrollTo", vi.fn());
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/* ------------------------------------------------------------------------ */

describe("the shared draft navigation guard", () => {
  function DraftPage({ busy = false }: { readonly busy?: boolean }) {
    const [changed, setChanged] = useState(false);
    const state = useUnsavedChanges(changed && !busy, busy);

    return (
      <AppShell initialMe={meWith("admin")}>
        <button type="button" onClick={() => setChanged(true)}>Change name</button>
        <span aria-label="Draft state">{state}</span>
        <a href="/projects/prj_1/tests">Leave page</a>
      </AppShell>
    );
  }

  it("keeps a draft on the page until the discard action is explicit", async () => {
    render(<DraftPage />);
    fireEvent.click(screen.getByRole("button", { name: "Change name" }));
    expect(screen.getByLabelText("Draft state").textContent).toBe("unsaved");

    const destination = screen.getByRole("link", { name: "Leave page" });
    destination.focus();
    fireEvent.click(destination);

    expect(routed.push).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: "Leave without saving?" }))
      .toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));
    expect(screen.queryByRole("dialog", { name: "Leave without saving?" }))
      .toBeNull();
    expect(document.activeElement).toBe(destination);

    const [projectSelector] = screen.getAllByRole("button", {
      name: /^Organization Acme/u,
    });
    expect(projectSelector).toBeDefined();
    if (projectSelector === undefined) throw new Error("project selector missing");
    fireEvent.click(projectSelector);
    fireEvent.click(
      within(screen.getByRole("menu")).getByText("Outbound"),
    );
    expect(routed.push).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: "Leave without saving?" }))
      .toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));
    expect(routed.push).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(projectSelector);

    fireEvent.click(destination);
    fireEvent.click(screen.getByRole("button", { name: "Discard changes" }));
    expect(routed.push).toHaveBeenCalledWith("/projects/prj_1/tests");
  });
});

/* ------------------------------------------------------------------------ */

/**
 * The Agents landing page, driven through its own states with the API standing
 * in. Each of these is a page somebody actually meets, and each says a
 * different thing.
 */
describe("the Agents page", () => {
  const AGENT = {
    id: "agt_1",
    projectId: "prj_1",
    name: "Front desk",
    // Every field the contract makes required is here, `agentPlatform`
    // included: the row reads it to say which platform an agent is on, and a
    // fixture that left it out would be a shape the API cannot answer with.
    agentPlatform: "retell",
    // The list read carries every agent's connections, so a row in this
    // fixture carries the field. An agent with none is one of the states the
    // page draws, and it is drawn from an empty list rather than a missing one.
    connections: [],
    createdAt: "2026-08-15T10:00:00.000Z",
    updatedAt: "2026-08-15T10:00:00.000Z",
  };

  /**
   * The one thing this whole ticket exists to prevent, in the page it ships.
   *
   * Press `Show more` in one project, change project before the answer comes
   * back, and the rows that arrive belong to the project nobody is looking at
   * any more. They were correctly scoped when they were sent — the server was
   * never wrong — and showing them under another project's name would still
   * make somebody distrust everything else on the screen.
   */
  it("drops a next page that arrives after the project changed", async () => {
    let release: (answer: Response) => void = () => undefined;
    const pending = new Promise<Response>((resolve) => {
      release = resolve;
    });

    const firstPageOf = (project: string | null) =>
      json(200, {
        agents: [
          {
            ...AGENT,
            projectId: String(project),
            id: `agt_${String(project)}`,
            name: project === "prj_1" ? "Front desk" : "Night line",
          },
        ],
        nextPageToken: "agt_cursor",
      });

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: FetchInput, init?: RequestInit) => {
        const { address: at } = await observeRequest(input, init);
        if (at.pathname === "/api/me") return json(200, meWith("admin"));
        if (at.searchParams.has("pageToken")) return pending;
        return firstPageOf(at.searchParams.get("projectId"));
      }),
    );

    const { rerender } = render(<AgentsPage />);
    expect(await screen.findAllByText("Front desk")).not.toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "Show more" }));

    // Somebody chooses another project while that read is still in flight.
    // The page is not remounted — it is the same route with another project in
    // it, which is exactly why its own state can outlive the change.
    routed.projectId = "prj_2";
    routed.pathname = "/projects/prj_2/agents";
    rerender(<AgentsPage />);
    expect(await screen.findAllByText("Night line")).not.toHaveLength(0);

    // The first project's next page finally arrives.
    release(
      json(200, {
        agents: [{ ...AGENT, id: "agt_stale", name: "Somebody else's project" }],
        nextPageToken: null,
      }),
    );
    await new Promise((settle) => setTimeout(settle, 0));

    expect(screen.queryByText("Somebody else's project")).toBeNull();
    expect(screen.queryAllByText("Front desk")).toHaveLength(0);
    expect(screen.getAllByText("Night line").length).toBeGreaterThan(0);
  });

  it("offers a member the way to connect an agent, and a viewer the same control disabled", async () => {
    apiAnswers({
      "/api/me": { status: 200, body: meWith("member") },
      "/v1/agents": {
        status: 200,
        body: { agents: [AGENT], nextPageToken: null },
      },
    });
    const { unmount } = render(<AgentsPage />);
    expect(await screen.findByRole("link", { name: "Connect an agent" })).toBeDefined();
    unmount();

    apiAnswers({
      "/api/me": { status: 200, body: meWith("viewer") },
      "/v1/agents": {
        status: 200,
        body: { agents: [AGENT], nextPageToken: null },
      },
    });
    render(<AgentsPage />);

    const refused = await screen.findByRole("button", { name: "Connect an agent" });
    expect((refused as HTMLButtonElement).disabled).toBe(true);
    expect(refused.getAttribute("title")).toContain("viewer role cannot");
    expect(screen.queryByRole("link", { name: "Connect an agent" })).toBeNull();
  });
});
