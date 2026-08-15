"use client";

import { useCallback, useEffect, useState } from "react";

import { readJson, type Answer } from "../lib/api.ts";

/**
 * One read that names **no project**, with the same four answers every product
 * read has and a way to ask again.
 *
 * **Its own hook rather than `useProjectRead` with the project left off**, and
 * the difference is the whole point: that one exists so a product page cannot
 * forget to say which project it is asking about. Members, invitations, API
 * keys, the organization itself and the list of projects are not asked about a
 * project — they belong to the customer — and sending `?project=` with them
 * would put a claim in the request that the route does not read and that is not
 * true.
 *
 * `null` is still loading, on the same terms: an answer is something egma said,
 * and "nothing yet" is not.
 */
export function useOrganizationRead<T>(path: string): {
  readonly answer: Answer<T> | null;
  readonly reload: () => void;
} {
  const [answer, setAnswer] = useState<Answer<T> | null>(null);
  const [attempt, setAttempt] = useState(0);

  const reload = useCallback(() => {
    setAnswer(null);
    setAttempt((one) => one + 1);
  }, []);

  useEffect(() => {
    let current = true;
    setAnswer(null);

    void readJson<T>(path).then((next) => {
      if (current) setAnswer(next);
    });

    return () => {
      current = false;
    };
  }, [path, attempt]);

  return { answer, reload };
}
