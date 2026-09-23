"use client";

import Link from "next/link";
import { useState } from "react";

import { Button } from "@/components/ui/button";

/** Display exactly the text that the copy button places on the clipboard. */
type CopyState = "idle" | "copying" | "copied" | "failed";

export function CopyBlock({
  value,
  copyLabel = "text",
}: {
  readonly value: string;
  readonly copyLabel?: string;
}) {
  const [state, setState] = useState<CopyState>("idle");
  const announcedLabel =
    copyLabel.charAt(0).toUpperCase() + copyLabel.slice(1);

  async function copy(): Promise<void> {
    setState("copying");
    try {
      if (navigator.clipboard?.writeText === undefined) {
        throw new Error("The Clipboard API is not available.");
      }
      await navigator.clipboard.writeText(value);
      setState("copied");
    } catch {
      setState("failed");
    }
  }

  return (
    <div className="flex flex-col gap-2 border border-border bg-surface-soft p-3">
      <div className="flex items-start justify-between gap-3">
        <pre className="m-0 min-w-0 overflow-x-auto whitespace-pre-wrap font-mono text-sm leading-(--line-normal) text-foreground">
          {value}
        </pre>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          aria-label={
            state === "failed"
              ? `Try to copy ${copyLabel} again`
              : state === "copied"
                ? `${announcedLabel} copied`
                : `Copy ${copyLabel}`
          }
          busy={state === "copying"}
          onClick={() => void copy()}
        >
          {state === "copying"
            ? "Copying…"
            : state === "copied"
              ? "Copied"
              : state === "failed"
                ? "Try again"
                : "Copy"}
        </Button>
      </div>

      {state === "failed" ? (
        <p className="m-0 text-sm text-failure" role="alert">
          Could not copy the {copyLabel}. Select the text and copy it manually.
        </p>
      ) : null}
      <p className="sr-only" aria-live="polite" role="status">
        {state === "copied" ? `${announcedLabel} copied.` : ""}
      </p>
    </div>
  );
}

/** One numbered instruction: what to do, and the exact text that does it. */
export type InstructionStep = {
  readonly title: string;
  readonly value: string;
  /** What the copy button names, in lower case: `install command`. */
  readonly copyLabel: string;
};

/**
 * The numbered steps of a setup instructions screen, each with its copy block.
 *
 * Every platform's testing and monitoring instructions draw their steps here,
 * so the screens keep one shape.
 */
export function InstructionSteps({
  steps,
}: {
  readonly steps: readonly InstructionStep[];
}) {
  return (
    <ol className="m-0 flex list-none flex-col gap-5 p-0">
      {steps.map((step, index) => (
        <li className="flex gap-3" key={step.title}>
          <span className="w-(--space-5) flex-none text-sm leading-(--line-normal) text-foreground tabular-nums">
            {index + 1}
          </span>
          <div className="flex min-w-0 flex-1 flex-col gap-2">
            <p className="m-0 text-sm leading-(--line-normal) font-medium text-foreground">
              {step.title}
            </p>
            <CopyBlock value={step.value} copyLabel={step.copyLabel} />
          </div>
        </li>
      ))}
    </ol>
  );
}

/** The two values the agent's environment carries, as the steps show them. */
export const EGMA_URL_PLACEHOLDER = "<your-public-egma-url>";
export const API_KEY_PLACEHOLDER = "<your-project-api-key>";
export const ENVIRONMENT_VALUES = environmentValues(API_KEY_PLACEHOLDER);

/** The environment values, with the key the agent should export with. */
export function environmentValues(key: string): string {
  return `EGMA_URL=${EGMA_URL_PLACEHOLDER}\nEGMA_API_KEY=${key}`;
}

/** What the URL placeholder stands for, where the key comes from a step. */
export function EgmaUrlNote({ reachedBy }: { readonly reachedBy: string }) {
  return (
    <p className="m-0 text-sm leading-(--line-normal) text-muted-foreground">
      Set {EGMA_URL_PLACEHOLDER} to the public Egma API URL that {reachedBy} can
      reach.
    </p>
  );
}

/** Where the project key comes from, and what the URL placeholder stands for. */
export function ProjectKeyNote({
  projectId,
  reachedBy,
}: {
  readonly projectId: string;
  /** Who must reach the URL: `your deployed LiveKit worker`, `your bot`. */
  readonly reachedBy: string;
}) {
  return (
    <p className="m-0 text-sm leading-(--line-normal) text-muted-foreground">
      Create a project key in{" "}
      <Link
        className="text-foreground underline underline-offset-2 pointer-hover:text-brand"
        href={`/projects/${encodeURIComponent(projectId)}/settings/keys`}
      >
        API keys
      </Link>
      , then replace {API_KEY_PLACEHOLDER}. Set {EGMA_URL_PLACEHOLDER} to the
      public Egma API URL that {reachedBy} can reach.
    </p>
  );
}
