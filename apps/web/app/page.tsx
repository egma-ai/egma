"use client";

import { useEffect, useState } from "react";

import { readJson, type Answer } from "../lib/api.ts";
import { firstProjectOf, type Me } from "../lib/me.ts";
import { projectLanding } from "../lib/project-context.ts";
import { Button } from "../ui/controls.tsx";
import { ProductStatePage } from "../ui/shell.tsx";

/**
 * The root address is an entrance, not a second product page.
 *
 * A current session enters the product at **Agents**, under the first project
 * its membership reaches — you start with the system you are testing, and a
 * generic home page would be a page with nothing on it. Everybody else reaches
 * the sign-in page directly instead of first opening a protected page and
 * finding a sign-in link there.
 *
 * **This is the one address that chooses a project for you**, and it is the
 * right one to: an entrance with nothing in it has to pick a door. Every
 * address it sends somebody to names its project explicitly from then on, so
 * the choice is made once, in the open, and lands in the address bar where a
 * person can see it and change it.
 */
export default function RootPage() {
  const [attempt, setAttempt] = useState(0);
  const [answer, setAnswer] = useState<Answer<Me> | null>(null);

  useEffect(() => {
    let current = true;
    setAnswer(null);

    void readJson<Me>("/api/me").then((next) => {
      if (!current) return;

      if (next.status === "signed-out") {
        window.location.replace("/sign-in");
        return;
      }

      if (next.status === "ready") {
        const first = firstProjectOf(next.value);
        if (first !== undefined) {
          window.location.replace(projectLanding(first.id));
          return;
        }
      }

      setAnswer(next);
    });

    return () => {
      current = false;
    };
  }, [attempt]);

  if (answer === null || answer.status === "signed-out") {
    return (
      <ProductStatePage
        title="Opening egma"
        lead="Checking your session."
      />
    );
  }

  /**
   * Signed in, and in an organization that holds no project. Signup provisions
   * one, so this is a rare state — but an organization can only be *given* a
   * project by an admin, and a person who is not one has to be told that rather
   * than left on a product shell with nothing in it.
   */
  if (answer.status === "ready") {
    return (
      <ProductStatePage
        eyebrow="Organization"
        title="This organization has no project yet"
        lead="Tests, agents, personas and graders all live in a project. An organization admin can create the first one in organization settings."
      />
    );
  }

  return (
    <ProductStatePage
      title="Egma could not be reached."
      lead={answer.refusal.message}
    >
      <Button onClick={() => setAttempt((one) => one + 1)}>Try again</Button>
    </ProductStatePage>
  );
}
