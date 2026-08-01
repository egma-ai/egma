"use client";

import { useEffect, useState } from "react";

import {
  DEFAULT_PROJECT_NAME,
  organizationNameFromEmail,
} from "../../lib/signup-defaults.ts";
import { Card, styles } from "../ui.tsx";

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
        window.location.assign("/");
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
    return <Card title="egma">Loading…</Card>;
  }

  if (!availability.open) {
    return (
      <Card
        title="This egma has been claimed"
        lead={
          availability.message ??
          "Somebody has already set this instance up. Ask them for an invitation."
        }
      >
        <p style={styles.aside}>
          Already have an account? <a href="/sign-in">Sign in</a>.
        </p>
      </Card>
    );
  }

  return (
    <Card
      title="Set up egma"
      lead="One step. Your organization and your first project are created together."
    >
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
            onChange={(event) => onEmailChange(event.target.value)}
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
            autoComplete="new-password"
            required
            minLength={8}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        </div>

        <div style={styles.field}>
          <label style={styles.label} htmlFor="organizationName">
            Organization
            <span style={styles.hint}>Filled in from your email. Change it if you like.</span>
          </label>
          <input
            style={styles.input}
            id="organizationName"
            name="organizationName"
            required
            value={organizationName}
            onChange={(event) => {
              setOrganizationEdited(true);
              setOrganizationName(event.target.value);
            }}
          />
        </div>

        <div style={styles.field}>
          <label style={styles.label} htmlFor="projectName">
            First project
          </label>
          <input
            style={styles.input}
            id="projectName"
            name="projectName"
            required
            value={projectName}
            onChange={(event) => setProjectName(event.target.value)}
          />
        </div>

        <button style={styles.button} type="submit" disabled={submitting}>
          {submitting ? "Setting up…" : "Create my egma"}
        </button>
      </form>

      <p style={styles.aside}>
        Already have an account? <a href="/sign-in">Sign in</a>.
      </p>
    </Card>
  );
}
