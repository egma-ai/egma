"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";

/**
 * Cover unresolved session state with a static logo, status text, and separate
 * progress indicator. Mount through a body portal without the usual route
 * loading delay. Existing body siblings become inert until the last cover closes.
 */
/**
 * Reference-count overlapping covers. The first records elements it makes
 * inert; the last restores only those elements, preserving preexisting inert state.
 */
let covers = 0;
let marked: readonly Element[] = [];

function takeCover(): void {
  covers += 1;
  if (covers > 1) return;

  // Read before the caller's host joins the document, so a cover's own node is
  // never in the list — and anything already inert for a reason of its own is
  // left exactly as it was.
  marked = [...document.body.children].filter(
    (one) => !one.hasAttribute("inert"),
  );
  for (const one of marked) one.setAttribute("inert", "");
}

function releaseCover(): void {
  covers -= 1;
  if (covers > 0) return;

  for (const one of marked) one.removeAttribute("inert");
  marked = [];
}

export function SessionLoading({ label }: { readonly label: string }) {
  const [host, setHost] = useState<HTMLElement | null>(null);

  useEffect(() => {
    takeCover();

    const node = document.createElement("div");
    node.dataset.slot = "session-loading-host";
    document.body.append(node);
    setHost(node);

    return () => {
      node.remove();
      releaseCover();
    };
  }, []);

  if (host === null) return null;

  return createPortal(
    <div
      data-slot="session-loading"
      className="fixed inset-0 z-50 grid place-items-center bg-background px-6"
      role="status"
      aria-busy="true"
    >
      <div className="flex flex-col items-center gap-6">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          /*
           * Sized by its own viewBox, exactly as the access surface's `Brand`
           * and the sidebar's mark are: a width in the class list would be a
           * second declaration of the logo's proportion.
           */
          className="block h-8 w-auto [[data-theme=dark]_&]:invert"
          src="/brand/egma-wordmark.svg"
          /*
           * Empty on purpose. The line below says what is happening, and a
           * name here would have a screen reader read the product's name and
           * then the same name again inside the sentence about it.
           */
          alt=""
          height={32}
        />
        <div className="flex flex-col items-center gap-3">
          <span
            data-slot="session-progress"
            className="block h-0.5 w-40 overflow-hidden bg-border"
            aria-hidden="true"
          >
            <span className="block h-full w-1/3 bg-foreground" />
          </span>
          <p className="m-0 text-sm text-muted-foreground">{label}</p>
        </div>
      </div>
    </div>,
    host,
  );
}
