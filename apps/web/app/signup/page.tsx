"use client";

import { useEffect, useState } from "react";

import {
  DEFAULT_SIGNED_IN_PATH,
  returnPathIn,
  withReturnTo,
} from "../../lib/return-to.ts";
import {
  DEFAULT_PROJECT_NAME,
  organizationNameFromEmail,
} from "../../lib/signup-defaults.ts";
import { AuthShell, Field, Notice, StatePage, styles } from "../ui.tsx";

/**
 * Signing up: one page, one submit, and an organization and a project at the
 * end of it.
 *
 * Both names arrive filled in and both are editable. Nothing here asks a person
 * which project they mean before they have one, which is the form that would
 * spend the ten minutes the product is judged on.
 *
 * Every path on this page is relative, so the pages are served from whatever
 * origin the instance runs on and never from a domain egma runs. A self-hoster
 * depends on nothing they do not operate in order to log in.
 */

type Availability = { open: boolean; message?: string };

export default function SignUpPage() {
  const [availability, setAvailability] = useState<Availability | null>(null);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [organizationName, setOrganizationName] = useState("");
  const [organizationEdited, setOrganizationEdited] = useState(false);
  const [projectName, setProjectName] = useState(DEFAULT_PROJECT_NAME);
  const [problem, setProblem] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  /**
   * Where to go afterwards. Somebody who arrived here from a terminal's
   * approval page goes back to it with their code intact, rather than landing
   * at the front door having lost what they came for.
   */
  const [returnTo, setReturnTo] = useState<string | null>(null);

  useEffect(() => {
    setReturnTo(returnPathIn(window.location.search));
  }, []);

  useEffect(() => {
    let current = true;
    void fetch("/api/signup/availability")
      .then((response) => response.json())
      .then((body: Availability) => {
        if (current) setAvailability(body);
      })
      .catch(() => {
        if (current) setAvailability({ open: true });
      });
    return () => {
      current = false;
    };
  }, []);

  // The organization name follows the email address until somebody types over
  // it, and then it stops following. A default that overwrites what a person
  // wrote is worse than no default at all.
  function onEmailChange(next: string): void {
    setEmail(next);
    if (!organizationEdited) {
      setOrganizationName(next.includes("@") ? organizationNameFromEmail(next) : "");
    }
  }

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setProblem(null);
    setSubmitting(true);
    try {
      const response = await fetch("/api/signup", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, password, organizationName, projectName }),
      });
      if (response.ok) {
        window.location.assign(returnTo ?? DEFAULT_SIGNED_IN_PATH);
        return;
      }
      const body = (await response.json().catch(() => ({}))) as {
        message?: string;
      };
      setProblem(body.message ?? "signing up did not complete");
    } catch {
      setProblem("egma could not be reached. Is the API running?");
    } finally {
      setSubmitting(false);
    }
  }

  if (availability === null) {
    return <StatePage title="Loading egma" lead="Checking whether this instance is ready for setup." />;
  }

  if (!availability.open) {
    return (
      <StatePage
        title="This egma has been claimed"
        lead={
          availability.message ??
          "Somebody has already set this instance up. Ask them for an invitation."
        }
      >
        <p className={styles.linkLine}>
          Already have an account?{" "}
          <a
            href={
              returnTo === null ? "/sign-in" : withReturnTo("/sign-in", returnTo)
            }
          >
            Sign in
          </a>
          .
        </p>
      </StatePage>
    );
  }

  return (
    <AuthShell
      eyebrow="First setup"
      title="Set up egma"
      lead="One step. Your organization and your first project are created together."
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
            onChange={(event) => onEmailChange(event.target.value)}
          />
        </Field>

        <Field label="Password" htmlFor="password">
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

        <Field label="Organization" hint="Filled in from your email. Change it if you like." htmlFor="organizationName">
          <input
            className={styles.input}
            id="organizationName"
            name="organizationName"
            required
            value={organizationName}
            onChange={(event) => {
              setOrganizationEdited(true);
              setOrganizationName(event.target.value);
            }}
          />
        </Field>

        <Field label="First project" htmlFor="projectName">
          <input
            className={styles.input}
            id="projectName"
            name="projectName"
            required
            value={projectName}
            onChange={(event) => setProjectName(event.target.value)}
          />
        </Field>

        <button className={styles.button} type="submit" disabled={submitting}>
          {submitting ? "Setting up…" : "Create my egma"}
        </button>
      </form>

      <p className={styles.linkLine}>
        Already have an account?{" "}
        <a
          href={returnTo === null ? "/sign-in" : withReturnTo("/sign-in", returnTo)}
        >
          Sign in
        </a>
        .
      </p>
    </AuthShell>
  );
}
