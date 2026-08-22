"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useMemo, useState } from "react";
import {
  discoverRetellVoiceAgents,
  listAgents,
  startMonitoring,
} from "@egma/platform-api/client";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { cn } from "@/lib/utils";

import type { Refusal } from "../../../../../lib/api.ts";
import type {
  AgentPage,
  ListedAgentWithConnections,
  ListedConnection,
} from "../../../../../lib/agents.ts";
import { roleOf } from "../../../../../lib/me.ts";
import {
  platformAgentIdIn,
  platformOfConnectionType,
  type RetellAgentChoice,
  type StartedMonitoring,
} from "../../../../../lib/monitoring.ts";
import {
  platformAnswer,
  platformClient,
} from "../../../../../lib/platform-client.ts";
import { projectPath } from "../../../../../lib/project-context.ts";
import { canAuthor } from "../../../../../lib/roles.ts";
import { transcriptsPath } from "../../../../../lib/transcripts.ts";
import { Field, Form, FormActions, Problem } from "../../../../../ui/form.tsx";
import { Empty, Failure, Loading, NotFound } from "../../../../../ui/page-state.tsx";
import { useProjectRead } from "../../../../../ui/resource.ts";
import { Section } from "../../../../../ui/section.tsx";
import {
  AppShell,
  PageBody,
  PageHeader,
  ProductPage,
  useShellSession,
} from "../../../../../ui/shell.tsx";

/**
 * Start monitoring: the one flow that turns production evidence on.
 *
 * **There is no monitoring setup object to fill in.** Configuration collapsed
 * into the agent (ADR-0015): an agent binds to its platform, holds that
 * platform's sealed monitoring key, and one per-agent switch — *pull
 * production calls* — is the only stored monitoring choice in the product. So
 * this page does not save a setup row; it flips switches on agents.
 *
 * **Two platforms, two completely different answers, and the difference is
 * pull against push.**
 *
 * - **Retell** is pull: egma has to ask Retell, on a clock, with a key. So the
 *   flow asks for the account API key — *the monitoring-only credential, asked
 *   for even when a connection already holds one for the same account*,
 *   because simulation custody and monitoring custody are two jobs kept
 *   apart — lists the account with it so the platform agent id is confirmed
 *   rather than typed, and commits.
 * - **LiveKit Agents** is push: the customer's own process sends spans to the
 *   OTLP door with the project key. There is nothing to configure and nothing
 *   to switch, so that branch is *instructions*. It consults no server state
 *   and changes none — a screen that read one would be this page quietly
 *   becoming a second place monitoring is configured.
 *
 * **Ticking an unregistered Retell agent registers it.** Watching a platform
 * agent egma does not know means bringing it into the roster, because the
 * roster is the mirror of what egma knows. The commit creates the agent row,
 * seals its own copy of the key onto it, and opens its switch.
 */
export default function StartMonitoringPage() {
  const { projectId } = useParams<{ projectId: string }>();
  return (
    <AppShell>
      <StartMonitoring projectId={projectId} />
    </AppShell>
  );
}

type Platform = "retell" | "livekit_agents";

/** Which agent this flow is about, or the roster it is adding to. */
const FROM_THE_ACCOUNT = "";

/** No connection chosen: nothing prefills the platform binding. */
const NO_CONNECTION = "";

const COPY = {
  eyebrow: "Monitoring",
  title: "Start monitoring",
  lead: "Egma reads what your agent did in production. Pull asks the platform; push arrives on its own.",
  agent: "Agent",
  agentHint:
    "The Egma agent whose production calls you want. Leave it on the account option to register agents straight from Retell.",
  fromTheAccount: "Register agents from the Retell account",
  connection: "Connection",
  connectionHint:
    "A Retell chat connection knows the Retell agent id and fills it in below. A phone connection does not know it, so it fills in nothing.",
  noConnection: "None",
  platform: "Platform",
  platformHint: "Where this agent runs. Retell is pulled; LiveKit Agents pushes.",
  retell: "Retell",
  livekit: "LiveKit Agents",
  key: "Retell API key",
  keyHint:
    "The key Egma pulls production calls with. It is a monitoring-only credential, so it is asked for even when a connection already holds one.",
  list: "List Retell agents",
  listing: "Listing…",
  listed: "Agents on this Retell account",
  listedLead:
    "Choose which one this agent is. Tick any others you want Egma to watch — ticking one Egma does not know registers it.",
  which: (name: string) => `Which Retell agent is “${name}”?`,
  alsoWatch: "Also watch",
  watching: "Watching",
  registered: (name: string) => `In Egma as “${name}”`,
  unregistered: "Not in Egma yet. Ticking it registers it.",
  start: "Start monitoring",
  starting: "Starting…",
  started: "Egma is pulling production calls",
  startedLead:
    "The last 30 days are being imported now, and new calls arrive within a minute of ending.",
  openMonitoring: "Open Monitoring",
  nothingPicked: "Choose at least one Retell agent, then try again.",
  noAgents: "This Retell account has no voice agents",
  noAgentsLead: "Egma pulls voice calls. Create a voice agent in Retell, then try again.",
  cancel: "Cancel",
} as const;

