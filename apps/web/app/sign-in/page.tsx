"use client";

import { useEffect, useState } from "react";

import {
  DEFAULT_SIGNED_IN_PATH,
  returnPathIn,
  withReturnTo,
} from "../../lib/return-to.ts";
import { Button, Field, Form, TextInput } from "../../ui/controls.tsx";
import { AuthShell, Notice, styles } from "../ui.tsx";

function PasswordVisibilityIcon({ visible }: { readonly visible: boolean }) {
  return (
    <svg aria-hidden="true" focusable="false" viewBox="0 0 24 24">
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
      animated
      eyebrow="Welcome back"
      title="Sign in"
      lead="Sign in to continue to your organization."
    >
      <Form onSubmit={() => void submit()}>
        {problem === null ? null : <Notice tone="error">{problem}</Notice>}

        <Field label="Email" htmlFor="email">
          <TextInput
            id="email"
            name="email"
            type="email"
            autoComplete="email"
            required
            value={email}
            onChange={setEmail}
          />
        </Field>

        <Field label="Password" htmlFor="password">
          <div className={styles.passwordControl}>
            <TextInput
              id="password"
              name="password"
              type={passwordVisible ? "text" : "password"}
              autoComplete="current-password"
              required
              value={password}
              onChange={setPassword}
            />
            <button
              className={styles.passwordToggle}
              type="button"
              aria-label={passwordVisible ? "Hide password" : "Show password"}
              aria-controls="password"
              onClick={() => setPasswordVisible((visible) => !visible)}
            >
              <PasswordVisibilityIcon visible={passwordVisible} />
            </button>
          </div>
        </Field>

        <Button weight="strong" type="submit" disabled={submitting}>
          {submitting ? "Signing in…" : "Sign in"}
        </Button>
      </Form>

      {/* Carrying where they were headed, exactly as the signup link does.
          Somebody sent here by a terminal's approval page who turns out to have
          forgotten their password is still on their way to that page. */}
      <p className={styles.linkLine}>
        <a
          href={
            returnTo === null
              ? "/forgot-password"
              : withReturnTo("/forgot-password", returnTo)
          }
        >
          Forgot your password?
        </a>
      </p>

      <p className={styles.linkLine}>
        No account yet?{" "}
        <a href={returnTo === null ? "/signup" : withReturnTo("/signup", returnTo)}>
          Sign up
        </a>
        .
      </p>
    </AuthShell>
  );
}
