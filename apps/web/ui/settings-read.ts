"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

import type { Answer } from "../lib/api.ts";

const DISCARD_DRAFT = "Discard your unsaved changes?";
let protectedDrafts = 0;
let busyDrafts = 0;
let confirmedThisTurn = false;

export type DraftState = "unchanged" | "unsaved" | "saving";

/** The strongest draft state currently held anywhere in the product shell. */
export function currentDraftState(): DraftState {
  if (busyDrafts > 0) return "saving";
  if (protectedDrafts > 0) return "unsaved";
  return "unchanged";
}

/** Native fallback for a control rendered outside the product shell. */
export function confirmUnsavedNavigation(): boolean {
  // A person may choose to discard a local draft. They cannot choose to make
  // an unsettled write safe: leaving while it is in flight can hide whether
  // the server accepted it, so in-product navigation waits without asking.
  if (busyDrafts > 0) return false;
  if (protectedDrafts === 0) return true;
  const confirmed = globalThis.confirm(DISCARD_DRAFT);
  if (confirmed) {
    // A plain same-origin anchor can unload before React removes this hook. Do
    // not follow an accepted in-product question with the browser's second
    // question. Reset if the navigation does not happen.
    confirmedThisTurn = true;
    globalThis.setTimeout(() => {
      confirmedThisTurn = false;
    }, 0);
  }
  return confirmed;
}

function protectUnload(event: BeforeUnloadEvent): void {
  if (
    protectedDrafts === 0 ||
    (confirmedThisTurn && busyDrafts === 0)
  ) {
    return;
  }
  event.preventDefault();
  event.returnValue = "";
}

function beginProtectingDraft(busy: boolean): () => void {
  protectedDrafts += 1;
  if (busy) busyDrafts += 1;
  if (protectedDrafts === 1) {
    globalThis.addEventListener("beforeunload", protectUnload);
  }

  return () => {
    protectedDrafts = Math.max(0, protectedDrafts - 1);
    if (busy) busyDrafts = Math.max(0, busyDrafts - 1);
    if (protectedDrafts === 0) {
      globalThis.removeEventListener("beforeunload", protectUnload);
    }
  };
}

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
export function useOrganizationRead<T>(read: () => Promise<Answer<T>>): {
  readonly answer: Answer<T> | null;
  readonly reload: () => void;
} {
  const [answer, setAnswer] = useState<Answer<T> | null>(null);
  const [attempt, setAttempt] = useState(0);
  const readNow = useRef(read);
  readNow.current = read;

  const reload = useCallback(() => {
    setAnswer(null);
    setAttempt((one) => one + 1);
  }, []);

  useEffect(() => {
    let current = true;
    setAnswer(null);

    void readNow.current().then((next) => {
      if (current) setAnswer(next);
    });

    return () => {
      current = false;
    };
  }, [attempt]);

  return { answer, reload };
}

/**
 * Keep an in-product link, a project switch, a reload, or a closed tab from
 * silently throwing an editable product draft away.
 *
 * The browser owns the warning for reload, tab close, and external unload.
 * Same-origin product navigation uses the shared Egma dialog instead. A busy
 * write blocks in-product navigation because there is no safe discard decision
 * while its result is unknown. Callers turn protection off after the draft or
 * write is safe. The return value lets an editor show its state if that helps.
 */
export function useUnsavedChanges(
  unsaved: boolean,
  busy = false,
): DraftState {
  // Install the capture listener before the browser paints the changed field.
  // A quick click on a breadcrumb must not fit between a draft becoming dirty
  // and its protection becoming active.
  useLayoutEffect(() => {
    if (!unsaved && !busy) return;
    return beginProtectingDraft(busy);
  }, [busy, unsaved]);

  return busy ? "saving" : unsaved ? "unsaved" : "unchanged";
}
