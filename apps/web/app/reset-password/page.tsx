"use client";

import { useEffect, useState } from "react";

import { returnPathIn, withReturnTo } from "../../lib/return-to.ts";
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
 * **There is a third answer**, and it has a page of its own for that same
 * reason. A link too old for the API to tell which of the two it is gets a
 * sentence that says so, because a page that picked the likelier one would tell
 * half the people holding it to go on using a password that no longer works.
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
  /**
   * Where to go once the password is set. It arrives in the link itself,
   * because the message is the one hop no page survives — this is a fresh tab,
   * minutes later, and nothing that was on screen when the reset was asked for
   * is still there. It is checked again here, on the way out.
   */
  const [returnTo, setReturnTo] = useState<string | null>(null);

  useEffect(() => {
    setToken(new URLSearchParams(window.location.search).get("token") ?? "");
    setReturnTo(returnPathIn(window.location.search));
  }, []);

  /** Both ways on from here, carrying wherever this person was going. */
  const signInHref =
    returnTo === null ? "/sign-in" : withReturnTo("/sign-in", returnTo);
  const forgotHref =
    returnTo === null
      ? "/forgot-password"
      : withReturnTo("/forgot-password", returnTo);

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
          <a href={signInHref}>Sign in</a>
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
          <a href={forgotHref}>Ask for another link</a>
        </p>
      </StatePage>
    );
  }

  // Said only where the API has checked it: this one means the provider was
  // asked and still holds the token, so nobody used the link.
  if (refused?.error === "reset_link_expired") {
    return (
      <StatePage
        title="That link has run out of time"
        lead="Nobody used it, so nothing has changed and your old password still works. Ask for another link and it will let you in."
      >
        <p className={styles.linkLine}>
          <a href={forgotHref}>Ask for another link</a>
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
          <a href={signInHref}>Sign in</a> ·{" "}
          <a href={forgotHref}>Ask for another link</a>
        </p>
      </StatePage>
    );
  }

  // The third answer. Old enough that the API cannot tell which of the two
  // above it is, so the page says both rather than choosing one — telling
  // somebody their old password still works when it may not is the failure this
  // whole page is arranged to avoid.
  if (refused?.error === "reset_link_no_longer_works") {
    return (
      <StatePage
        title="That link no longer works"
        lead="It is too old now for egma to say whether it was used before it ran out. If you set a password with it, sign in with that one. If nothing happened, ask for another link."
      >
        <p className={styles.linkLine}>
          <a href={signInHref}>Sign in</a> ·{" "}
          <a href={forgotHref}>Ask for another link</a>
        </p>
      </StatePage>
    );
  }

  if (refused !== null) {
    return (
      <StatePage title="That link could not be used" lead={refused.message}>
        <p className={styles.linkLine}>
          <a href={forgotHref}>Ask for another link</a>
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
