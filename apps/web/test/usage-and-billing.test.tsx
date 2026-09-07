// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import UsageAndBillingPage from "../app/projects/[projectId]/settings/billing/page.tsx";
import OrganizationSettingsPage from "../app/projects/[projectId]/settings/organization/page.tsx";
import { HOBBY, PRO, USAGE, memberSession } from "./usage-billing-fixtures.ts";
import { observeRequest, type FetchInput } from "./platform-request.ts";
import type { BillingAccount } from "../lib/billing.ts";

const routed = vi.hoisted(() => ({
  pathname: "/projects/prj_1/settings/billing",
  search: "",
  router: { push: vi.fn(), replace: vi.fn(), back: vi.fn() },
}));
vi.mock("next/navigation", () => ({
  usePathname: () => routed.pathname,
  useRouter: () => routed.router,
  useParams: () => ({ projectId: "prj_1" }),
  useSearchParams: () => new URLSearchParams(routed.search),
}));
vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    ...rest
  }: {
    href: string;
    children: unknown;
  }) => (
    <a href={href} {...rest}>
      {children as never}
    </a>
  ),
}));
vi.mock("next/image", () => ({
  default: ({ alt }: { alt: string }) => <img alt={alt} />,
}));
type ResponseFact = { status: number; body: unknown };
const requests: Awaited<ReturnType<typeof observeRequest>>[] = [];
const responses: Record<string, ResponseFact | (() => Promise<ResponseFact>)> =
  {};
