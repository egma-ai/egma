// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import ApproveDevicePage from "../app/device/approve/page.tsx";
import DeviceCodePage from "../app/device/page.tsx";
import ForgotPasswordPage from "../app/forgot-password/page.tsx";
import InvitePage from "../app/invite/page.tsx";
import RootPage from "../app/page.tsx";
import ResetPasswordPage from "../app/reset-password/page.tsx";
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

/**
 * One screen for every moment egma does not yet know who is here.
 *
 * The four moments were four different screens, and two of them were a guess:
 * opening the product drew the signed-in shell — sidebar, navigation, account
 * menu — over the sentence "Checking your session", and then replaced the whole
 * of it with the sign-in page. What these hold is that no page is chosen before
 * the answer arrives, and that the same component covers all four.
 */
describe("the screen egma shows while the session is unresolved", () => {
  function waiting(): HTMLElement {
    return screen.getByRole("status");
  }

  it("draws no product shell at the entrance while the session read is in flight", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json(401, {})));
    render(<RootPage />);

    expect(waiting().dataset.slot).toBe("session-loading");
    expect(waiting().textContent).toBe("Opening Egma");
    // The three things a signed-out person was being shown a moment ago.
    expect(screen.queryByText("Checking your session.")).toBeNull();
    expect(document.querySelector("aside")).toBeNull();
    expect(screen.queryByRole("navigation")).toBeNull();

    await waitFor(() => expect(routed.replace).toHaveBeenCalledWith("/sign-in"));
    // And still nothing guessed on the way out.
    expect(waiting().dataset.slot).toBe("session-loading");
  });

  it("covers signing in with the same screen rather than a form that has stopped answering", async () => {
    const assign = vi.fn();
    vi.stubGlobal("location", { assign, search: "", href: "" });
    vi.stubGlobal("fetch", vi.fn(async () => json(200, {})));
    render(<SignInPage />);

    fireEvent.change(screen.getByLabelText("Email"), {
      target: { value: "ada@acme.example" },
    });
    fireEvent.change(screen.getByLabelText("Password"), {
      target: { value: "correct horse" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

    await waitFor(() => expect(waiting().textContent).toBe("Signing in"));
    expect(waiting().dataset.slot).toBe("session-loading");
    // The form is gone rather than sitting there with a greyed-out button for
    // the length of a whole document load.
    expect(screen.queryByLabelText("Password")).toBeNull();
    expect(assign).toHaveBeenCalledTimes(1);
  });
});

describe("the shared controls on access pages", () => {
  it("keeps sign-in labels, browser validation, and password-manager meaning", () => {
    render(<SignInPage />);

    const email = screen.getByLabelText("Email");
    const password = screen.getByLabelText("Password");
    expect(email.getAttribute("type")).toBe("email");
    expect(email.getAttribute("autocomplete")).toBe("email");
    expect(email.hasAttribute("required")).toBe(true);
    expect(password.getAttribute("type")).toBe("password");
    expect(password.getAttribute("autocomplete")).toBe("current-password");

    const showPassword = screen.getByRole("button", { name: "Show password" });
    expect(showPassword.getAttribute("type")).toBe("button");
    expect(showPassword.getAttribute("aria-controls")).toBe("password");
    expect(showPassword.textContent).toBe("");
    expect(showPassword.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");

    fireEvent.change(email, { target: { value: "ada@example.com" } });
    fireEvent.change(password, { target: { value: "correct horse" } });
    expect((email as HTMLInputElement).value).toBe("ada@example.com");
    expect((password as HTMLInputElement).value).toBe("correct horse");

    fireEvent.click(showPassword);
    expect(password.getAttribute("type")).toBe("text");
    expect((password as HTMLInputElement).value).toBe("correct horse");

    const hidePassword = screen.getByRole("button", { name: "Hide password" });
    expect(hidePassword.textContent).toBe("");
    expect(hidePassword.querySelectorAll("path")).toHaveLength(2);
    fireEvent.click(hidePassword);
    expect(password.getAttribute("type")).toBe("password");
    expect(screen.getByRole("button", { name: "Sign in" }).getAttribute("type")).toBe("submit");
    expect(screen.getByRole("link", { name: "Sign up" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Sign in" })).toBeTruthy();
    expect(screen.queryByText("Trust starts with what happened.")).toBeNull();
    expect(screen.queryByText("Voice agent reliability")).toBeNull();
    expect(document.querySelector("canvas")).toBeNull();

    /*
     * The statement outlived the split screen it used to fill, and where it
     * went is the whole of what changed: the wordmark, then the sentence, then
     * the panel — three children of one column, in that order. Asserting only
     * that the words are somewhere on the page would pass with them back
     * beside a canvas, which is the arrangement this ticket removed.
     */
    const column = document.querySelector('[data-slot="auth-column"]');
    expect(column).toBeTruthy();
    const above = [...(column?.children ?? [])];
    expect(above[0]?.tagName).toBe("IMG");
    expect(above[0]?.getAttribute("alt")).toBe("Egma");
    expect(above[1]?.textContent).toBe(
      "Trust the voice agents you ship in production.",
    );
    expect(above[2]?.getAttribute("data-slot")).toBe("auth-panel");
    expect(above[2]?.contains(screen.getByRole("heading", { name: "Sign in" }))).toBe(
      true,
    );
  });

  it("keeps first setup as one labelled form with a described organization default", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json(200, { open: true })));
    render(<SignUpPage />);

    const organization = await screen.findByLabelText("Organization");
    const hint = screen.getByText("Filled in from your email. Change it if you like.");
    expect(organization.getAttribute("aria-describedby")).toBe(hint.id);

    const password = screen.getByLabelText("Password");
    expect(password.getAttribute("autocomplete")).toBe("new-password");
    expect(password.getAttribute("minlength")).toBe("8");
    expect(screen.getByLabelText("First project")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Create my Egma instance" }),
    ).toBeTruthy();
    expect(screen.getByText("Trust the voice agents you ship in production.")).toBeTruthy();
    expect(document.querySelector("canvas")).toBeNull();
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

  it("keeps a claimed instance invitation clear and does not repeat the heading", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        json(200, {
          open: false,
          message:
            "this Egma instance has been claimed. Ask an admin for an invitation.",
        }),
      ),
    );
    render(<SignUpPage />);

    expect(
      await screen.findByRole("heading", {
        name: "Ask an admin for an invitation to this Egma instance.",
      }),
    ).toBeTruthy();
    expect(screen.queryByText("This Egma instance has been claimed")).toBeNull();
    expect(
      screen.queryByText(
        "this Egma instance has been claimed. Ask an admin for an invitation.",
      ),
    ).toBeNull();
    expect(document.querySelector("canvas")).toBeNull();
  });

  it("keeps invitation identity fixed and the new password writable", async () => {
    window.history.replaceState({}, "", "/invite?token=inv_1");
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
        throw new Error(`nothing stubbed for ${path}`);
      }),
    );

    render(<InvitePage />);

    const email = await screen.findByLabelText("Email");
    expect((email as HTMLInputElement).readOnly).toBe(true);
    expect((email as HTMLInputElement).value).toBe("ada@example.com");
    const password = screen.getByLabelText("Choose a password");
    expect(password.getAttribute("minlength")).toBe("8");
    expect(screen.getByRole("button", { name: "Join Acme" })).toBeTruthy();
  });

  it("keeps password recovery and completion native to the browser", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json(200, {})));
    const forgot = render(<ForgotPasswordPage />);
    const email = screen.getByLabelText("Email");
    expect(email.getAttribute("type")).toBe("email");
    expect(screen.getByRole("button", { name: "Send reset link" })).toBeTruthy();
    expect(
      screen.queryByText(
        "Name the address you signed up with, and Egma sends a link to set a new one.",
      ),
    ).toBeNull();

    fireEvent.change(email, { target: { value: "ada@example.com" } });
    fireEvent.click(screen.getByRole("button", { name: "Send reset link" }));
    expect(await screen.findByRole("heading", { name: "Check your email" })).toBeTruthy();
    const emphasizedEmail = screen.getByText("ada@example.com");
    expect(emphasizedEmail.tagName).toBe("SPAN");
    expect(emphasizedEmail.parentElement?.textContent).toBe(
      "If ada@example.com has an account, a link to reset password has been sent",
    );
    expect(screen.queryByText(/Nothing arrived\?/u)).toBeNull();
    forgot.unmount();

    window.history.replaceState({}, "", "/reset-password?token=reset_1");
    render(<ResetPasswordPage />);
    const password = await screen.findByLabelText("New password");
    expect(password.getAttribute("autocomplete")).toBe("new-password");
    expect(password.getAttribute("minlength")).toBe("8");
    expect(screen.getByRole("button", { name: "Set the password" })).toBeTruthy();
  });

  it("keeps the terminal code editable and project approval explicit", async () => {
    window.history.replaceState({}, "", "/device?user_code=AB-CD");
    const entered = render(<DeviceCodePage />);
    const code = await screen.findByLabelText("Code");
    expect((code as HTMLInputElement).value).toBe("AB-CD");
    expect(code.getAttribute("autocapitalize")).toBe("characters");
    expect(screen.getByRole("button", { name: "Continue" })).toBeTruthy();
    entered.unmount();

    window.history.replaceState({}, "", "/device/approve?user_code=ABCD1234");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        json(200, {
          status: "pending",
          user_code: "ABCD1234",
          organization: { id: "org_1", name: "Acme" },
          projects: [
            { id: "prj_1", name: "Support" },
            { id: "prj_2", name: "Outbound" },
          ],
        }),
      ),
    );
    render(<ApproveDevicePage />);

    const project = await screen.findByLabelText("Project");
    expect((project as HTMLSelectElement).value).toBe("prj_1");
    fireEvent.change(project, { target: { value: "prj_2" } });
    expect((project as HTMLSelectElement).value).toBe("prj_2");
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Deny" })).toBeTruthy();
      expect(screen.getByRole("button", { name: "Approve" })).toBeTruthy();
    });
  });
});
