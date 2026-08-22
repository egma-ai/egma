"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import {
  getAgent,
  stopMonitoring,
  updateAgent,
} from "@egma/platform-api/client";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import type { Refusal } from "../../../../../lib/api.ts";
import {
  NO_ENVIRONMENT,
  type AgentDetail,
  type ListedAgent,
  type ListedConnection,
} from "../../../../../lib/agents.ts";
import { roleOf } from "../../../../../lib/me.ts";
import { startMonitoringPath } from "../../../../../lib/monitoring.ts";
import { platformAnswer, platformClient } from "../../../../../lib/platform-client.ts";
import { projectPath } from "../../../../../lib/project-context.ts";
import { canAuthor } from "../../../../../lib/roles.ts";
import { Actions, Facts, Section } from "../../../../../ui/section.tsx";
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
 * Egma-owned identity — a name, and nothing about the
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
 * its platform, connection type, access variant, and modality. A label table
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
        <ProductionCalls
          projectId={projectId}
          agent={agent}
          mayAuthor={mayAuthor}
          /*
           * Its own sentence, because this control changes monitoring rather
           * than the agent's identity, and a person told the wrong thing they
           * cannot do goes looking in the wrong place.
           */
          whyNot={
            role === null
              ? undefined
              : `Your ${role} role cannot change monitoring. Ask an organization admin to change your role.`
          }
          onChanged={reload}
        />
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
 * The pull switch, on the agent that owns it.
 *
 * **This is the only stored monitoring choice in the product.** There is no
 * setup object, no per-platform integration row, and no project-wide kill
 * switch: an agent binds to its platform, holds that platform's sealed
 * monitoring key, and this switch says whether egma asks the platform for its
 * finished production calls (ADR-0015).
 *
 * **Off is a door and on is a flow, and that asymmetry is honest rather than
 * lazy.** Turning it off needs nothing but the decision, so it happens here.
 * Turning it on needs the platform key — sealed randomly, never readable
 * back — so it happens in the start-monitoring flow, which asks for the key,
 * lists the account, and confirms which platform agent this is.
 *
 * **Push is not here at all.** An agent whose own process sends spans to the
 * OTLP door has no switch anywhere, because there is no server-side off for
 * it. It shows itself through its traffic in Monitoring and nowhere else.
 */
