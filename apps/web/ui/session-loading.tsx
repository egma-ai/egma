"use client";

/**
 * The one screen egma shows while it does not yet know who is here.
 *
 * **It guesses nothing.** Opening the product used to draw the signed-in shell
 * — sidebar, navigation, account menu — over the sentence "Checking your
 * session", and replace the whole of it a moment later. Somebody signed out
 * met a dashboard that was never theirs; somebody signed in met a page saying
 * egma was unsure. Both are a screen chosen before the answer arrived. This is
 * what stands there instead, at all four points where the session is
 * unresolved or changing: opening the product, the route fallback under it,
 * signing in, and signing out.
 *
 * **The mark is still.** `DESIGN.md` forbids animating the logo, so what moves
 * is a separate indicator under it — the "fast, quiet indicator" that file
 * gives a loading state — and its motion lives in `tailwind-theme.css` beside
 * the run mark's turn, keyed on the `session-progress` slot below.
 *
 * It carries `route-loading` so it inherits that file's wait before drawing: a
 * session that answers inside `--duration-popover-in` is never covered by this
 * at all, because a screen that appears and vanishes inside a fifth of a second
 * reads as a fault rather than as speed.
 *
 * `fixed` rather than a page layout, so the same component is both the whole of
 * an entrance and the cover over a shell that is being signed out of.
 */
export function SessionLoading({ label }: { readonly label: string }) {
  return (
    <div
      data-slot="route-loading"
      className="fixed inset-0 z-50 grid place-items-center bg-background px-6"
      role="status"
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
           * Empty on purpose. The whole screen is one `status`, and the
           * sentence below is what it announces — a second name here would
           * have a screen reader read the product's name and then the same
           * name again inside what is happening to it.
           */
          alt=""
          height={32}
        />
        <span
          data-slot="session-progress"
          className="block h-0.5 w-40 overflow-hidden bg-border"
          aria-hidden="true"
        >
          <span className="block h-full w-1/3 bg-brand" />
        </span>
        <span className="sr-only">{label}</span>
      </div>
    </div>
  );
}
