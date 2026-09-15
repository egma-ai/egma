"use client";

import { useState } from "react";
import { deletePersona } from "@egma/platform-api/client";

import { Button } from "@/components/ui/button";
import type { Refusal } from "@/lib/api.ts";
import type { Persona } from "@/lib/personas.ts";
import { platformAnswer, platformClient } from "@/lib/platform-client.ts";
import { Dialog } from "@/ui/dialog.tsx";
import { Refused } from "@/ui/form.tsx";

/** Confirm the only destructive action in the persona library. */
export function DeletePersonaDialog({ persona, projectId, onClose, onDeleted }: {
  readonly persona: Persona;
  readonly projectId: string;
  readonly onClose: () => void;
  readonly onDeleted: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [refused, setRefused] = useState<Refusal | null>(null);

  async function remove(): Promise<void> {
    if (busy) return;
    setBusy(true);
    setRefused(null);
    const answer = await platformAnswer(
      deletePersona({ personaId: persona.id, projectId }, { client: platformClient }),
    );
    setBusy(false);
    if (answer.status === "signed-out") {
      window.location.replace("/sign-in");
      return;
    }
    if (answer.status !== "ready") {
      setRefused(answer.refusal);
      return;
    }
    onDeleted();
  }

  return (
    <Dialog title={`Delete ${persona.name}?`} onClose={onClose}>
      {(dismiss) => (
        <>
          <p className="m-0 text-sm leading-(--line-normal) text-muted-foreground">
            This persona leaves authoring lists and pickers. Existing run evidence stays readable.
          </p>
          {refused === null ? null : <Refused message={refused.message} />}
          <div className="flex flex-wrap items-center gap-3">
            <Button type="button" size="lg" variant="destructive" busy={busy} onClick={() => void remove()}>
              {busy ? "Deleting…" : "Delete persona"}
            </Button>
            <Button type="button" size="lg" variant="secondary" disabled={busy} onClick={() => dismiss()}>
              Cancel
            </Button>
          </div>
        </>
      )}
    </Dialog>
  );
}
