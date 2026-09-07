"use client";

import type { ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

/**
 * What a page shows when it is not showing its data.
 *
 * Loading, empty, failed and not-found are four different sentences and they
 * must never be collapsed into one. "Nothing here" and "egma could not answer"
 * point somebody in opposite directions, and a spinner that stays forever
 * because a request failed is the worst of the four.
 *
 * Every state is the same component with a different tone, so a page that
 * grows a fifth state cannot invent a fifth appearance for it.
 *
 * The tone is also on the element as `data-tone`, because the appearance is now
 * a class list rather than a named module class. A page under test, or a person
 * reading the inspector, can still ask which of the four this is.
 */

export type StateTone = "quiet" | "plain" | "bad";

function PageState({
  tone = "plain",
  title,
  lead,
  action,
  children,
}: {
  readonly tone?: StateTone;
  readonly title: string;
  readonly lead?: ReactNode;
  readonly action?: ReactNode;
  /**
   * What a state draws under its sentence, and internal on purpose: only
   * `Loading` has anything to put there. There is deliberately no way to pass
   * classes in — the four states below are the whole vocabulary, and a page
   * that could restyle one could invent a fifth appearance, which is the one
   * thing this component exists to stop.
   */
  readonly children?: ReactNode;
}) {
  return (
    <section
      data-slot="page-state"
      data-tone={tone}
      className={cn(
        "flex flex-col items-start gap-3 text-left",
        "rounded-card border border-border bg-surface px-8 py-10",
        "max-[900px]:px-5 max-[900px]:py-8",
        /*
         * Quiet is an outline around an absence that is about to be filled:
         * nothing is raised off the page. `Loading` is its only caller — an
         * empty list is not an absence egma caused, and it draws its own card.
         */
        tone === "quiet" && "border-dashed bg-transparent",
      )}
      role={tone === "bad" ? "alert" : "status"}
    >
      <h2
        className={cn("m-0 text-lg font-medium", tone === "bad" && "text-failure")}
      >
        {title}
      </h2>
      {lead === undefined ? null : (
        <p className="m-0 max-w-[62ch] text-base text-muted-foreground">{lead}</p>
      )}
      {children}
      {action}
    </section>
  );
}

/**
 * Waiting on egma. It says what it is waiting for, not just that it is waiting.
 *
 * **The sentence is the state; the bars are the proof it is still running.**
 * `DESIGN.md` asks a loading state for a "fast, quiet indicator", and a page
 * that only wrote "Loading agents…" and then held perfectly still could not be
 * told from one that had given up. Three neutral bars breathing under the
 * sentence say the wait is alive. They are `aria-hidden`, because the sentence
 * above them is already announced by this section's `role="status"` and a
 * screen reader gains nothing from three rectangles.
 *
 * **No motion is written here, and the slot names are why.** The wait before
 * this appears, the breath in the bars and the phase between them are all in
 * `tailwind-theme.css`, under the same `DESIGN.md` rule as the run state
 * mark's turn and keyed on the two names this component publishes:
 * `page-state` on the section and `loading-indicator` on the group below. That
 * is what lets one rule treat a route fallback, the card inside it and the
 * bars inside that as a single arrival rather than three overlapping ones —
 * something three separate class lists could never agree on.
 *
 * Nothing here flashes on a fast read, and reduced motion keeps the meaning:
 * both are properties of those rules, and both are argued where they live.
 */
export function Loading({ what }: { readonly what: string }) {
  return (
    <PageState tone="quiet" title={`Loading ${what}…`}>
      <div
        data-slot="loading-indicator"
        className="flex w-full flex-col gap-2"
        aria-hidden="true"
      >
        <Skeleton className="h-3 w-64 max-w-full" />
        <Skeleton className="h-3 w-48 max-w-full" />
        <Skeleton className="h-3 w-32 max-w-full" />
      </div>
    </PageState>
  );
}

/**
 * There is nothing here, and that is a fact about the project, not a fault.
 *
 * **It is drawn here rather than through `PageState`, and the reason is what
 * the four states are about.** Loading, failed and not-available are about
 * *egma* — a wait, a refusal, an address that leads nowhere. They interrupt,
 * so they are set apart from the page. An empty list is about the *project*:
 * it is the ordinary first day of a list nobody has written to yet, it belongs
 * on the page, and it is the one state that offers an action.
 *
 * `AN8-0` (page `B-0`) draws exactly that and it is what this matches, value
 * for value: a solid `--surface` card inside one `--border` hairline with no
 * corner, 40px of padding, a 16px weight-500 title over one 14px sentence at
 * the board's measure, and the primary action under them as the wash button.
 * The dashed outline and 24px heading it wore before said "something has gone
 * wrong here", which is the one thing an empty list has not done.
 *
 * The gap inside the head block is the board's 6px rounded to the 4px grid,
 * the same rounding ticket 01 made for the sheet's padding.
 */
export function Empty({
  title,
  lead,
  action,
}: {
  readonly title: string;
  readonly lead?: ReactNode;
  readonly action?: ReactNode;
}) {
  return (
    <section
      data-slot="page-state"
      data-tone="empty"
      className={cn(
        "flex w-full flex-col items-start gap-4 text-left",
        "rounded-card border border-border bg-surface p-10",
        "max-[900px]:p-5",
      )}
      role="status"
    >
      <div className="flex flex-col gap-1">
        <h2 className="m-0 text-base font-medium">{title}</h2>
        {lead === undefined ? null : (
          <p className="m-0 max-w-(--state-lead-width) text-sm text-muted-foreground">
            {lead}
          </p>
        )}
      </div>
      {action}
    </section>
  );
}

/**
 * Egma refused, or could not be reached. The API's own sentence is shown
 * unchanged — it names the next move — and there is always a way to try again.
 *
 * `Try again` is the quiet button it has always been. shadcn's `default` is the
 * filled one, so the variant is said out loud: a migration that drops it turns
 * a retry into the strongest thing on a failed page.
 */
export function Failure({
  title = "Egma could not answer this page.",
  message,
  onRetry,
}: {
  readonly title?: string;
  readonly message: string;
  readonly onRetry?: () => void;
}) {
  return (
    <PageState
      tone="bad"
      title={title}
      lead={message}
      action={
        onRetry === undefined ? undefined : (
          <Button type="button" variant="secondary" onClick={onRetry}>
            Try again
          </Button>
        )
      }
    />
  );
}

/**
 * The thing on the other end of this address is not available here — because it
 * is somebody else's, or because it never existed. One state for both, so a
 * page never confirms which.
 */
export function NotFound({
  message,
  action,
}: {
  readonly message: string;
  readonly action?: ReactNode;
}) {
  return (
    <PageState tone="plain" title="Not available here" lead={message} action={action} />
  );
}