function StartMonitoring({ projectId }: { readonly projectId: string }) {
  const { me } = useShellSession();
  const role = me === null ? null : roleOf(me);

  const { answer, reload } = useProjectRead<AgentPage>(
    (projectId) =>
      platformAnswer(
        listAgents({ projectId, pageSize: 200 }, { client: platformClient }),
      ),
    projectId,
  );

  const monitoring = projectPath(projectId, "monitoring");
  const header = (
    <PageHeader
      eyebrow={COPY.eyebrow}
      title={COPY.title}
      lead={COPY.lead}
      breadcrumbs={[
        { label: COPY.eyebrow, href: monitoring },
        { label: COPY.title },
      ]}
    />
  );

  if (role !== null && !canAuthor(role)) {
    return (
      <ProductPage>
        {header}
        <PageBody>
          <NotFound
            message={`Your ${role} role cannot change monitoring. Ask an organization admin to change your role, then try again.`}
          />
        </PageBody>
      </ProductPage>
    );
  }

  if (answer === null || answer.status === "signed-out") {
    return (
      <ProductPage>
        {header}
        <PageBody>
          <Loading what="this project's agents" />
        </PageBody>
      </ProductPage>
    );
  }

  if (answer.status !== "ready") {
    return (
      <ProductPage>
        {header}
        <PageBody>
          <Failure message={answer.refusal.message} onRetry={reload} />
        </PageBody>
      </ProductPage>
    );
  }

  return (
    <ProductPage>
      {header}
      <PageBody>
        <Picker projectId={projectId} agents={answer.value.agents} />
      </PageBody>
    </ProductPage>
  );
}

/** The one connection on an agent that can name it on Retell, if any. */
function prefillingConnection(
  connections: readonly ListedConnection[],
): ListedConnection | undefined {
  return connections.find((one) => platformAgentIdIn(one) !== undefined);
}

/**
 * Which platform this flow is about, once the agent and the connection have
 * had their say.
 *
 * The agent's own binding wins, because it is the fact monitoring is stored
 * against. A connection answers only where its type pins one platform, and
 * `phone_number` pins none — so where nothing answers, the person chooses.
 */
function platformFrom(
  agent: ListedAgentWithConnections | undefined,
  connection: ListedConnection | undefined,
): Platform | null {
  if (agent?.agentPlatform !== null && agent?.agentPlatform !== undefined) {
    return agent.agentPlatform;
  }
  if (connection === undefined) return null;
  return platformOfConnectionType(connection.connectionType);
}