function setup(account: BillingAccount | null = HOBBY, role = "admin") {
  Object.assign(responses, {
    "/api/me": { status: 200, body: memberSession(role) },
    "/api/organization/billing":
      account === null
        ? { status: 404, body: { error: "not_found", message: "Not found" } }
        : { status: 200, body: account },
    "/api/organization/usage": { status: 200, body: USAGE },
    "/v1/organization": {
      status: 200,
      body: {
        id: "org_1",
        name: "Acme",
        slug: "acme",
        mayManageOrganization: true,
      },
    },
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: FetchInput, init?: RequestInit) => {
      const request = await observeRequest(input, init);
      requests.push(request);
      const supplied = responses[request.path];
      if (supplied === undefined)
        throw new Error(`Unexpected request: ${request.path}`);
      const fact = typeof supplied === "function" ? await supplied() : supplied;
      return new Response(JSON.stringify(fact.body), {
        status: fact.status,
        headers: { "content-type": "application/json" },
      });
    }),
  );
}
function open(account: BillingAccount | null = HOBBY, role = "admin") {
  setup(account, role);
  render(<UsageAndBillingPage />);
}
beforeEach(() => {
  requests.length = 0;
  for (const key of Object.keys(responses)) delete responses[key];
  routed.search = "";
  vi.stubGlobal("scrollTo", vi.fn());
  vi.stubGlobal("location", { assign: vi.fn(), href: "http://localhost/" });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("puts all billing facts on the named settings page and uses the activation bounds", async () => {
  open();
  expect(
    await screen.findByRole("heading", { level: 1, name: "Usage and billing" }),
  ).toBeTruthy();
  expect(await screen.findByText("$4.25")).toBeTruthy();
  expect(await screen.findByText("openai/gpt-4o-mini")).toBeTruthy();
  expect(screen.getByText("Welcome credit")).toBeTruthy();
  expect(screen.getByText("Inference charge")).toBeTruthy();
  expect(screen.getByText("+$5.00")).toBeTruthy();
  expect(screen.getByText("-$0.75")).toBeTruthy();
  expect(screen.getByText("$0.00024")).toBeTruthy();
  const usage = requests.find(
    (request) => request.path === "/api/organization/usage",
  );
  expect(usage?.address.searchParams.get("from")).toBe(HOBBY.usageStartedAt);
  expect(usage?.address.searchParams.get("to")).toBe(HOBBY.resetsAt);
  const nav = screen.getByRole("navigation", { name: "Settings" });
  expect(
    within(nav)
      .getByRole("link", { name: "Usage and billing" })
      .getAttribute("aria-current"),
  ).toBe("page");
});
it("lets members read provider costs and all history without payment actions", async () => {
  open({ ...HOBBY, mayManageBilling: false }, "member");
  expect(await screen.findByText("openai/gpt-4o-mini")).toBeTruthy();
  expect(screen.getByText("Welcome credit")).toBeTruthy();
  expect(screen.getByText("$4.25")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Buy credit" })).toBeNull();
});
it("shows OSS usage without a pretend plan or balance", async () => {
  open(null);
  expect(
    await screen.findByText("Billing is not enabled on this deployment."),
  ).toBeTruthy();
  expect(await screen.findByText("128 simulations")).toBeTruthy();
  expect(screen.getByText("41.5 minutes")).toBeTruthy();
  expect(screen.getByText("openai/gpt-4o-mini")).toBeTruthy();
  expect(screen.queryByText("Inference balance")).toBeNull();
  expect(
    requests.find((request) => request.path === "/api/organization/usage")
      ?.address.search,
  ).toBe("");
});
it("shows Pro included minutes and its phone/web overage prices", async () => {
  open(PRO);
  expect(await screen.findByText("Unlimited")).toBeTruthy();
  expect(screen.getByText("5,000 minutes")).toBeTruthy();
  expect(screen.getByText("2,000 minutes")).toBeTruthy();
  expect(screen.getByText("$0.02/minute")).toBeTruthy();
  expect(screen.getByText("$0.01/minute")).toBeTruthy();
});
it("keeps loading and account failures distinct from zero or OSS", async () => {
  setup();
  let settle!: (fact: ResponseFact) => void;
  responses["/api/organization/billing"] = () =>
    new Promise((resolve) => {
      settle = resolve;
    });
  render(<UsageAndBillingPage />);
  expect(await screen.findByText("Loading usage and billing…")).toBeTruthy();
  expect(screen.queryByText("$0.00")).toBeNull();
  settle({
    status: 503,
    body: {
      error: "unavailable",
      message: "Billing is unavailable. Try again.",
    },
  });
  expect(
    await screen.findByText("Billing is unavailable. Try again."),
  ).toBeTruthy();
  expect(
    requests.some((request) => request.path === "/api/organization/usage"),
  ).toBe(false);
  responses["/api/organization/billing"] = { status: 200, body: HOBBY };
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  expect(await screen.findByText("$4.25")).toBeTruthy();
});
it("keeps a known balance visible when provider usage cannot be read", async () => {
  setup();
  responses["/api/organization/usage"] = {
    status: 503,
    body: {
      error: "unavailable",
      message: "Usage could not be read. Try again.",
    },
  };
  render(<UsageAndBillingPage />);
  expect(
    await screen.findByText("Usage could not be read. Try again."),
  ).toBeTruthy();
  expect(screen.getByText("$4.25")).toBeTruthy();
});
it("shows an empty provider period and an empty ledger explicitly", async () => {
  setup({ ...HOBBY, ledger: { entries: [], nextCursor: null } });
  responses["/api/organization/usage"] = {
    status: 200,
    body: {
      ...USAGE,
      inference: { amountMicros: 0, requests: 0, byModel: [] },
    },
  };
  render(<UsageAndBillingPage />);
  expect(await screen.findByText("No model usage this period")).toBeTruthy();
  expect(screen.getByText("No billing activity yet")).toBeTruthy();
});
it("loads another ledger page without losing history when a retry is needed", async () => {
  open({ ...HOBBY, ledger: { ...HOBBY.ledger, nextCursor: "older/+page" } });
  responses["/api/organization/billing/ledger"] = {
    status: 503,
    body: {
      error: "unavailable",
      message: "History is unavailable. Try again.",
    },
  };
  fireEvent.click(await screen.findByRole("button", { name: "Show more" }));
  expect(
    await screen.findByText("History is unavailable. Try again."),
  ).toBeTruthy();
  expect(screen.getByText("Welcome credit")).toBeTruthy();
  responses["/api/organization/billing/ledger"] = {
    status: 200,
    body: {
      entries: [
        {
          ...HOBBY.ledger.entries[0],
          id: "cle_purchase",
          kind: "purchased_credit",
          amountMicros: 25_000_000,
        },
      ],
      nextCursor: null,
    },
  };
  fireEvent.click(screen.getByRole("button", { name: "Show more" }));
  expect(await screen.findByText("Credit purchase")).toBeTruthy();
  expect(screen.getByText("Welcome credit")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Show more" })).toBeNull();
  expect(
    requests
      .find((request) => request.path.endsWith("/ledger"))
      ?.address.searchParams.get("cursor"),
  ).toBe("older/+page");
});
it("checks current history after a bought return without claiming a successful payment", async () => {
  routed.search = "credit=bought";
  open();
  expect(
    await screen.findByText(
      "Check billing history for your payment. If it has not appeared yet, refresh in a moment.",
    ),
  ).toBeTruthy();
  expect(screen.queryByText(/payment successful/i)).toBeNull();
  expect(screen.queryByText("Credit purchase")).toBeNull();
  responses["/api/organization/billing"] = {
    status: 200,
    body: {
      ...HOBBY,
      balanceMicros: 29_250_000,
      ledger: {
        entries: [
          ...HOBBY.ledger.entries,
          {
            ...HOBBY.ledger.entries[0],
            id: "cle_paid",
            kind: "purchased_credit",
            amountMicros: 25_000_000,
          },
        ],
        nextCursor: null,
      },
    },
  };
  fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
  expect(await screen.findByText("$29.25")).toBeTruthy();
  expect(screen.getByText("Credit purchase")).toBeTruthy();
});
it("does not upgrade the displayed plan merely from a return parameter", async () => {
  routed.search = "plan=pro";
  open();
  expect(
    await screen.findByText(
      "Pro is not active yet. Refresh after checkout finishes.",
    ),
  ).toBeTruthy();
  expect(screen.getByText("Hobby")).toBeTruthy();
});
it("says checkout closed on cancellation while showing actual account facts", async () => {
  routed.search = "credit=cancelled";
  open();
  expect(
    await screen.findByText(
      "Checkout closed. Your current billing details are shown below.",
    ),
  ).toBeTruthy();
  expect(screen.getByText("$4.25")).toBeTruthy();
});
it("buys a preset and preserves an action failure", async () => {
  open();
  responses["/api/billing/credit"] = {
    status: 503,
    body: {
      error: "unavailable",
      message: "Checkout could not open. Try again.",
    },
  };
  fireEvent.click(await screen.findByRole("button", { name: "Buy credit" }));
  fireEvent.click(screen.getByRole("button", { name: "$25.00" }));
  expect(
    await screen.findByText("Checkout could not open. Try again."),
  ).toBeTruthy();
  expect(
    requests.find((request) => request.path === "/api/billing/credit")?.body,
  ).toEqual({ amountMicros: 25_000_000 });
});
it("validates a custom amount before opening checkout", async () => {
  open();
  responses["/api/billing/credit"] = {
    status: 200,
    body: { url: "https://checkout.stripe.com/test" },
  };
  fireEvent.click(await screen.findByRole("button", { name: "Buy credit" }));
  const input = screen.getByLabelText("Another amount [optional]");
  fireEvent.change(input, { target: { value: "4.99" } });
  fireEvent.click(screen.getByRole("button", { name: "Continue" }));
  expect(screen.getByText("The smallest amount is $5.00.")).toBeTruthy();
  fireEvent.change(input, { target: { value: "40.50" } });
  fireEvent.click(screen.getByRole("button", { name: "Continue" }));
  await waitFor(() =>
    expect(
      requests.find((request) => request.path === "/api/billing/credit")?.body,
    ).toEqual({ amountMicros: 40_500_000 }),
  );
  expect(window.location.assign).toHaveBeenCalledWith(
    "https://checkout.stripe.com/test",
  );
});
it("blocks duplicate upgrade actions and refresh while their result is pending", async () => {
  open();
  let resolve!: (fact: ResponseFact) => void;
  responses["/api/billing/upgrade"] = () =>
    new Promise((done) => {
      resolve = done;
    });
  fireEvent.click(
    await screen.findByRole("button", { name: "Upgrade to Pro" }),
  );
  expect(
    await screen.findByRole("button", { name: "Opening Stripe…" }),
  ).toBeTruthy();
  expect(
    (screen.getByRole("button", { name: "Buy credit" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  expect(
    (screen.getByRole("button", { name: "Refresh" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  resolve({
    status: 503,
    body: { error: "failed", message: "Upgrade could not open. Try again." },
  });
  expect(
    await screen.findByText("Upgrade could not open. Try again."),
  ).toBeTruthy();
});
it("confirms a downgrade and reports its actual scheduled date", async () => {
  open(PRO);
  responses["/api/billing/downgrade"] = {
    status: 200,
    body: { endsAt: PRO.resetsAt },
  };
  fireEvent.click(
    await screen.findByRole("button", { name: "Downgrade at period end" }),
  );
  expect(
    requests.some((request) => request.path === "/api/billing/downgrade"),
  ).toBe(false);
  const dialog = screen.getByRole("dialog");
  fireEvent.click(
    within(dialog).getByRole("button", { name: "Stop Pro on Oct 15, 2026" }),
  );
  expect(await screen.findByText(/Pro stops on Oct 15, 2026/)).toBeTruthy();
});
it("opens the existing payment portal action", async () => {
  open(PRO);
  responses["/api/billing/portal"] = {
    status: 200,
    body: { url: "https://billing.stripe.com/test" },
  };
  fireEvent.click(
    await screen.findByRole("button", { name: "Manage payment and invoices" }),
  );
  await waitFor(() =>
    expect(window.location.assign).toHaveBeenCalledWith(
      "https://billing.stripe.com/test",
    ),
  );
});
it("keeps usage out of the organization name form", async () => {
  setup();
  routed.pathname = "/projects/prj_1/settings/organization";
  render(<OrganizationSettingsPage />);
  expect(await screen.findByLabelText("Name")).toBeTruthy();
  expect(
    requests.some((request) => request.path.startsWith("/api/organization/")),
  ).toBe(false);
  expect(screen.queryByText("Inference balance")).toBeNull();
  routed.pathname = "/projects/prj_1/settings/billing";
});

it("clears pending navigation when the browser returns to the page", async () => {
  open();
  responses["/api/billing/portal"] = {
    status: 200,
    body: { url: "https://billing.stripe.com/test" },
  };
  fireEvent.click(
    await screen.findByRole("button", { name: "Manage payment and invoices" }),
  );
  await waitFor(() => expect(window.location.assign).toHaveBeenCalled());
  fireEvent(window, new Event("pageshow"));
  expect(await screen.findByText("$4.25")).toBeTruthy();
  await waitFor(() =>
    expect(
      (screen.getByRole("button", { name: "Buy credit" }) as HTMLButtonElement)
        .disabled,
    ).toBe(false),
  );
  expect(
    requests.filter((request) => request.path === "/api/organization/billing"),
  ).toHaveLength(2);
});
it("keeps billing facts readable while payment actions are unavailable", async () => {
  open({ ...HOBBY, actions: { ...HOBBY.actions, available: false } });
  expect(
    await screen.findByText(
      "Payment actions are unavailable. Ask your administrator to check billing setup.",
    ),
  ).toBeTruthy();
  expect(screen.getByText("$4.25")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Buy credit" })).toBeNull();
});
