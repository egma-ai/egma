"use client";

import { useParams, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import {
  deleteTest,
  getTest,
  getTestSuite,
  updateTest,
} from "@egma/platform-api/client";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import type { Refusal } from "../../../../../lib/api.ts";
import { roleOf } from "../../../../../lib/me.ts";
import {
  platformAnswer,
  platformClient,
} from "../../../../../lib/platform-client.ts";
import { canAuthor } from "../../../../../lib/roles.ts";
import {
  suitePagePath,
  testsPagePath,
  type TestSuite,
} from "../../../../../lib/test-suites.ts";
import {
  behaviorsAreUsable,
  whyBehaviorsRefuse,
  type ExpectedBehavior,
  type ListedTest,
  type Named,
} from "../../../../../lib/tests.ts";
import { Field, Refused } from "../../../../../ui/form.tsx";
import { Failure, Loading, NotFound } from "../../../../../ui/page-state.tsx";
import { RelativeInstant, useMinuteClock } from "../../../../../ui/relative-time.tsx";
import { useProjectRead } from "../../../../../ui/resource.ts";
import { useUnsavedChanges } from "../../../../../ui/settings-read.ts";
import {
  AppShell,
  PageBody,
  PageHeader,
  ProductPage,
  useShellSession,
} from "../../../../../ui/shell.tsx";
import {
  GroupHead,
  SaveAction,
  TestChecks,
  type SaveState,
  type TestContentDraft,
} from "../editor.tsx";
import { ConfirmDialog } from "../parts.tsx";

/**
 * One test: what it is, and what it checks.
 *
 * **Two save boundaries, because they are two different writes.** A name and a
 * description are the record's identity and save against its revision; the
 * scenario, the behaviors and the personas are what a run is judged by and save
 * against the version they were read at. `B9M-0` draws them as two groups in
 * one column with a save row each, which is what they are.
 *
 * **The version history left this page with the boards.** Versioning is hidden
 * from the interface for launch, so nothing here reads or lists versions — the
 * versions themselves are untouched, and every run still pins the one it ran.
 */

/** The one column the boards draw this page in. */
const COLUMN = "w-[760px] max-w-full border border-border bg-surface";
const GROUP = "flex min-w-0 flex-col gap-4 p-6 max-[40rem]:p-5";

type Draft = {
  readonly testId: string;
  readonly projectId: string;
  readonly name: string;
  readonly description: string;
} & TestContentDraft;

type SaveArea = "settings" | "version";

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function draftOf(test: ListedTest, projectId: string): Draft {
  return {
    testId: test.id,
    projectId,
    name: test.name,
    description: test.description ?? "",
    scenario: test.scenario,
    behaviors: test.expectedBehaviors,
    personas: test.personas.map((persona) => persona.id),
  };
}

export default function TestDetailPage() {
  const { projectId, testId } = useParams<{ projectId: string; testId: string }>();
  return (
    <AppShell>
      <TestDetail projectId={projectId} testId={testId} />
    </AppShell>
  );
}

/**
 * What a save was refused with, when the refusal is that the test moved on.
 *
 * **It keeps the platform's own sentence.** A refusal is shown unchanged
 * wherever it is shown, and the sentence names the next move better than a
 * paraphrase would. What this adds is the heading a person reads first and the
 * two ways out: take the draft with you, or read the test again and edit on top
 * of the latest save.
 *
 * The board names a person and a time. The 409 body carries neither, so this
 * says what is true instead of inventing an author.
 */
function ConflictBanner({
  message,
  copied,
  onCopy,
  onReread,
}: {
  readonly message: string;
  readonly copied: boolean;
  readonly onCopy: () => void;
  readonly onReread: () => void;
}) {
  return (
    <div
      className={cn(
        COLUMN,
        "mb-5 flex flex-wrap items-center justify-between gap-5",
        "border-y-0 border-r-0 border-l-[3px] border-l-failure px-4 py-3.5",
      )}
      role="alert"
    >
      <div className="flex min-w-0 flex-col gap-0.5">
        <p className="m-0 text-sm font-medium text-foreground">
          This test moved on while you were editing.
        </p>
        <p className="m-0 text-sm text-muted-foreground">{message}</p>
        <p className="m-0 text-sm text-muted-foreground">
          Your draft is kept on this screen; read the test again to edit on top
          of the latest save.
        </p>
      </div>
      <div className="flex flex-none flex-wrap items-center gap-3">
        <Button type="button" variant="secondary" onClick={onCopy}>
          {copied ? "Copied" : "Copy my draft"}
        </Button>
        <Button type="button" onClick={onReread}>
          Read the test again
        </Button>
      </div>
    </div>
  );
}

function TestDetail({
  projectId,
  testId,
}: {
  readonly projectId: string;
  readonly testId: string;
}) {
  const router = useRouter();
  const { me } = useShellSession();
  const role = me === null ? null : roleOf(me);
  const mayAuthor = role !== null && canAuthor(role);
  const now = useMinuteClock();
  const { answer, reload } = useProjectRead<ListedTest>(
    (projectId) =>
      platformAnswer(getTest({ testId, projectId }, { client: platformClient })),
    projectId,
    testId,
  );
  const readTest = answer?.status === "ready" ? answer.value : null;
  const suiteId = readTest?.suiteId ?? null;
  const { answer: suite, reload: reloadSuite } = useProjectRead<TestSuite>(
    (projectId) =>
      platformAnswer(
        getTestSuite(
          { suiteId: suiteId ?? "", projectId },
          { client: platformClient },
        ),
      ),
    suiteId === null ? null : projectId,
    suiteId ?? "",
  );

  const [baseline, setBaseline] = useState<ListedTest | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [known, setKnown] = useState<ReadonlyMap<string, Named>>(new Map());
  const [saving, setSaving] = useState<SaveArea | null>(null);
  const [saveStates, setSaveStates] = useState<Record<SaveArea, SaveState>>({
    settings: "unchanged",
    version: "unchanged",
  });
  const [refused, setRefused] = useState<Refusal | null>(null);
  const [copied, setCopied] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteRefused, setDeleteRefused] = useState<string | null>(null);

  const test =
    baseline !== null && baseline.id === testId && baseline.projectId === projectId
      ? baseline
      : readTest;
  const editing =
    draft !== null && draft.testId === testId && draft.projectId === projectId
      ? draft
      : null;

  useEffect(() => {
    if (readTest === null) return;
    setBaseline(readTest);
    setDraft(draftOf(readTest, projectId));
    setSaveStates({ settings: "unchanged", version: "unchanged" });
    setRefused(null);
    setCopied(false);
    setConfirmingDelete(false);
  }, [readTest, projectId]);

  useEffect(() => {
    if (answer?.status === "signed-out" || suite?.status === "signed-out") {
      window.location.replace("/sign-in");
    }
  }, [answer, suite]);

  useEffect(() => {
    if (!copied) return undefined;
    const timer = window.setTimeout(() => setCopied(false), 2_000);
    return () => window.clearTimeout(timer);
  }, [copied]);

  const settingsChanged =
    editing !== null &&
    test !== null &&
    (editing.name !== test.name || editing.description !== (test.description ?? ""));
  const versionChanged =
    editing !== null &&
    test !== null &&
    (editing.scenario !== test.scenario ||
      !sameStrings(editing.behaviors, test.expectedBehaviors) ||
      !sameStrings(editing.personas, test.personas.map((persona) => persona.id)));
  useUnsavedChanges(settingsChanged || versionChanged, saving !== null);

  /**
   * Whether the last refusal was "somebody else saved this first".
   *
   * `lib/api.ts` hands the platform's own error code through, so this is the
   * platform's answer rather than a guess made from the sentence.
   */
  const conflict = refused !== null && refused.error === "version_conflict";

  function stateFor(area: SaveArea, changed: boolean): SaveState {
    if (saving === area) return "saving";
    if (area === "version" && conflict) return "conflict";
    if (changed && saveStates[area] === "saved") return "unchanged";
    return saveStates[area];
  }

  async function save(area: SaveArea): Promise<void> {
    if (editing === null || test === null) return;
    setSaving(area);
    setSaveStates((held) => ({ ...held, [area]: "unchanged" }));
    setRefused(null);
    const body =
      area === "settings"
        ? {
            name: editing.name.trim(),
            description: editing.description.trim() === "" ? null : editing.description.trim(),
            expectedRevision: test.revision,
          }
        : {
            scenario: editing.scenario.trim(),
            expectedBehaviors: editing.behaviors
              .map((behavior: ExpectedBehavior) => behavior.trim())
              .filter((behavior: ExpectedBehavior) => behavior !== ""),
            personas: [...editing.personas],
            expectedVersionId: test.versionId,
          };
    const written = await platformAnswer(
      updateTest({ testId, projectId, ...body }, { client: platformClient }),
    );
    setSaving(null);
    if (written.status === "signed-out") {
      window.location.replace("/sign-in");
      return;
    }
    if (written.status !== "ready") {
      setRefused(written.refusal);
      setSaveStates((held) => ({ ...held, [area]: "failed" }));
      return;
    }
    setBaseline(written.value);
    setDraft((held) => {
      if (held === null || held.testId !== testId || held.projectId !== projectId) {
        return held;
      }
      return {
        testId: written.value.id,
        projectId,
        name:
          area === "settings" && held.name === editing.name
            ? written.value.name
            : held.name,
        description:
          area === "settings" && held.description === editing.description
            ? (written.value.description ?? "")
            : held.description,
        scenario:
          area === "version" && held.scenario === editing.scenario
            ? written.value.scenario
            : held.scenario,
        behaviors:
          area === "version" && sameStrings(held.behaviors, editing.behaviors)
            ? written.value.expectedBehaviors
            : held.behaviors,
        personas:
          area === "version" && sameStrings(held.personas, editing.personas)
            ? written.value.personas.map((persona) => persona.id)
            : held.personas,
      };
    });
    setSaveStates((held) => ({ ...held, [area]: "saved" }));
  }

  async function remove(): Promise<void> {
    if (test === null) return;
    setDeleting(true);
    setDeleteRefused(null);
    const deleted = await platformAnswer(
      deleteTest({ testId: test.id, projectId }, { client: platformClient }),
    );
    setDeleting(false);
    if (deleted.status === "signed-out") {
      window.location.replace("/sign-in");
      return;
    }
    if (deleted.status !== "ready") {
      setDeleteRefused(deleted.refusal.message);
      return;
    }
    setConfirmingDelete(false);
    router.push(suitePagePath(projectId, test.suiteId));
  }

  /** The draft as plain text, for somebody who wants to keep it outside egma. */
  function copyDraft(): void {
    if (editing === null) return;
    const lines = [
      editing.name,
      editing.description,
      "",
      editing.scenario,
      "",
      ...editing.behaviors.map((one: ExpectedBehavior) => `- ${one}`),
    ];
    void navigator.clipboard?.writeText(lines.join("\n")).then(
      () => setCopied(true),
      () => setCopied(false),
    );
  }

  const basicBreadcrumbs = [
    { label: "Tests", href: testsPagePath(projectId) },
    { label: "Test" },
  ] as const;

  if (answer === null || answer.status === "signed-out") {
    return (
      <ProductPage>
        <PageHeader title="Test" breadcrumbs={basicBreadcrumbs} />
        <PageBody><Loading what="this test" /></PageBody>
      </ProductPage>
    );
  }
  if (answer.status === "missing") {
    return (
      <ProductPage>
        <PageHeader title="Test" breadcrumbs={basicBreadcrumbs} />
        <PageBody><NotFound message={answer.refusal.message} /></PageBody>
      </ProductPage>
    );
  }
  if (answer.status === "failed") {
    return (
      <ProductPage>
        <PageHeader title="Test" breadcrumbs={basicBreadcrumbs} />
        <PageBody><Failure message={answer.refusal.message} onRetry={reload} /></PageBody>
      </ProductPage>
    );
  }
  if (test === null || editing === null || suite === null || suite.status === "signed-out") {
    return (
      <ProductPage>
        <PageHeader title={answer.value.name} breadcrumbs={basicBreadcrumbs} />
        <PageBody><Loading what="this test's suite" /></PageBody>
      </ProductPage>
    );
  }
  if (suite.status === "missing") {
    return (
      <ProductPage>
        <PageHeader title={test.name} breadcrumbs={basicBreadcrumbs} />
        <PageBody><NotFound message={suite.refusal.message} /></PageBody>
      </ProductPage>
    );
  }
  if (suite.status === "failed") {
    return (
      <ProductPage>
        <PageHeader title={test.name} breadcrumbs={basicBreadcrumbs} />
        <PageBody><Failure message={suite.refusal.message} onRetry={reloadSuite} /></PageBody>
      </ProductPage>
    );
  }

  const behaviorProblem = whyBehaviorsRefuse(editing.behaviors);
  const whyNot = mayAuthor
    ? undefined
    : `Your ${String(role ?? "")} role cannot change tests. Ask an organization admin to change your role.`;
  const personaCount = test.personas.length;

  return (
    <ProductPage>
      <PageHeader
        title={test.name}
        breadcrumbs={[
          { label: "Tests", href: testsPagePath(projectId) },
          { label: suite.value.name, href: suitePagePath(projectId, suite.value.id) },
          { label: test.name },
        ]}
        toolbar={
          <p className="m-0 text-sm text-muted-foreground">
            changed <RelativeInstant instant={test.updatedAt} now={now} /> ·{" "}
            {personaCount === 1 ? "1 persona" : `${String(personaCount)} personas`}
          </p>
        }
        action={
          <Button
            type="button"
            variant="ghost"
            className="px-0 text-failure pointer-hover:text-failure"
            disabled={!mayAuthor || saving !== null}
            {...(whyNot === undefined ? {} : { why: whyNot })}
            onClick={() => {
              setDeleteRefused(null);
              setConfirmingDelete(true);
            }}
          >
            Delete test
          </Button>
        }
      />
      <PageBody>
        {conflict && refused !== null ? (
          <ConflictBanner
            message={refused.message}
            copied={copied}
            onCopy={copyDraft}
            onReread={reload}
          />
        ) : null}
        {refused === null || conflict ? null : (
          <div className="mb-5">
            <Refused
              message={refused.message}
              action={
                <Button type="button" variant="secondary" onClick={reload}>
                  Read the test again
                </Button>
              }
            />
          </div>
        )}

        <section className={COLUMN} aria-labelledby="test-editor-title">
          <div className={cn(GROUP, "border-b border-border")}>
            <GroupHead
              id="test-editor-title"
              eyebrow="Test details"
              lead="Name and description save on their own, apart from what the test checks."
            />
            <Field label="Name" htmlFor="test-name">
              <Input
                id="test-name"
                value={editing.name}
                disabled={!mayAuthor}
                autoComplete="off"
                spellCheck={false}
                onChange={(event) => setDraft({ ...editing, name: event.target.value })}
              />
            </Field>
            <Field label="Description" htmlFor="test-description">
              <Input
                id="test-description"
                value={editing.description}
                disabled={!mayAuthor}
                autoComplete="off"
                spellCheck={false}
                onChange={(event) =>
                  setDraft({ ...editing, description: event.target.value })
                }
              />
            </Field>
            <SaveAction
              label="Save settings"
              changed={settingsChanged}
              state={stateFor("settings", settingsChanged)}
              disabled={!mayAuthor || saving !== null || editing.name.trim() === ""}
              divided={false}
              {...(whyNot === undefined ? {} : { why: whyNot })}
              onSave={() => void save("settings")}
            />
          </div>

          <div className={cn(GROUP, "gap-5")}>
            <GroupHead
              eyebrow="What the test checks"
              lead="The scenario, the expected behaviors and the personas are what a run is judged by. Save to apply them to the next run; runs that already happened keep what they ran."
            />
            <TestChecks
              projectId={projectId}
              draft={editing}
              known={known}
              selectedPersonas={test.personas}
              mockTools={test.mockTools}
              disabled={!mayAuthor}
              problem={behaviorProblem}
              onChange={(next, named) => {
                setDraft({ ...editing, ...next });
                if (named !== undefined) setKnown(new Map(named));
              }}
            />
            <SaveAction
              label="Save version"
              changed={versionChanged}
              state={stateFor("version", versionChanged)}
              disabled={
                !mayAuthor ||
                saving !== null ||
                conflict ||
                editing.scenario.trim() === "" ||
                !behaviorsAreUsable(editing.behaviors)
              }
              secondary={
                <Button
                  type="button"
                  variant="secondary"
                  disabled={!mayAuthor || saving !== null || !versionChanged}
                  onClick={() =>
                    setDraft({
                      ...editing,
                      scenario: test.scenario,
                      behaviors: test.expectedBehaviors,
                      personas: test.personas.map((persona) => persona.id),
                    })
                  }
                >
                  Discard
                </Button>
              }
              {...(whyNot === undefined ? {} : { why: whyNot })}
              onSave={() => void save("version")}
            />
          </div>
        </section>
      </PageBody>

      {confirmingDelete ? (
        <ConfirmDialog
          title="Delete this test?"
          lines={[
            `“${test.name}” leaves the ${suite.value.name} suite. Nobody can author or run it after this.`,
            "Runs that already ran it keep their results and transcripts.",
          ]}
          confirmLabel="Delete test"
          busy={deleting}
          refusal={deleteRefused}
          onConfirm={() => void remove()}
          onClose={() => setConfirmingDelete(false)}
        />
      ) : null}
    </ProductPage>
  );
}
