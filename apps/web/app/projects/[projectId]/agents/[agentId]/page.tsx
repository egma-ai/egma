"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";

import { writeJson, type Refusal } from "../../../../../lib/api.ts";
import {
  agentActionPath,
  agentDetailQuery,
  agentPath,
  NO_ENVIRONMENT,
  type AgentDetail,
  type ArchiveFilter,
  type ListedAgent,
  type ListedConnection,
} from "../../../../../lib/agents.ts";
import { asDay } from "../../../../../lib/instants.ts";
import { roleOf } from "../../../../../lib/me.ts";
import { projectPath } from "../../../../../lib/project-context.ts";
import { canAuthor } from "../../../../../lib/roles.ts";
import {
  Actions,
  Badge,
  Button,
  ButtonLink,
  Choice,
  Fact,
  Facts,
  Field,
  Problem,
  Section,
  TextArea,
  TextInput,
} from "../../../../../ui/controls.tsx";
import { DataTable, type Column } from "../../../../../ui/data-table.tsx";
import { Dialog } from "../../../../../ui/dialog.tsx";
import { Empty, Failure, Loading, NotFound } from "../../../../../ui/page-state.tsx";
import { useProjectRead } from "../../../../../ui/resource.ts";
import {
  AppShell,
  PageBody,
  PageHeader,
  ProductPage,
  useShellSession,
} from "../../../../../ui/shell.tsx";

/**
 * One agent: what egma owns about it, and every way egma can reach it.
 *
 * **Two halves, and the split is the product boundary.** The top is the
 * Egma-owned identity — a name and a description, and nothing about the
 * provider's prompt, model or tools, because those live where the customer
 * configures them and a copy here would be stale from the moment it was taken.
 * The bottom is the connections, which are how egma reaches the agent and are
 * where the credentials and the measured capabilities live.
 *
 * **An archived agent opens.** Following a link to one has to work — its runs
 * are still evidence and Restore has to be reachable from somewhere — so this
 * page reads whether or not the agent is active and says which it is.
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

const CONNECTION_FILTERS: readonly { value: ArchiveFilter; label: string }[] = [
  { value: "active", label: "Active" },
  { value: "archived", label: "Archived" },
];

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
    { key: "type", header: "Type", width: "110px", cell: (one) => one.type },
    {
      key: "modality",
      header: "Modality",
      width: "100px",
      cell: (one) => one.modality,
    },
    {
      key: "environment",
      header: "Environment",
      width: "130px",
      cell: (one) => one.environment ?? NO_ENVIRONMENT,
    },
    {
      key: "credential",
      header: "Credential",
      width: "140px",
      cell: (one) =>
        one.credential_present ? (
          // The hint and never the secret: enough to tell two keys apart, and
          // enough to see that a rotation landed.
          <span>Stored · {one.credentials_hint ?? "—"}</span>
        ) : (
          <span>None stored</span>
        ),
    },
    {
      key: "capabilities",
      header: "Capabilities",
      width: "150px",
      cell: (one) =>
        one.capabilities.state === "known" ? (
          <Badge tone="good" title={`Checked ${asDay(one.capabilities.checked_at ?? "")}`}>
            {(one.capabilities.supported ?? []).length} known
          </Badge>
        ) : (
          // Never "none": nobody has looked, which is a different fact from a
          // target that was measured and has none.
          <Badge tone="warn">Unknown</Badge>
        ),
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

  const [filter, setFilter] = useState<ArchiveFilter>("active");
  const { answer, reload } = useProjectRead<AgentDetail>(
    agentDetailQuery(agentId, filter),
    projectId,
  );

  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState<"archive" | "restore" | null>(null);

  useEffect(() => {
    if (answer?.status === "signed-out") window.location.replace("/sign-in");
  }, [answer]);

  const agents = projectPath(projectId, "agents");

  if (answer === null || answer.status === "signed-out") {
    return (
      <ProductPage>
        <PageHeader eyebrow="Agent" title="Agent" />
        <PageBody>
          <Loading what="this agent" />
        </PageBody>
      </ProductPage>
    );
  }

  if (answer.status === "missing") {
    return (
      <ProductPage>
        <PageHeader eyebrow="Agent" title="Agent" />
        <PageBody>
          <NotFound
            message={answer.refusal.message}
            action={<ButtonLink href={agents}>Back to agents</ButtonLink>}
          />
        </PageBody>
      </ProductPage>
    );
  }

  if (answer.status === "failed") {
    return (
      <ProductPage>
        <PageHeader eyebrow="Agent" title="Agent" />
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
        lead={agent.description ?? "No description yet."}
        action={
          role === null ? undefined : (
            <Actions>
              <Button
                disabled={!mayAuthor || agent.archived}
                onClick={() => setEditing(true)}
              >
                Edit
              </Button>
              {agent.archived ? (
                <Button
                  weight="strong"
                  disabled={!mayAuthor}
                  onClick={() => setConfirming("restore")}
                >
                  Restore
                </Button>
              ) : (
                <Button disabled={!mayAuthor} onClick={() => setConfirming("archive")}>
                  Archive
                </Button>
              )}
            </Actions>
          )
        }
      />
      <PageBody>
        {agent.archived ? (
          <Empty
            title="This agent is archived"
            lead="It stays readable and its runs stay open, and it cannot enter new work. Its connections were archived with it and each one is restored on its own terms."
          />
        ) : null}

        {role !== null && !mayAuthor ? <Problem>{whyNot}</Problem> : null}

        <Facts label="What egma knows about this agent">
          <Fact name="Identifier" mono>
            {agent.id}
          </Fact>
          <Fact name="State">
            {agent.archived ? (
              <Badge tone="warn">Archived</Badge>
            ) : (
              <Badge>Active</Badge>
            )}
          </Fact>
          <Fact name="Registered" mono>
            {asDay(agent.created_at)}
          </Fact>
          <Fact name="Last changed" mono>
            {asDay(agent.updated_at)}
          </Fact>
        </Facts>

        <Section
          title="Connections"
          lead="How egma reaches this agent. The same agent can be reached several ways, and a simulation records which one it ran over."
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
                disabled={!mayAuthor || agent.archived}
                why={
                  agent.archived
                    ? "Restore this agent before adding a way to reach it."
                    : whyNot
                }
              >
                Add connection
              </ButtonLink>
            )
          }
        >
          <Choice
            label="Which connections"
            value={filter}
            options={CONNECTION_FILTERS}
            onChange={setFilter}
          />
          {connections.length === 0 ? (
            <Empty
              title={
                filter === "archived"
                  ? "No archived connections"
                  : "No active connections"
              }
              lead={
                filter === "archived"
                  ? "Nothing has been archived on this agent."
                  : "Egma cannot reach this agent yet. Add a connection to give it a way in."
              }
            />
          ) : (
            <DataTable
              label={`${filter} connections for this agent`}
              columns={connectionColumns(projectId, agentId)}
              rows={connections}
              keyOf={(one) => one.id}
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

      {confirming === null ? null : (
        <ConfirmLifecycle
          projectId={projectId}
          agent={agent}
          action={confirming}
          onClose={() => setConfirming(null)}
          onDone={() => {
            setConfirming(null);
            reload();
          }}
        />
      )}
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
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
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

        <Actions>
          <Button type="submit" weight="strong" disabled={saving}>
            {saving ? "Saving…" : "Save"}
          </Button>
          <Button onClick={onClose}>Cancel</Button>
        </Actions>
      </form>
    </Dialog>
  );
}

/**
 * Archive and Restore, each said plainly before it happens.
 *
 * Archive stops work that may be running right now — queued simulations settle
 * at once and conversations already happening are asked to stop — so the dialog
 * says so rather than letting somebody find out from a run that went
 * `canceled`. Restore says the other half: the connections do not come back
 * with the agent, because bringing them back would put old provider
 * credentials into use without anybody choosing to.
 */
