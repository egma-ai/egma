"use client";

import { useState } from "react";

import { Button } from "@/components/ui/button";

/**
 * A block of text the person is meant to take away, with the button that takes
 * it.
 *
 * Setup surfaces hand work over that Egma cannot do itself, and each one is
 * read with a keyboard in one hand and somebody else's editor in the other.
 * **What is on screen has to be the exact bytes copied away**, so the block
 * never prettifies what it was given.
 *
 * It lives on its own because one shape drawn twice becomes two shapes, and
 * the day they differed would be the day a customer pasted the older one.
 */
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