function Picker({
  projectId,
  agents,
}: {
  readonly projectId: string;
  readonly agents: readonly ListedAgentWithConnections[];
}) {
  const [agentId, setAgentId] = useState<string>(FROM_THE_ACCOUNT);
  const [connectionId, setConnectionId] = useState<string>(NO_CONNECTION);
  const [chosenPlatform, setChosenPlatform] = useState<Platform>("retell");

  const agent = agents.find((one) => one.id === agentId);
  const connection = agent?.connections.find((one) => one.id === connectionId);
  const settled = platformFrom(agent, connection);
  const platform = settled ?? chosenPlatform;

  /** Whatever the chosen connection already knows about the Retell binding. */
  const prefilled = connection === undefined ? undefined : platformAgentIdIn(connection);

  return (
    <>
      <Section title="What Egma should watch" lead={COPY.agentHint}>
        <Form>
          <Field label={COPY.agent} htmlFor="monitoring-agent">
            <Select
              id="monitoring-agent"
              value={agentId}
              onChange={(event) => {
                setAgentId(event.target.value);
                const next = agents.find((one) => one.id === event.target.value);
                const helpful =
                  next === undefined
                    ? undefined
                    : prefillingConnection(next.connections);
                setConnectionId(helpful?.id ?? NO_CONNECTION);
              }}
            >
              <option value={FROM_THE_ACCOUNT}>{COPY.fromTheAccount}</option>
              {agents.map((one) => (
                <option key={one.id} value={one.id}>
                  {one.name}
                </option>
              ))}
            </Select>
          </Field>

          {agent === undefined || agent.connections.length === 0 ? null : (
            <Field
              label={COPY.connection}
              htmlFor="monitoring-connection"
              hint={COPY.connectionHint}
            >
              <Select
                id="monitoring-connection"
                value={connectionId}
                onChange={(event) => setConnectionId(event.target.value)}
              >
                <option value={NO_CONNECTION}>{COPY.noConnection}</option>
                {agent.connections.map((one) => (
                  <option key={one.id} value={one.id}>
                    {one.name} · {one.productLabel}
                  </option>
                ))}
              </Select>
            </Field>
          )}

          <Field
            label={COPY.platform}
            htmlFor="monitoring-platform"
            hint={COPY.platformHint}
          >
            <Select
              id="monitoring-platform"
              value={platform}
              disabled={settled !== null}
              onChange={(event) =>
                setChosenPlatform(event.target.value as Platform)
              }
            >
              <option value="retell">{COPY.retell}</option>
              <option value="livekit_agents">{COPY.livekit}</option>
            </Select>
          </Field>
        </Form>
      </Section>

      {platform === "livekit_agents" ? (
        <LiveKitInstructions projectId={projectId} />
      ) : (
        <RetellPath
          projectId={projectId}
          agent={agent}
          prefilled={prefilled}
        />
      )}
    </>
  );
}

/**
 * The Retell half: the key, the account listing, the ticks, the commit.
 *
 * Everything about the account is asked for with the key that was just typed
 * and nothing is stored until the commit, so a person who changes their mind
 * after listing has changed nothing anywhere.
 */
function RetellPath({
  projectId,
  agent,
  prefilled,
}: {
  readonly projectId: string;
  readonly agent: ListedAgentWithConnections | undefined;
  readonly prefilled: string | undefined;
}) {
  const [apiKey, setApiKey] = useState("");
  const [listing, setListing] = useState(false);
  const [listed, setListed] = useState<readonly RetellAgentChoice[] | null>(null);
  const [bound, setBound] = useState<string | null>(null);
  const [ticked, setTicked] = useState<readonly string[]>([]);
  const [starting, setStarting] = useState(false);
  const [started, setStarted] = useState<readonly StartedMonitoring[] | null>(
    null,
  );
  const [refused, setRefused] = useState<Refusal | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  /** What the radio settles on before anybody touches it. */
  const binding = useMemo(() => {
    if (bound !== null) return bound;
    if (agent?.platformAgentId !== null && agent?.platformAgentId !== undefined) {
      return agent.platformAgentId;
    }
    return prefilled ?? null;
  }, [bound, agent, prefilled]);

  async function list(): Promise<void> {
    if (listing || apiKey.trim() === "") return;
    setListing(true);
    setRefused(null);
    setProblem(null);
    setStarted(null);

    const answer = await platformAnswer(
      discoverRetellVoiceAgents(
        { projectId, apiKey: apiKey.trim() },
        { client: platformClient },
      ),
    );
    setListing(false);

    if (answer.status === "signed-out") {
      window.location.replace("/sign-in");
      return;
    }
    if (answer.status !== "ready") {
      setRefused(answer.refusal);
      setListed(null);
      return;
    }
    setListed(answer.value.agents);
    // Everything already switched on stays on screen as ticked and fixed:
    // it is a fact rather than a choice, and the commit never sends it.
    setTicked(
      answer.value.agents
        .filter((one) => one.pullProductionCalls)
        .map((one) => one.id),
    );
  }

  async function commit(): Promise<void> {
    if (starting || listed === null) return;

    const watch = [
      ...(binding === null
        ? []
        : [
            {
              platformAgentId: binding,
              ...(agent === undefined ? {} : { agentId: agent.id }),
              ...(agent === undefined
                ? { name: nameOf(listed, binding) }
                : {}),
            },
          ]),
      ...ticked
        .filter((id) => id !== binding)
        .filter((id) => !alreadyWatching(listed, id))
        .map((id) => ({ platformAgentId: id, name: nameOf(listed, id) })),
    ];

    if (watch.length === 0) {
      setProblem(COPY.nothingPicked);
      return;
    }

    setProblem(null);
    setRefused(null);
    setStarting(true);

    const answer = await platformAnswer(
      startMonitoring(
        {
          projectId,
          agentPlatform: "retell",
          apiKey: apiKey.trim(),
          watch,
        },
        { client: platformClient },
      ),
    );
    setStarting(false);

    if (answer.status === "signed-out") {
      window.location.replace("/sign-in");
      return;
    }
    if (answer.status !== "ready") {
      // Never silent, and never paraphrased: the one-switched-on-agent rule
      // refuses in the server's own words, which name the agent already
      // watching the Retell agent that was ticked.
      setRefused(answer.refusal);
      return;
    }
    setStarted(answer.value.watching);
  }

  return (
    <Section title={COPY.retell} lead={COPY.keyHint}>
      <Form onSubmit={() => void list()}>
        <Field label={COPY.key} htmlFor="retell-monitoring-key">
          <Input
            id="retell-monitoring-key"
            type="password"
            value={apiKey}
            autoComplete="off"
            spellCheck={false}
            placeholder="key_…"
            onChange={(event) => {
              setApiKey(event.target.value);
              setListed(null);
              setStarted(null);
            }}
          />
        </Field>

        {refused === null ? null : <Problem>{refused.message}</Problem>}

        <FormActions>
          <Button type="submit" disabled={listing || apiKey.trim() === ""}>
            {listing ? COPY.listing : COPY.list}
          </Button>
        </FormActions>
      </Form>

      {started !== null ? (
        <Started projectId={projectId} watching={started} />
      ) : listed === null ? null : listed.length === 0 ? (
        <Empty title={COPY.noAgents} lead={COPY.noAgentsLead} />
      ) : (
        <Section title={COPY.listed} lead={COPY.listedLead}>
          <ul className="m-0 flex list-none flex-col gap-3 p-0">
            {listed.map((one) => (
              <AccountAgent
                key={one.id}
                choice={one}
                agentName={agent?.name}
                bound={binding === one.id}
                ticked={ticked.includes(one.id)}
                onBind={() => setBound(one.id)}
                onTick={(next) =>
                  setTicked(
                    next
                      ? [...ticked, one.id]
                      : ticked.filter((id) => id !== one.id),
                  )
                }
              />
            ))}
          </ul>

          {problem === null ? null : <Problem>{problem}</Problem>}

          <FormActions>
            <Button type="button" disabled={starting} onClick={() => void commit()}>
              {starting ? COPY.starting : COPY.start}
            </Button>
            <Button asChild variant="secondary">
              <Link href={transcriptsPath(projectId)}>{COPY.cancel}</Link>
            </Button>
          </FormActions>
        </Section>
      )}
    </Section>
  );
}

