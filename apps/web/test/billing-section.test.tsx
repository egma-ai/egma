// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
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
  actions: {
    available: true,
    creditAmountsMicros: [10_000_000, 25_000_000, 50_000_000, 100_000_000],
    smallestCreditMicros: 5_000_000,
    largestCreditMicros: 1_000_000_000,
  },
};

const PRO = {
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
};

type Stubbed = { readonly status: number; readonly body: unknown };

/** What each billing action answered, and what the page asked for it. */
const asked: { path: string; body: unknown }[] = [];

function openWith(
  billing: Stubbed,
  role = "admin",
  actions: Record<string, Stubbed> = {},
): void {
  const answers: Record<string, Stubbed> = {
    "/api/me": { status: 200, body: meWith(role) },
    "/v1/organization": { status: 200, body: ORGANIZATION },
    "/api/organization/usage": { status: 200, body: USAGE },
    "/api/organization/billing": billing,
    ...actions,
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: FetchInput, init?: RequestInit) => {
      const request = await observeRequest(input, init);
      const answer = answers[request.path];
      if (answer === undefined) {
        throw new Error(`nothing stubbed for ${request.path}`);
      }
      if (init?.method === "POST") {
        asked.push({
          path: request.path,
          body:
            typeof init.body === "string"
              ? (JSON.parse(init.body) as unknown)
              : null,
        });
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
  asked.length = 0;
  vi.stubGlobal("scrollTo", vi.fn());
  // Following Stripe is a whole-page navigation, which jsdom cannot do and
  // does not need to: what matters here is that the page asked, and where it
  // was told to go.
  vi.stubGlobal("location", { assign: vi.fn(), href: "http://localhost/" });
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
    openWith({ status: 200, body: PRO });
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

describe("what an admin can do about the plan and the balance", () => {
  it("offers a member nothing to press", async () => {
    openWith(
      { status: 200, body: { ...HOBBY, mayManageBilling: false, charges: [] } },
      "member",
    );
    expect(await screen.findByText("Billing")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Buy credit" })).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Upgrade to Pro" }),
    ).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Manage payment and invoices" }),
    ).toBeNull();
  });

  it("offers nothing on a deployment whose Stripe is not in place", async () => {
    openWith({
      status: 200,
      body: { ...HOBBY, actions: { ...HOBBY.actions, available: false } },
    });
    expect(await screen.findByText("Billing")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Buy credit" })).toBeNull();
  });

  it("takes an admin to Stripe to move to Pro", async () => {
    openWith({ status: 200, body: HOBBY }, "admin", {
      "/api/billing/upgrade": {
        status: 200,
        body: { url: "https://checkout.stripe.test/upgrade" },
      },
    });
    fireEvent.click(await screen.findByRole("button", { name: "Upgrade to Pro" }));

    await waitFor(() => {
      expect(window.location.assign).toHaveBeenCalledWith(
        "https://checkout.stripe.test/upgrade",
      );
    });
  });

  it("buys one of the four amounts the deployment offers", async () => {
    openWith({ status: 200, body: HOBBY }, "admin", {
      "/api/billing/credit": {
        status: 200,
        body: { url: "https://checkout.stripe.test/credit" },
      },
    });
    fireEvent.click(await screen.findByRole("button", { name: "Buy credit" }));
    fireEvent.click(await screen.findByRole("button", { name: "$25.00" }));

    await waitFor(() => {
      expect(asked).toContainEqual({
        path: "/api/billing/credit",
        body: { amountMicros: 25_000_000 },
      });
    });
  });

  it("refuses an amount outside the bounds before it asks for one", async () => {
    openWith({ status: 200, body: HOBBY });
    fireEvent.click(await screen.findByRole("button", { name: "Buy credit" }));
    fireEvent.change(await screen.findByLabelText("Another amount [optional]"), {
      target: { value: "2" },
    });
    fireEvent.click(await screen.findByRole("button", { name: "Continue" }));

    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toContain("$5.00");
    expect(asked).toHaveLength(0);
  });

  it("confirms before it ends a paid plan, and names the date", async () => {
    openWith({ status: 200, body: PRO }, "admin", {
      "/api/billing/downgrade": {
        status: 200,
        body: { endsAt: "2026-10-15T08:00:00.000Z" },
      },
    });
    fireEvent.click(
      await screen.findByRole("button", { name: "Downgrade at period end" }),
    );

    // Nothing is asked of the API until the confirmation is answered.
    expect(await screen.findByRole("dialog")).toBeTruthy();
    expect(asked).toHaveLength(0);
    const confirm = await screen.findByRole("button", {
      name: "Stop Pro on Oct 15, 2026",
    });
    expect(confirm.className).toContain("destructive");

    fireEvent.click(confirm);

    const said = await screen.findByRole("status");
    expect(said.textContent).toContain("Pro stops on");
    expect(said.textContent).toContain("stays available until then");
    expect(asked).toContainEqual({ path: "/api/billing/downgrade", body: {} });
  });

  it("keeps the plan when the confirmation is turned down", async () => {
    openWith({ status: 200, body: PRO });
    fireEvent.click(
      await screen.findByRole("button", { name: "Downgrade at period end" }),
    );
    fireEvent.click(await screen.findByRole("button", { name: "Keep Pro" }));

    expect(asked).toHaveLength(0);
  });

  it("offers no upgrade to an organization already on Pro", async () => {
    openWith({ status: 200, body: PRO });
    expect(await screen.findByText("Billing")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Upgrade to Pro" })).toBeNull();
  });

  it("keeps a refusal's own sentence", async () => {
    openWith({ status: 200, body: HOBBY }, "admin", {
      "/api/billing/portal": {
        status: 422,
        body: {
          error: "unprocessable",
          message:
            "This organization has never paid Egma anything, so it has no " +
            "card and no invoices yet.",
        },
      },
    });
    fireEvent.click(await screen.findByRole("button", {
        name: "Manage payment and invoices",
      }));

    const said = await screen.findByRole("status");
    expect(said.textContent).toContain("never paid Egma anything");
  });
});
