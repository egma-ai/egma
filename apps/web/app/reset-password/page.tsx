"use client";

import { useEffect, useState } from "react";

import { AuthShell, Field, Notice, StatePage, styles } from "../ui.tsx";

/**
 * The page behind the link, and it asks for one thing.
 *
 * A new password, and nothing else. The link already names the account, so
 * there is no address to type and nothing to get wrong — the same reason the
 * invitation page shows the address rather than asking for it.
 *
 * **A spent link and an expired one say different things**, because they mean
 * opposite things to whoever is holding one: you already did this, so sign in —
 * versus nothing happened at all, so ask for another. The API decides which,
 * and this page never guesses between them.
 *
 * Setting the password does not sign anybody in. Two steps a person can see is
 * better than one they cannot, and using the password is what proves it works.
 */

type Refused = {
  /** The API's own code, so the page never branches on a sentence. */
  readonly error: string;
  readonly message: string;
};

export default function ResetPasswordPage() {
  const [token, setToken] = useState<string | null>(null);
  const [password, setPassword] = useState("");
  const [refused, setRefused] = useState<Refused | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);

  useEffect(() => {
    setToken(new URLSearchParams(window.location.search).get("token") ?? "");
  }, []);

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setProblem(null);
    setSubmitting(true);
    try {
      const response = await fetch("/api/password-reset/complete", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token, password }),
      });
      if (response.ok) {
        setDone(true);
        return;
      }

      const said = (await response.json().catch(() => ({}))) as {
        error?: string;
        message?: string;
      };
      const message = said.message ?? "that password could not be set";
      // A dead link replaces the form, because filling it in again cannot
      // help. Anything else — a password too short — keeps the form and says
      // what to change.
      if (said.error !== undefined && said.error !== "invalid_request") {
        setRefused({ error: said.error, message });
        return;
      }
      setProblem(message);
    } catch {
      setProblem("egma could not be reached. Is the API running?");
    } finally {
      setSubmitting(false);
    }
  }

  if (done) {
    return (
      <StatePage
        title="That password is set"
        lead="Sign in with the new one. The old one no longer works."
      >
        <p className={styles.linkLine}>
          <a href="/sign-in">Sign in</a>
        </p>
      </StatePage>
    );
  }

  if (token === null) {
    return <StatePage title="Loading" lead="Checking the reset link." />;
  }

  if (token === "" || refused?.error === "no_such_reset_link") {
    return (
      <StatePage
        title="That link is missing something"
        lead="A reset link carries a token. Check it was copied whole, or ask for another."
      >
        <p className={styles.linkLine}>
          <a href="/forgot-password">Ask for another link</a>
        </p>
      </StatePage>
    );
  }

  if (refused?.error === "reset_link_expired") {
    return (
      <StatePage
        title="That link has run out of time"
        lead="Nothing has changed, and your old password still works. Ask for another link and it will let you in."
      >
        <p className={styles.linkLine}>
          <a href="/forgot-password">Ask for another link</a>
        </p>
      </StatePage>
    );
  }

  if (refused?.error === "reset_link_already_used") {
    return (
      <StatePage
        title="That link has already been used"
        lead="The password behind it has been set. Sign in with it — or ask for another link if it was not you who used it."
      >
        <p className={styles.linkLine}>
          <a href="/sign-in">Sign in</a> ·{" "}
          <a href="/forgot-password">Ask for another link</a>
        </p>
      </StatePage>
    );
  }

  if (refused !== null) {
    return (
      <StatePage title="That link could not be used" lead={refused.message}>
        <p className={styles.linkLine}>
          <a href="/forgot-password">Ask for another link</a>
        </p>
      </StatePage>
    );
  }

  return (
    <AuthShell
      eyebrow="Forgotten password"
      title="Choose a new password."
      lead="This link names your account, so a password is all egma needs."
    >
      <form className={styles.form} onSubmit={submit}>
        {problem === null ? null : <Notice tone="error">{problem}</Notice>}

        <Field label="New password" htmlFor="password">
          <input
            className={styles.input}
            id="password"
            name="password"
            type="password"
            autoComplete="new-password"
            required
            minLength={8}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        </Field>

        <button className={styles.button} type="submit" disabled={submitting}>
          {submitting ? "Setting…" : "Set the password"}
        </button>
      </form>
    </AuthShell>
  );
}
