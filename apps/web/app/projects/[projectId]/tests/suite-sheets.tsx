"use client";

import { useEffect, useState } from "react";
import { createTestSuite, updateTestSuite } from "@egma/platform-api/client";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Sheet,
  SheetBody,
  SheetClose,
  SheetContent,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import type { Refusal } from "../../../../lib/api.ts";
import {
  platformAnswer,
  platformClient,
} from "../../../../lib/platform-client.ts";
import type { TestSuite } from "../../../../lib/test-suites.ts";
import { Field, Refused } from "../../../../ui/form.tsx";
import { RelativeInstant, useMinuteClock } from "../../../../ui/relative-time.tsx";

/**
 * Where a test suite is created and where it is renamed.
 *
 * **A suite is one short record, so it is written in the side sheet** rather
 * than on a page of its own: the list a person came from stays on screen behind
 * it, which is the arrangement `DESIGN.md` records for agents, connections,
 * personas and tests alike. Both boards (`94I-0`, `9FG-0`) draw the same panel
 * with the same one field; what differs is the title, the sentence under the
 * field, and whether there is anything to delete yet.
 */

/**
 * The hint under the field, which is the only place either sheet explains
 * itself. It is two different facts, so it is two different sentences.
 */
const CREATE_HINT =
  "Tests in one suite stay together for their full lifetime. Rename it any time; tests never move between suites.";
const RENAME_HINT =
  "Renaming changes nothing about the tests inside or the runs that already happened.";

export function CreateSuiteSheet({
  projectId,
  open,
  onCreated,
  onClose,
}: {
  readonly projectId: string;
  readonly open: boolean;
  readonly onCreated: (suite: TestSuite) => void;
  readonly onClose: () => void;
}) {
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);
  const [refused, setRefused] = useState<Refusal | null>(null);

  /*
   * The panel stays mounted so its exit runs to completion, which means it
   * opens carrying whatever the last visit left in it. Opening is therefore
   * where the draft is cleared, not closing.
   */
  useEffect(() => {
    if (!open) return;
    setName("");
    setRefused(null);
  }, [open]);

  async function create(): Promise<void> {
    if (name.trim() === "" || saving) return;
    setSaving(true);
    setRefused(null);
    const answer = await platformAnswer(
      createTestSuite(
        { projectId, name: name.trim() },
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
    onCreated(answer.value);
  }

  return (
    <Sheet
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <SheetContent aria-describedby={undefined}>
        <SheetHeader>
          <SheetTitle>Create a suite</SheetTitle>
        </SheetHeader>
        <form
          className="flex min-h-0 flex-1 flex-col gap-5"
          onSubmit={(event) => {
            event.preventDefault();
            void create();
          }}
        >
          <SheetBody>
            {refused === null ? null : <Refused message={refused.message} />}
            <Field label="Suite name" htmlFor="suite-name" hint={CREATE_HINT}>
              <Input
                id="suite-name"
                value={name}
                autoComplete="off"
                spellCheck={false}
                placeholder="Northside Ford"
                disabled={saving}
                onChange={(event) => setName(event.target.value)}
              />
            </Field>
          </SheetBody>
          <SheetFooter>
            <Button type="submit" size="lg" busy={saving} disabled={name.trim() === ""}>
              {saving ? "Creating…" : "Create suite"}
            </Button>
            <SheetClose asChild>
              <Button type="button" size="lg" variant="secondary" disabled={saving}>
                Cancel
              </Button>
            </SheetClose>
          </SheetFooter>
        </form>
      </SheetContent>
    </Sheet>
  );
}

export function RenameSuiteSheet({
  projectId,
  suite,
  open,
  mayAuthor,
  why,
  onRenamed,
  onDelete,
  onClose,
}: {
  readonly projectId: string;
  readonly suite: TestSuite;
  readonly open: boolean;
  readonly mayAuthor: boolean;
  readonly why?: string;
  readonly onRenamed: (suite: TestSuite) => void;
  /** Hands the suite to whichever screen owns the confirmation and what follows it. */
  readonly onDelete: () => void;
  readonly onClose: () => void;
}) {
  const now = useMinuteClock();
  const [name, setName] = useState(suite.name);
  const [saving, setSaving] = useState(false);
  const [refused, setRefused] = useState<Refusal | null>(null);
  /* Opening reads the suite again, for the reason the create sheet gives. */
  useEffect(() => {
    if (!open) return;
    setName(suite.name);
    setRefused(null);
  }, [open, suite.name]);
  const unchanged = name.trim() === "" || name.trim() === suite.name;

  async function rename(): Promise<void> {
    if (unchanged || saving) return;
    setSaving(true);
    setRefused(null);
    const answer = await platformAnswer(
      updateTestSuite(
        { suiteId: suite.id, projectId, name: name.trim() },
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
    onRenamed(answer.value);
    onClose();
  }

  return (
    <Sheet
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <SheetContent aria-describedby={undefined}>
        <SheetHeader>
          <SheetTitle>{suite.name}</SheetTitle>
        </SheetHeader>
        <form
          className="flex min-h-0 flex-1 flex-col gap-5"
          onSubmit={(event) => {
            event.preventDefault();
            void rename();
          }}
        >
          <SheetBody>
            {refused === null ? null : <Refused message={refused.message} />}
            <Field label="Suite name" htmlFor="suite-name" hint={RENAME_HINT}>
              <Input
                id="suite-name"
                value={name}
                autoComplete="off"
                spellCheck={false}
                disabled={saving || !mayAuthor}
                onChange={(event) => setName(event.target.value)}
              />
            </Field>
            {/*
             * What this suite is, for somebody who needs to name it somewhere
             * else. The id is the reason the list stopped carrying one: it is a
             * fact about the record rather than a column of the table.
             */}
            <dl className="m-0 mt-1 grid grid-cols-[72px_minmax(0,1fr)] gap-x-3 gap-y-1.5">
              <dt className="text-sm text-faint">Suite id</dt>
              <dd className="m-0 min-w-0 font-mono text-sm break-all text-muted-foreground">
                {suite.id}
              </dd>
              <dt className="text-sm text-faint">Created</dt>
              <dd className="m-0 text-sm text-muted-foreground">
                <RelativeInstant instant={suite.createdAt} now={now} /> · changed{" "}
                <RelativeInstant instant={suite.updatedAt} now={now} />
              </dd>
            </dl>
          </SheetBody>
          <SheetFooter
            destructive={
              <Button
                type="button"
                variant="ghost"
                size="lg"
                className="px-0 text-failure pointer-hover:text-failure"
                disabled={!mayAuthor || saving}
                {...(why === undefined ? {} : { why })}
                onClick={onDelete}
              >
                Delete suite
              </Button>
            }
          >
            <Button
              type="submit"
              size="lg"
              busy={saving}
              disabled={!mayAuthor || unchanged}
              {...(why === undefined ? {} : { why })}
            >
              {saving ? "Saving…" : "Save name"}
            </Button>
            <SheetClose asChild>
              <Button type="button" size="lg" variant="secondary" disabled={saving}>
                Cancel
              </Button>
            </SheetClose>
          </SheetFooter>
        </form>
      </SheetContent>
    </Sheet>
  );
}
