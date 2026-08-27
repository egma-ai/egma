"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";

/**
 * The one screen egma shows while it does not yet know who is here.
 *
 * **It guesses nothing.** Opening the product used to draw the signed-in shell
 * — sidebar, navigation, account menu — over the sentence "Checking your
 * session", and replace the whole of it a moment later. Somebody signed out
 * met a dashboard that was never theirs; somebody signed in met a page saying
 * egma was unsure. Both are a screen chosen before the answer arrived. This is
 * what stands there instead, everywhere the session is unresolved or changing:
 * the entrance, any product address on a cold load, signing in, signing up,
 * and signing out.
 *
 * **The mark is still.** `DESIGN.md` forbids animating the logo, so what moves
 * is a separate indicator under it — the "fast, quiet indicator" that file
 * gives a loading state — and its motion lives in `tailwind-theme.css` beside
 * the run mark's turn, keyed on the `session-progress` slot below. The segment
 * is ink rather than the brand orange, which is the ruling `progress.tsx`
 * already wrote down for the one other bar in this product that fills.
 *
 * **It says what it is waiting for.** A wordmark and a moving bar alone are a
 * screen with no words on it, and `DESIGN.md` asks every state to say what
 * happened. The line is short, quiet, and different on each moment, because
 * they are different waits.
 *
 * **It is opaque on its first frame**, and deliberately does not take the wait
 * every other loading state here takes. A route fallback fades in after
 * `--duration-popover-in` so a warm route is never covered by a box that
 * appears and vanishes. This one has the opposite job: a shell is mounted
 * behind it, so a screen that spent a fifth of a second transparent would show
 * exactly the guess it exists to cover.
 *
 * **It leaves the document behind it, and takes it out of reach.** The cover
 * goes to the end of `document.body` so nothing anchored inside the shell — a
 * sticky sidebar at `z-20`, a sheet at `z-30`, a toast at `z-50` — floats over
 * it. Everything else in the body goes `inert` while it stands, because a
 * control hidden from eyes and still reachable by Tab or by a screen reader is
 * worse than one that is simply there. That is the trade a dialog already
 * makes.
 */
export function SessionLoading({ label }: { readonly label: string }) {
  const [host, setHost] = useState<HTMLElement | null>(null);

  useEffect(() => {
    // Read before appending, so the cover's own host is never in the list, and
    // anything already inert for another reason is left exactly as it was.
    const covered = [...document.body.children].filter(
      (one) => !one.hasAttribute("inert"),
    );
    for (const one of covered) one.setAttribute("inert", "");

    const node = document.createElement("div");
    node.dataset.slot = "session-loading-host";
    document.body.append(node);
    setHost(node);

    return () => {
      for (const one of covered) one.removeAttribute("inert");
      node.remove();
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
