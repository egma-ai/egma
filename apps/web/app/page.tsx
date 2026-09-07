"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import type { Answer } from "../lib/api.ts";
import { firstProjectOf, readSession, roleOf, type Me } from "../lib/me.ts";
import { projectLanding } from "../lib/project-context.ts";
import { NEW_PROJECT_PATH } from "../lib/settings.ts";
import { Actions } from "../ui/section.tsx";
import { SessionLoading } from "../ui/session-loading.tsx";
import { ProductStatePage } from "../ui/shell.tsx";

/**
 * Resolve the session at the root, then redirect to the first accessible
 * project's landing page or sign-in. Subsequent product URLs carry the project ID.
 */
export default function RootPage() {
  const router = useRouter();
  const [attempt, setAttempt] = useState(0);
  const [answer, setAnswer] = useState<Answer<Me> | null>(null);

  useEffect(() => {
    let current = true;
    setAnswer(null);

    /*
     * Bounded, for the reason the shell's own read is: the branch below
     * covers the whole document and makes it inert, so a read that never
     * answers would be a page nobody can touch rather than one saying it
     * could not reach egma. Running out lands on the failure state, which
     * has a way to try again.
     */
    void readSession().then((next) => {
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

  /*
   * Keep the entrance covered until its redirect completes. The shared shell
   * may finish its session read before this page has navigated.
   */
  if (answer === null || answer.status === "signed-out") {
    return <SessionLoading label="Opening Egma" />;
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
          * The control is wrapped, and a screenshot is what asked for it.
          * `ProductStatePage` puts whatever it is given straight into the
          * page body, which is a column — so a lone button stretched to the
          * full width of the page and stopped looking like a button at all.
          * `Actions` is the shared group a page's controls stand in.
          */}
        {/*
         * Use a disabled button for users who cannot create projects. aria-disabled
         * on an anchor alone would not prevent navigation.
         */}
        <Actions>
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
        </Actions>
      </ProductStatePage>
    );
  }

  return (
    <ProductStatePage
      title="Egma could not be reached."
      lead={answer.refusal.message}
    >
      <Actions>
        <Button
          type="button"
          variant="secondary"
          onClick={() => setAttempt((one) => one + 1)}
        >
          Try again
        </Button>
      </Actions>
    </ProductStatePage>
  );
}
