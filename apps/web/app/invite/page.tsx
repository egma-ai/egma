"use client";

import { useEffect, useState } from "react";

import {
  DEFAULT_SIGNED_IN_PATH,
  withReturnTo,
} from "../../lib/return-to.ts";
import { AuthShell, Field, Notice, StatePage, styles } from "../ui.tsx";

/**
 * The page a colleague lands on.
 *
 * It says what they are joining and at what, and then asks for the one thing it
 * needs: a password. The address is the invitation's and is shown rather than
 * asked for, because that is the address the link lets in — there is nothing to
 * type and nothing to get wrong.
 *
 * **An expired link and an already-accepted one say different things**, because
 * they mean opposite things to the person holding one: ask for another, versus
 * you are already in, sign in.
 *
 * Somebody who already has an account gets a button instead of a form. That is
 * the person who was removed from an organization and asked back, and without it
 * they would be told their email address is taken by an account they cannot use.
 */

type Lookup = {
  state: "pending" | "expired" | "accepted";
  email: string;
  role: string;
  organization: { name: string };
};

type State =
  | { status: "loading" }
  | { status: "failed" }
  | { status: "no-token" }
  | { status: "unknown" }
  | { status: "ready"; invitation: Lookup; signedInAs: string | null };

export default function InvitePage() {
  const [state, setState] = useState<State>({ status: "loading" });
  const [token, setToken] = useState("");
  const [password, setPassword] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const given = new URLSearchParams(window.location.search).get("token") ?? "";
    setToken(given);
    if (given === "") {
      setState({ status: "no-token" });
      return;
    }

    let current = true;
    void (async () => {
      const looked = await fetch("/api/invitations/lookup", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: given }),
      });
      if (!current) return;

      if (!looked.ok) {
        setState({ status: looked.status === 404 ? "unknown" : "failed" });
        return;
      }

      // Somebody already signed in is offered the button rather than the form.
      // Somebody signed in as a different person is told so by the refusal, and
      // that is better than this page guessing what they meant.
      const me = await fetch("/api/me").catch(() => null);
      if (!current) return;
      if (me === null || (me.status !== 401 && !me.ok)) {
        setState({ status: "failed" });
        return;
      }
      let signedInAs: string | null = null;
      if (me.ok) {
        signedInAs = await me
          .json()
          .then((body: { user?: { email?: unknown } }) =>
            typeof body.user?.email === "string" ? body.user.email : null,
          )
          .catch(() => null);
        if (signedInAs === null) {
          setState({ status: "failed" });
          return;
        }
      }

      setState({
        status: "ready",
        invitation: (await looked.json()) as Lookup,
        signedInAs,
      });
    })().catch(() => {
      if (current) setState({ status: "failed" });
    });

    return () => {
      current = false;
    };
  }, [attempt]);

  async function post(
    path: string,
    body: Record<string, unknown>,
  ): Promise<void> {
    setProblem(null);
    setSubmitting(true);
    try {
      const response = await fetch(path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (response.ok) {
        window.location.assign(DEFAULT_SIGNED_IN_PATH);
        return;
      }
      const said = (await response.json().catch(() => ({}))) as {
        message?: string;
      };
      setProblem(said.message ?? "that invitation could not be accepted");
    } catch {
      setProblem("Egma could not be reached. Is the API running?");
    } finally {
      setSubmitting(false);
    }
  }

  if (state.status === "loading") return <StatePage title="Loading invitation" lead="Checking the invitation link." />;

  if (state.status === "failed") {
    return (
      <StatePage title="The invitation could not be checked" lead="Egma could not reach the invitation service right now.">
        <button
          className={styles.button}
          type="button"
          onClick={() => {
            setState({ status: "loading" });
            setAttempt((value) => value + 1);
          }}
        >
          Try again
        </button>
      </StatePage>
    );
  }

  if (state.status === "no-token") {
    return (
      <StatePage
        title="That link is missing something"
        lead="An invitation link carries a token. Check it was copied whole, or ask whoever sent it for another."
      >
        <p className={styles.linkLine}>
          <a href="/sign-in">Sign in</a> if you already have an account.
        </p>
      </StatePage>
    );
  }

  if (state.status === "unknown") {
    return (
      <StatePage
        title="That invitation does not name anything"
        lead="Check the link was copied whole, or ask whoever sent it for another."
      >
        <p className={styles.linkLine}>
          <a href="/sign-in">Sign in</a> if you already have an account.
        </p>
      </StatePage>
    );
  }

  const { invitation, signedInAs } = state;

  if (invitation.state === "expired") {
    return (
      <StatePage
        title="That invitation has expired"
        lead={`Ask an admin of ${invitation.organization.name} to send another one.`}
      >
        <p className={styles.linkLine}>
          <a href="/sign-in">Sign in</a> if you already have an account.
        </p>
      </StatePage>
    );
  }

  if (invitation.state === "accepted") {
    return (
      <StatePage
        title="That invitation has already been accepted"
        lead="If it was you, you are already in — sign in instead."
      >
        <p className={styles.linkLine}>
          <a href="/sign-in">Sign in</a>
        </p>
      </StatePage>
    );
  }

  const joining = `Join ${invitation.organization.name} on Egma`;

  if (signedInAs !== null) {
    return (
      <AuthShell
        eyebrow="Organization invitation"
        title={joining}
        lead={`You are signed in as ${signedInAs}, and this invitation is for ${invitation.email}.`}
      >
        {problem === null ? null : <Notice tone="error">{problem}</Notice>}
        <button
          className={styles.button}
          type="button"
          disabled={submitting}
          onClick={() => {
            void post("/api/invitations/accept", { token });
          }}
        >
          {submitting ? "Joining…" : `Join ${invitation.organization.name}`}
        </button>
      </AuthShell>
    );
  }

  return (
    <AuthShell
      eyebrow="Organization invitation"
      title={joining}
      lead={`You have been invited as ${invitation.email}, and you will be ${
        invitation.role === "admin" ? "an" : "a"
      } ${invitation.role}.`}
    >
      <form
        className={styles.form}
        onSubmit={(event) => {
          event.preventDefault();
          void post("/api/signup", {
            email: invitation.email,
            password,
            invitationToken: token,
          });
        }}
      >
        {problem === null ? null : <Notice tone="error">{problem}</Notice>}

        <Field label="Email" hint="The address this invitation was sent to." htmlFor="email">
          <input
            className={styles.input}
            id="email"
            name="email"
            type="email"
            readOnly
            value={invitation.email}
          />
        </Field>

        <Field label="Choose a password" htmlFor="password">
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
          {submitting ? "Joining…" : `Join ${invitation.organization.name}`}
        </button>
      </form>

      <p className={styles.linkLine}>
        Already have an Egma account?{" "}
        <a
          href={withReturnTo(
            "/sign-in",
            `/invite?token=${encodeURIComponent(token)}`,
          )}
        >
          Sign in
        </a>{" "}
        and this page will let you join.
      </p>
    </AuthShell>
  );
}
