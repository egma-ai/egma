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
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
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
  type StartOutcome,
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
  isThis: (name: string) => `This is “${name}”`,
  pairing: (agentName: string, retellName: string) =>
    `“${agentName}” is ${retellName}`,
  bindFirst: (name: string) =>
    `Choose which Retell agent “${name}” is, then start monitoring. Without ` +
    "that, Egma would register a second agent for the same Retell agent.",
  allWatched: "Egma already pulls every voice agent on this Retell account.",
  alsoWatch: "Also watch",
  watching: "Watching",
  registered: (name: string) => `In Egma as “${name}”`,
  unregistered: "Not in Egma yet. Ticking it registers it.",
  start: "Start monitoring",
  starting: "Starting…",
  started: "Egma is pulling production calls",
  registeredNow: "registered now",
  notStarted: "Not started",
  notStartedLead:
    "These stayed as they were. Nothing about them changed.",
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
          /*
           * Keyed by the agent it is about. Everything inside — the pasted
           * key, the account listing, the chosen binding — was decided for
           * one agent, and carrying it across to another would commit a
           * binding somebody chose for a different agent.
           */
          key={agent?.id ?? FROM_THE_ACCOUNT}
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
 *
 * **The commit is per tick and the answer says so.** One tick can lose the
 * one-switched-on-agent rule while the ticks beside it start, so what comes
 * back is two lists — what started and what did not — and both are shown. The
 * account listing is then read again, so an agent that started reads as
 * *Watching* and cannot be ticked a second time.
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
  const [outcome, setOutcome] = useState<StartOutcome | null>(null);
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

  /**
   * Read the account, and settle the ticks from what came back.
   *
   * `keep` is what a commit could not start: still wanted, still ticked, and
   * the person does not have to find it again. Everything that did start is a
   * fact rather than a tick, so it cannot be sent a second time.
   */
  async function readAccount(
    quiet: boolean,
    keep: readonly string[] = [],
  ): Promise<readonly RetellAgentChoice[] | null> {
    if (!quiet) setListing(true);
    const answer = await platformAnswer(
      discoverRetellVoiceAgents(
        { projectId, apiKey: apiKey.trim() },
        { client: platformClient },
      ),
    );
    if (!quiet) setListing(false);

    if (answer.status === "signed-out") {
      window.location.replace("/sign-in");
      return null;
    }
    if (answer.status !== "ready") {
      setRefused(answer.refusal);
      setListed(null);
      return null;
    }
    setListed(answer.value.agents);
    // Everything already switched on stays on screen as ticked and fixed: it
    // is a fact rather than a choice, and the commit never sends it again.
    setTicked(
      answer.value.agents
        .filter((one) => one.pullProductionCalls || keep.includes(one.id))
        .map((one) => one.id),
    );
    return answer.value.agents;
  }

  async function list(): Promise<void> {
    if (listing || apiKey.trim() === "") return;
    setRefused(null);
    setProblem(null);
    setOutcome(null);
    await readAccount(false);
  }

  async function commit(): Promise<void> {
    if (starting || listed === null) return;

    /*
     * **A picked agent has to be bound before anything is committed.** Left
     * unanswered, the ticks would go without an agent id, the server would
     * resolve them by platform id alone, and a second agent named after the
     * Retell agent would appear beside the one already picked — a silent
     * duplicate of the same thing.
     */
    if (agent !== undefined && binding === null) {
      setProblem(COPY.bindFirst(agent.name));
      return;
    }

    const watch = [
      ...(binding === null || alreadyWatching(listed, binding)
        ? []
        : [
            {
              platformAgentId: binding,
              ...(agent === undefined
                ? { name: nameOf(listed, binding) }
                : { agentId: agent.id }),
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

    if (answer.status === "signed-out") {
      window.location.replace("/sign-in");
      return;
    }
    if (answer.status !== "ready") {
      setStarting(false);
      setRefused(answer.refusal);
      return;
    }

    setOutcome(answer.value);
    /*
     * Read the account again before the button comes back. What started now
     * reads as *Watching*, so it is neither shown as a choice nor sent a
     * second time — which is what makes pressing again harmless rather than a
     * repeat of work already done.
     */
    await readAccount(
      true,
      answer.value.refused.map((one) => one.platformAgentId),
    );
    setStarting(false);
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
              setOutcome(null);
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

      {outcome === null ? null : (
        <Outcome projectId={projectId} outcome={outcome} />
      )}

      {listed === null ? null : listed.length === 0 ? (
        <Empty title={COPY.noAgents} lead={COPY.noAgentsLead} />
      ) : (
        <Section title={COPY.listed} lead={COPY.listedLead}>
          <RadioGroup
            value={binding ?? ""}
            aria-label={agent === undefined ? COPY.listed : COPY.which(agent.name)}
            onValueChange={(next) => {
              setBound(next);
              if (problem !== null) setProblem(null);
            }}
          >
            <ul className="m-0 flex list-none flex-col gap-3 p-0">
              {listed.map((one) => (
                <AccountAgent
                  key={one.id}
                  choice={one}
                  agentName={agent?.name}
                  bound={binding === one.id}
                  ticked={ticked.includes(one.id)}
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
          </RadioGroup>

          {problem === null ? null : <Problem>{problem}</Problem>}

          <FormActions>
            <Button
              type="button"
              disabled={starting || everyOneWatched(listed)}
              why={everyOneWatched(listed) ? COPY.allWatched : undefined}
              onClick={() => void commit()}
            >
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

/** Nothing left to start, because every agent on the account is watched. */
function everyOneWatched(listed: readonly RetellAgentChoice[]): boolean {
  return listed.every((one) => one.pullProductionCalls);
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
  onTick,
}: {
  readonly choice: RetellAgentChoice;
  readonly agentName: string | undefined;
  readonly bound: boolean;
  readonly ticked: boolean;
  readonly onTick: (next: boolean) => void;
}) {
  const said =
    choice.registeredAgentName === null
      ? COPY.unregistered
      : COPY.registered(choice.registeredAgentName);
  const tickId = `watch-${choice.id}`;
  const bindId = `bind-${choice.id}`;

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
          <div className="flex min-h-(--tap-target) items-center gap-2">
            <Label htmlFor={tickId}>{COPY.alsoWatch}</Label>
            <Checkbox
              id={tickId}
              checked={ticked}
              aria-label={`${COPY.alsoWatch} ${choice.name}`}
              onChange={(event) => onTick(event.target.checked)}
            />
          </div>
        )}
        {agentName === undefined || choice.pullProductionCalls ? null : (
          <div className="flex min-h-(--tap-target) items-center gap-2">
            <Label htmlFor={bindId}>{COPY.isThis(agentName)}</Label>
            {/*
             * Every row's visible label reads the same words, because in the
             * row they mean this row. Heard out of that context they would be
             * one name for a whole group of choices, so the announced name
             * carries both halves of the pairing.
             */}
            <RadioGroupItem
              id={bindId}
              value={choice.id}
              aria-label={COPY.pairing(agentName, choice.name)}
            />
          </div>
        )}
      </div>
    </li>
  );
}

/**
 * What the commit turned out to be, tick by tick.
 *
 * **Both lists are shown, always.** A commit that started three agents and
 * lost the fourth is two facts, and showing only the refusal would leave three
 * switches on that nothing on screen mentions — the exact thing that makes
 * somebody press the button again.
 */
function Outcome({
  projectId,
  outcome,
}: {
  readonly projectId: string;
  readonly outcome: StartOutcome;
}) {
  return (
    <>
      {outcome.watching.length === 0 ? null : (
        <Section title={COPY.started} lead={COPY.startedLead}>
          <ul className="m-0 flex list-none flex-col gap-2 p-0">
            {outcome.watching.map((one) => (
              <li key={one.agentId} className="text-base text-foreground">
                {one.agentName}
                <span className="ml-2 font-mono text-sm text-muted-foreground">
                  {one.platformAgentId}
                </span>
                {one.created ? (
                  <span className="ml-2 text-sm text-muted-foreground">
                    {COPY.registeredNow}
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
      )}

      {outcome.refused.length === 0 ? null : (
        <Section title={COPY.notStarted} lead={COPY.notStartedLead}>
          <ul className="m-0 flex list-none flex-col gap-3 p-0">
            {outcome.refused.map((one) => (
              <li
                key={one.platformAgentId}
                className="rounded-card border border-border bg-surface p-4"
              >
                <p className="m-0 font-mono text-sm text-muted-foreground [overflow-wrap:anywhere]">
                  {one.platformAgentId}
                </p>
                {/*
                 * The server's own sentence, relayed word for word. The rule
                 * it explains is the database's, and paraphrasing it here
                 * would be this page inventing a rule it does not own.
                 */}
                <p className="mt-1 mb-0 max-w-[72ch] text-base leading-(--line-normal) text-foreground">
                  {one.message}
                </p>
              </li>
            ))}
          </ul>
        </Section>
      )}
    </>
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
            "from egma import monitor_livekit\n" +
            "from livekit import agents\n" +
            "from livekit.agents import Agent, AgentSession\n\n" +
            "async def entrypoint(ctx: agents.JobContext) -> None:\n" +
            "    monitor_livekit(ctx)\n" +
            "    await ctx.connect()\n\n" +
            "    agent = Agent(instructions=INSTRUCTIONS)\n" +
            "    session = AgentSession(stt=..., llm=..., tts=...)\n" +
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
