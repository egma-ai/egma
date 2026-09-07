// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import OrganizationSettingsPage from "../app/projects/[projectId]/settings/organization/page.tsx";
import type { Me } from "../lib/me.ts";
import { observeRequest, type FetchInput } from "./platform-request.ts";

/**
 * What the organization settings page says about the month.
 *
 * **On every deployment, and against no limit.** Nothing here is a plan: the
 * three numbers are what this organization has run since the period began, and
 * a self-hoster reads exactly the same ones. So what is asserted is that they
 * are shown with their units and their reset date, to every role, and that a
 * page with nothing to show says so rather than going quiet.
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

type Stubbed = { readonly status: number; readonly body: unknown };

function apiAnswers(answers: Record<string, Stubbed>): void {
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
}

function openWith(usage: Stubbed, role = "admin"): void {
  apiAnswers({
    "/api/me": { status: 200, body: meWith(role) },
    "/v1/organization": { status: 200, body: ORGANIZATION },
    "/api/organization/usage": usage,
    // The deployment this file is about does not bill, so the Billing routes
    // are not mounted and the section beside the month is not drawn at all.
    "/api/organization/billing": {
      status: 404,
      body: { error: "not_found", message: "Not Found" },
    },
  });
  render(<OrganizationSettingsPage />);
}

const USED = {
  periodStartedAt: "2026-09-15T08:00:00.000Z",
  resetsAt: "2026-10-15T08:00:00.000Z",
  allowances: [
    { kind: "chat_simulations", unit: "simulations", used: 128 },
    { kind: "web_call_minutes", unit: "minutes", used: 41.5 },
    { kind: "phone_minutes", unit: "minutes", used: 3 },
  ],
};

beforeEach(() => {
  vi.stubGlobal("scrollTo", vi.fn());
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("what the organization page says about the month", () => {
  it("shows the three allowances in their own units", async () => {
    openWith({ status: 200, body: USED });

    expect(await screen.findByText("Usage this period")).toBeTruthy();
    expect(await screen.findByText("Chat simulations")).toBeTruthy();
    expect(screen.getByText("128 simulations")).toBeTruthy();
    // Minutes are summed from seconds, so a decimal place is kept: a month of
    // short conversations that rounded to zero would read as a month nobody
    // used.
    expect(screen.getByText("Web-call minutes")).toBeTruthy();
    expect(screen.getByText("41.5 minutes")).toBeTruthy();
    expect(screen.getByText("Phone minutes")).toBeTruthy();
    expect(screen.getByText("3.0 minutes")).toBeTruthy();
  });

  it("says when the period began and when it resets, as dates", async () => {
    openWith({ status: 200, body: USED });
    // Absolute short dates, never an age: a reset is a date somebody plans
    // around, and "in 12 days" cannot be put in a calendar.
    expect(
      await screen.findByText("Sep 15, 2026 — resets Oct 15, 2026"),
    ).toBeTruthy();
  });

  it("shows a month nobody has run in as three zeroes", async () => {
    openWith({
      status: 200,
      body: {
        ...USED,
        allowances: USED.allowances.map((one) => ({ ...one, used: 0 })),
      },
    });
    expect(await screen.findByText("0 simulations")).toBeTruthy();
    // Two of them, both minutes, so the query has to allow more than one.
    await waitFor(() => {
      expect(screen.getAllByText("0.0 minutes")).toHaveLength(2);
    });
  });

  it("shows it to a viewer, who can change nothing else on the page", async () => {
    openWith(
      { status: 200, body: USED },
      "viewer",
    );
    expect(await screen.findByText("128 simulations")).toBeTruthy();
    // The refusal a read-only role meets is on the button, never on the number.
    const save = await screen.findByRole("button", {
      name: "Save organization",
    });
    expect(save.hasAttribute("disabled")).toBe(true);
  });

  it("says what happened when the read is refused", async () => {
    openWith({
      status: 403,
      body: {
        error: "not_permitted",
        message: "Your viewer role cannot read this organization's usage.",
      },
    });
    expect(
      await screen.findByText(
        "Your viewer role cannot read this organization's usage.",
      ),
    ).toBeTruthy();
    // And the rest of the page is unaffected: one quiet line, not a takeover.
    expect(await screen.findByDisplayValue("Acme")).toBeTruthy();
  });

  it("names an allowance a newer Egma sent that these pages do not know", async () => {
    // A blank row is a bug report; a readable one is something somebody can
    // act on.
    openWith({
      status: 200,
      body: {
        ...USED,
        allowances: [{ kind: "sms_messages", unit: "messages", used: 7 }],
      },
    });
    expect(await screen.findByText("sms messages")).toBeTruthy();
    expect(screen.getByText("7 messages")).toBeTruthy();
  });
});
