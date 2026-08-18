"use client";

import { useParams, useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { writeJson, type Refusal } from "../../../../../lib/api.ts";
import { roleOf } from "../../../../../lib/me.ts";
import { projectPath } from "../../../../../lib/project-context.ts";
import { canAuthor } from "../../../../../lib/roles.ts";
import {
  availability,
  behaviorsAreUsable,
  testAgentsPath,
  testPath,
  testVersionsPath,
  whyBehaviorsRefuse,
  type ExpectedBehavior,
  type ListedTest,
  type TestVersionPage,
  type TestVersionRow,
} from "../../../../../lib/tests.ts";
import {
  Actions,
  Badge,
  Button,
  Field,
  Problem,
  Refused,
  Section,
  TextArea,
  TextInput,
} from "../../../../../ui/controls.tsx";
import { Dialog } from "../../../../../ui/dialog.tsx";
import { useDraftNavigation } from "../../../../../ui/draft-navigation.tsx";
import { Failure, Loading, NotFound } from "../../../../../ui/page-state.tsx";
import {
  RelativeInstant,
  useMinuteClock,
} from "../../../../../ui/relative-time.tsx";
import { useProjectRead } from "../../../../../ui/resource.ts";
import { useUnsavedChanges } from "../../../../../ui/settings-read.ts";
import { RecentRuns } from "../../../../../ui/run-status.tsx";
import {
  AppShell,
  PageBody,
  PageHeader,
  ProductPage,
  useShellSession,
} from "../../../../../ui/shell.tsx";
import {
  Behaviors,
  NamedSelector,
  SaveAction,
  VersionHistory,
} from "../editor.tsx";
import styles from "./test-detail.module.css";

/**
 * One focused test editor beside its recent activity.
 *
 * The fields read as one task, but the three safe write boundaries remain:
 * identity, versioned test content, and applicable agents each carry their own
 * concurrency token. A save in one area cannot erase an unsaved change in
 * another area.
 */
export default function TestDetailPage() {
  const { projectId, testId } = useParams<{
    projectId: string;
    testId: string;
  }>();
  return (
    <AppShell>
      <TestDetail projectId={projectId} testId={testId} />
    </AppShell>
  );
}

type Draft = {
  readonly testId: string;
  readonly project: string;
  readonly name: string;
  readonly description: string;
  readonly scenario: string;
  readonly behaviors: readonly ExpectedBehavior[];
  readonly personas: readonly string[];
  readonly agents: readonly string[];
};

type SaveArea = "settings" | "agents" | "version";

function sameStrings(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function TestDetail({
  projectId,
  testId,
}: {
  readonly projectId: string;
  readonly testId: string;
}) {
  const router = useRouter();
  const draftNavigation = useDraftNavigation();
  const { me } = useShellSession();
  const role = me === null ? null : roleOf(me);
  const mayAuthor = role !== null && canAuthor(role);
  const now = useMinuteClock();

  const { answer, reload } = useProjectRead<ListedTest>(
    testPath(testId),
    projectId,
  );
  const { answer: history, reload: reloadHistory } =
    useProjectRead<TestVersionPage>(testVersionsPath(testId), projectId);
  const readTest = answer?.status === "ready" ? answer.value : null;

  const [draft, setDraft] = useState<Draft | null>(null);
  const [baseline, setBaseline] = useState<ListedTest | null>(null);
  const [saving, setSaving] = useState(false);
  const [savingArea, setSavingArea] = useState<SaveArea | null>(null);
  const [savedAreas, setSavedAreas] = useState<ReadonlySet<SaveArea>>(new Set());
  const [failedAreas, setFailedAreas] = useState<ReadonlySet<SaveArea>>(new Set());
  const [refused, setRefused] = useState<Refusal | null>(null);
  const [reading, setReading] = useState<TestVersionRow | null>(null);
  const [confirmingLifecycle, setConfirmingLifecycle] = useState<
    "archive" | "restore" | null
  >(null);

  const test =
    baseline !== null &&
    baseline.id === testId &&
    baseline.project_id === projectId
      ? baseline
      : readTest;

  /**
   * The draft, and everything else that means "for the test on screen".
   *
   * Reset together whenever the read answers for a different test or a
   * different project — the refusal and the opened version included. A refusal
   * left behind leaves a *Try again* bound to the test that failed, and pressing
   * it would send whatever is in the fields now: this test's scenario against
   * that test's version, reported as a success for a test nobody was looking at.
   */
  useEffect(() => {
    if (readTest === null) return;
    setBaseline(readTest);
    setDraft({
      testId: readTest.id,
      project: projectId,
      name: readTest.name,
      description: readTest.description ?? "",
      scenario: readTest.scenario,
      behaviors: readTest.expected_behaviors,
      personas: readTest.personas.map((one) => one.id),
      agents: readTest.agents.map((one) => one.id),
    });
    setRefused(null);
    setSavedAreas(new Set());
    setFailedAreas(new Set());
    setReading(null);
    setConfirmingLifecycle(null);
  }, [readTest, projectId]);

  useEffect(() => {
    if (answer?.status === "signed-out") window.location.replace("/sign-in");
  }, [answer]);

  /** A draft is only ever this test's, in this project. Anything else is not shown. */
  const editing =
    draft !== null && draft.testId === testId && draft.project === projectId
      ? draft
      : null;
  const settingsChanged =
    editing !== null &&
    test !== null &&
    (editing.name !== test.name ||
      editing.description !== (test.description ?? ""));
  const versionChanged =
    editing !== null &&
    test !== null &&
    (editing.scenario !== test.scenario ||
      !sameStrings(editing.behaviors, test.expected_behaviors) ||
      !sameStrings(editing.personas, test.personas.map((one) => one.id)));
  const agentsChanged =
    editing !== null &&
    test !== null &&
    !sameStrings(editing.agents, test.agents.map((one) => one.id));
  const changed = settingsChanged || versionChanged || agentsChanged;
  useUnsavedChanges(changed && !saving, saving);

  const saveState = (
    area: SaveArea,
    areaChanged: boolean,
  ): "unchanged" | "saving" | "saved" | "failed" => {
    if (savingArea === area) return "saving";
    if (failedAreas.has(area)) return "failed";
    if (savedAreas.has(area) && !areaChanged) return "saved";
    return "unchanged";
  };

  async function write(
    path: string,
    body: Record<string, unknown>,
    method: "POST" | "PATCH" = "PATCH",
    area: SaveArea | null = null,
  ): Promise<ListedTest | null> {
    setRefused(null);
    if (area !== null) {
      setSavedAreas((held) => {
        const next = new Set(held);
        next.delete(area);
        return next;
      });
      setFailedAreas((held) => {
        const next = new Set(held);
        next.delete(area);
        return next;
      });
    }
    setSavingArea(area);
    setSaving(true);
    const written = await writeJson<ListedTest>(path, {
      method,
      project: projectId,
      body,
    });
    setSaving(false);
    setSavingArea(null);

    if (written.status === "signed-out") {
      window.location.replace("/sign-in");
      return null;
    }
    if (written.status !== "ready") {
      setRefused(written.refusal);
      if (area !== null) {
        setFailedAreas((held) => new Set(held).add(area));
      }
      return null;
    }
    if (area !== null) {
      setSavedAreas((held) => new Set(held).add(area));
    }
    return written.value;
  }

  async function saveLive(): Promise<void> {
    if (editing === null || test === null) return;
    const sent = editing;
    const written = await write(testPath(testId), {
      name: editing.name.trim(),
      description:
        editing.description.trim() === "" ? null : editing.description.trim(),
      // The live half carries the revision alone. Sending the version too would
      // make a rename fail because somebody else sharpened a scenario, which is
      // a conflict that never existed.
      expected_revision: test.revision,
    }, "PATCH", "settings");
    if (written === null) return;

    setBaseline(written);
    setDraft((current) => {
      if (
        current === null ||
        current.testId !== testId ||
        current.project !== projectId ||
        current.name !== sent.name ||
        current.description !== sent.description
      ) {
        return current;
      }
      return {
        ...current,
        name: written.name,
        description: written.description ?? "",
      };
    });
  }

  async function saveContent(): Promise<void> {
    if (editing === null || test === null) return;
    const sent = editing;
    const written = await write(testPath(testId), {
      scenario: editing.scenario.trim(),
      expected_behaviors: editing.behaviors
        .map((one) => one.trim())
        .filter((one) => one !== ""),
      personas: [...editing.personas],
      // And the content half carries the version alone, for the mirror reason.
      // Hidden capabilities and mock-tool overrides are deliberately absent.
      // The form does not edit them, so leaving them out preserves them.
      expected_version_id: test.version_id,
    }, "PATCH", "version");
    if (written !== null) {
      setBaseline(written);
      setDraft((current) => {
        if (
          current === null ||
          current.testId !== testId ||
          current.project !== projectId ||
          current.scenario !== sent.scenario ||
          !sameStrings(current.behaviors, sent.behaviors) ||
          !sameStrings(current.personas, sent.personas)
        ) {
          return current;
        }
        return {
          ...current,
          scenario: written.scenario,
          behaviors: written.expected_behaviors,
          personas: written.personas.map((one) => one.id),
        };
      });
      reloadHistory();
    }
  }

  async function saveAgents(): Promise<void> {
    if (editing === null || test === null) return;
    const sent = editing;
    const written = await write(
      testAgentsPath(testId),
      {
        agents: [...editing.agents],
        expected_applicability_revision: test.applicability_revision,
      },
      "POST",
      "agents",
    );
    if (written === null) return;

    setBaseline(written);
    setDraft((current) => {
      if (
        current === null ||
        current.testId !== testId ||
        current.project !== projectId ||
        !sameStrings(current.agents, sent.agents)
      ) {
        return current;
      }
      return {
        ...current,
        agents: written.agents.map((one) => one.id),
      };
    });
  }

  async function clone(): Promise<void> {
    if (test === null) return;
    const written = await write(`${testPath(testId)}/clone`, {}, "POST");
    if (written !== null) {
      router.push(projectPath(projectId, "tests", written.id));
    }
  }

  async function setArchived(next: boolean): Promise<void> {
    if (test === null || editing === null) return;
    const written = await write(
      `${testPath(testId)}/${next ? "archive" : "restore"}`,
      {
        expected_revision: test.revision,
        // A test an upgrade left with no agent takes one in the Restore itself,
        // so there is never an instant in which it is active and unusable.
        ...(next || test.agents.length > 0
          ? {}
          : { agents: [...editing.agents] }),
      },
      "POST",
    );
    setConfirmingLifecycle(null);
    if (written !== null) reload();
  }

  if (answer === null || answer.status === "signed-out") {
    return (
      <ProductPage>
        <PageHeader
          eyebrow="Tests"
          title="Test"
          breadcrumbs={[
            { label: "Tests", href: projectPath(projectId, "tests") },
            { label: "Test" },
          ]}
        />
        <PageBody>
          <Loading what="this test" />
        </PageBody>
      </ProductPage>
    );
  }

  if (answer.status === "missing") {
    return (
      <ProductPage>
        <PageHeader
          eyebrow="Tests"
          title="Test"
          breadcrumbs={[
            { label: "Tests", href: projectPath(projectId, "tests") },
            { label: "Test" },
          ]}
        />
        <PageBody>
          <NotFound message={answer.refusal.message} />
        </PageBody>
      </ProductPage>
    );
  }

  if (answer.status === "failed" || test === null || editing === null) {
    return (
      <ProductPage>
        <PageHeader
          eyebrow="Tests"
          title="Test"
          breadcrumbs={[
            { label: "Tests", href: projectPath(projectId, "tests") },
            { label: "Test" },
          ]}
        />
        <PageBody>
          {answer.status === "failed" ? (
            <Failure message={answer.refusal.message} onRetry={reload} />
          ) : (
            <Loading what="this test" />
          )}
        </PageBody>
      </ProductPage>
    );
  }

  const archived = test.archived_at !== null;
  const standing = availability(test);
  const behaviorProblem = whyBehaviorsRefuse(editing.behaviors);
  const whyNot = mayAuthor
    ? undefined
    : `Your ${String(role ?? "")} role cannot change tests. Ask an organization admin to change your role.`;

  return (
    <ProductPage wide>
      <PageHeader
        eyebrow="Tests"
        title={test.name}
        breadcrumbs={[
          { label: "Tests", href: projectPath(projectId, "tests") },
          { label: test.name },
        ]}
        lead={
          <>
            v{test.version} · changed{" "}
            <RelativeInstant instant={test.updated_at} now={now} />{" "}
            {archived ? <Badge tone="warn">Archived</Badge> : null}{" "}
            {standing.runnable ? null : <Badge tone="bad">Cannot run</Badge>}
          </>
        }
        action={
          <Actions>
            <Button
              disabled={!mayAuthor || saving}
              why={whyNot}
              onClick={() => draftNavigation.request(() => void clone())}
            >
              Clone
            </Button>
            <Button
              disabled={!mayAuthor || saving}
              why={whyNot}
              onClick={() =>
                setConfirmingLifecycle(archived ? "restore" : "archive")
              }
            >
              {archived ? "Restore" : "Archive"}
            </Button>
          </Actions>
        }
      />
      <PageBody>
        {refused === null ? null : (
          <Refused
            message={refused.message}
            action={<Button onClick={reload}>Read the test again</Button>}
          />
        )}

        {standing.why === null ? null : <Problem>{standing.why}</Problem>}

        <div className={styles.layout}>
          <section className={styles.editor} aria-labelledby="test-editor-title">
            <div className={styles.group}>
              <h2 className={styles.groupTitle} id="test-editor-title">
                Test details
              </h2>
              <Field label="Name" htmlFor="test-name">
                <TextInput
                  id="test-name"
                  value={editing.name}
                  disabled={!mayAuthor}
                  onChange={(name) => setDraft({ ...editing, name })}
                />
              </Field>
              <Field label="Description" htmlFor="test-description">
                <TextInput
                  id="test-description"
                  value={editing.description}
                  disabled={!mayAuthor}
                  onChange={(description) =>
                    setDraft({ ...editing, description })
                  }
                />
              </Field>
              <SaveAction
                label="Save settings"
                changed={settingsChanged}
                state={saveState("settings", settingsChanged)}
                disabled={!mayAuthor || saving || editing.name.trim() === ""}
                why={whyNot}
                onSave={() => void saveLive()}
              />
            </div>

            <div className={styles.group}>
              <Field label="Scenario" htmlFor="test-scenario">
                <TextArea
                  id="test-scenario"
                  value={editing.scenario}
                  rows={4}
                  disabled={!mayAuthor}
                  onChange={(scenario) => setDraft({ ...editing, scenario })}
                />
              </Field>

              <h3 className={styles.fieldHeading}>Expected behaviors</h3>
              <Behaviors
                behaviors={editing.behaviors}
                disabled={!mayAuthor}
                onChange={(behaviors) => setDraft({ ...editing, behaviors })}
              />
              {behaviorProblem === null ? null : <Problem>{behaviorProblem}</Problem>}

              <h3 className={styles.fieldHeading}>Persona attached</h3>
              <NamedSelector
                label="Personas"
                resource="personas"
                project={projectId}
                chosen={editing.personas}
                selectedItems={test.personas}
                disabled={!mayAuthor}
                onChange={(personaIds) =>
                  setDraft({ ...editing, personas: personaIds })
                }
              />

              <SaveAction
                label="Save version"
                changed={versionChanged}
                state={saveState("version", versionChanged)}
                disabled={
                  !mayAuthor ||
                  saving ||
                  editing.scenario.trim() === "" ||
                  !behaviorsAreUsable(editing.behaviors)
                }
                why={whyNot}
                onSave={() => void saveContent()}
              />
            </div>

            <div className={styles.group}>
              <h3 className={styles.fieldHeading}>Applies to agents</h3>
              <NamedSelector
                label="Agents"
                resource="agents"
                project={projectId}
                chosen={editing.agents}
                selectedItems={test.agents}
                disabled={!mayAuthor}
                onChange={(chosen) => setDraft({ ...editing, agents: chosen })}
              />
              {editing.agents.length === 0 ? (
                <Problem>
                  Every test must apply to at least one active agent. Select an
                  active agent and save the test again.
                </Problem>
              ) : null}
              <SaveAction
                label="Save applicable agents"
                changed={agentsChanged}
                state={saveState("agents", agentsChanged)}
                disabled={!mayAuthor || saving || editing.agents.length === 0}
                why={whyNot}
                onSave={() => void saveAgents()}
              />
            </div>
          </section>

          <aside className={styles.activity} aria-label="Test activity">
            <RecentRuns
              projectId={projectId}
              title="Recent runs"
              lead="Latest executions of this test."
              filters={{ test: testId }}
            />

            <Section title="Version history">
              {history?.status === "ready" ? (
                <VersionHistory
                  versions={history.value.items}
                  reading={reading}
                  now={now}
                  onRead={setReading}
                />
              ) : (
                <Loading what="the version history" />
              )}
            </Section>
          </aside>
        </div>
      </PageBody>

      {confirmingLifecycle === null ? null : (
        <Dialog
          title={`${confirmingLifecycle === "archive" ? "Archive" : "Restore"} test “${test.name}”?`}
          onClose={() => setConfirmingLifecycle(null)}
        >
          {(dismiss) => (
            <>
              <p>
                {confirmingLifecycle === "archive"
                  ? "This test leaves every new run. Its versions, links, and past run evidence stay available."
                  : "This test returns to new runs. Egma will refuse the restore while its current version names an archived persona."}
              </p>
              <Actions>
                <Button onClick={dismiss}>Cancel</Button>
                <Button
                  weight="strong"
                  tone={confirmingLifecycle === "archive" ? "destructive" : "default"}
                  disabled={saving}
                  onClick={() =>
                    draftNavigation.request(() =>
                      void setArchived(confirmingLifecycle === "archive")
                    )
                  }
                >
                  {saving
                    ? confirmingLifecycle === "archive"
                      ? "Archiving…"
                      : "Restoring…"
                    : confirmingLifecycle === "archive"
                      ? "Archive test"
                      : "Restore test"}
                </Button>
              </Actions>
            </>
          )}
        </Dialog>
      )}
    </ProductPage>
  );
}
