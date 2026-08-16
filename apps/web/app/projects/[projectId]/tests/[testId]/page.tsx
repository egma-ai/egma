"use client";

import { useParams, useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { sendJson, type Refusal } from "../../../../../lib/api.ts";
import { agentsQuery, type AgentPage } from "../../../../../lib/agents.ts";
import { asDay } from "../../../../../lib/instants.ts";
import { roleOf } from "../../../../../lib/me.ts";
import { personasPath, type PersonaPage } from "../../../../../lib/personas.ts";
import { projectPath } from "../../../../../lib/project-context.ts";
import { canAuthor } from "../../../../../lib/roles.ts";
import {
  availability,
  behaviorsAreUsable,
  CAPABILITIES_PATH,
  testAgentsPath,
  testPath,
  testVersionsPath,
  whyBehaviorsRefuse,
  type CapabilityCatalog,
  type ExpectedBehavior,
  type ListedTest,
  type TestVersionPage,
  type TestVersionRow,
} from "../../../../../lib/tests.ts";
import {
  Actions,
  Badge,
  Button,
  ButtonLink,
  Facts,
  Field,
  Help,
  Problem,
  Refused,
  Section,
  TextArea,
  TextInput,
} from "../../../../../ui/controls.tsx";
import { Dialog } from "../../../../../ui/dialog.tsx";
import { Failure, Loading, NotFound } from "../../../../../ui/page-state.tsx";
import { useProjectRead } from "../../../../../ui/resource.ts";
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
  CapabilityChoices,
  NamedChoices,
  VersionHistory,
} from "../editor.tsx";

