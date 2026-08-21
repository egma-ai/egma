"use client";

import { useParams, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import {
  archiveTest,
  cloneTest,
  getTest,
  listTestVersions,
  restoreTest,
  setTestAgents,
  updateTest,
} from "@egma/platform-api/client";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import type { Refusal } from "../../../../../lib/api.ts";
import { roleOf } from "../../../../../lib/me.ts";
import {
  platformAnswer,
  platformClient,
  type PlatformRequest,
} from "../../../../../lib/platform-client.ts";
import { projectPath } from "../../../../../lib/project-context.ts";
import { canAuthor } from "../../../../../lib/roles.ts";
import {
  availability,
  behaviorsAreUsable,
  whyBehaviorsRefuse,
  type ExpectedBehavior,
  type ListedTest,
  type TestVersionPage,
  type TestVersionRow,
} from "../../../../../lib/tests.ts";
import { Actions, Section } from "../../../../../ui/section.tsx";
import { Field, Problem, Refused } from "../../../../../ui/form.tsx";
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

/**
 * One group of fields inside the editing card, and the small heading that
 * names a part of one.
 *
 * They are named here rather than repeated four times, because the hairline
 * between groups and the heading step are one decision each about how this
 * page reads — not four.
 */
const GROUP =
  "flex min-w-0 flex-col gap-4 p-6 " +
  "border-t border-border first:border-t-0 " +
  "max-[40rem]:p-4";

const FIELD_HEADING = "m-0 text-sm font-medium text-foreground";

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
    (projectId) =>
      platformAnswer(
        getTest({ testId, projectId }, { client: platformClient }),
      ),
    projectId,
    testId,
  );
  const { answer: history, reload: reloadHistory } =
    useProjectRead<TestVersionPage>(
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
    baseline.projectId === projectId
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
      behaviors: readTest.expectedBehaviors,
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
      !sameStrings(editing.behaviors, test.expectedBehaviors) ||
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
    request: PlatformRequest<ListedTest>,
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
    const written = await platformAnswer(request);
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
    const written = await write(
      updateTest(
        {
          testId,
          projectId,
          name: editing.name.trim(),
          description:
            editing.description.trim() === "" ? null : editing.description.trim(),
      // The live half carries the revision alone. Sending the version too would
      // make a rename fail because somebody else sharpened a scenario, which is
      // a conflict that never existed.
          expectedRevision: test.revision,
        },
        { client: platformClient },
      ),
      "settings",
    );
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
    const written = await write(
      updateTest(
        {
          testId,
          projectId,
          scenario: editing.scenario.trim(),
          expectedBehaviors: editing.behaviors
            .map((one) => one.trim())
            .filter((one) => one !== ""),
          personas: [...editing.personas],
      // And the content half carries the version alone, for the mirror reason.
      // Hidden capabilities and mock-tool overrides are deliberately absent.
      // The form does not edit them, so leaving them out preserves them.
          expectedVersionId: test.versionId,
        },
        { client: platformClient },
      ),
      "version",
    );
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
          behaviors: written.expectedBehaviors,
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
      setTestAgents(
        {
          testId,
          projectId,
          agents: [...editing.agents],
          expectedApplicabilityRevision: test.applicabilityRevision,
        },
        { client: platformClient },
      ),
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
    const written = await write(
      cloneTest(
        { testId, projectId },
        { client: platformClient },
      ),
    );
    if (written !== null) {
      router.push(projectPath(projectId, "tests", written.id));
    }
  }

  async function setArchived(next: boolean): Promise<void> {
    if (test === null || editing === null) return;
    const request = next
      ? archiveTest(
          {
            testId,
            projectId,
            expectedRevision: test.revision,
          },
          { client: platformClient },
        )
      : restoreTest(
          {
            testId,
            projectId,
            expectedRevision: test.revision,
        // A test an upgrade left with no agent takes one in the Restore itself,
        // so there is never an instant in which it is active and unusable.
            ...(test.agents.length > 0 ? {} : { agents: [...editing.agents] }),
          },
          { client: platformClient },
        );
    const written = await write(request);
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

  const archived = test.archivedAt !== null;
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
            <RelativeInstant instant={test.updatedAt} now={now} />{" "}
            {archived ? <Badge variant="warning">Archived</Badge> : null}{" "}
            {standing.runnable ? null : (
              <Badge variant="failure">Cannot run</Badge>
            )}
          </>
        }
        action={
          <Actions>
            <Button
              type="button"
              variant="secondary"
              disabled={!mayAuthor || saving}
              why={whyNot}
              onClick={() => draftNavigation.request(() => void clone())}
            >
              Clone
            </Button>
            <Button
              type="button"
              variant="secondary"
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
            action={
              <Button type="button" variant="secondary" onClick={reload}>
                Read the test again
              </Button>
            }
          />
        )}

        {standing.why === null ? null : <Problem>{standing.why}</Problem>}

        {/*
          One editing column beside a rail of what has been happening to this
          test. The rail is narrow and never below 340px, because a run row
          with a verdict on it stops being readable before that; below 72rem
          there is no room for two columns at all and the rail goes under the
          editor rather than getting thinner.
        */}
        <div
          className={
            "grid items-start gap-8 " +
            "grid-cols-[minmax(0,1.55fr)_minmax(340px,0.85fr)] " +
            "max-[72rem]:grid-cols-1"
          }
        >
          <section
            className="min-w-0 rounded-card border border-border bg-surface"
            aria-labelledby="test-editor-title"
          >
            <div className={GROUP}>
              <h2
                className="m-0 text-lg font-medium text-foreground"
                id="test-editor-title"
              >
                Test details
              </h2>
              <Field label="Name" htmlFor="test-name">
                <Input
                  id="test-name"
                  value={editing.name}
                  disabled={!mayAuthor}
                  autoComplete="off"
                  spellCheck={false}
                  onChange={(event) =>
                    setDraft({ ...editing, name: event.target.value })
                  }
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
                state={saveState("settings", settingsChanged)}
                disabled={!mayAuthor || saving || editing.name.trim() === ""}
                why={whyNot}
                onSave={() => void saveLive()}
              />
            </div>

            <div className={GROUP}>
              <Field label="Scenario" htmlFor="test-scenario">
                <Textarea
                  id="test-scenario"
                  value={editing.scenario}
                  rows={4}
                  disabled={!mayAuthor}
                  onChange={(event) =>
                    setDraft({ ...editing, scenario: event.target.value })
                  }
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

            <div className={GROUP}>
              <h3 className={FIELD_HEADING}>Applies to agents</h3>
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

          {/*
            The rail follows the page down while the editor is long, and stops
            doing so once the layout is one column and there is nothing beside
            it to follow.

            `mt-0!` is not decoration. A shared `Section` carries its own top
            margin for a page's main column, and a CSS Modules stylesheet is
            unlayered, so an ordinary utility loses to it whatever the class
            list says. Important is what reaches across that boundary. It goes
            when `Section` is migrated and can be told directly.
          */}
          <aside
            className={
              "sticky top-5 flex min-w-0 flex-col gap-8 " +
              "max-[72rem]:static [&>section]:mt-0!"
            }
            aria-label="Test activity"
          >
            <RecentRuns
              projectId={projectId}
              title="Recent runs"
              lead="Latest executions of this test."
              filters={{ testId }}
            />

            <Section title="Version history">
              {history?.status === "ready" ? (
                <VersionHistory
                  versions={history.value.versions}
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
                <Button type="button" variant="secondary" onClick={dismiss}>
                  Cancel
                </Button>
                <Button
                  type="button"
                  variant={
                    confirmingLifecycle === "archive" ? "destructive" : "default"
                  }
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
