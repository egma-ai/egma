"use client";

import { useCallback, useEffect, useState } from "react";

import { readJson, type Answer } from "../lib/api.ts";

const DISCARD_DRAFT = "Discard your unsaved Settings changes?";
let protectedDrafts = 0;
let confirmedThisTurn = false;

/** Ask once before an in-product control changes the current address. */
export function confirmUnsavedSettingsNavigation(): boolean {
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
  if (protectedDrafts === 0 || confirmedThisTurn) return;
  event.preventDefault();
  event.returnValue = "";
}

function protectSameOriginLink(event: MouseEvent): void {
  if (
    protectedDrafts === 0 ||
    event.defaultPrevented ||
    event.button !== 0 ||
    event.metaKey ||
    event.ctrlKey ||
    event.shiftKey ||
    event.altKey ||
    !(event.target instanceof Element)
  ) {
    return;
  }

  const link = event.target.closest<HTMLAnchorElement>("a[href]");
  if (
    link === null ||
    link.target === "_blank" ||
    link.hasAttribute("download")
  ) {
    return;
  }

  const here = new URL(globalThis.location.href);
  const next = new URL(link.getAttribute("href") ?? link.href, here);
  if (next.origin !== here.origin) return;
  if (next.pathname === here.pathname && next.search === here.search) {
    return;
  }

  if (confirmUnsavedSettingsNavigation()) return;
  event.preventDefault();
  event.stopPropagation();
}

function beginProtectingDraft(): () => void {
  protectedDrafts += 1;
  if (protectedDrafts === 1) {
    globalThis.addEventListener("beforeunload", protectUnload);
    document.addEventListener("click", protectSameOriginLink, true);
  }

  return () => {
    protectedDrafts = Math.max(0, protectedDrafts - 1);
    if (protectedDrafts === 0) {
      globalThis.removeEventListener("beforeunload", protectUnload);
      document.removeEventListener("click", protectSameOriginLink, true);
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

/**
 * Keep an in-product link, a project switch, a reload, or a closed tab from
 * silently throwing a Settings draft away.
 *
 * Browsers own the warning text, so this does not promise wording that they do
 * not let a product control. In-product navigation uses one short product
 * question instead. Callers turn protection off while a save is in flight and
 * after the saved answer comes back.
 */
export function useUnsavedChanges(unsaved: boolean): void {
  useEffect(() => {
    if (!unsaved) return;
    return beginProtectingDraft();
  }, [unsaved]);
}