/**
 * One test: what it checks now, what it checked before, which agents it applies
 * to, and the three kinds of edit.
 *
 * **The page is built around the three-way split, because the split is what
 * somebody has to understand before they save.** Renaming a test, sharpening
 * its scenario and linking a second agent look like the same act in a form and
 * are not: one changes a label, one changes what a verdict *means*, and one
 * changes where the test may run. So the three sections say what saving them
 * does, and each carries its own expectation — the revision, the version, the
 * applicability revision — so that no one of them can make the other two stale.
 *
 * **Every piece of state here belongs to this test, in this project.** The
 * drafts are reset whenever the read answers for a different one, and a refusal
 * is cleared with them: a retry left over from another test would send this
 * test's typing against that test's revision.
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
  readonly capabilities: readonly string[];
  readonly agents: readonly string[];
};

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

  const { answer, reload } = useProjectRead<ListedTest>(
    testPath(testId),
    projectId,
  );
  const { answer: history, reload: reloadHistory } =
    useProjectRead<TestVersionPage>(testVersionsPath(testId), projectId);
  const { answer: agents } = useProjectRead<AgentPage>(agentsQuery({}), projectId);
  const { answer: personas } = useProjectRead<PersonaPage>(
    personasPath(false),
    projectId,
  );
  const { answer: catalog } = useProjectRead<CapabilityCatalog>(
    CAPABILITIES_PATH,
    projectId,
  );

  const test = answer?.status === "ready" ? answer.value : null;

  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  const [refused, setRefused] = useState<Refusal | null>(null);
  const [reading, setReading] = useState<TestVersionRow | null>(null);
  const [confirmingLifecycle, setConfirmingLifecycle] = useState<
    "archive" | "restore" | null
  >(null);

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
    if (test === null) return;
    setDraft({
      testId: test.id,
      project: projectId,
      name: test.name,
      description: test.description ?? "",
      scenario: test.scenario,
      behaviors: test.expected_behaviors,
      personas: test.personas.map((one) => one.id),
      capabilities: test.required_capabilities,
      agents: test.agents.map((one) => one.id),
    });
    setRefused(null);
    setReading(null);
    setConfirmingLifecycle(null);
  }, [test, projectId]);

  useEffect(() => {
    if (answer?.status === "signed-out") window.location.replace("/sign-in");
  }, [answer]);

  /** A draft is only ever this test's, in this project. Anything else is not shown. */
  const editing =
    draft !== null && draft.testId === testId && draft.project === projectId
      ? draft
      : null;

  async function write(
    path: string,
    body: Record<string, unknown>,
    method: "POST" | "PATCH" = "PATCH",
  ): Promise<ListedTest | null> {
    setRefused(null);
    setSaving(true);
    const written = await sendJson<ListedTest>(path, {
      method,
      project: projectId,
      body,
    });
    setSaving(false);

    if (written.status === "signed-out") {
      window.location.replace("/sign-in");
      return null;
    }
    if (written.status !== "ready") {
      setRefused(written.refusal);
      return null;
    }
    return written.value;
  }

  async function saveLive(): Promise<void> {
    if (editing === null || test === null) return;
    const written = await write(testPath(testId), {
      name: editing.name.trim(),
      description:
        editing.description.trim() === "" ? null : editing.description.trim(),
      // The live half carries the revision alone. Sending the version too would
      // make a rename fail because somebody else sharpened a scenario, which is
      // a conflict that never existed.
      expected_revision: test.revision,
    });
    if (written !== null) reload();
  }

  async function saveContent(): Promise<void> {
    if (editing === null || test === null) return;
    const written = await write(testPath(testId), {
      scenario: editing.scenario.trim(),
      expected_behaviors: editing.behaviors
        .map((one) => one.trim())
        .filter((one) => one !== ""),
      personas: [...editing.personas],
      required_capabilities: [...editing.capabilities],
      // And the content half carries the version alone, for the mirror reason.
      // `mock_tools` is deliberately absent: this form does not edit the
      // overrides, so it does not send them, and leaving them out keeps them.
      expected_version_id: test.version_id,
    });
    if (written !== null) {
      reload();
      reloadHistory();
    }
  }

  async function saveAgents(): Promise<void> {
    if (editing === null || test === null) return;
    const written = await write(
      testAgentsPath(testId),
      {
        agents: [...editing.agents],
        expected_applicability_revision: test.applicability_revision,
      },
      "POST",
    );
    if (written !== null) reload();
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
        <PageHeader eyebrow="Tests" title="Test" />
        <PageBody>
          <Loading what="this test" />
        </PageBody>
      </ProductPage>
    );
  }

  if (answer.status === "missing") {
    return (
      <ProductPage>
        <PageHeader eyebrow="Tests" title="Test" />
        <PageBody>
          <NotFound
            message={answer.refusal.message}
            action={
              <ButtonLink href={projectPath(projectId, "tests")}>
                Back to tests
              </ButtonLink>
            }
          />
        </PageBody>
      </ProductPage>
    );
  }

  if (answer.status === "failed" || test === null || editing === null) {
    return (
      <ProductPage>
        <PageHeader eyebrow="Tests" title="Test" />
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
  const activeAgents =
    agents?.status === "ready"
      ? agents.value.items.filter((one) => one.archived_at === null)
      : [];
  const activePersonas =
    personas?.status === "ready"
      ? personas.value.items.filter((one) => one.archived_at === null)
      : [];

  /**
   * The agents this editor offers: the project's active ones, plus every agent
   * this test already applies to.
   *
   * The second half is what keeps an archived link visible. Offering only the
   * active ones would make an archived agent silently disappear from the set
   * the moment somebody opened the editor and saved anything at all.
   */
  const agentChoices = [
    ...activeAgents.map((one) => ({
      id: one.id,
      name: one.name,
      archived_at: one.archived_at,
    })),
    ...test.agents.filter(
      (one) => !activeAgents.some((active) => active.id === one.id),
    ),
  ];

  const behaviorProblem = whyBehaviorsRefuse(editing.behaviors);
  const whyNot = mayAuthor
    ? undefined
    : `Your ${String(role ?? "")} role cannot change tests. Ask an organization admin to change your role.`;

  return (
    <ProductPage>
      <PageHeader
        eyebrow="Tests"
        title={test.name}
        lead={
          <>
            v{test.version} · changed {asDay(test.updated_at)}{" "}
            {archived ? <Badge tone="warn">Archived</Badge> : null}{" "}
            {standing.runnable ? null : <Badge tone="bad">Cannot run</Badge>}
          </>
        }
        action={
          <ButtonLink href={projectPath(projectId, "tests")}>
            Back to tests
          </ButtonLink>
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

        <Section
          title="What it is"
          lead="Live settings. They take effect the moment they are saved and change nothing about any verdict already made."
        >
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
              onChange={(description) => setDraft({ ...editing, description })}
            />
          </Field>
          <Button
            disabled={!mayAuthor || saving || editing.name.trim() === ""}
            why={whyNot}
            onClick={() => void saveLive()}
          >
            Save settings
          </Button>
        </Section>

        <Section
          title="Which agents it applies to"
          lead="Target coverage. Changing it makes no version and no repository copy stale — a run may only pair an agent with a test linked to it."
        >
          <NamedChoices
            legend="Applicable agents"
            available={agentChoices}
            chosen={editing.agents}
            disabled={!mayAuthor}
            onChange={(chosen) => setDraft({ ...editing, agents: chosen })}
          />
          {editing.agents.length === 0 ? (
            <Problem>
              Every test must apply to at least one active agent. Select an
              active agent and save the test again.
            </Problem>
          ) : null}
          <Button
            disabled={!mayAuthor || saving || editing.agents.length === 0}
            why={whyNot}
            onClick={() => void saveAgents()}
          >
            Save applicable agents
          </Button>
        </Section>

        <Section
          title="What it checks"
          lead="Immutable version content. Saving a change here makes a new version and applies from then on; runs already judged keep meaning what they meant. Saving content that has not changed makes no version at all."
        >
          <Field label="Scenario" htmlFor="test-scenario">
            <TextArea
              id="test-scenario"
              value={editing.scenario}
              rows={5}
              disabled={!mayAuthor}
              onChange={(scenario) => setDraft({ ...editing, scenario })}
            />
          </Field>

          <h3>Expected behaviors</h3>
          <Behaviors
            behaviors={editing.behaviors}
            disabled={!mayAuthor}
            onChange={(behaviors) => setDraft({ ...editing, behaviors })}
          />
          {behaviorProblem === null ? null : <Problem>{behaviorProblem}</Problem>}
          <Help>
            Every one of these has to hold. A grader that reports rather than
            blocks is a setting on the grader, not on a sentence.
          </Help>

          <h3>Who calls</h3>
          <NamedChoices
            legend="Personas"
            available={[
              ...activePersonas.map((one) => ({
                id: one.id,
                name: one.name,
                archived_at: one.archived_at,
              })),
              ...test.personas.filter(
                (one) => !activePersonas.some((active) => active.id === one.id),
              ),
            ]}
            chosen={editing.personas}
            disabled={!mayAuthor}
            onChange={(personaIds) =>
              setDraft({ ...editing, personas: personaIds })
            }
          />

          <h3>What a connection has to be able to do</h3>
          <CapabilityChoices
            catalog={catalog?.status === "ready" ? catalog.value.items : []}
            chosen={editing.capabilities}
            disabled={!mayAuthor}
            onChange={(capabilities) => setDraft({ ...editing, capabilities })}
          />

          <Button
            disabled={
              !mayAuthor ||
              saving ||
              editing.scenario.trim() === "" ||
              !behaviorsAreUsable(editing.behaviors)
            }
            why={whyNot}
            onClick={() => void saveContent()}
          >
            Save version
          </Button>
        </Section>

        <Section
          title="What else this test carries"
          lead="Facts about the current version that this browser reads and does not author."
        >
          <Facts
            facts={[
              {
                label: "Mock tool overrides",
                value:
                  test.override_count > 0 ? (
                    <>
                      <Badge>Overrides present</Badge> {test.override_count}{" "}
                      {test.override_count === 1 ? "tool" : "tools"} answered by
                      this test. They are versioned content, this browser does not
                      edit them, and a clone copies them.
                    </>
                  ) : (
                    "None. The project's mock tools are the whole world for this test."
                  ),
              },
              { label: "Current version", value: test.version_id },
              {
                label: "Applies to",
                value:
                  test.agents.length === 0
                    ? "nothing — restore it with an agent selected"
                    : test.agents
                        .map(
                          (one) =>
                            `${one.name}${(one.archived_at ?? null) === null ? "" : " (archived)"}`,
                        )
                        .join(", "),
              },
            ]}
          />
        </Section>

        {/*
          What this test has actually been run against lately. The same
          component the agent page uses, because it is the same question asked
          of a different subject — and the answer keeps machinery and judgment
          apart on both.
        */}
        <RecentRuns
          projectId={projectId}
          title="Recent runs"
          lead="The newest runs that executed a version of this test. Each row keeps the run's machinery and its verdict apart."
          filters={{ test: testId }}
        />

        <Section
          title="Version history"
          lead="Every version stays exactly as it was written, because a run that pinned one has to stay interpretable."
        >
          {history?.status === "ready" ? (
            <VersionHistory
              versions={history.value.items}
              reading={reading}
              onRead={setReading}
            />
          ) : (
            <Loading what="the version history" />
          )}
        </Section>

        <Section
          title="This test"
          lead="Archive takes it out of every new run and keeps every version, every link and every run that used it."
        >
          <Actions>
            <Button disabled={!mayAuthor || saving} why={whyNot} onClick={() => void clone()}>
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
          {archived ? (
            <Help>
              Restore is refused while this test&rsquo;s current version names an
              archived persona or grader. Restore those first.
            </Help>
          ) : null}
        </Section>
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
                  : "This test returns to new runs. Egma will refuse the restore while its current version names an archived persona or grader."}
              </p>
              <Actions>
                <Button onClick={dismiss}>Cancel</Button>
                <Button
                  weight="strong"
                  disabled={saving}
                  onClick={() =>
                    void setArchived(confirmingLifecycle === "archive")
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
