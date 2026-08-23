"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { createTest } from "@egma/platform-api/client";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Sheet,
  SheetBody,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import type { Refusal } from "../../../../lib/api.ts";
import {
  platformAnswer,
  platformClient,
} from "../../../../lib/platform-client.ts";
import { suitePagePath, type TestSuite } from "../../../../lib/test-suites.ts";
import {
  behaviorsAreUsable,
  whyBehaviorsRefuse,
  type ExpectedBehavior,
  type ListedTest,
  type Named,
} from "../../../../lib/tests.ts";
import { Field, Refused } from "../../../../ui/form.tsx";
import { useUnsavedChanges } from "../../../../ui/settings-read.ts";
import { TestChecks, type TestContentDraft } from "./editor.tsx";

/**
 * Writing a test, in the panel the boards write it in.
 *
 * **The address is still a route, and that is deliberate.** `ATG-0` draws this
 * over the suite it belongs to, so the panel is component state — but
 * `/tests/new?suite=…` stays a real address, which keeps the link somebody
 * sends a colleague, the Back button, and the browser walk that opens it
 * directly. The route renders the suite screen with this open.
 *
 * **It offers no way to author a mock override.** The boards draw one; the
 * standing rule is that overrides arrive with the repository change set that
 * owns them, and the browser walk holds every product screen to it.
 */
const EMPTY: TestContentDraft = { scenario: "", behaviors: [""], personas: [] };

export function WriteTestSheet({
  projectId,
  suite,
  open,
  mayAuthor,
  why,
  onWritten,
  onClose,
}: {
  readonly projectId: string;
  readonly suite: TestSuite;
  readonly open: boolean;
  readonly mayAuthor: boolean;
  readonly why?: string;
  readonly onWritten: (test: ListedTest) => void;
  readonly onClose: () => void;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [draft, setDraft] = useState<TestContentDraft>(EMPTY);
  const [known, setKnown] = useState<ReadonlyMap<string, Named>>(new Map());
  const [saving, setSaving] = useState(false);
  const [refused, setRefused] = useState<Refusal | null>(null);

  const changed =
    name !== "" ||
    description !== "" ||
    draft.scenario !== "" ||
    draft.behaviors.length !== 1 ||
    draft.behaviors[0] !== "" ||
    draft.personas.length > 0;
  useUnsavedChanges(open && changed && !saving, saving);

  /* The panel stays mounted so its exit finishes; opening clears the draft. */
  useEffect(() => {
    if (!open) return;
    setName("");
    setDescription("");
    setDraft(EMPTY);
    setRefused(null);
  }, [open, suite.id]);

  const behaviorProblem = whyBehaviorsRefuse(draft.behaviors);
  const usable =
    name.trim() !== "" &&
    draft.scenario.trim() !== "" &&
    behaviorsAreUsable(draft.behaviors);

  async function write(): Promise<void> {
    if (!usable || saving || !mayAuthor) return;
    setSaving(true);
    setRefused(null);
    const written = await platformAnswer(
      createTest(
        {
          projectId,
          suiteId: suite.id,
          name: name.trim(),
          ...(description.trim() === "" ? {} : { description: description.trim() }),
          scenario: draft.scenario.trim(),
          expectedBehaviors: draft.behaviors
            .map((one: ExpectedBehavior) => one.trim())
            .filter((one: ExpectedBehavior) => one !== ""),
          personas: [...draft.personas],
        },
        { client: platformClient },
      ),
    );
    setSaving(false);
    if (written.status === "signed-out") {
      window.location.replace("/sign-in");
      return;
    }
    if (written.status !== "ready") {
      setRefused(written.refusal);
      return;
    }
    onWritten(written.value);
  }

  return (
    <Sheet
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <SheetContent>
        <SheetHeader>
          <SheetTitle>Write a test</SheetTitle>
          <SheetDescription>In suite {suite.name}</SheetDescription>
        </SheetHeader>
        <form
          className="flex min-h-0 flex-1 flex-col gap-5"
          onSubmit={(event) => {
            event.preventDefault();
            void write();
          }}
        >
          <SheetBody className="gap-5">
            {refused === null ? null : <Refused message={refused.message} />}
            <Field label="Name" htmlFor="test-name">
              <Input
                id="test-name"
                value={name}
                placeholder="Caller asks to cancel today's booking"
                disabled={!mayAuthor}
                autoComplete="off"
                spellCheck={false}
                onChange={(event) => setName(event.target.value)}
              />
            </Field>
            <Field label="Description (optional)" htmlFor="test-description">
              <Input
                id="test-description"
                value={description}
                placeholder="Why this test exists, for the team"
                disabled={!mayAuthor}
                autoComplete="off"
                spellCheck={false}
                onChange={(event) => setDescription(event.target.value)}
              />
            </Field>
            <TestChecks
              projectId={projectId}
              draft={draft}
              known={known}
              disabled={!mayAuthor}
              problem={behaviorProblem}
              onChange={(next, named) => {
                setDraft(next);
                if (named !== undefined) setKnown(new Map(named));
              }}
            />
          </SheetBody>
          <SheetFooter>
            <Button
              type="submit"
              size="lg"
              busy={saving}
              disabled={!mayAuthor || !usable}
              {...(why === undefined ? {} : { why })}
            >
              {saving ? "Writing…" : "Write the test"}
            </Button>
            <Button asChild size="lg" variant="secondary">
              <Link href={suitePagePath(projectId, suite.id)}>Cancel</Link>
            </Button>
          </SheetFooter>
        </form>
      </SheetContent>
    </Sheet>
  );
}
