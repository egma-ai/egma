"use client";

import { useEffect, useState } from "react";

import {
  DEFAULT_SIGNED_IN_PATH,
  returnPathIn,
  withReturnTo,
} from "../../lib/return-to.ts";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

import { Field } from "../../ui/form.tsx";
import { AuthForm, AuthShell, LinkLine, Notice } from "../ui.tsx";

function PasswordVisibilityIcon({ visible }: { readonly visible: boolean }) {
  return (
    /*
     * `size-5` is on the icon rather than on the control. The base button sizes
     * any icon that does not carry a size of its own, and this one is 20px
     * inside a 36px target rather than the 16px a row action wears.
     */
    <svg
      className="size-5"
      aria-hidden="true"
      focusable="false"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={1.5}
    >
      <path d="M2.5 12s3.4-5.5 9.5-5.5 9.5 5.5 9.5 5.5-3.4 5.5-9.5 5.5S2.5 12 2.5 12Z" />
      <circle cx="12" cy="12" r="2.75" />
      {visible ? <path d="m4 4 16 16" /> : null}
    </svg>
  );
}

/**
 * Signing in, for the second machine and everybody who arrived by invitation.
 *
 * It posts straight at the auth provider's own endpoint, which the instance
 * serves under its own origin. There is no egma-run domain in the path.
 */
export default function SignInPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [passwordVisible, setPasswordVisible] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  /** Somebody sent here by a terminal's approval page goes back to it. */
  const [returnTo, setReturnTo] = useState<string | null>(null);

  useEffect(() => {
    setReturnTo(returnPathIn(window.location.search));
  }, []);

  async function submit(): Promise<void> {
    setProblem(null);
    setSubmitting(true);
    try {
      const response = await fetch("/api/auth/sign-in/email", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      if (response.ok) {
        window.location.assign(returnTo ?? DEFAULT_SIGNED_IN_PATH);
        return;
      }
      const body = (await response.json().catch(() => ({}))) as {
        message?: string;
      };
      setProblem(body.message ?? "that email and password did not match");
    } catch {
      setProblem("Egma could not be reached. Is the API running?");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <AuthShell
      eyebrow="Welcome back"
      title="Sign in"
      lead="Sign in to continue to your organization."
    >
      <AuthForm onSubmit={() => void submit()}>
        {problem === null ? null : <Notice tone="error">{problem}</Notice>}

        <Field label="Email" htmlFor="email">
          <Input
            id="email"
            name="email"
            type="email"
            autoComplete="email"
            spellCheck={false}
            required
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
        </Field>

        <Field label="Password" htmlFor="password">
          <div className="relative min-w-0">
            <Input
              className="min-w-0 pr-[calc(var(--tap-target)+var(--space-2))]"
              id="password"
              name="password"
              type={passwordVisible ? "text" : "password"}
              autoComplete="current-password"
              spellCheck={false}
              required
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
            {/*
             * The one control in this product that sits inside another one, so
             * it is the base button resized rather than a second kind of
             * button: a 36px target inside a 44px field for a fine pointer, and
             * the full 44px where a finger has to find it.
             */}
            <Button
              className={cn(
                "absolute top-1/2 right-1 size-(--control-md) min-h-(--control-md)",
                "-translate-y-1/2 p-0 text-muted-foreground",
                /*
                 * The icon brightens under a fine pointer. The base ghost
                 * variant changes only the background, and the quiet colour
                 * pinned above wins over its `text-foreground` at rest *and* on
                 * hover — so the hover half has to be said here too, or the
                 * only answer to pointing at the control is a faint wash.
                 */
                "pointer-hover:text-foreground",
                "pointer-coarse:right-0 pointer-coarse:size-(--tap-target)",
                "pointer-coarse:min-h-(--tap-target)",
              )}
              variant="ghost"
              type="button"
              aria-label={passwordVisible ? "Hide password" : "Show password"}
              aria-controls="password"
              onClick={() => setPasswordVisible((visible) => !visible)}
            >
              <PasswordVisibilityIcon visible={passwordVisible} />
            </Button>
          </div>
        </Field>

        <Button type="submit" size="lg" disabled={submitting}>
          {submitting ? "Signing in…" : "Sign in"}
        </Button>
      </AuthForm>

      {/* Carrying where they were headed, exactly as the signup link does.
          Somebody sent here by a terminal's approval page who turns out to have
          forgotten their password is still on their way to that page. */}
      <LinkLine>
        <a
          href={
            returnTo === null
              ? "/forgot-password"
              : withReturnTo("/forgot-password", returnTo)
          }
        >
          Forgot your password?
        </a>
      </LinkLine>

      <LinkLine>
        No account yet?{" "}
        <a href={returnTo === null ? "/signup" : withReturnTo("/signup", returnTo)}>
          Sign up
        </a>
        .
      </LinkLine>
    </AuthShell>
  );
}
