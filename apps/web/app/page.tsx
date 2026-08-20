"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { readJson, type Answer } from "../lib/api.ts";
import { firstProjectOf, roleOf, type Me } from "../lib/me.ts";
import { projectLanding } from "../lib/project-context.ts";
import { NEW_PROJECT_PATH } from "../lib/settings.ts";
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
  const router = useRouter();
  const [attempt, setAttempt] = useState(0);
  const [answer, setAnswer] = useState<Answer<Me> | null>(null);

  useEffect(() => {
    let current = true;
    setAnswer(null);

    void readJson<Me>("/api/me").then((next) => {
      if (!current) return;

      if (next.status === "signed-out") {
        router.replace("/sign-in");
        return;
      }

      if (next.status === "ready") {
        const first = firstProjectOf(next.value);
        if (first !== undefined) {
          router.replace(projectLanding(first.id));
          return;
        }
      }

      setAnswer(next);
    });

    return () => {
      current = false;
    };
  }, [attempt, router]);

  if (answer === null || answer.status === "signed-out") {
    return (
      <ProductStatePage
        title="Opening Egma"
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
    const role = roleOf(answer.value);
    return (
      <ProductStatePage
        eyebrow="Organization"
        title="This organization has no project yet"
        lead="Agents, tests, personas, graders and runs all live in a project. Making one is the first step, and it takes a name."
      >
        {/*
          * A way forward rather than a dead end. Signup provisions a project, so
          * an organization reaching this state is rare — and the person looking
          * at it is standing in front of a product shell with nothing in it,
          * which is exactly when being told what to do next matters. A viewer
          * or a member sees the same control, genuinely disabled, and the
          * sentence that says who to ask.
          *
          * **A disabled control is genuinely inert or it is a lie.** A link
          * cannot be disabled: `aria-disabled` on an anchor greys it out and it
          * still follows on click and still takes the keyboard. So when this is
          * not theirs it stops being a link and becomes a disabled button,
          * which carries the reason where a keyboard and a screen reader can
          * reach it.
          */}
        {role === "admin" ? (
          <Button asChild>
            <Link href={NEW_PROJECT_PATH}>Create the first project</Link>
          </Button>
        ) : (
          <Button
            type="button"
            disabled
            why={`Your ${role} role cannot create a project. Ask an organization admin to make the first one.`}
          >
            Create the first project
          </Button>
        )}
      </ProductStatePage>
    );
  }

  return (
    <ProductStatePage
      title="Egma could not be reached."
      lead={answer.refusal.message}
    >
      <Button
        type="button"
        variant="secondary"
        onClick={() => setAttempt((one) => one + 1)}
      >
        Try again
      </Button>
    </ProductStatePage>
  );
}
