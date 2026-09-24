// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import InvitePage from "../app/invite/page.tsx";
import SignInPage from "../app/sign-in/page.tsx";
import SignUpPage from "../app/signup/page.tsx";

/**
 * The entrance redirects, so the only thing it needs from the router is that.
 * One object for the whole run, because that is what Next hands back and
 * because the entrance's effect names the router among its dependencies.
 */
const routed = vi.hoisted(() => {
  const replace = vi.fn();
  return { replace, router: { replace } };
});

vi.mock("next/navigation", () => ({
  useRouter: () => routed.router,
  usePathname: () => "/",
}));

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  routed.replace.mockClear();
  window.history.replaceState({}, "", "/");
});

describe("the shared controls on access pages", () => {
  it("keeps credentials out of the URL before the sign-in page hydrates", () => {
    const page = document.createElement("div");
    page.innerHTML = renderToStaticMarkup(<SignInPage />);

    const password = page.querySelector<HTMLInputElement>('input[name="password"]');
    expect(password?.form?.method).toBe("post");
  });

  /**
   * Where the instance posts mail, the provider deliberately opens no session
   * until the address is confirmed. The page used to walk straight on into the
   * product, which turned everybody around at the sign-in door with nothing
   * anywhere saying a message was waiting for them.
   */
  it("sends somebody to their inbox when the address has to be confirmed first", async () => {
    const assign = vi.fn();
    vi.stubGlobal("location", { assign, search: "", href: "" });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: unknown) =>
        String(input) === "/api/signup"
          ? json(201, { emailVerificationRequired: true })
          : json(200, { open: true }),
      ),
    );
    render(<SignUpPage />);

    fireEvent.change(await screen.findByLabelText("Email"), {
      target: { value: "ada@acme.example" },
    });
    fireEvent.change(screen.getByLabelText("Password"), {
      target: { value: "correct horse" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Create my Egma instance" }),
    );

    expect(
      await screen.findByRole("heading", { name: "Check your inbox" }),
    ).toBeTruthy();
    // Which inbox, because that is the one thing somebody has to know.
    expect(screen.getByText("ada@acme.example").tagName).toBe("STRONG");
    expect(screen.getByRole("link", { name: "Sign in" })).toBeTruthy();
    // And nobody was sent into a product their session cannot open yet.
    expect(assign).not.toHaveBeenCalled();
  });

  /**
   * An invitation can only be delivered by an instance that posts mail, and
   * that is precisely the instance where the provider requires the address to
   * be confirmed and issues no session for a new identity. So the invited
   * colleague is the likeliest person in the product to meet this, and the one
   * this page used to walk into a product they could not open.
   */
  it("sends an invited colleague to their inbox when the address has to be confirmed first", async () => {
    window.history.replaceState({}, "", "/invite?token=inv_1");
    const assign = vi.fn();
    vi.stubGlobal("location", {
      assign,
      search: "?token=inv_1",
      href: "http://egma.test/invite?token=inv_1",
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const path = new URL(String(input), "http://egma.test").pathname;
        if (path === "/api/invitations/lookup") {
          return json(200, {
            state: "pending",
            email: "ada@example.com",
            role: "member",
            organization: { name: "Acme" },
          });
        }
        if (path === "/api/me") return json(401, {});
        if (path === "/api/signup") {
          return json(201, { emailVerificationRequired: true });
        }
        throw new Error(`nothing stubbed for ${path}`);
      }),
    );

    render(<InvitePage />);

    fireEvent.change(await screen.findByLabelText("Choose a password"), {
      target: { value: "correct horse" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Join Acme" }));

    expect(
      await screen.findByRole("heading", { name: "Check your inbox" }),
    ).toBeTruthy();
    // The invitation's own address, which is the one the link went to.
    expect(screen.getByText("ada@example.com").tagName).toBe("STRONG");
    expect(screen.getByRole("link", { name: "Sign in" })).toBeTruthy();
    expect(assign).not.toHaveBeenCalled();
  });
});
