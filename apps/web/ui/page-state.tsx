"use client";

import type { ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

/**
 * Keep loading, empty, failed, and missing states distinct. Data-tone exposes
 * the state for styling and tests.
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
 * Announce what is loading; hide decorative bars from assistive technology.
 * The theme owns delay, animation, and reduced-motion behavior. Animation
 * indicates a waiting state, not proof that the request is progressing.
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
 * Render an empty collection as a normal page state with an optional next
 * action. Keep its appearance distinct from loading and failure.
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
