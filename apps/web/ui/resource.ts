"use client";

import { useCallback, useEffect, useState } from "react";

import { readJson, type Answer } from "../lib/api.ts";

/**
 * One product read, with its four answers and a way to ask again.
 *
 * **Every product request names its project**, which is the whole point of this
 * hook existing rather than each page calling `fetch`. A page cannot forget the
 * project, and a page cannot invent a second way of deciding what a 404 means.
 *
 * `null` is still loading. It is deliberately not a fifth `Answer` variant: an
 * answer is something egma said, and "nothing yet" is not.
 */
export function useProjectRead<T>(
  path: string,
  project: string | null,
): {
  readonly answer: Answer<T> | null;
  readonly reload: () => void;
  /** Ask again without replacing the current page with a loading state. */
  readonly refresh: () => void;
} {
  const [answer, setAnswer] = useState<Answer<T> | null>(null);
  const [attempt, setAttempt] = useState({ number: 0, quiet: false });

  const reload = useCallback(() => {
    setAnswer(null);
    setAttempt((one) => ({ number: one.number + 1, quiet: false }));
  }, []);

  const refresh = useCallback(() => {
    setAttempt((one) => ({ number: one.number + 1, quiet: true }));
  }, []);

  useEffect(() => {
    if (project === null) return undefined;
    let current = true;
    if (!attempt.quiet) setAnswer(null);

    void readJson<T>(path, { project }).then((next) => {
      if (current) setAnswer(next);
    });

    return () => {
      current = false;
    };
  }, [path, project, attempt]);

  return { answer, reload, refresh };
}
