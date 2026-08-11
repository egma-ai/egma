"use client";

import { useEffect, useState } from "react";

import { StatePage, styles } from "./ui.tsx";

/**
 * The root address is an entrance, not a second product page.
 *
 * A current session enters the transcript list. Everybody else reaches the
 * sign-in page directly instead of first opening a protected page and finding
 * a sign-in link there.
 */
export default function RootPage() {
  const [attempt, setAttempt] = useState(0);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let current = true;
    setFailed(false);

    void fetch("/api/me", { cache: "no-store" })
      .then((response) => {
        if (!current) return;
        if (response.status === 401) {
          window.location.replace("/sign-in");
          return;
        }
        if (response.ok) {
          window.location.replace("/traces");
          return;
        }
        setFailed(true);
      })
      .catch(() => {
        if (current) setFailed(true);
      });

    return () => {
      current = false;
    };
  }, [attempt]);

  return (
    <StatePage
      title={failed ? "Egma could not be reached." : "Opening egma"}
      lead={failed ? "Check the API, then try again." : "Checking your session."}
    >
      {failed ? (
        <button
          className={styles.button}
          type="button"
          onClick={() => setAttempt((one) => one + 1)}
        >
          Try again
        </button>
      ) : null}
    </StatePage>
  );
}
