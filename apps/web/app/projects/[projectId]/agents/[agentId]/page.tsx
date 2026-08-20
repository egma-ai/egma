"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";

import { writeJson, type Refusal } from "../../../../../lib/api.ts";
import {
  agentDetailQuery,
  agentPath,
  type AgentDetail,
  type ListedAgent,
  type ListedConnection,
} from "../../../../../lib/agents.ts";
import {
  testsPath,
  type ListedTest,
  type TestPage,
} from "../../../../../lib/tests.ts";
import { roleOf } from "../../../../../lib/me.ts";
import { projectPath } from "../../../../../lib/project-context.ts";
import { canAuthor } from "../../../../../lib/roles.ts";
import {
  Actions,
  Button,
  ButtonLink,
  Field,
  Form,
  FormActions,
  Problem,
  Section,
  TextArea,
  TextInput,
} from "../../../../../ui/controls.tsx";
import { DataTable, type Column } from "../../../../../ui/data-table.tsx";
import { Dialog } from "../../../../../ui/dialog.tsx";
import { Empty, Failure, Loading, NotFound } from "../../../../../ui/page-state.tsx";
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
import styles from "./agent.module.css";

type AgentSection = "runs" | "tests" | "configuration";

const AGENT_SECTIONS: readonly {
  readonly id: AgentSection;
  readonly label: string;
}[] = [
  { id: "runs", label: "Recent runs" },
  { id: "tests", label: "Attached tests" },
  { id: "configuration", label: "Configuration" },
];

/**
 * One agent: what egma owns about it, and every way egma can reach it.
 *
 * **Two halves, and the split is the product boundary.** The top is the
 * Egma-owned identity — a name and a description, and nothing about the
 * provider's prompt, model or tools, because those live where the customer
 * configures them and a copy here would be stale from the moment it was taken.
 * The bottom is the active connections, which are how Egma reaches the agent.
 * Lifecycle machinery stays in the API for history and recovery, but it is not
 * a product control until customers need it.
 */
export default function AgentDetailPage() {
  const { projectId, agentId } = useParams<{
    projectId: string;
    agentId: string;
  }>();
  return (
    <AppShell>
      <AgentDetailView projectId={projectId} agentId={agentId} />
    </AppShell>
  );
}

function connectionColumns(
  projectId: string,
  agentId: string,
): readonly Column<ListedConnection>[] {
  return [
    {
      key: "name",
      header: "Connection",
      primary: true,
      cell: (one) => (
        <Link
          href={projectPath(
            projectId,
            "agents",
            agentId,
            "connections",
            one.id,
          )}
        >
          {one.name}
        </Link>
      ),
    },
    {
      key: "product-label",
      header: "Connection",
      width: "180px",
      cell: (one) => one.product_label,
    },
    {
      key: "modality",
      header: "Modality",
      hideOnMobile: true,
      width: "100px",
      cell: (one) => one.modality,
    },
  ];
}

