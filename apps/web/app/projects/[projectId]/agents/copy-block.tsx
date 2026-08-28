"use client";

import { useState } from "react";

import { Button } from "@/components/ui/button";

/**
 * A block of text the person is meant to take away, with the button that takes
 * it.
 *
 * Two setup surfaces hand work over that Egma cannot do itself — the LiveKit
 * monitoring entry and the LiveKit chat setup — and both of them are read with
 * a keyboard in one hand and somebody else's editor in the other. **What is on
 * screen has to be the exact bytes that go in the worker**, so the block never
 * wraps, reflows or prettifies what it was given; it scrolls instead.
 *
 * It lives on its own because one shape drawn twice becomes two shapes, and
 * the day they differed would be the day a customer pasted the older one.
 */
export function CopyBlock({ value }: { readonly value: string }) {
  const [copied, setCopied] = useState(false);

  async function copy(): Promise<void> {
    if (navigator.clipboard === undefined) return;
    await navigator.clipboard.writeText(value);
    setCopied(true);
  }

  return (
    <div className="flex items-start justify-between gap-3 border border-border bg-surface-soft p-3">
      <pre className="m-0 min-w-0 overflow-x-auto whitespace-pre-wrap font-mono text-sm leading-(--line-normal) text-foreground">
        {value}
      </pre>
      <Button type="button" size="sm" variant="ghost" onClick={() => void copy()}>
        {copied ? "Copied" : "Copy"}
      </Button>
    </div>
  );
}
