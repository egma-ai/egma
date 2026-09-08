"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

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
  if (protectedDrafts === 0 || (confirmedThisTurn && busyDrafts === 0)) {
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
 * Read organization-scoped settings without adding project context. null
 * means pending; expose the shared Answer states and a reload action.
 */
export function useOrganizationRead<T>(read: () => Promise<Answer<T>>): {
  readonly answer: Answer<T> | null;
  readonly reload: () => void;
  readonly refresh: () => void;
} {
  const [answer, setAnswer] = useState<Answer<T> | null>(null);
  const [attempt, setAttempt] = useState({ number: 0, quiet: false });
  const readNow = useRef(read);
  readNow.current = read;

  const reload = useCallback(() => {
    setAnswer(null);
    setAttempt((one) => ({ number: one.number + 1, quiet: false }));
  }, []);

  const refresh = useCallback(() => {
    setAttempt((one) => ({ number: one.number + 1, quiet: true }));
  }, []);

  useEffect(() => {
    let current = true;
    if (!attempt.quiet) setAnswer(null);

    void readNow.current().then((next) => {
      if (current) setAnswer(next);
    });

    return () => {
      current = false;
    };
  }, [attempt]);

  return { answer, reload, refresh };
}

/**
 * Protect dirty drafts with the browser unload prompt and the shared in-app
 * navigation dialog. Busy writes block guarded navigation while their result
 * is unknown. Callers disable protection after successful save or discard.
 */
export function useUnsavedChanges(unsaved: boolean, busy = false): DraftState {
  // Install the capture listener before the browser paints the changed field.
  // A quick click on a breadcrumb must not fit between a draft becoming dirty
  // and its protection becoming active.
  useLayoutEffect(() => {
    if (!unsaved && !busy) return;
    return beginProtectingDraft(busy);
  }, [busy, unsaved]);

  return busy ? "saving" : unsaved ? "unsaved" : "unchanged";
}