function ConfirmLifecycle({
  projectId,
  agent,
  action,
  onClose,
  onDone,
}: {
  readonly projectId: string;
  readonly agent: ListedAgent;
  readonly action: "archive" | "restore";
  readonly onClose: () => void;
  readonly onDone: () => void;
}) {
  const [working, setWorking] = useState(false);
  const [refused, setRefused] = useState<Refusal | null>(null);
  const [name, setName] = useState(agent.name);

  const archiving = action === "archive";

  async function go(): Promise<void> {
    if (working) return;
    setRefused(null);
    setWorking(true);

    const answer = await writeJson<unknown>(agentActionPath(agent.id, action), {
      method: "POST",
      project: projectId,
      body: {
        expected_revision: agent.revision,
        ...(archiving || name.trim() === agent.name ? {} : { name: name.trim() }),
      },
    });

    setWorking(false);

    if (answer.status === "signed-out") {
      window.location.replace("/sign-in");
      return;
    }
    if (answer.status !== "ready") {
      setRefused(answer.refusal);
      return;
    }
    onDone();
  }

  return (
    <Dialog
      title={archiving ? "Archive this agent?" : "Restore this agent?"}
      onClose={onClose}
    >
      <p>
        {archiving
          ? "Archiving takes this agent out of new work and archives every active connection with it. Queued simulations over those connections are canceled, and conversations already happening are asked to stop. Past runs stay readable."
          : "Restoring brings the agent back. Its connections stay archived, and each one is restored on its own terms so that an old credential is never quietly reused."}
      </p>

      {archiving ? null : (
        <Field label="Name" htmlFor="restore-agent-name">
          <TextInput id="restore-agent-name" value={name} onChange={setName} />
        </Field>
      )}

      {refused === null ? null : <Problem>{refused.message}</Problem>}

      <Actions>
        <Button weight="strong" disabled={working} onClick={() => void go()}>
          {working
            ? archiving
              ? "Archiving…"
              : "Restoring…"
            : archiving
              ? "Archive agent"
              : "Restore agent"}
        </Button>
        <Button onClick={onClose}>Cancel</Button>
      </Actions>
    </Dialog>
  );
}
