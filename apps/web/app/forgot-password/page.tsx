"use client";

import { useState } from "react";

import { AuthShell, Field, Notice, StatePage, styles } from "../ui.tsx";

/**
 * Asking for a way back in.
 *
 * **The page says the same thing however it went**, because the API does: an
 * address with an account here and one without get one status and one sentence,
 * so this form is never a way to ask an egma who its customers are. A page that
 * said "no such account" would give away exactly what the API refuses to.
 *
 * Where the link then arrives is the deployment's own business and not a second
 * setting: a platform with mail configured posts it, and one without writes the
 * whole message to its log, which is where a solo self-hoster reads it.
 */
export default function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [asked, setAsked] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setProblem(null);
    setSubmitting(true);
    try {
      const response = await fetch("/api/password-reset", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email }),
      });
      if (response.ok) {
        setAsked(true);
        return;
      }
      const said = (await response.json().catch(() => ({}))) as {
        message?: string;
      };
      setProblem(said.message ?? "that reset could not be asked for");
    } catch {
      setProblem("egma could not be reached. Is the API running?");
    } finally {
      setSubmitting(false);
    }
  }

  if (asked) {
    return (
      <StatePage
        title="Check your email"
        lead={`If ${email} has an egma account, a link to set a new password is on its way to it. The link works once, and runs out in an hour.`}
      >
        <p className={styles.linkLine}>
          Nothing arrived? On an egma with no mail configured the message is
          written to the platform's log instead. <a href="/sign-in">Sign in</a>{" "}
          once the password is set.
        </p>
      </StatePage>
    );
  }

  return (
    <AuthShell
      eyebrow="Forgotten password"
      title="Set a new password."
      lead="Name the address you signed up with, and egma sends a link to set a new one."
    >
      <form className={styles.form} onSubmit={submit}>
        {problem === null ? null : <Notice tone="error">{problem}</Notice>}

        <Field label="Email" htmlFor="email">
          <input
            className={styles.input}
            id="email"
            name="email"
            type="email"
            autoComplete="email"
            required
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
        </Field>

        <button className={styles.button} type="submit" disabled={submitting}>
          {submitting ? "Sending…" : "Send the link"}
        </button>
      </form>

      <p className={styles.linkLine}>
        Remembered it? <a href="/sign-in">Sign in</a>.
      </p>
    </AuthShell>
  );
}
