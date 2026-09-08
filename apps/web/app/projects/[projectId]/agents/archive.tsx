"use client";

import { useState, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import type { Refusal } from "@/lib/api.ts";
import { Dialog } from "@/ui/dialog.tsx";
import { Form, FormActions, Problem } from "@/ui/form.tsx";

/**
 * The UI says Delete; the API archives the record. The confirmation explains
 * what stops and that stored transcripts remain. Permission enforcement is
 * server-side, with disabled controls explaining unavailable actions.
 */
export function ArchiveConfirm({
  title,
  onArchive,
  onClose,
  onArchived,
  children,
}: {
  readonly title: string;
  /** The write. It answers a refusal rather than throwing one. */
  readonly onArchive: () => Promise<Refusal | null>;
  readonly onClose: () => void;
  readonly onArchived: () => void;
  /** The sentence that names the thing and says what stops. */
  readonly children: ReactNode;
}) {
  const [busy, setBusy] = useState(false);
  const [refused, setRefused] = useState<Refusal | null>(null);

  async function archive(): Promise<void> {
    if (busy) return;
    setRefused(null);
    setBusy(true);
    const problem = await onArchive();
    setBusy(false);
    if (problem !== null) {
      setRefused(problem);
      return;
    }
    onArchived();
  }

  return (
    <Dialog title={title} onClose={onClose}>
      {(dismiss) => (
        <Form onSubmit={() => void archive()}>
          <p className="m-0 max-w-[72ch] text-base leading-(--line-normal) text-foreground">
            {children}
          </p>
          {refused === null ? null : <Problem>{refused.message}</Problem>}
          <FormActions>
            <Button type="submit" variant="destructive" disabled={busy}>
              {busy ? "Deleting…" : "Delete"}
            </Button>
            <Button type="button" variant="secondary" onClick={dismiss}>
              Cancel
            </Button>
          </FormActions>
        </Form>
      )}
    </Dialog>
  );
}
