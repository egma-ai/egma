// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import OrganizationSettingsPage from "../app/projects/[projectId]/settings/organization/page.tsx";
import type { Me } from "../lib/me.ts";
import { observeRequest, type FetchInput } from "./platform-request.ts";

/**
 * What the organization settings page says about the plan and the balance.
 *
 * **It is drawn only where there is something to draw.** A self-hosted Egma
 * mounts no Billing routes, so the read answers "not here" and the section is
 * absent — not an empty panel implying there is a plan to see. That is the
 * first thing asserted, because it is the deployment almost everybody runs.
 *
 * **Every role reads the plan and the balance; only an admin reads where the
 * money went.** A run that paused for money has to explain itself to whoever
 * started it.
 */

const routed = vi.hoisted(() => ({
  router: { push: vi.fn(), replace: vi.fn(), back: vi.fn() },
  pathname: "/projects/prj_1/settings/organization",
}));

vi.mock("next/navigation", () => ({
  usePathname: () => routed.pathname,
  useRouter: () => routed.router,
  useParams: () => ({ projectId: "prj_1" }),
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

const ORGANIZATION = {
  id: "org_1",
  name: "Acme",
  slug: "acme",
  createdAt: "2026-01-15T08:00:00.000Z",
  mayManageOrganization: true,
};

const USAGE = {
  periodStartedAt: "2026-09-15T08:00:00.000Z",
  resetsAt: "2026-10-15T08:00:00.000Z",
  allowances: [
    { kind: "chat_simulations", unit: "simulations", used: 128 },
    { kind: "web_call_minutes", unit: "minutes", used: 41.5 },
    { kind: "phone_minutes", unit: "minutes", used: 3 },
  ],
};

const HOBBY = {
  plan: {
    code: "hobby",
    name: "Hobby",
    feeMicros: 0,
    allowances: [
      { kind: "chat_simulations", unit: "simulations", allowed: 500 },
      { kind: "web_call_minutes", unit: "minutes", allowed: 500 },
      { kind: "phone_minutes", unit: "minutes", allowed: 500 },
    ],
  },
  balanceMicros: 4_250_000,
  periodStartedAt: "2026-09-15T08:00:00.000Z",
  resetsAt: "2026-10-15T08:00:00.000Z",
  mayManageBilling: true,
  charges: [
    {
      provider: "openai",
      model: "gpt-4o-mini",
      requests: 312,
      amountMicros: 640_000,
    },
  ],
};

type Stubbed = { readonly status: number; readonly body: unknown };

function openWith(billing: Stubbed, role = "admin"): void {
  const answers: Record<string, Stubbed> = {
    "/api/me": { status: 200, body: meWith(role) },
    "/v1/organization": { status: 200, body: ORGANIZATION },
    "/api/organization/usage": { status: 200, body: USAGE },
    "/api/organization/billing": billing,
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: FetchInput, init?: RequestInit) => {
      const request = await observeRequest(input, init);
      const answer = answers[request.path];
      if (answer === undefined) {
        throw new Error(`nothing stubbed for ${request.path}`);
      }
      return new Response(JSON.stringify(answer.body), {
        status: answer.status,
        headers: { "content-type": "application/json" },
      });
    }),
  );
  render(<OrganizationSettingsPage />);
}

beforeEach(() => {
  vi.stubGlobal("scrollTo", vi.fn());
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("what the organization page says about billing", () => {
  it("says nothing at all on a deployment that does not bill", async () => {
    openWith({
      status: 404,
      body: { error: "not_found", message: "Not Found" },
    });
    // The month is still there, because counting one is the product.
    expect(await screen.findByText("Usage this period")).toBeTruthy();
    expect(screen.queryByText("Billing")).toBeNull();
  });

  it("names the plan, what it includes and the balance", async () => {
    openWith({ status: 200, body: HOBBY });

    expect(await screen.findByText("Billing")).toBeTruthy();
    expect(screen.getByText("Hobby")).toBeTruthy();
    // Hobby charges nothing, and the word says so rather than "$0.00 a month".
    expect(screen.getByText("Free")).toBeTruthy();
    expect(screen.getByText("$4.25")).toBeTruthy();
    expect(screen.getByText("Chat simulations included")).toBeTruthy();
    expect(screen.getAllByText("500 simulations").length).toBeGreaterThan(0);
    expect(screen.getAllByText("500 minutes")).toHaveLength(2);
  });

  it("shows an admin what the balance paid for, by provider and model", async () => {
    openWith({ status: 200, body: HOBBY });
    expect(await screen.findByText("openai/gpt-4o-mini")).toBeTruthy();
    expect(screen.getByText("$0.64")).toBeTruthy();
  });

  it("shows a member the plan and the balance, and no breakdown", async () => {
    openWith(
      {
        status: 200,
        body: { ...HOBBY, mayManageBilling: false, charges: [] },
      },
      "member",
    );
    expect(await screen.findByText("Billing")).toBeTruthy();
    expect(screen.getByText("$4.25")).toBeTruthy();
    expect(screen.queryByText("openai/gpt-4o-mini")).toBeNull();
  });

  it("writes an unlimited allowance as a word, never as a zero", async () => {
    openWith({
      status: 200,
      body: {
        ...HOBBY,
        plan: {
          code: "pro",
          name: "Pro",
          feeMicros: 50_000_000,
          allowances: [
            { kind: "chat_simulations", unit: "simulations", allowed: null },
            { kind: "web_call_minutes", unit: "minutes", allowed: 5_000 },
            { kind: "phone_minutes", unit: "minutes", allowed: 2_000 },
          ],
        },
      },
    });
    expect(await screen.findByText("Pro")).toBeTruthy();
    expect(screen.getByText("$50.00 a month")).toBeTruthy();
    expect(screen.getByText("Unlimited")).toBeTruthy();
    expect(screen.getByText("5,000 minutes")).toBeTruthy();
  });

  it("writes a balance below zero with its sign", async () => {
    // Work already claimed finishes and is charged, so a busy hour can end
    // below zero. A person has to see at once that they owe rather than hold.
    openWith({ status: 200, body: { ...HOBBY, balanceMicros: -1_500_000 } });
    expect(await screen.findByText("-$1.50")).toBeTruthy();
  });

  it("says what happened when the read is refused", async () => {
    openWith({
      status: 500,
      body: {
        error: "unavailable",
        message: "Egma could not read this organization's billing account.",
      },
    });
    expect(
      await screen.findByText(
        "Egma could not read this organization's billing account.",
      ),
    ).toBeTruthy();
    // One quiet line, and the rest of the page is unaffected.
    expect(await screen.findByDisplayValue("Acme")).toBeTruthy();
  });
});
