"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { readJson, type Answer } from "../../lib/api.ts";
import { firstProjectOf, type Me } from "../../lib/me.ts";
import { NEW_PROJECT_PATH } from "../../lib/settings.ts";
import { Button } from "../../ui/controls.tsx";
import { settingsPath } from "../../ui/settings-nav.tsx";
import { ProductStatePage } from "../../ui/shell.tsx";

/**
 * Where organization settings used to be, and where they are now.
 *
 * **This address is kept rather than removed**, because it is the one people
 * have bookmarked, the one an older account menu linked to, and the one the
 * acceptance journey walks in on. Settings moved into the product shell so that
 * the project selector stays on screen throughout it — every Settings page now
 * lives under a project, including the pages whose subject is the whole
 * organization — and an address that named no project could not serve that.
 *
 * So this reads the session, finds the project a Settings page can be drawn
 * under, and goes there. An organization that holds no project has nowhere to
 * draw one, and is sent to make its first instead.
 */
export default function MembersPage() {
  const router = useRouter();
  const [answer, setAnswer] = useState<Answer<Me> | null>(null);
  const [attempt, setAttempt] = useState(0);

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
        router.replace(
          first === undefined
            ? NEW_PROJECT_PATH
            : settingsPath(first.id, "people"),
        );
        return;
      }

      setAnswer(next);
    });

    return () => {
      current = false;
    };
  }, [attempt, router]);

  if (answer === null || answer.status === "ready") {
    return (
      <ProductStatePage
        eyebrow="Settings"
        title="Opening organization settings"
        lead="People and invitations moved into the product shell, beside the project selector."
      />
    );
  }

  return (
    <ProductStatePage
      eyebrow="Settings"
      title="Egma could not be reached."
      lead={
        answer.status === "signed-out"
          ? "Your session has ended. Sign in and try again."
          : answer.refusal.message
      }
    >
      <Button onClick={() => setAttempt((one) => one + 1)}>Try again</Button>
    </ProductStatePage>
  );
}