function nameOf(
  listed: readonly RetellAgentChoice[],
  platformAgentId: string,
): string {
  return (
    listed.find((one) => one.id === platformAgentId)?.name ?? platformAgentId
  );
}

function alreadyWatching(
  listed: readonly RetellAgentChoice[],
  platformAgentId: string,
): boolean {
  return (
    listed.find((one) => one.id === platformAgentId)?.pullProductionCalls ===
    true
  );
}

/**
 * One agent on the Retell account.
 *
 * Three facts and at most two controls: whether egma knows it, whether egma is
 * already watching it, and what ticking it would do. An agent already being
 * watched shows the word rather than a control, because there is nothing to
 * decide about it here — its switch is turned off on its own agent screen.
 */
function AccountAgent({
  choice,
  agentName,
  bound,
  ticked,
  onBind,
  onTick,
}: {
  readonly choice: RetellAgentChoice;
  readonly agentName: string | undefined;
  readonly bound: boolean;
  readonly ticked: boolean;
  readonly onBind: () => void;
  readonly onTick: (next: boolean) => void;
}) {
  const said =
    choice.registeredAgentName === null
      ? COPY.unregistered
      : COPY.registered(choice.registeredAgentName);

  return (
    <li
      className={cn(
        "flex items-start justify-between gap-4 rounded-card border p-4",
        bound ? "border-brand bg-selected" : "border-border bg-surface",
      )}
    >
      <div className="min-w-0">
        <p className="m-0 text-base text-foreground">{choice.name}</p>
        <p className="m-0 font-mono text-sm text-muted-foreground [overflow-wrap:anywhere]">
          {choice.id}
        </p>
        <p className="mt-1 mb-0 text-sm text-muted-foreground">{said}</p>
      </div>

      <div className="flex flex-none flex-col items-end gap-2">
        {choice.pullProductionCalls ? (
          <span className="text-sm text-muted-foreground">{COPY.watching}</span>
        ) : (
          <label className="flex items-center gap-2 text-sm text-foreground">
            {COPY.alsoWatch}
            <Checkbox
              checked={ticked}
              aria-label={`${COPY.alsoWatch} ${choice.name}`}
              onChange={(event) => onTick(event.target.checked)}
            />
          </label>
        )}
        {agentName === undefined || choice.pullProductionCalls ? null : (
          <Button
            type="button"
            variant="secondary"
            aria-pressed={bound}
            onClick={onBind}
          >
            {bound ? `This is “${agentName}”` : COPY.which(agentName)}
          </Button>
        )}
      </div>
    </li>
  );
}

