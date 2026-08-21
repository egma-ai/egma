"use client";

import { useParams, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import {
  deleteTest,
  getTest,
  getTestSuite,
  listTestVersions,
  updateTest,
} from "@egma/platform-api/client";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import type { Refusal } from "../../../../../lib/api.ts";
import { roleOf } from "../../../../../lib/me.ts";
import {
  platformAnswer,
  platformClient,
} from "../../../../../lib/platform-client.ts";
import { canAuthor } from "../../../../../lib/roles.ts";
import {
  suitePagePath,
  type TestSuite,
} from "../../../../../lib/test-suites.ts";
import {
  behaviorsAreUsable,
  whyBehaviorsRefuse,
  type ExpectedBehavior,
  type ListedTest,
  type TestVersionPage,
  type TestVersionRow,
} from "../../../../../lib/tests.ts";
import { Dialog } from "../../../../../ui/dialog.tsx";
import { Field, Problem, Refused } from "../../../../../ui/form.tsx";
import { Failure, Loading, NotFound } from "../../../../../ui/page-state.tsx";
import { RelativeInstant, useMinuteClock } from "../../../../../ui/relative-time.tsx";
import { useProjectRead } from "../../../../../ui/resource.ts";
import { Actions, Section } from "../../../../../ui/section.tsx";
import { useUnsavedChanges } from "../../../../../ui/settings-read.ts";
import {
  AppShell,
  PageBody,
  PageHeader,
  ProductPage,
  useShellSession,
} from "../../../../../ui/shell.tsx";
import { Behaviors, NamedSelector, SaveAction, VersionHistory } from "../editor.tsx";

const GROUP =
  "flex min-w-0 flex-col gap-4 border-t border-border p-6 first:border-t-0 max-[40rem]:p-4";
const FIELD_HEADING = "m-0 text-sm font-medium text-foreground";

type Draft = {
  readonly testId: string;
  readonly projectId: string;
  readonly name: string;
  readonly description: string;
  readonly scenario: string;
  readonly behaviors: readonly ExpectedBehavior[];
  readonly personas: readonly string[];
};

type SaveArea = "settings" | "version";
type SaveState = "unchanged" | "saving" | "saved" | "failed";

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export default function TestDetailPage() {
  const { projectId, testId } = useParams<{ projectId: string; testId: string }>();
  return (
    <AppShell>
      <TestDetail projectId={projectId} testId={testId} />
    </AppShell>
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
      platformAnswer(
        getTest({ testId, projectId }, { client: platformClient }),
      ),
    projectId,
    testId,
  );
  const { answer: history, reload: reloadHistory } = useProjectRead<TestVersionPage>(
    (projectId) =>
      platformAnswer(
        listTestVersions(
          { testId, projectId },
          { client: platformClient },
        ),
      ),
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
  const [saving, setSaving] = useState<SaveArea | null>(null);
  const [saveStates, setSaveStates] = useState<Record<SaveArea, SaveState>>({
    settings: "unchanged",
    version: "unchanged",
  });
  const [refused, setRefused] = useState<Refusal | null>(null);
  const [reading, setReading] = useState<TestVersionRow | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);

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
    setDraft({
      testId: readTest.id,
      projectId,
      name: readTest.name,
      description: readTest.description ?? "",
      scenario: readTest.scenario,
      behaviors: readTest.expectedBehaviors,
      personas: readTest.personas.map((persona) => persona.id),
    });
    setSaveStates({ settings: "unchanged", version: "unchanged" });
    setRefused(null);
    setReading(null);
    setConfirmingDelete(false);
  }, [readTest, projectId]);

  useEffect(() => {
    if (
      answer?.status === "signed-out" ||
      history?.status === "signed-out" ||
      suite?.status === "signed-out"
    ) {
      window.location.replace("/sign-in");
    }
  }, [answer, history, suite]);

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

  function stateFor(area: SaveArea, changed: boolean): SaveState {
    if (saving === area) return "saving";
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
              .map((behavior) => behavior.trim())
              .filter((behavior) => behavior !== ""),
            personas: [...editing.personas],
            expectedVersionId: test.versionId,
          };
    const written = await platformAnswer(
      updateTest(
        { testId, projectId, ...body },
        { client: platformClient },
      ),
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
      if (
        held === null ||
        held.testId !== testId ||
        held.projectId !== projectId
      ) {
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
    if (area === "version") reloadHistory();
  }

  async function remove(): Promise<void> {
    if (test === null) return;
    setDeleting(true);
    setRefused(null);
    const deleted = await platformAnswer(
      deleteTest(
        { testId: test.id, projectId },
        { client: platformClient },
      ),
    );
    setDeleting(false);
    if (deleted.status === "signed-out") {
      window.location.replace("/sign-in");
      return;
    }
    if (deleted.status !== "ready") {
      setRefused(deleted.refusal);
      return;
    }
    router.push(suitePagePath(projectId, test.suiteId));
  }

  const basicBreadcrumbs = [
    { label: "Tests", href: `/projects/${encodeURIComponent(projectId)}/tests` },
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

  return (
    <ProductPage wide>
      <PageHeader
        title={test.name}
        breadcrumbs={[
          { label: "Tests", href: `/projects/${encodeURIComponent(projectId)}/tests` },
          { label: suite.value.name, href: suitePagePath(projectId, suite.value.id) },
          { label: test.name },
        ]}
        lead={<>v{test.version} · changed <RelativeInstant instant={test.updatedAt} now={now} /></>}
        action={
          <Button
            type="button"
            variant="destructive"
            disabled={!mayAuthor || saving !== null}
            why={whyNot}
            onClick={() => setConfirmingDelete(true)}
          >
            Delete test
          </Button>
        }
      />
      <PageBody>
        {refused === null ? null : (
          <Refused
            message={refused.message}
            action={
              <Button type="button" variant="secondary" onClick={reload}>
                Read the test again
              </Button>
            }
          />
        )}

        <div className="grid items-start gap-8 grid-cols-[minmax(0,1.55fr)_minmax(340px,0.85fr)] max-[72rem]:grid-cols-1">
          <section
            className="min-w-0 rounded-card border border-border bg-surface"
            aria-labelledby="test-editor-title"
          >
            <div className={GROUP}>
              <h2 className="m-0 text-lg font-medium" id="test-editor-title">Test details</h2>
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
                  onChange={(event) => setDraft({ ...editing, description: event.target.value })}
                />
              </Field>
              <SaveAction
                label="Save settings"
                changed={settingsChanged}
                state={stateFor("settings", settingsChanged)}
                disabled={!mayAuthor || saving !== null || editing.name.trim() === ""}
                why={whyNot}
                onSave={() => void save("settings")}
              />
            </div>

            <div className={GROUP}>
              <Field label="Scenario" htmlFor="test-scenario">
                <Textarea
                  id="test-scenario"
                  value={editing.scenario}
                  rows={4}
                  disabled={!mayAuthor}
                  onChange={(event) => setDraft({ ...editing, scenario: event.target.value })}
                />
              </Field>
              <h3 className={FIELD_HEADING}>Expected behaviors</h3>
              <Behaviors
                behaviors={editing.behaviors}
                disabled={!mayAuthor}
                onChange={(behaviors) => setDraft({ ...editing, behaviors })}
              />
              {behaviorProblem === null ? null : <Problem>{behaviorProblem}</Problem>}
              <h3 className={FIELD_HEADING}>Persona attached</h3>
              <NamedSelector
                label="Personas"
                resource="personas"
                project={projectId}
                chosen={editing.personas}
                selectedItems={test.personas}
                disabled={!mayAuthor}
                onChange={(personas) => setDraft({ ...editing, personas })}
              />
              <SaveAction
                label="Save version"
                changed={versionChanged}
                state={stateFor("version", versionChanged)}
                disabled={
                  !mayAuthor ||
                  saving !== null ||
                  editing.scenario.trim() === "" ||
                  !behaviorsAreUsable(editing.behaviors)
                }
                why={whyNot}
                onSave={() => void save("version")}
              />
            </div>
          </section>

          <aside className="sticky top-5 min-w-0 max-[72rem]:static" aria-label="Test history">
            <Section title="Version history">
              {history === null || history.status === "signed-out" ? (
                <Loading what="the version history" />
              ) : history.status === "ready" ? (
                <VersionHistory
                  versions={history.value.versions}
                  reading={reading}
                  now={now}
                  onRead={setReading}
                />
              ) : (
                <Failure message={history.refusal.message} onRetry={reloadHistory} />
              )}
            </Section>
          </aside>
        </div>
      </PageBody>

      {confirmingDelete ? (
        <Dialog title={`Delete ${test.name}`} onClose={() => setConfirmingDelete(false)}>
          {(dismiss) => (
            <div className="flex flex-col gap-5">
              <p className="m-0 text-sm text-muted-foreground">
                This permanently deletes {test.name}. You cannot restore it. Past run evidence stays available.
              </p>
              {refused === null ? null : <Refused message={refused.message} />}
              <Actions>
                <Button type="button" variant="secondary" disabled={deleting} onClick={dismiss}>
                  Cancel
                </Button>
                <Button
                  type="button"
                  variant="destructive"
                  busy={deleting}
                  onClick={() => void remove()}
                >
                  {deleting ? "Deleting…" : "Delete test"}
                </Button>
              </Actions>
            </div>
          )}
        </Dialog>
      ) : null}
    </ProductPage>
  );
}
