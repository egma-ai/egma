"use client";

import Link from "next/link";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import {
  archiveConnection,
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
import { asListInstant } from "../../../../../lib/instants.ts";
import { roleOf } from "../../../../../lib/me.ts";
import { startMonitoringPath } from "../../../../../lib/monitoring.ts";
import { platformAnswer, platformClient } from "../../../../../lib/platform-client.ts";
import { projectPath } from "../../../../../lib/project-context.ts";
import { canAuthor } from "../../../../../lib/roles.ts";
import { agentPlatformLabel } from "../../../../../lib/transcripts.ts";
import { Actions, Facts, Section } from "../../../../../ui/section.tsx";
import { Field, Form, FormActions, Problem } from "../../../../../ui/form.tsx";
import { DataTable, type Column } from "../../../../../ui/data-table.tsx";
import { Dialog } from "../../../../../ui/dialog.tsx";
import { Empty, Failure, Loading, NotFound } from "../../../../../ui/page-state.tsx";
import {
  ListInstant,
  RelativeInstant,
  useMinuteClock,
} from "../../../../../ui/relative-time.tsx";
import { useProjectRead } from "../../../../../ui/resource.ts";
import { useUnsavedChanges } from "../../../../../ui/settings-read.ts";
import {
  AppShell,
  PageBody,
  PageHeader,
  ProductPage,
  useShellSession,
} from "../../../../../ui/shell.tsx";
import { ArchiveConfirm } from "../archive.tsx";
import { ConnectAgentSheet } from "../connect-sheet.tsx";
import { modalityLabel } from "../connection-facts.tsx";
import { ConnectionSheet } from "../connection-sheet.tsx";
import { RowMenu, RowMenuDestructive, RowMenuLink } from "../row-menu.tsx";

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
function connectionColumns({
  projectId,
  agentId,
  whyNotChange,
  onArchive,
}: {
  readonly projectId: string;
  readonly agentId: string;
  /** Why a destructive item is not this person's, or nothing when it is. */
  readonly whyNotChange: string | undefined;
  readonly onArchive: (connection: ListedConnection) => void;
}): readonly Column<ListedConnection>[] {
  const home = projectPath(projectId, "agents", agentId);
  /*
   * The panel opens over *this* page. The connection's own address still
   * exists and still opens the same panel, over the list — but a person who
   * pressed a name here came from this agent and should come back to it, so
   * the link that opens the panel is a state of this page rather than a
   * different one.
   */
  const opens = (one: ListedConnection) =>
    `${home}?connection=${encodeURIComponent(one.id)}`;

  return [
    {
      key: "name",
      header: "Name",
      primary: true,
      width: "260px",
      cell: (one) => <Link href={opens(one)}>{one.name}</Link>,
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
    {
      /* The lane that takes the slack, exactly as it does on the list. */
      key: "created",
      header: "Created",
      hideOnMobile: true,
      cell: (one) => <ListInstant instant={one.createdAt} />,
    },
    {
      key: "menu",
      header: "Actions",
      action: true,
      cell: (one) => (
        <RowMenu label={`Actions for ${one.name}`}>
          <RowMenuLink href={opens(one)}>Open connection</RowMenuLink>
          <RowMenuDestructive onSelect={() => onArchive(one)} why={whyNotChange}>
            Archive connection
          </RowMenuDestructive>
        </RowMenu>
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
  const router = useRouter();
  const query = useSearchParams();
  const { me } = useShellSession();
  const role = me === null ? null : roleOf(me);

  const { answer, reload, refresh } = useProjectRead<AgentDetail>(
    (projectId) =>
      platformAnswer(
        getAgent({ agentId, projectId }, { client: platformClient }),
      ),
    projectId,
    agentId,
  );

  const [editing, setEditing] = useState(false);
  /** The connection a confirmation is standing in front of. */
  const [archiving, setArchiving] = useState<ListedConnection | null>(null);

  useEffect(() => {
    if (answer?.status === "signed-out") window.location.replace("/sign-in");
  }, [answer]);

  const home = projectPath(projectId, "agents", agentId);
  /** Where the trail's first crumb goes back to. */
  const agents = projectPath(projectId, "agents");

  /**
   * Which panel this page has open, read from the address and nowhere else.
   *
   * `?connection=<id>` opens that connection over this page, and
   * `?sheet=connect` opens the connect panel with this agent already chosen.
   * Both are states of *this* page rather than journeys away from it, so Back
   * closes the panel and a copied link opens it.
   */
  const openConnection = query.get("connection");
  const connecting = query.get("sheet") === "connect";
  const closeSheet = () => router.replace(home);

  if (answer === null || answer.status === "signed-out") {
    return (
      <ProductPage>
        <PageHeader
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
      {/*
       * **The trail is back in the bar.** Every other record page in the
       * product draws one there, and this page had none: the only way back
       * into the section was the sidebar.
       *
       * **Its last crumb is the word rather than this agent's name.** The bar
       * draws the trail and the title on one 56px line, so a trail ending in
       * the name says the name twice, a slash apart — which is what took the
       * trail out in the first place. The trail names the section and the kind
       * of record; the title beside it names *this* record. The run page and
       * this route's own `loading.tsx` draw the same shape.
       */}
      <PageHeader
        title={agent.name}
        /*
          The real trail: Agents, then this agent. `PageHeader` takes the last
          step off, because the heading beside it is that step. Before that
          rule this page named the *kind* here — "Agents / Agent   Ada" — to
          keep the record's own name out of the bar twice.
        */
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
               * **It preselects and bypasses nothing.** The run still chooses a
               * suite and a connection for this agent; tests are not permanently
               * attached to the agent. The server also freezes the project
               * graders whose scope matches each selected test. Hidden while the
               * agent is archived, because an archived agent cannot enter new
               * work at all.
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
        {/*
         * What only this page holds, in the line the connection panel writes
         * its own dates on.
         *
         * **The platform is deliberately not here.** Production calls below
         * already states it, and that one is the monitoring *binding* — the
         * platform egma asks for finished calls — while the list's Platform
         * column is read from the connections. Two facts that share a word, on
         * one page, would leave a person unable to tell which they were
         * reading.
         *
         * **And two dates are a line rather than a panel.** A card holding one
         * short fact per row is a card made mostly of empty space; this is the same
         * sentence the connection panel ends with, in the same words.
         */}
        <p className="mt-0 mb-6 text-sm text-faint">
          {`Created ${asListInstant(agent.createdAt)} · Last changed ${asListInstant(agent.updatedAt)}`}
        </p>
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
              /*
               * The connect panel, opened over this page with this agent
               * already chosen. It is a link rather than a button because it
               * is an address — the same panel `connections/new` opens — and a
               * person may want it in a new tab.
               */
              <Button asChild variant="secondary">
                <Link href={`${home}?sheet=connect`}>Add connection</Link>
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
              columns={connectionColumns({
                projectId,
                agentId,
                whyNotChange: mayAuthor ? undefined : whyNot,
                onArchive: setArchiving,
              })}
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

      {connecting ? (
        <ConnectAgentSheet
          projectId={projectId}
          agents={[]}
          agentId={agentId}
          mayAuthor={mayAuthor}
          role={role}
          onClose={closeSheet}
          onConnected={() => {
            router.replace(home);
            refresh();
          }}
        />
      ) : null}

      {openConnection === null ? null : (
        <ConnectionSheet
          projectId={projectId}
          agentId={agentId}
          connectionId={openConnection}
          environments={[
            ...new Set(
              connections.flatMap((one) =>
                one.environment === null ? [] : [one.environment],
              ),
            ),
          ]}
          mayAuthor={mayAuthor}
          role={role}
          onClose={closeSheet}
          onChanged={refresh}
        />
      )}

      {archiving === null ? null : (
        <ArchiveConfirm
          title="Archive connection"
          onArchive={async () => {
            const done = await platformAnswer(
              archiveConnection(
                {
                  agentId,
                  connectionId: archiving.id,
                  projectId,
                },
                { client: platformClient },
              ),
            );
            if (done.status === "signed-out") {
              window.location.replace("/sign-in");
              return null;
            }
            return done.status === "ready" ? null : done.refusal;
          }}
          onClose={() => setArchiving(null)}
          onArchived={() => {
            setArchiving(null);
            reload();
          }}
        >
          {`Egma stops using “${archiving.name}” to reach “${agent.name}”, and every run waiting on it stops. Transcripts already stored stay stored.`}
        </ArchiveConfirm>
      )}
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
  const now = useMinuteClock();

  const on = agent.pullProductionCalls;

  /*
   * **A LiveKit agent has no switch, here or anywhere.** Push is
   * observed rather than declared: the agent's own process sends its spans to
   * the OTLP door with the project key, and there is no server-side off for
   * it. Drawing "Pull production calls: Off" would offer a control that can
   * never be turned on for this agent and would read as a fault.
   */
  if (agent.agentPlatform === "livekit") {
    return (
      <Section
        title="Production calls"
        lead="This agent's own process reports its production calls to Egma. There is no switch to turn on."
        action={
          <Button asChild variant="secondary">
            <Link href={startMonitoringPath(projectId, agent.id)}>
              Read the setup steps
            </Link>
          </Button>
        }
      >
        <Facts
          facts={[
            { label: "Platform", value: "LiveKit" },
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
            <Link href={startMonitoringPath(projectId, agent.id)}>
              Start monitoring
            </Link>
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
            value: agentPlatformLabel(agent.agentPlatform),
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
          /*
           * **The second half of what an agent says about monitoring**:
           * whether it pulls, and when it last received. It is a bare fact
           * with no condition word — there is no health surface anywhere in
           * the product, and a late arrival is not a fault to report.
           */
          {
            label: "Last received",
            value:
              agent.lastReceivedAt === null ? (
                NOTHING_YET
              ) : (
                <RelativeInstant instant={agent.lastReceivedAt} now={now} />
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
                {`Egma stops asking ${platformOf(agent.agentPlatform)} `}
                {`for “${agent.name}”. Every transcript already stored stays `}
                {"stored, and its key and platform binding stay on the agent, so "}
                {"turning it back on is one action. That is a new observation "}
                {"from that moment: Egma does not go back for the calls that "}
                {"happen while the switch is off."}
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

/** No production call has arrived for this agent yet, which is not a fault. */
const NOTHING_YET = "Nothing yet";

/**
 * The platform this sentence is about, or the word that stands in for it.
 *
 * An agent with the switch on always has a platform, so the fallback is only
 * ever read by a sentence about an agent that has none. The label itself is
 * the shared one, so this screen and Monitoring cannot print two different
 * words for one platform.
 */
function platformOf(platform: string | null): string {
  return platform === null ? "its platform" : agentPlatformLabel(platform);
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
