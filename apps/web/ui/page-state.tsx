"use client";

import type { ReactNode } from "react";

import { Button } from "@/components/ui/button";
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
}: {
  readonly tone?: StateTone;
  readonly title: string;
  readonly lead?: ReactNode;
  readonly action?: ReactNode;
}) {
  return (
    <section
      data-slot="page-state"
      data-tone={tone}
      className={cn(
        "flex flex-col items-start gap-3 text-left",
        "rounded-card border border-border bg-surface px-8 py-10",
        "max-[900px]:px-5 max-[900px]:py-8",
        /* Quiet is an outline around an absence: nothing is raised off the page. */
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
      {action}
    </section>
  );
}

/** Waiting on egma. It says what it is waiting for, not just that it is waiting. */
export function Loading({ what }: { readonly what: string }) {
  return <PageState tone="quiet" title={`Loading ${what}…`} />;
}

/** There is nothing here, and that is a fact about the project, not a fault. */
export function Empty({
  title,
  lead,
  action,
}: {
  readonly title: string;
  readonly lead?: ReactNode;
  readonly action?: ReactNode;
}) {
  return <PageState tone="quiet" title={title} lead={lead} action={action} />;
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
