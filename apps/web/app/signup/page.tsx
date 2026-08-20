"use client";

import { useEffect, useId, useState } from "react";

import {
  DEFAULT_SIGNED_IN_PATH,
  returnPathIn,
  withReturnTo,
} from "../../lib/return-to.ts";
import {
  DEFAULT_PROJECT_NAME,
  organizationNameFromEmail,
} from "../../lib/signup-defaults.ts";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

import { Field } from "../../ui/controls.tsx";
import { AuthForm, AuthShell, LinkLine, Notice, StatePage } from "../ui.tsx";

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
  /*
   * The hint's own id, held here rather than inside `Field`.
   *
   * A hint nothing points at is a hint only a sighted reader ever gets, and the
   * base input is a plain `<input>` that reads no context. So the page that
   * writes the sentence is the page that names it, and the two cannot drift.
   */
  const organizationHint = useId();
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

  async function submit(): Promise<void> {
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
      setProblem("Egma could not be reached. Is the API running?");
    } finally {
      setSubmitting(false);
    }
  }

  if (availability === null) {
    return (
      <StatePage
        animated
        title="Loading Egma"
        lead="Checking whether this instance is ready for setup."
      />
    );
  }

  if (!availability.open) {
    return (
      <StatePage
        animated
        title="Ask an admin for an invitation to this Egma instance."
      >
        <LinkLine>
          Already have an account?{" "}
          <a
            href={
              returnTo === null ? "/sign-in" : withReturnTo("/sign-in", returnTo)
            }
          >
            Sign in
          </a>
          .
        </LinkLine>
      </StatePage>
    );
  }

  return (
    <AuthShell
      animated
      eyebrow="First setup"
      title="Set up Egma"
      lead="One step. Your organization and your first project are created together."
    >
      <AuthForm onSubmit={() => void submit()}>
        {problem === null ? null : <Notice tone="error">{problem}</Notice>}

        <Field label="Email" htmlFor="email">
          <Input
            id="email"
            name="email"
            type="email"
            autoComplete="email"
            spellCheck={false}
            required
            value={email}
            onChange={(event) => onEmailChange(event.target.value)}
          />
        </Field>

        <Field label="Password" htmlFor="password">
          <Input
            id="password"
            name="password"
            type="password"
            autoComplete="new-password"
            spellCheck={false}
            required
            minLength={8}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        </Field>

        <Field label="Organization" htmlFor="organizationName">
          <Input
            id="organizationName"
            name="organizationName"
            autoComplete="off"
            spellCheck={false}
            required
            aria-describedby={organizationHint}
            value={organizationName}
            onChange={(event) => {
              setOrganizationEdited(true);
              setOrganizationName(event.target.value);
            }}
          />
          <p className="m-0 text-sm text-faint" id={organizationHint}>
            Filled in from your email. Change it if you like.
          </p>
        </Field>

        <Field label="First project" htmlFor="projectName">
          <Input
            id="projectName"
            name="projectName"
            autoComplete="off"
            spellCheck={false}
            required
            value={projectName}
            onChange={(event) => setProjectName(event.target.value)}
          />
        </Field>

        <Button type="submit" disabled={submitting}>
          {submitting ? "Setting up…" : "Create my Egma instance"}
        </Button>
      </AuthForm>

      <LinkLine>
        Already have an account?{" "}
        <a
          href={returnTo === null ? "/sign-in" : withReturnTo("/sign-in", returnTo)}
        >
          Sign in
        </a>
        .
      </LinkLine>
    </AuthShell>
  );
}
