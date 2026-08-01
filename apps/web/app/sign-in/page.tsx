"use client";

import { useEffect, useState } from "react";

import { returnPathIn, withReturnTo } from "../../lib/return-to.ts";
import { Card, styles } from "../ui.tsx";

/**
 * Signing in, for the second machine and everybody who arrived by invitation.
 *
 * It posts straight at the auth provider's own endpoint, which the instance
 * serves under its own origin. There is no egma-run domain in the path.
 */
export default function SignInPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  /** Somebody sent here by a terminal's approval page goes back to it. */
  const [returnTo, setReturnTo] = useState<string | null>(null);

  useEffect(() => {
    setReturnTo(returnPathIn(window.location.search));
  }, []);

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setProblem(null);
    setSubmitting(true);
    try {
      const response = await fetch("/api/auth/sign-in/email", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      if (response.ok) {
        window.location.assign(returnTo ?? "/");
        return;
      }
      const body = (await response.json().catch(() => ({}))) as {
        message?: string;
      };
      setProblem(body.message ?? "that email and password did not match");
    } catch {
      setProblem("egma could not be reached. Is the API running?");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Card title="Sign in to egma">
      <form onSubmit={submit}>
        {problem === null ? null : <p style={styles.problem}>{problem}</p>}

        <div style={styles.field}>
          <label style={styles.label} htmlFor="email">
            Email
          </label>
          <input
            style={styles.input}
            id="email"
            name="email"
            type="email"
            autoComplete="email"
            required
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
        </div>

        <div style={styles.field}>
          <label style={styles.label} htmlFor="password">
            Password
          </label>
          <input
            style={styles.input}
            id="password"
            name="password"
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        </div>

        <button style={styles.button} type="submit" disabled={submitting}>
          {submitting ? "Signing in…" : "Sign in"}
        </button>
      </form>

      <p style={styles.aside}>
        No account yet?{" "}
        <a href={returnTo === null ? "/signup" : withReturnTo("/signup", returnTo)}>
          Set up egma
        </a>
        .
      </p>
    </Card>
  );
}