function AgentDetailView({
  projectId,
  agentId,
}: {
  readonly projectId: string;
  readonly agentId: string;
}) {
  const { me } = useShellSession();
  const role = me === null ? null : roleOf(me);

  const { answer, reload } = useProjectRead<AgentDetail>(
    agentDetailQuery(agentId, "active"),
    projectId,
  );

  const [editing, setEditing] = useState(false);
  const [section, setSection] = useState<AgentSection>("runs");

  useEffect(() => {
    if (answer?.status === "signed-out") window.location.replace("/sign-in");
  }, [answer]);

  const agents = projectPath(projectId, "agents");

  if (answer === null || answer.status === "signed-out") {
    return (
      <ProductPage>
        <PageHeader
          eyebrow="Agent"
          title="Agent"
          breadcrumbs={[
            { label: "Agents", href: agents },
            { label: "Agent" },
          ]}
        />
        <PageBody>
          <Loading what="this agent" />
        </PageBody>
      </ProductPage>
    );
  }

  if (answer.status === "missing") {
    return (
      <ProductPage>
        <PageHeader
          eyebrow="Agent"
          title="Agent"
          breadcrumbs={[
            { label: "Agents", href: agents },
            { label: "Agent" },
          ]}
        />
        <PageBody>
          <NotFound message={answer.refusal.message} />
        </PageBody>
      </ProductPage>
    );
  }

  if (answer.status === "failed") {
    return (
      <ProductPage>
        <PageHeader
          eyebrow="Agent"
          title="Agent"
          breadcrumbs={[
            { label: "Agents", href: agents },
            { label: "Agent" },
          ]}
        />
        <PageBody>
          <Failure message={answer.refusal.message} onRetry={reload} />
        </PageBody>
      </ProductPage>
    );
  }

  const { agent, connections } = answer.value;
  const mayAuthor = role !== null && canAuthor(role);
  const whyNot =
    role === null
      ? undefined
      : `Your ${role} role cannot change agents. Ask an organization admin to change your role.`;

  return (
    <ProductPage>
      <PageHeader
        eyebrow="Agent"
        title={agent.name}
        breadcrumbs={[
          { label: "Agents", href: agents },
          { label: agent.name },
        ]}
        lead={agent.description ?? "No description yet."}
        action={
          role === null ? undefined : (
            <Actions>
              {/*
               * Straight into the builder with this agent already chosen.
               *
               * **It preselects and bypasses nothing.** The connection still
               * has to be this agent's and every test still has to apply to it.
               * The server also freezes the project's current running grader
               * copies, if any. Nothing here bypasses those checks. Hidden while
               * the agent is archived, because an archived agent cannot enter
               * new work at all.
               */}
              <ButtonLink
                href={`${projectPath(projectId, "runs", "new")}?agent=${encodeURIComponent(agent.id)}`}
              >
                Create a run
              </ButtonLink>
              <Button
                disabled={!mayAuthor}
                onClick={() => setEditing(true)}
              >
                Edit
              </Button>
            </Actions>
          )
        }
      />
      <PageBody>
        <div className={styles.agentLayout}>
          <nav className={styles.sectionNav} aria-label="Agent sections">
            <ul className={styles.sectionList}>
              {AGENT_SECTIONS.map((item) => (
                <li key={item.id}>
                  <button
                    className={styles.sectionButton}
                    type="button"
                    aria-current={section === item.id ? "page" : undefined}
                    aria-controls="agent-section-content"
                    onClick={() => setSection(item.id)}
                  >
                    {item.label}
                  </button>
                </li>
              ))}
            </ul>
          </nav>

          <div className={styles.content} id="agent-section-content">
            {section === "runs" ? (
              <RecentRuns
                projectId={projectId}
                title="Recent runs"
                lead="The newest runs against this agent."
                filters={{ agent: agentId }}
              />
            ) : null}

            {section === "tests" ? (
              <ApplicableTests projectId={projectId} agentId={agentId} />
            ) : null}

            {section === "configuration" ? (
              <Section
                title="Connections"
                lead="How Egma reaches this agent."
                action={
                  role === null ? undefined : (
                    <ButtonLink
                      href={projectPath(
                        projectId,
                        "agents",
                        agentId,
                        "connections",
                        "new",
                      )}
                      disabled={!mayAuthor}
                      why={whyNot}
                    >
                      Add connection
                    </ButtonLink>
                  )
                }
              >
                {connections.length === 0 ? (
                  <Empty
                    title="No connections"
                    lead="Egma cannot reach this agent yet. Add a connection to give it a way in."
                  />
                ) : (
                  <DataTable
                    label="Connections for this agent"
                    columns={connectionColumns(projectId, agentId)}
                    rows={connections}
                    keyOf={(one) => one.id}
                    stretchPrimaryLink
                  />
                )}
              </Section>
            ) : null}
          </div>
        </div>
      </PageBody>

      {editing ? (
        <EditAgent
          projectId={projectId}
          agent={agent}
          onClose={() => setEditing(false)}
          onSaved={() => {
            setEditing(false);
            reload();
          }}
        />
      ) : null}

    </ProductPage>
  );
}

/**
 * The Egma-owned identity, edited against the revision the form was opened on.
 *
 * **The revision goes with the save and is not a formality.** Two people
 * editing one agent from two browsers is the ordinary case; without it the
 * second save silently erases the first and neither of them is told. When egma
 * refuses for that reason the typing stays exactly where it is and the sentence
 * says what to do — reading again is one click, retyping is not.
 */
