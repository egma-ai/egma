// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import ModelProvidersPage from "../app/projects/[projectId]/settings/model-providers/page.tsx";
import type { Me } from "../lib/me.ts";

/**
 * Model providers, in the three shapes a deployment can put it in.
 *
 * **Hosted managed access is a state to read; self-hosted managed access is a
 * key to connect.** The two are different screens behind one word, and a page
 * that guessed which one it was on would draw a Connect form on a deployment
 * with nothing to connect. So the deployment says which it is, and this reads
 * back what a person actually sees in each.
 *
 * Nothing here asserts that a component exists or that a source file contains a
 * string: the API's real answers go in front of the real page, and the DOM is
 * what is read.
 */

vi.mock("next/navigation", () => ({
  usePathname: () => "/projects/prj_1/settings/model-providers",
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
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

const ME: Me = {
  user: { id: "usr_1", email: "ada@acme.example" },
  organizations: [{ id: "org_1", name: "Acme", slug: "acme", role: "admin" }],
  projects: [{ id: "prj_1", name: "Default", slug: "default" }],
};

const CATALOG = {
  jobs: ["llm", "stt", "tts"],
  providers: [
    {
      provider: "openai",
      job: "llm",
      label: "OpenAI",
      recommended_model: "gpt-4o-mini",
      recommended: true,
      model_is_free_text: true,
    },
  ],
  reserved: [],
};

function accessAnswer(
  over: Partial<{
    mode: string;
    hosted: boolean;
    managed_available: boolean;
    managed: Record<string, unknown>;
  }>,
): Record<string, unknown> {
  return {
    mode: "customer-owned",
    updated_at: null,
    modes: ["managed", "customer-owned"],
    managed_available: false,
    hosted: false,
    managed: {
      connected: false,
      hint: null,
      cloud_organization_id: null,
      connected_at: null,
    },
    credentials: [],
    ...over,
  };
}

function apiAnswers(answers: Record<string, unknown>): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string) => {
      const url = new URL(input, "http://egma.test");
      const held = answers[url.pathname];
      if (held === undefined) throw new Error(`nothing stubbed for ${url.pathname}`);
      return new Response(JSON.stringify(held), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }),
  );
}

beforeEach(() => {
  Object.defineProperty(window, "location", {
    configurable: true,
    value: { ...window.location, replace: vi.fn(), assign: vi.fn() },
  });
  vi.stubGlobal("scrollTo", vi.fn());
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function open(access: Record<string, unknown>): Promise<void> {
  apiAnswers({
    "/api/me": ME,
    "/api/projects": { projects: ME.projects },
    "/api/model-access": access,
    "/api/model-catalog": CATALOG,
  });
  render(<ModelProvidersPage />);
  await waitFor(() => expect(screen.getByText("Model access")).toBeDefined());
}

describe("hosted Egma", () => {
  it("says managed access is Available, with nothing to paste and nothing to disconnect", async () => {
    await open(
      accessAnswer({ mode: "managed", hosted: true, managed_available: true }),
    );

    expect(screen.getByText("Available")).toBeDefined();
    // There is no key to connect, so no form and no destructive action exist
    // to be found — which is the shape rather than a rule anybody follows.
    expect(screen.queryByRole("button", { name: "Connect Egma" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Disconnect" })).toBeNull();
    expect(document.querySelectorAll('input[type="password"]')).toHaveLength(0);
  });
});

describe("a self-hosted deployment with nothing connected", () => {
  it("offers Connect Egma, and says why managed access cannot be chosen yet", async () => {
    await open(accessAnswer({}));

    expect(screen.getByText("Not connected")).toBeDefined();
    expect(screen.getByRole("button", { name: "Connect Egma" })).toBeDefined();
    expect(screen.queryByRole("button", { name: "Disconnect" })).toBeNull();
    expect(
      screen.getByText(/connected no inference key for it/),
    ).toBeDefined();
    // The choice is still drawn, because refusing to show a mode is not the
    // same as explaining it — and the sentence above is the explanation.
    expect(screen.getByRole("radio", { name: "Managed by Egma" })).toBeDefined();
  });

  it("opens exactly one masked field, and the key is never a value on screen", async () => {
    await open(accessAnswer({}));

    expect(document.querySelectorAll('input[type="password"]')).toHaveLength(0);
    screen.getByRole("button", { name: "Connect Egma" }).click();

    await waitFor(() =>
      expect(document.querySelectorAll('input[type="password"]')).toHaveLength(1),
    );
    const field = document.querySelector<HTMLInputElement>("#managed-access-key");
    expect(field?.type).toBe("password");
    expect(field?.value).toBe("");
  });
});

describe("a self-hosted deployment with a key connected", () => {
  it("shows Connected and a safe hint, and offers Replace and Disconnect", async () => {
    await open(
      accessAnswer({
        mode: "managed",
        managed_available: true,
        managed: {
          connected: true,
          hint: "A1B2",
          cloud_organization_id: "org_cloud_1",
          connected_at: "2026-08-17T10:00:00.000Z",
        },
      }),
    );

    expect(screen.getByText("Connected")).toBeDefined();
    expect(screen.getByText("…A1B2")).toBeDefined();
    expect(screen.getByRole("button", { name: "Replace key" })).toBeDefined();
    expect(screen.getByRole("button", { name: "Disconnect" })).toBeDefined();
    // Managed access is chosen, so the provider rows are not the story here.
    expect(screen.queryByLabelText("Model providers")).toBeNull();
  });

  it("names the key in the disconnect dialog, because a destructive one must", async () => {
    await open(
      accessAnswer({
        mode: "managed",
        managed_available: true,
        managed: {
          connected: true,
          hint: "A1B2",
          cloud_organization_id: "org_cloud_1",
          connected_at: "2026-08-17T10:00:00.000Z",
        },
      }),
    );

    screen.getByRole("button", { name: "Disconnect" }).click();

    const dialog = await waitFor(() => screen.getByRole("dialog"));
    // The safe hint is the only part of a connected key anybody can see, and
    // it is exactly enough to tell an administrator holding two which one this
    // is about.
    expect(within(dialog).getAllByText(/A1B2/).length).toBeGreaterThan(0);
    // And it says what stops, rather than only what is removed.
    expect(within(dialog).getByText(/stops with an error/)).toBeDefined();
  });
});
