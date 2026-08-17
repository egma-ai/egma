// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import ApproveDevicePage from "../app/device/approve/page.tsx";
import DeviceCodePage from "../app/device/page.tsx";
import ForgotPasswordPage from "../app/forgot-password/page.tsx";
import InvitePage from "../app/invite/page.tsx";
import ResetPasswordPage from "../app/reset-password/page.tsx";
import SignInPage from "../app/sign-in/page.tsx";
import SignUpPage from "../app/signup/page.tsx";

vi.mock("next/image", () => ({
  default: ({ alt }: { readonly alt: string }) => <img alt={alt} />,
}));

// The canvas explains the sign-in and sign-up brand surfaces. These tests concern the form
// controls, and jsdom does not draw or resize a canvas.
vi.mock("../app/trust-gate.tsx", () => ({
  TrustGate: () => <canvas aria-hidden="true" />,
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
  window.history.replaceState({}, "", "/");
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

    fireEvent.change(email, { target: { value: "ada@example.com" } });
    fireEvent.change(password, { target: { value: "correct horse" } });
    expect((email as HTMLInputElement).value).toBe("ada@example.com");
    expect((password as HTMLInputElement).value).toBe("correct horse");
    expect(screen.getByRole("button", { name: "Sign in" }).getAttribute("type")).toBe("submit");
    expect(screen.getByRole("link", { name: "Sign up" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Sign in" })).toBeTruthy();
    expect(screen.queryByText("Trust starts with what happened.")).toBeNull();
    expect(screen.getByText("Trust the voice agents you ship in production.")).toBeTruthy();
    expect(screen.queryByText("Voice agent reliability")).toBeNull();
    expect(document.querySelector("canvas")).toBeTruthy();
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
    expect(document.querySelector("canvas")).toBeTruthy();
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
    expect(document.querySelector("canvas")).toBeTruthy();
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