/** What the commit did, said as switches rather than as a saved object. */
function Started({
  projectId,
  watching,
}: {
  readonly projectId: string;
  readonly watching: readonly StartedMonitoring[];
}) {
  return (
    <Section title={COPY.started} lead={COPY.startedLead}>
      <ul className="m-0 flex list-none flex-col gap-2 p-0">
        {watching.map((one) => (
          <li key={one.agentId} className="text-base text-foreground">
            {one.agentName}
            <span className="ml-2 font-mono text-sm text-muted-foreground">
              {one.platformAgentId}
            </span>
            {one.created ? (
              <span className="ml-2 text-sm text-muted-foreground">
                registered now
              </span>
            ) : null}
          </li>
        ))}
      </ul>
      <FormActions>
        <Button asChild>
          <Link href={transcriptsPath(projectId)}>{COPY.openMonitoring}</Link>
        </Button>
      </FormActions>
    </Section>
  );
}

/**
 * The LiveKit Agents half: instructions, and nothing else.
 *
 * **It consults no server state and changes none.** Push is ungated by design:
 * the OTLP door authenticates with the project key, tenancy comes from the
 * key, and the stored evidence is the whole record of an agent pushing. There
 * is no row to write here and no switch to flip, so anything this screen read
 * would be a second place monitoring looked configured.
 */
function LiveKitInstructions({ projectId }: { readonly projectId: string }) {
  return (
    <Section
      title={COPY.livekit}
      lead="Your agent's own process sends its spans to Egma. There is nothing to switch on here."
    >
      <ol className="m-0 flex list-none flex-col gap-5 p-0">
        <Step
          number={1}
          title="Install the Egma SDK where your agent runs"
          code="pip install egma"
        />
        <Step
          number={2}
          title="Point the agent at Egma"
          lead="Set both in the agent's environment. The key must name this project — Egma rejects an organization-wide key for production telemetry."
          code={"export EGMA_URL=https://api.egma.ai\nexport EGMA_API_KEY=egma_sk_…"}
          action={
            <Button asChild variant="secondary">
              <Link href={projectPath(projectId, "settings", "keys")}>
                Mint a key for this project
              </Link>
            </Button>
          }
        />
        <Step
          number={3}
          title="Call monitor_livekit before AgentSession.start"
          lead="Before the session starts, so the first turn is recorded with everything after it."
          code={
            "from egma import monitor_livekit\n\n" +
            "async def entrypoint(ctx: agents.JobContext) -> None:\n" +
            "    monitor_livekit(ctx)\n" +
            "    await ctx.connect()\n" +
            "    await session.start(agent=agent, room=ctx.room)"
          }
        />
      </ol>
      <FormActions>
        <Button asChild>
          <Link href={transcriptsPath(projectId)}>{COPY.openMonitoring}</Link>
        </Button>
      </FormActions>
    </Section>
  );
}

function Step({
  number,
  title,
  lead,
  code,
  action,
}: {
  readonly number: number;
  readonly title: string;
  readonly lead?: string;
  readonly code: string;
  readonly action?: React.ReactNode;
}) {
  return (
    <li className="flex flex-col gap-2">
      <p className="m-0 text-base text-foreground">
        <span className="mr-2 font-mono text-sm text-muted-foreground tabular-nums">
          {number}
        </span>
        {title}
      </p>
      {lead === undefined ? null : (
        <p className="m-0 max-w-[72ch] text-sm leading-(--line-normal) text-muted-foreground">
          {lead}
        </p>
      )}
      <pre
        className={cn(
          "m-0 overflow-auto p-3",
          "rounded-input border border-border bg-background",
          "font-mono text-sm whitespace-pre-wrap [overflow-wrap:anywhere]",
        )}
      >
        {code}
      </pre>
      {action === undefined ? null : <div>{action}</div>}
    </li>
  );
}
