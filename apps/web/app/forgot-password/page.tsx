"use client";

import { useEffect, useState } from "react";

import { returnPathIn, withReturnTo } from "../../lib/return-to.ts";
import { Button, Field, Form, TextInput } from "../../ui/controls.tsx";
import { AuthShell, Notice, StatePage, styles } from "../ui.tsx";

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
 *
 * **Where the person was headed is sent along with the address.** Somebody who
 * got here from a terminal's approval page has to end up back on it, and the
 * message is the one hop no page survives — it opens a fresh tab, minutes
 * later. So the API is told, and it writes the destination into the link it
 * sends.
 */
export default function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [asked, setAsked] = useState(false);
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
      const response = await fetch("/api/password-reset", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(
          returnTo === null ? { email } : { email, next: returnTo },
        ),
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
      setProblem("Egma could not be reached. Is the API running?");
    } finally {
      setSubmitting(false);
    }
  }

  if (asked) {
    return (
      <StatePage
        title="Check your email"
        lead={
          <>
            If <span className={styles.emphasizedEmail}>{email}</span> has an
            account, a link to reset password has been sent
          </>
        }
      />
    );
  }

  return (
    <AuthShell
      eyebrow="Forgotten password"
      title="Set a new password."
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

        <Button weight="strong" type="submit" disabled={submitting}>
          {submitting ? "Sending…" : "Send reset link"}
        </Button>
      </Form>

      <p className={styles.linkLine}>
        Remembered it?{" "}
        <a
          href={
            returnTo === null ? "/sign-in" : withReturnTo("/sign-in", returnTo)
          }
        >
          Sign in
        </a>
        .
      </p>
    </AuthShell>
  );
}
