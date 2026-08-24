"use client";

import { useState, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import type { Refusal } from "@/lib/api.ts";
import { Dialog } from "@/ui/dialog.tsx";
import { Form, FormActions, Problem } from "@/ui/form.tsx";

/**
 * The confirmation in front of the one destructive thing these screens offer.
 *
 * **It says "Archive", and it says it because that is what happens.** There is
 * no delete in the contract for an agent or for a connection — `archiveAgent`
 * and `archiveConnection` are the whole of it — and a control labelled Delete
 * over a write that archives would be the screen telling a person their data is
 * gone when the API kept it. The boards draw a destructive slot; the word in it
 * is the API's.
 *
 * **It names the thing, which `DESIGN.md` asks of every destructive dialog**,
 * and it says what stops. What it cannot say is a number: the counts of
 * archived connections and cancelled runs are in the *answer*, and this sentence
 * is written before the write is made. So it says what will happen rather than
 * inventing an arithmetic it does not have.
 *
 * The button inside is the filled failure-colour one, which is the only place
 * in the product that draws it.
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
              {busy ? "Archiving…" : "Archive"}
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
