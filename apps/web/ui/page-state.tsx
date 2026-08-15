"use client";

import type { ReactNode } from "react";

import styles from "./system.module.css";
import { Button } from "./controls.tsx";

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
 */

export type StateTone = "quiet" | "plain" | "bad";

export function PageState({
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
  const toneClass =
    tone === "bad" ? styles.stateBad : tone === "quiet" ? styles.stateQuiet : "";

  return (
    <section
      className={`${styles.state} ${toneClass}`}
      role={tone === "bad" ? "alert" : "status"}
    >
      <h2 className={styles.stateTitle}>{title}</h2>
      {lead === undefined ? null : <p className={styles.stateLead}>{lead}</p>}
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
          <Button onClick={onRetry}>Try again</Button>
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
  return <PageState tone="plain" title="Not available here" lead={message} action={action} />;
}
