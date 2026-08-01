"use client";

import { useEffect, useState } from "react";

import { withReturnTo } from "../../lib/return-to.ts";
import { Card, styles } from "../ui.tsx";

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
  | { status: "no-token" }
  | { status: "unknown" }
  | { status: "ready"; invitation: Lookup; signedInAs: string | null };

export default function InvitePage() {
  const [state, setState] = useState<State>({ status: "loading" });
  const [token, setToken] = useState("");
  const [password, setPassword] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    const given = new URLSearchParams(window.location.search).get("token") ?? "";
    setToken(given);
    if (given === "") {
      setState({ status: "no-token" });
      return;
    }

    let current = true;
    void (async () => {
      const [looked, me] = await Promise.all([
        fetch("/api/invitations/lookup", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ token: given }),
        }),
        fetch("/api/me"),
      ]);
      if (!current) return;

      if (!looked.ok) {
        setState({ status: "unknown" });
        return;
      }

      // Somebody already signed in is offered the button rather than the form.
      // Somebody signed in as a different person is told so by the refusal, and
      // that is better than this page guessing what they meant.
      const signedInAs = me.ok
        ? ((await me.json()) as { user: { email: string } }).user.email
        : null;

      setState({
        status: "ready",
        invitation: (await looked.json()) as Lookup,
        signedInAs,
      });
    })().catch(() => {
      if (current) setProblem("egma could not be reached. Is the API running?");
    });

    return () => {
      current = false;
    };
  }, []);

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
        window.location.assign("/");
        return;
      }
      const said = (await response.json().catch(() => ({}))) as {
        message?: string;
      };
      setProblem(said.message ?? "that invitation could not be accepted");
    } catch {
      setProblem("egma could not be reached. Is the API running?");
    } finally {
      setSubmitting(false);
    }
  }

  if (state.status === "loading") return <Card title="egma">Loading…</Card>;

  if (state.status === "no-token") {
    return (
      <Card
        title="That link is missing something"
        lead="An invitation link carries a token. Check it was copied whole, or ask whoever sent it for another."
      >
        <p style={styles.aside}>
          <a href="/sign-in">Sign in</a> if you already have an account.
        </p>
      </Card>
    );
  }

  if (state.status === "unknown") {
    return (
      <Card
        title="That invitation does not name anything"
        lead="Check the link was copied whole, or ask whoever sent it for another."
      >
        <p style={styles.aside}>
          <a href="/sign-in">Sign in</a> if you already have an account.
        </p>
      </Card>
    );
  }

  const { invitation, signedInAs } = state;

  if (invitation.state === "expired") {
    return (
      <Card
        title="That invitation has expired"
        lead={`Ask an admin of ${invitation.organization.name} to send another one.`}
      >
        <p style={styles.aside}>
          <a href="/sign-in">Sign in</a> if you already have an account.
        </p>
      </Card>
    );
  }

  if (invitation.state === "accepted") {
    return (
      <Card
        title="That invitation has already been accepted"
        lead="If it was you, you are already in — sign in instead."
      >
        <p style={styles.aside}>
          <a href="/sign-in">Sign in</a>
        </p>
      </Card>
    );
  }

  const joining = `Join ${invitation.organization.name} on egma`;

  if (signedInAs !== null) {
    return (
      <Card
        title={joining}
        lead={`You are signed in as ${signedInAs}, and this invitation is for ${invitation.email}.`}
      >
        {problem === null ? null : <p style={styles.problem}>{problem}</p>}
        <button
          style={styles.button}
          type="button"
          disabled={submitting}
          onClick={() => {
            void post("/api/invitations/accept", { token });
          }}
        >
          {submitting ? "Joining…" : `Join ${invitation.organization.name}`}
        </button>
      </Card>
    );
  }

  return (
    <Card
      title={joining}
      lead={`You have been invited as ${invitation.email}, and you will be ${
        invitation.role === "admin" ? "an" : "a"
      } ${invitation.role}.`}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void post("/api/signup", {
            email: invitation.email,
            password,
            invitationToken: token,
          });
        }}
      >
        {problem === null ? null : <p style={styles.problem}>{problem}</p>}

        <div style={styles.field}>
          <label style={styles.label} htmlFor="email">
            Email
            <span style={styles.hint}>
              The address this invitation was sent to.
            </span>
          </label>
          <input
            style={{ ...styles.input, background: "#f6f6f6" }}
            id="email"
            name="email"
            type="email"
            readOnly
            value={invitation.email}
          />
        </div>

        <div style={styles.field}>
          <label style={styles.label} htmlFor="password">
            Choose a password
          </label>
          <input
            style={styles.input}
            id="password"
            name="password"
            type="password"
            autoComplete="new-password"
            required
            minLength={8}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        </div>

        <button style={styles.button} type="submit" disabled={submitting}>
          {submitting ? "Joining…" : `Join ${invitation.organization.name}`}
        </button>
      </form>

      <p style={styles.aside}>
        Already have an egma account?{" "}
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
    </Card>
  );
}
