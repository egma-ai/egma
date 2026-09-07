"use client";

import { useState } from "react";
import { updateAgent } from "@egma/platform-api/client";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Sheet,
  SheetBody,
  SheetContent,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import type { Refusal } from "@/lib/api.ts";
import type { ListedAgent } from "@/lib/agents.ts";
import { platformAnswer, platformClient } from "@/lib/platform-client.ts";
import { Field, Help, Refused } from "@/ui/form.tsx";

/**
 * Rename only the Egma agent label. Platform binding, prompt, model, and tools
 * are outside this form.
 */
export function RenameAgentSheet({
  projectId,
  agent,
  mayAuthor,
  why,
  onClose,
  onRenamed,
}: {
  readonly projectId: string;
  readonly agent: ListedAgent;
  readonly mayAuthor: boolean;
  /** Why this cannot be saved, when it cannot. Its presence disables Save. */
  readonly why?: string;
  readonly onClose: () => void;
  readonly onRenamed: () => void;
}) {
  const [name, setName] = useState(agent.name);
  const [saving, setSaving] = useState(false);
  const [refused, setRefused] = useState<Refusal | null>(null);

  const unchanged = name.trim() === "" || name.trim() === agent.name;

  async function rename(): Promise<void> {
    if (unchanged || saving || !mayAuthor) return;
    setSaving(true);
    setRefused(null);
    const answer = await platformAnswer(
      updateAgent(
        { agentId: agent.id, projectId, name: name.trim() },
        { client: platformClient },
      ),
    );
    setSaving(false);
    if (answer.status === "signed-out") {
      window.location.replace("/sign-in");
      return;
    }
    if (answer.status !== "ready") {
      setRefused(answer.refusal);
      return;
    }
    onRenamed();
  }

  return (
    <Sheet
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <SheetContent aria-describedby={undefined}>
        <form
          className="contents"
          data-slot="form"
          onSubmit={(event) => {
            event.preventDefault();
            void rename();
          }}
        >
          <SheetHeader>
            <SheetTitle>Rename agent</SheetTitle>
          </SheetHeader>
          <SheetBody>
            {refused === null ? null : <Refused message={refused.message} />}
            <Field label="Name*" htmlFor="agent-rename">
              <Input
                aria-required="true"
                autoComplete="off"
                disabled={saving || !mayAuthor}
                id="agent-rename"
                onChange={(event) => setName(event.target.value)}
                spellCheck={false}
                value={name}
              />
              <Help>Its name in Egma. Nothing at the provider changes.</Help>
            </Field>
          </SheetBody>
          <SheetFooter>
            <Button
              busy={saving}
              disabled={!mayAuthor || unchanged}
              size="lg"
              type="submit"
              {...(why === undefined ? {} : { why })}
            >
              {saving ? "Saving…" : "Save"}
            </Button>
            <Button
              disabled={saving}
              onClick={onClose}
              size="lg"
              type="button"
              variant="secondary"
            >
              Cancel
            </Button>
          </SheetFooter>
        </form>
      </SheetContent>
    </Sheet>
  );
}