function ProductionCalls({
  projectId,
  agent,
  mayAuthor,
  whyNot,
  onChanged,
}: {
  readonly projectId: string;
  readonly agent: ListedAgent;
  readonly mayAuthor: boolean;
  readonly whyNot: string | undefined;
  readonly onChanged: () => void;
}) {
  const [stopping, setStopping] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [refused, setRefused] = useState<Refusal | null>(null);

  const on = agent.pullProductionCalls;

  /*
   * **A LiveKit Agents agent has no switch, here or anywhere.** Push is
   * observed rather than declared: the agent's own process sends its spans to
   * the OTLP door with the project key, and there is no server-side off for
   * it. Drawing "Pull production calls: Off" would offer a control that can
   * never be turned on for this agent and would read as a fault.
   */
  if (agent.agentPlatform === "livekit_agents") {
    return (
      <Section
        title="Production calls"
        lead="This agent's own process reports its production calls to Egma. There is no switch to turn on."
        action={
          <Button asChild variant="secondary">
            <Link href={startMonitoringPath(projectId)}>
              Read the setup steps
            </Link>
          </Button>
        }
      >
        <Facts
          facts={[
            { label: "Platform", value: "LiveKit Agents" },
            {
              label: "How evidence arrives",
              value: "Reported by the agent, using this project's API key.",
            },
          ]}
        />
      </Section>
    );
  }

  async function stop(): Promise<void> {
    if (stopping) return;
    setRefused(null);
    setStopping(true);

    const answer = await platformAnswer(
      stopMonitoring({ agentId: agent.id, projectId }, { client: platformClient }),
    );

    setStopping(false);
    if (answer.status === "signed-out") {
      window.location.replace("/sign-in");
      return;
    }
    if (answer.status !== "ready") {
      setRefused(answer.refusal);
      return;
    }
    setConfirming(false);
    onChanged();
  }

  return (
    <Section
      title="Production calls"
      lead="Whether Egma asks this agent's platform for the calls it has finished."
      action={
        on ? (
          <Button
            type="button"
            variant="secondary"
            disabled={!mayAuthor}
            why={mayAuthor ? undefined : whyNot}
            onClick={() => setConfirming(true)}
          >
            Stop pulling
          </Button>
        ) : mayAuthor ? (
          <Button asChild variant="secondary">
            <Link href={startMonitoringPath(projectId)}>Start monitoring</Link>
          </Button>
        ) : (
          <Button type="button" variant="secondary" disabled why={whyNot}>
            Start monitoring
          </Button>
        )
      }
    >
      {/*
       * The state is a word and a shape before it is a colour, because
       * `DESIGN.md` does not let colour carry a state on its own. The facts
       * under it are what the switch is standing on: the platform, its own id
       * for this agent, and the last characters of the sealed key — never the
       * key, which nothing reads back.
       */}
      <Facts
        facts={[
          {
            label: "Pull production calls",
            value: (
              <span className="inline-flex items-center gap-2">
                <span
                  aria-hidden="true"
                  className={cn(
                    "inline-block size-2 rounded-chip",
                    on ? "bg-brand" : "bg-muted-foreground",
                  )}
                />
                {on ? "On" : "Off"}
              </span>
            ),
          },
          {
            label: "Platform",
            value: agent.agentPlatform === null
              ? NOT_BOUND
              : agentPlatformLabel(agent.agentPlatform),
          },
          {
            label: "Platform agent ID",
            value:
              agent.platformAgentId === null ? (
                NOT_BOUND
              ) : (
                <span className="font-mono text-sm">{agent.platformAgentId}</span>
              ),
          },
          {
            label: "Monitoring key",
            value:
              agent.monitoringApiKeyHint === null ? (
                NO_KEY
              ) : (
                <span className="font-mono text-sm">
                  {`…${agent.monitoringApiKeyHint}`}
                </span>
              ),
          },
        ]}
      />

      {refused === null ? null : <Problem>{refused.message}</Problem>}

      {confirming ? (
        <Dialog title="Stop pulling production calls" onClose={() => setConfirming(false)}>
          {(dismiss) => (
            <Form onSubmit={() => void stop()}>
              <p className="m-0 max-w-[72ch] text-base leading-(--line-normal) text-foreground">
                {`Egma stops asking ${agentPlatformLabel(agent.agentPlatform)} `}
                {`for “${agent.name}”. Every transcript already stored stays `}
                {"stored, and its key and platform binding stay on the agent, so "}
                {"starting again picks up where this left off."}
              </p>
              {refused === null ? null : <Problem>{refused.message}</Problem>}
              <FormActions>
                <Button type="submit" disabled={stopping}>
                  {stopping ? "Stopping…" : "Stop pulling"}
                </Button>
                <Button type="button" variant="secondary" onClick={dismiss}>
                  Cancel
                </Button>
              </FormActions>
            </Form>
          )}
        </Dialog>
      ) : null}
    </Section>
  );
}

/** Nothing binds this agent to a platform yet, which is a lawful state. */
const NOT_BOUND = "Not bound";

/** No monitoring key is sealed on this agent. Never the key itself. */
const NO_KEY = "None";

/** The platform's product name, said the way the rest of the product says it. */
function agentPlatformLabel(platform: string | null): string {
  if (platform === "retell") return "Retell";
  if (platform === "livekit_agents") return "LiveKit Agents";
  return "its platform";
}

/**
 * The Egma-owned identity: the name, and nothing about the agent itself.
 *
 * **Saving is last-writer-wins.** The revision column was dropped pre-launch
 * (ADR-0015), so two people editing one agent from two browsers is a silent
 * overwrite — accepted with eyes open, and the exact failure the column
 * existed to stop.
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
  const [saving, setSaving] = useState(false);
  const [refused, setRefused] = useState<Refusal | null>(null);
  const [nameProblem, setNameProblem] = useState<string | null>(null);

  const changed = name !== agent.name;
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
