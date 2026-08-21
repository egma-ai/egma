"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import { getAgent, updateAgent } from "@egma/platform-api/client";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import type { Refusal } from "../../../../../lib/api.ts";
import {
  NO_ENVIRONMENT,
  type AgentDetail,
  type ListedAgent,
  type ListedConnection,
} from "../../../../../lib/agents.ts";
import { roleOf } from "../../../../../lib/me.ts";
import { platformAnswer, platformClient } from "../../../../../lib/platform-client.ts";
import { projectPath } from "../../../../../lib/project-context.ts";
import { canAuthor } from "../../../../../lib/roles.ts";
import { Actions, Section } from "../../../../../ui/section.tsx";
import { Field, Form, FormActions, Problem } from "../../../../../ui/form.tsx";
import { DataTable, type Column } from "../../../../../ui/data-table.tsx";
import { Dialog } from "../../../../../ui/dialog.tsx";
import { Empty, Failure, Loading, NotFound } from "../../../../../ui/page-state.tsx";
import { useProjectRead } from "../../../../../ui/resource.ts";
import { useUnsavedChanges } from "../../../../../ui/settings-read.ts";
import {
  AppShell,
  PageBody,
  PageHeader,
  ProductPage,
  useShellSession,
} from "../../../../../ui/shell.tsx";
import { modalityLabel } from "../connection-facts.tsx";

/**
 * One agent: what egma owns about it, and every way egma can reach it.
 *
 * **Two things, and the split is the product boundary.** The header is the
 * Egma-owned identity — a name and a description, and nothing about the
 * provider's prompt, model or tools, because those live where the customer
 * configures them and a copy here would be stale from the moment it was taken.
 * The body is the connections, which are how Egma reaches the agent, and this
 * is their one home: added here, opened from here, changed from there.
 *
 * **What this page deliberately does not hold is runs and tests.** Both were
 * here, each behind a section of its own, and both were a second rendering of
 * something another area owns: which tests apply to an agent is the Tests
 * area's fact, and what an agent has been run through is the Runs area's. Two
 * places to read one fact is two places to keep in step, and the page paid for
 * it by burying connection custody under sections that belonged elsewhere.
 * Starting a run from here is still one click, because starting work is an
 * action rather than a second copy of a record.
 *
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

/**
 * A connection, said the same way the agents list says it.
 *
 * The product label comes down on the connection, derived by the registry from
 * its platform, connection kind, access variant, and modality. A label table
 * kept in this application would be a second vocabulary able to disagree with
 * the registry that gates the connection forms.
 */
function connectionColumns(
  projectId: string,
  agentId: string,
): readonly Column<ListedConnection>[] {
  return [
    {
      key: "name",
      header: "Name",
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
      key: "environment",
      header: "Environment",
      width: "140px",
      cell: (one) => one.environment ?? NO_ENVIRONMENT,
    },
    {
      key: "product-label",
      header: "Connection",
      width: "180px",
      cell: (one) => one.productLabel,
    },
    {
      key: "modality",
      header: "Modality",
      hideOnMobile: true,
      width: "100px",
      cell: (one) => modalityLabel(one.modality),
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
    (projectId) =>
      platformAnswer(
        getAgent({ agentId, projectId }, { client: platformClient }),
      ),
    projectId,
    agentId,
  );

  const [editing, setEditing] = useState(false);

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
              <Button asChild variant="secondary">
                <Link
                  href={`${projectPath(projectId, "runs", "new")}?agent=${encodeURIComponent(agent.id)}`}
                >
                  Create a run
                </Link>
              </Button>
              <Button
                type="button"
                variant="secondary"
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
        <Section
          title="Connections"
          lead="How Egma reaches this agent."
          action={
            role === null ? undefined : mayAuthor ? (
              <Button asChild variant="secondary">
                <Link
                  href={projectPath(
                    projectId,
                    "agents",
                    agentId,
                    "connections",
                    "new",
                  )}
                >
                  Add connection
                </Link>
              </Button>
            ) : (
              <Button type="button" variant="secondary" disabled why={whyNot}>
                Add connection
              </Button>
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

    const answer = await platformAnswer(
      updateAgent(
        {
          agentId: agent.id,
          projectId,
          name: wanted,
          description: description.trim() === "" ? null : description.trim(),
          expectedRevision: agent.revision,
        },
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
    onSaved();
  }

  return (
    <Dialog title="Edit agent" onClose={onClose}>
      {(dismiss) => (
        <Form onSubmit={() => void save()}>
          <Field label="Name" htmlFor="edit-agent-name">
            <Input
              id="edit-agent-name"
              value={name}
              aria-invalid={nameProblem !== null ? true : undefined}
              aria-describedby={
                nameProblem === null ? undefined : "edit-agent-name-problem"
              }
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => {
                setName(event.target.value);
                if (nameProblem !== null) setNameProblem(null);
              }}
            />
            {nameProblem === null ? null : (
              <Problem id="edit-agent-name-problem">{nameProblem}</Problem>
            )}
          </Field>

          <Field label="Description" htmlFor="edit-agent-description">
            <Textarea
              id="edit-agent-description"
              value={description}
              rows={3}
              onChange={(event) => setDescription(event.target.value)}
            />
          </Field>

          {refused === null ? null : <Problem>{refused.message}</Problem>}

          <FormActions>
            <Button type="submit" disabled={saving}>
              {saving ? "Saving…" : "Save"}
            </Button>
            <Button type="button" variant="secondary" onClick={dismiss}>
              Cancel
            </Button>
          </FormActions>
        </Form>
      )}
    </Dialog>
  );
}
