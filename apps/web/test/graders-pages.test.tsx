// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import GradersPage from "../app/projects/[projectId]/graders/page.tsx";
import type { ProjectGrader } from "../lib/graders.ts";
import type { Me } from "../lib/me.ts";
import { observeRequest, type FetchInput } from "./platform-request.ts";

const routed = vi.hoisted(() => ({
  pathname: "/projects/prj_1/graders",
  projectId: "prj_1",
}));

vi.mock("next/navigation", () => ({
  usePathname: () => routed.pathname,
  useParams: () => ({ projectId: routed.projectId }),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
}));

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: unknown }) => (
    <a href={href} {...rest}>
      {children as never}
    </a>
  ),
}));

vi.mock("next/image", () => ({
  default: ({ alt }: { alt: string }) => <img alt={alt} />,
}));

function meWith(role: string): Me {
  return {
    user: { id: "usr_1", email: "ada@acme.example" },
    organizations: [{ id: "org_1", name: "Acme", slug: "acme", role }],
    projects: [{ id: "prj_1", name: "Default", slug: "default" }],
  };
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

type Stubbed = { readonly status: number; readonly body: unknown };

function apiAnswers(answers: Record<string, Stubbed | Stubbed[]>): {
  readonly asked: { readonly method: string; readonly path: string; readonly body: unknown }[];
} {
  const turns: Record<string, number> = {};
  const asked: { method: string; path: string; body: unknown }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: FetchInput, init?: RequestInit) => {
      const request = await observeRequest(input, init);
      const key = `${request.method} ${request.address.pathname}`;
      asked.push({
        method: request.method,
        path: `${request.address.pathname}${request.address.search}`,
        body: request.body,
      });
      const held = answers[key];
      if (held === undefined) throw new Error(`nothing stubbed for ${key}`);
      const at = turns[key] ?? 0;
      turns[key] = at + 1;
      const answer = Array.isArray(held)
        ? (held[Math.min(at, held.length - 1)] as Stubbed)
        : held;
      return json(answer.status, answer.body);
    }),
  );
  return { asked };
}

const EXPECTED: ProjectGrader = {
  id: "grd_1",
  projectId: "prj_1",
  graderDefinitionId: "grl_expected",
  name: "expected_behaviors",
  description: "Grades a completed simulation against its expected behaviors.",
  scopeEditable: false,
  scope: { simulations: [{ kind: "all" }], production: null },
  passThreshold: 1,
  createdAt: "2026-08-15T10:00:00.000Z",
  updatedAt: "2026-08-15T10:00:00.000Z",
};

beforeEach(() => {
  routed.pathname = "/projects/prj_1/graders";
  routed.projectId = "prj_1";
  vi.stubGlobal("scrollTo", vi.fn());
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("the project Graders surface", () => {
  it("shows the fixed Expected behaviors policy in plain language", async () => {
    const { asked } = apiAnswers({
      "GET /api/me": { status: 200, body: meWith("admin") },
      "GET /v1/graders": {
        status: 200,
        body: { graders: [EXPECTED], nextPageToken: null },
      },
    });

    render(<GradersPage />);

    expect(await screen.findByText("Expected behaviors")).toBeTruthy();
    expect(screen.getByText("Grades all simulations")).toBeTruthy();
    expect(screen.getByText("Production off")).toBeTruthy();
    expect(screen.getByText("1.00")).toBeTruthy();
    expect(asked.map((one) => one.path)).toContain(
      "/v1/graders?projectId=prj_1",
    );
    expect(asked.some((one) => one.path.startsWith("/v1/grader-library"))).toBe(
      false,
    );

    for (const removed of ["Use", "Remove", "Latency", "Required", "Gate"]) {
      expect(screen.queryByText(removed)).toBeNull();
    }
  });

  it("changes only the pass threshold", async () => {
    const changed = { ...EXPECTED, passThreshold: 0.75 };
    const { asked } = apiAnswers({
      "GET /api/me": { status: 200, body: meWith("admin") },
      "GET /v1/graders": [
        { status: 200, body: { graders: [EXPECTED], nextPageToken: null } },
        { status: 200, body: { graders: [changed], nextPageToken: null } },
      ],
      "PATCH /v1/graders/grd_1": { status: 200, body: changed },
    });

    render(<GradersPage />);
    fireEvent.click(
      await screen.findByRole("button", { name: "Edit threshold" }),
    );
    fireEvent.change(screen.getByLabelText("Pass threshold"), {
      target: { value: "0.75" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save threshold" }));

    await waitFor(() => {
      expect(screen.getByRole("status").textContent).toContain(
        "Pass threshold saved",
      );
    });
    const write = asked.find((one) => one.method === "PATCH");
    expect(write).toEqual({
      method: "PATCH",
      path: "/v1/graders/grd_1?projectId=prj_1",
      body: { passThreshold: 0.75 },
    });
  });

  it("lets viewers read the policy but not edit it", async () => {
    apiAnswers({
      "GET /api/me": { status: 200, body: meWith("viewer") },
      "GET /v1/graders": {
        status: 200,
        body: { graders: [EXPECTED], nextPageToken: null },
      },
    });

    render(<GradersPage />);

    const edit = await screen.findByRole("button", { name: "Edit threshold" });
    expect((edit as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("Grades all simulations")).toBeTruthy();
  });

  it("has one project grader surface with no Library tab", async () => {
    apiAnswers({
      "GET /api/me": { status: 200, body: meWith("admin") },
      "GET /v1/graders": {
        status: 200,
        body: { graders: [EXPECTED], nextPageToken: null },
      },
    });

    render(<GradersPage />);

    expect(await screen.findByText("Expected behaviors")).toBeTruthy();
    expect(screen.queryByText("Library")).toBeNull();
  });
});