function EditAgent({
  projectId,
  agent,
  onClose,
  onSaved,
}: {
  readonly projectId: string;
  readonly agent: ListedAgent;
  readonly onClose: () => void;
  readonly onSaved: () => void;
}) {
  const [name, setName] = useState(agent.name);
  const [description, setDescription] = useState(agent.description ?? "");
  const [saving, setSaving] = useState(false);
  const [refused, setRefused] = useState<Refusal | null>(null);
  const [nameProblem, setNameProblem] = useState<string | null>(null);

  const changed =
    name !== agent.name || description !== (agent.description ?? "");
  useUnsavedChanges(changed && !saving, saving);

  async function save(): Promise<void> {
    if (saving) return;
    const wanted = name.trim();
    if (wanted === "") {
      setNameProblem("An agent needs a name, so that a list can tell it apart.");
      return;
    }

    setNameProblem(null);
    setRefused(null);
    setSaving(true);

    const answer = await writeJson<{ readonly agent: ListedAgent }>(
      agentPath(agent.id),
      {
        method: "PATCH",
        project: projectId,
        body: {
          name: wanted,
          description: description.trim() === "" ? null : description.trim(),
          expected_revision: agent.revision,
        },
      },
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
    onSaved();
  }

  return (
    <Dialog title="Edit agent" onClose={onClose}>
      {(dismiss) => (
        <Form onSubmit={() => void save()}>
          <Field label="Name" htmlFor="edit-agent-name">
            <TextInput
              id="edit-agent-name"
              value={name}
              invalid={nameProblem !== null}
              describedBy={nameProblem === null ? undefined : "edit-agent-name-problem"}
              onChange={(next) => {
                setName(next);
                if (nameProblem !== null) setNameProblem(null);
              }}
            />
            {nameProblem === null ? null : (
              <Problem id="edit-agent-name-problem">{nameProblem}</Problem>
            )}
          </Field>

          <Field label="Description" htmlFor="edit-agent-description">
            <TextArea
              id="edit-agent-description"
              value={description}
              rows={3}
              onChange={setDescription}
            />
          </Field>

          {refused === null ? null : <Problem>{refused.message}</Problem>}

          <FormActions>
            <Button type="submit" weight="strong" disabled={saving}>
              {saving ? "Saving…" : "Save"}
            </Button>
            <Button onClick={dismiss}>Cancel</Button>
          </FormActions>
        </Form>
      )}
    </Dialog>
  );
}

/**
 * The tests somebody has said are worth running against this agent.
 *
 * **Coverage is a fact about the agent, so it belongs on the agent's page.**
 * The relation is edited on the test — one test applies to several agents, and
 * a set of checkboxes there is the honest place to change it — but the question
 * "what does egma actually check about this agent" is asked here, and a page
 * that could not answer it would send somebody through every test in the
 * project to find out.
 *
 * A run may only pair this agent with a test on this list, so an empty one is
 * the reason a run builder would offer nothing.
 */
function ApplicableTests({
  projectId,
  agentId,
}: {
  readonly projectId: string;
  readonly agentId: string;
}) {
  const { answer, reload } = useProjectRead<TestPage>(
    testsPath({ agent: agentId }),
    projectId,
  );

  const columns: readonly Column<ListedTest>[] = [
    {
      key: "name",
      header: "Test",
      primary: true,
      cell: (test) => (
        <Link href={projectPath(projectId, "tests", test.id)}>{test.name}</Link>
      ),
    },
    {
      key: "behaviors",
      header: "Expects",
      hideOnMobile: true,
      width: "120px",
      cell: (test) =>
        `${String(test.expected_behaviors.length)} ${
          test.expected_behaviors.length === 1 ? "behavior" : "behaviors"
        }`,
    },
    {
      key: "version",
      header: "Version",
      mono: true,
      width: "90px",
      cell: (test) => `v${test.version}`,
    },
  ];

  return (
    <Section
      title="Attached tests"
      lead="Tests selected to run against this agent."
      action={
        <ButtonLink href={projectPath(projectId, "tests")}>All tests</ButtonLink>
      }
    >
      {answer === null || answer.status === "signed-out" ? (
        <Loading what="the tests that apply to this agent" />
      ) : answer.status === "ready" ? (
        answer.value.items.length === 0 ? (
          <Empty
            title="No test applies to this agent yet"
            lead="Link one on its own page, or write a test and select this agent."
            action={
              <ButtonLink href={projectPath(projectId, "tests", "new")}>
                Write a test
              </ButtonLink>
            }
          />
        ) : (
          <DataTable
            label="Tests that apply to this agent"
            columns={columns}
            rows={answer.value.items}
            keyOf={(test) => test.id}
            stretchPrimaryLink
          />
        )
      ) : (
        <Failure message={answer.refusal.message} onRetry={reload} />
      )}
    </Section>
  );
}
