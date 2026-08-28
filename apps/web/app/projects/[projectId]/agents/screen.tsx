"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import {
  archiveAgent,
  getAgent,
  listAgents,
  stopMonitoring,
} from "@egma/platform-api/client";

import { Button } from "@/components/ui/button";
import type { Refusal } from "@/lib/api.ts";
import {
  agentPlatformText,
  type AgentPage,
  type ListedAgentWithConnections,
} from "@/lib/agents.ts";
import { firstProjectOf, roleOf } from "@/lib/me.ts";
import { platformAnswer, platformClient } from "@/lib/platform-client.ts";
import { projectLanding, projectPath } from "@/lib/project-context.ts";
import { canAuthor } from "@/lib/roles.ts";
import { cn } from "@/lib/utils";
import { DataTable, type Column } from "@/ui/data-table.tsx";
import { Empty, Failure, Loading, NotFound } from "@/ui/page-state.tsx";
import { useMinuteClock } from "@/ui/relative-time.tsx";
import { useProjectRead } from "@/ui/resource.ts";
import { SearchField } from "@/ui/section.tsx";
import { PageBody, PageHeader, ProductPage, useShellSession } from "@/ui/shell.tsx";

import { ArchiveConfirm } from "./archive.tsx";
import {
  type AgentDetailsReadState,
  AgentDetailsReadStateSheet,
  AgentDetailsSheet,
  CapabilityState,
  MonitoringEvidence,
  monitoringCapabilityOf,
  simulationCapabilityOf,
} from "./agent-details-sheet.tsx";
import {
  ConnectAgentSheet,
  type ConnectAgentGoal,
  type ConnectAgentPlatform,
} from "./connect-sheet.tsx";
import { ConnectionSheet } from "./connection-sheet.tsx";
import { RenameAgentSheet } from "./rename-sheet.tsx";

/**
 * The agents of one project: the landing page of the product, and the one
 * screen every agent and connection panel opens over.
 *
 * **You start with the system you are testing.** An agent is the customer's
 * voice agent — the thing egma exists to establish trust in — so this is what a
 * signed-in person sees first, rather than a home page assembled out of
 * fragments of everything else.
 *
 * **One screen, and every panel is a state of it.** Connecting an agent,
 * reading a connection and changing one all happen in a side sheet over this
 * list (`DESIGN.md`, Side sheets). The three addresses that used to be pages
 * of their own — `agents/new`, `connections/new`, `connections/:id` — still
 * work and each opens the panel it names, and the agent's own address, whose
 * page is retired, lands on this list. So a link in the CLI, the docs or
 * somebody's notes still arrives somewhere honest.
 *
 * **Opening a panel never navigates.** Every control here changes query state
 * on the address the person is already at (the founder's blanket ruling of
 * 2026-08-24); the old addresses survive as deep-link aliases and nothing
 * else.
 *
 * **Which panel is open is in the address, and nowhere else.** Back closes a
 * sheet, a copied link opens one, and a reload keeps it. State held in this
 * component instead would disagree with the address the first time somebody
 * pressed Back.
 *
 * The project is in the address and in the request, every time.
 *
 * **Search is asked of the server, never applied to what came back.** A filter
 * that only reached the page already fetched would answer differently depending
 * on how far somebody had scrolled — a list of four hundred agents would find
 * nothing in the three hundred it had not loaded, and would say so as though
 * the project did not hold it.
 */

/** The panel a route insists on, whatever the query string says. */
export type ForcedSheet =
  | {
      readonly kind: "connect";
      readonly agentId?: string;
      readonly goal?: ConnectAgentGoal;
      readonly platform?: ConnectAgentPlatform;
      readonly onboarding?: boolean;
    }
  | { readonly kind: "agent"; readonly agentId: string }
  | { readonly kind: "connection"; readonly agentId: string; readonly connectionId: string };

export function AgentsScreen({
  projectId,
  forced,
}: {
  readonly projectId: string;
  readonly forced?: ForcedSheet;
}) {
  const router = useRouter();
  const query = useSearchParams();
  const { me } = useShellSession();
  // Null until the session read answers. A page that guessed would tell an
  // admin their role cannot do something it can, on every load.
  const role = me === null ? null : roleOf(me);
  const mayAuthor = role !== null && canAuthor(role);

  const [typed, setTyped] = useState("");
  const [search, setSearch] = useState("");

  /**
   * The typed text is debounced into the text the request is made from, so
   * every keystroke is not a request. Both are kept: the box shows what
   * somebody typed the instant they typed it, and the list follows.
   */
  useEffect(() => {
    const settle = setTimeout(() => setSearch(typed), 250);
    return () => clearTimeout(settle);
  }, [typed]);

  const { answer, reload, refresh } = useProjectRead<AgentPage>(
    (projectId) =>
      platformAnswer(
        listAgents(
          { projectId, ...(search.trim() === "" ? {} : { search: search.trim() }) },
          { client: platformClient },
        ),
      ),
    projectId,
    search,
  );

  /**
   * Pages fetched after the first, kept beside it rather than folded into it,
   * so that asking again always starts from a clean first page — **and each one
   * remembers the project it was fetched for.**
   *
   * That is not belt and braces. Changing project does not remount this screen:
   * it is the same route with another project in it, so this state outlives the
   * change and a read still in flight comes back into a view that has moved on.
   * Carrying the project in the value means a page fetched for somewhere else
   * can never be *rendered* here, whatever wrote it and whenever it landed.
   */
  const [after, setAfter] = useState<{
    readonly project: string;
    readonly page: AgentPage;
  } | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  /** Why the next page did not arrive, until somebody asks for it again. */
  const [moreRefused, setMoreRefused] = useState<Refusal | null>(null);
  const [stoppingAgent, setStoppingAgent] = useState<string | null>(null);
  const [stopRefused, setStopRefused] = useState<{
    readonly agentId: string;
    readonly refusal: Refusal;
  } | null>(null);
  /** The agent a confirmation is standing in front of. */
  const [archiving, setArchiving] = useState<ListedAgentWithConnections | null>(null);
  /** The agent whose name is being changed, in the sheet that changes it. */
  const [renaming, setRenaming] = useState<ListedAgentWithConnections | null>(null);

  const carried = after !== null && after.project === projectId ? after.page : null;

  /** Which project this view is showing, readable from inside an await. */
  const showing = useRef(projectId);

  useEffect(() => {
    showing.current = projectId;
    setAfter(null);
    setMoreRefused(null);
    setLoadingMore(false);
  }, [projectId]);

  useEffect(() => {
    setAfter(null);
    setMoreRefused(null);
  }, [answer]);

  useEffect(() => {
    if (answer?.status === "signed-out") window.location.replace("/sign-in");
  }, [answer]);

  const agents = answer?.status === "ready" ? answer.value.agents : [];
  const items = [...agents, ...(carried?.agents ?? [])];
  const now = useMinuteClock();

  const home = projectPath(projectId, "agents");
  const sheet = openSheet(forced, query);
  const requestedAgentId = sheet?.kind === "agent" ? sheet.agentId : null;
  const listedDetailsAgent =
    sheet?.kind === "agent"
      ? (items.find((agent) => agent.id === sheet.agentId) ?? null)
      : null;
  const [fetchedDetails, setFetchedDetails] = useState<
    | {
        readonly projectId: string;
        readonly agentId: string;
        readonly status: "loading";
      }
    | {
        readonly projectId: string;
        readonly agentId: string;
        readonly status: "ready";
        readonly agent: ListedAgentWithConnections;
      }
    | {
        readonly projectId: string;
        readonly agentId: string;
        readonly status: "missing" | "failed";
        readonly refusal: Refusal;
      }
    | null
  >(null);
  const [detailsAttempt, setDetailsAttempt] = useState(0);
  const [detailsOpener, setDetailsOpener] = useState<{
    readonly agentId: string;
    readonly element: HTMLElement | null;
  } | null>(null);

  useEffect(() => {
    if (requestedAgentId === null || listedDetailsAgent !== null) {
      setFetchedDetails(null);
      return;
    }

    let current = true;
    setFetchedDetails({
      projectId,
      agentId: requestedAgentId,
      status: "loading",
    });
    void platformAnswer(
      getAgent(
        { agentId: requestedAgentId, projectId },
        { client: platformClient },
      ),
    ).then((read) => {
      if (!current) return;
      if (read.status === "signed-out") {
        window.location.replace("/sign-in");
        return;
      }
      if (read.status !== "ready") {
        setFetchedDetails({
          projectId,
          agentId: requestedAgentId,
          status: read.status,
          refusal: read.refusal,
        });
        return;
      }
      setFetchedDetails({
        projectId,
        agentId: requestedAgentId,
        status: "ready",
        agent: {
          ...read.value.agent,
          connections: read.value.connections.filter(
            (connection) => !connection.archived,
          ),
        },
      });
    });

    return () => {
      current = false;
    };
  }, [projectId, requestedAgentId, listedDetailsAgent, detailsAttempt]);

  const fetchedDetailsForRoute =
    fetchedDetails?.projectId === projectId &&
    fetchedDetails.agentId === requestedAgentId
      ? fetchedDetails
      : null;

  const detailsAgent =
    listedDetailsAgent ??
    (fetchedDetailsForRoute?.status === "ready"
      ? fetchedDetailsForRoute.agent
      : null);
  const detailsReadState: AgentDetailsReadState | null =
    requestedAgentId === null ||
    listedDetailsAgent !== null ||
    detailsAgent !== null
      ? null
      : fetchedDetailsForRoute?.status === "missing" ||
          fetchedDetailsForRoute?.status === "failed"
        ? {
            status: fetchedDetailsForRoute.status,
            refusal: fetchedDetailsForRoute.refusal,
          }
        : { status: "loading" };
  const returnDetailsFocusTo =
    detailsOpener?.agentId === requestedAgentId
      ? detailsOpener.element
      : null;

  /**
   * One page for every role, and the control that changes data is disabled
   * rather than removed. A viewer sees what egma can do here and is told
   * plainly that this part is not theirs; the server refuses their write either
   * way, which is where the boundary actually is.
   *
   * It is disabled for the same reason on a project this organization does not
   * hold: there is no project here to connect an agent to.
   *
   * **While the role is unknown there is no control at all.** A disabled one
   * would have to say why, and every sentence it could say would be a claim
   * about somebody egma has not identified yet.
   */
  const mayConnect = mayAuthor && answer?.status !== "missing";
  const whyNot = mayAuthor
    ? "There is no project here to connect an agent to."
    : `Your ${String(role)} role cannot connect agents. Ask an organization admin to change your role.`;
  const whyNotChange = mayAuthor
    ? undefined
    : `Your ${String(role)} role cannot change agents. Ask an organization admin to change your role.`;

  async function stopPullMonitoring(agentId: string): Promise<void> {
    const asked = projectId;
    const stoppedWasCarried =
      carried?.agents.some((agent) => agent.id === agentId) ?? false;
    setStoppingAgent(agentId);
    setStopRefused(null);
    const answer = await platformAnswer(
      stopMonitoring({ agentId, projectId: asked }, { client: platformClient }),
    );
    setStoppingAgent(null);
    if (showing.current !== asked) return;
    if (answer.status === "signed-out") {
      window.location.replace("/sign-in");
      return;
    }
    if (answer.status !== "ready") {
      setStopRefused({ agentId, refusal: answer.refusal });
      return;
    }
    if (stoppedWasCarried) {
      setAfter((current) => {
        if (current === null || current.project !== asked) return current;
        return {
          project: current.project,
          page: {
            ...current.page,
            agents: current.page.agents.map((agent) =>
              agent.id === agentId
                ? {
                    ...agent,
                    monitoringConfigured: true,
                    pullProductionCalls: false,
                  }
                : agent,
            ),
          },
        };
      });
      return;
    }
    refresh();
  }

  /**
   * The one action this screen is for, and the same control wherever it stands.
   *
   * **It changes query state and never navigates** (the founder's blanket
   * ruling of 2026-08-24: opening any sheet never redirects or reloads the
   * page). The panel was always drawn over this list; sending the browser to
   * `/agents/new` to draw it meant a reload in the middle of the product's
   * first job. `/agents/new` survives as a deep-link alias that renders the
   * same panel in place, so every CLI message and every piece of documentation
   * still lands where it always did.
   */
  const connect = () =>
    role === null ? undefined : mayConnect ? (
      <Button asChild>
        <Link href={`${home}?sheet=connect`}>Connect an agent</Link>
      </Button>
    ) : (
      <Button type="button" disabled why={whyNot}>
        Connect an agent
      </Button>
    );

  const openAgent = (
    agent: ListedAgentWithConnections,
    opener: HTMLElement | null,
  ) => {
    setDetailsOpener({ agentId: agent.id, element: opener });
    router.push(`${home}?sheet=agent&agent=${encodeURIComponent(agent.id)}`);
  };

  function columns(): readonly Column<ListedAgentWithConnections>[] {
    return [
      {
        key: "agent",
        header: "Agent",
        primary: true,
        width: "280px",
        cell: (agent) => (
          <AgentRowOpener
            agent={agent}
            onOpen={(opener) => openAgent(agent, opener)}
          />
        ),
      },
      {
        key: "platform",
        header: "Platform",
        width: "160px",
        cell: agentPlatformText,
      },
      {
        key: "simulation",
        header: "Simulation",
        width: "160px",
        cell: (agent) => (
          <CapabilityState state={simulationCapabilityOf(agent)} />
        ),
      },
      {
        key: "monitoring",
        header: "Production monitoring",
        width: "360px",
        cell: (agent) => {
          const state = monitoringCapabilityOf(agent);
          if (state === "Configured via code") {
            return <CapabilityState state={state} />;
          }
          return (
            <div className="flex min-w-0 flex-col gap-1 whitespace-normal">
              <CapabilityState state={state} />
              <span className="text-faint">
                <MonitoringEvidence agent={agent} now={now} />
              </span>
            </div>
          );
        },
      },
    ];
  }

  function body() {
    if (answer === null || answer.status === "signed-out") {
      return <Loading what="agents" />;
    }

    if (answer.status === "missing") {
      const elsewhere = me === null ? undefined : firstProjectOf(me);
      return (
        <NotFound
          message={answer.refusal.message}
          action={
            elsewhere === undefined ? undefined : (
              <Button asChild variant="secondary">
                <Link href={projectLanding(elsewhere.id)}>Open {elsewhere.name}</Link>
              </Button>
            )
          }
        />
      );
    }

    if (answer.status === "failed") {
      return <Failure message={answer.refusal.message} onRetry={reload} />;
    }

    const cursor = carried === null ? answer.value.nextPageToken : carried.nextPageToken;

    if (items.length === 0) {
      // A search with no match and an empty project lead somewhere different.
      if (search.trim() !== "") {
        return (
          <Empty
            title={`No agents match “${search.trim()}”`}
            lead="Try part of another name, or clear the search."
          />
        );
      }
      return (
        <Empty
          title="No agents in this project yet"
          lead="Add an agent to run simulations, monitor production traffic, or do both."
          action={connect()}
        />
      );
    }

    /**
     * The next page, and everything that can happen instead of one.
     *
     * A next page that does not arrive is still something that happened.
     * Returning quietly would re-enable the control, say nothing, and leave
     * somebody pressing it — and a session that has expired would leave them
     * pressing it forever, on a page that can no longer read anything.
     */
    async function showMore(): Promise<void> {
      if (cursor === null) return;

      // The project this read is for. Somebody may choose another one before it
      // comes back, and the answer is then not this view's to show.
      const asked = projectId;
      setMoreRefused(null);
      setLoadingMore(true);

      const next = await platformAnswer(
        listAgents(
          {
            projectId: asked,
            pageToken: cursor,
            ...(search.trim() === "" ? {} : { search: search.trim() }),
          },
          { client: platformClient },
        ),
      );

      setLoadingMore(false);
      if (showing.current !== asked) return;

      if (next.status === "signed-out") {
        window.location.replace("/sign-in");
        return;
      }

      if (next.status !== "ready") {
        setMoreRefused(next.refusal);
        return;
      }

      setAfter({
        project: asked,
        page: {
          agents: [...(carried?.agents ?? []), ...next.value.agents],
          nextPageToken: next.value.nextPageToken,
        },
      });
    }

    return (
      <>
        <DataTable
          label="Agents in this project"
          columns={columns()}
          rows={items}
          keyOf={(agent) => agent.id}
          onRowActivate={(agent, opener) => openAgent(agent, opener)}
          {...(detailsAgent === null ? {} : { currentKey: detailsAgent.id })}
          {...(cursor === null
            ? {}
            : {
                more: {
                  onMore: () => void showMore(),
                  loading: loadingMore,
                  note: `${String(items.length)} agents so far`,
                },
              })}
        />
        {moreRefused === null ? null : (
          <Failure
            title="Egma could not load more agents."
            message={moreRefused.message}
            onRetry={() => void showMore()}
          />
        )}
      </>
    );
  }

  /**
   * A project with nothing in it is the whole screen, and it has one thing on
   * it.
   *
   * So the toolbar is not drawn there: a search box for a project with nothing
   * to search is a control that carries no meaning, and a second Connect an
   * agent above the one in the middle of the empty state would leave somebody
   * choosing between two identical primary buttons. Everywhere else — while the
   * read is in flight, over a list, over a search that matched nothing — the
   * toolbar stays exactly where it was, because a search box that vanished
   * under the keystroke that filled it would be unusable.
   */
  const nothingHereYet =
    answer?.status === "ready" &&
    answer.value.agents.length === 0 &&
    search.trim() === "";

  /** Closing a panel leaves the address it was in, whichever one that was. */
  const close = () => router.replace(home);

  return (
    <ProductPage>
      <PageHeader
        title="Agents"
        {...(nothingHereYet
          ? {}
          : {
              toolbar: (
                <SearchField
                  id="agent-search"
                  value={typed}
                  aria-label="Search agents by name"
                  placeholder="Search by name"
                  autoComplete="off"
                  spellCheck={false}
                  onChange={(event) => setTyped(event.target.value)}
                />
              ),
              action: connect(),
            })}
      />
      <PageBody>{body()}</PageBody>

      {sheet?.kind === "connect" ? (
        <ConnectAgentSheet
          projectId={projectId}
          agents={items}
          {...(sheet.agentId === undefined ? {} : { agentId: sheet.agentId })}
          {...(sheet.goal === undefined ? {} : { goal: sheet.goal })}
          {...(sheet.platform === undefined ? {} : { platform: sheet.platform })}
          onboarding={sheet.onboarding === true}
          mayAuthor={mayAuthor}
          role={role}
          onClose={close}
          onConnected={() => {
            /*
             * **A save closes onto the list, and nothing navigates.**
             *
             * There is no agent page to land on any more: the row is the agent,
             * and the row this save just wrote is right there behind the panel.
             * `replace` rather than `push`, because the address behind is the
             * panel that was just finished with — Back should be the list it
             * was opened from, not the form opening again.
             */
            router.replace(home);
            refresh();
          }}
        />
      ) : null}

      {detailsAgent === null || renaming !== null || archiving !== null ? null : (
        <AgentDetailsSheet
          agent={detailsAgent}
          home={home}
          now={now}
          mayAuthor={mayAuthor}
          {...(whyNotChange === undefined ? {} : { whyNotChange })}
          stopping={stoppingAgent === detailsAgent.id}
          stopRefused={
            stopRefused?.agentId === detailsAgent.id ? stopRefused.refusal : null
          }
          onStopMonitoring={() => void stopPullMonitoring(detailsAgent.id)}
          onRename={() => setRenaming(detailsAgent)}
          onDelete={() => setArchiving(detailsAgent)}
          onClose={close}
          returnFocusTo={returnDetailsFocusTo}
        />
      )}

      {detailsReadState === null || renaming !== null || archiving !== null ? null : (
        <AgentDetailsReadStateSheet
          state={detailsReadState}
          onRetry={() => setDetailsAttempt((attempt) => attempt + 1)}
          onClose={close}
          returnFocusTo={returnDetailsFocusTo}
        />
      )}

      {sheet?.kind === "connection" ? (
        <ConnectionSheet
          projectId={projectId}
          agentId={sheet.agentId}
          connectionId={sheet.connectionId}
          mayAuthor={mayAuthor}
          role={role}
          onClose={close}
          onChanged={refresh}
        />
      ) : null}

      {renaming === null ? null : (
        <RenameAgentSheet
          projectId={projectId}
          agent={renaming}
          mayAuthor={mayAuthor}
          {...(whyNotChange === undefined ? {} : { why: whyNotChange })}
          onClose={() => setRenaming(null)}
          onRenamed={() => {
            setRenaming(null);
            reload();
          }}
        />
      )}

      {archiving === null ? null : (
        <ArchiveConfirm
          title="Delete agent"
          onArchive={async () => {
            const done = await platformAnswer(
              archiveAgent(
                { agentId: archiving.id, projectId },
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
            router.replace(home);
            reload();
          }}
        >
          {`Egma stops testing “${archiving.name}”. Every connection on it goes with it and every run waiting on it stops. Transcripts already stored stay stored, and this screen has no way to bring it back.`}
        </ArchiveConfirm>
      )}
    </ProductPage>
  );
}

/**
 * The keyboard path for the row's one reading action.
 *
 * A pointer can open the details sheet from any non-control part of the row.
 * The named button keeps the same action available to a keyboard and gives it
 * the product focus indicator without changing the table's semantics.
 */
function AgentRowOpener({
  agent,
  onOpen,
}: {
  readonly agent: ListedAgentWithConnections;
  readonly onOpen: (opener: HTMLElement) => void;
}) {
  return (
    <button
      className={cn(
        "block max-w-full cursor-pointer overflow-hidden border-0 bg-transparent p-0",
        "text-left text-sm text-foreground text-ellipsis whitespace-nowrap",
        "transition-colors duration-(--duration-hover) ease-out",
        "pointer-hover:text-brand motion-reduce:transition-none",
      )}
      onClick={(event) => onOpen(event.currentTarget)}
      type="button"
    >
      {agent.name}
    </button>
  );
}

/**
 * Which panel is open: what the route insists on, or what the address asks for.
 *
 * A route that names a panel wins, because that is what the address *is* —
 * `/agents/new` is the connect panel and nothing else. Everywhere else the
 * query decides, which is what makes Back close a sheet and a copied link open
 * one.
 */
function openSheet(
  forced: ForcedSheet | undefined,
  query: URLSearchParams,
): ForcedSheet | null {
  if (forced !== undefined) return forced;
  const kind = query.get("sheet");
  const agentId = query.get("agent");
  const connectionId = query.get("connection");
  if (kind === "connect") {
    const goal = connectGoal(query.get("goal"));
    const platform = connectPlatform(query.get("platform"));
    return {
      kind: "connect",
      ...(agentId === null ? {} : { agentId }),
      ...(goal === undefined ? {} : { goal }),
      ...(platform === undefined ? {} : { platform }),
    };
  }
  if (kind === "agent" && agentId !== null) {
    return { kind: "agent", agentId };
  }
  if (kind === "connection" && agentId !== null && connectionId !== null) {
    return { kind: "connection", agentId, connectionId };
  }
  return null;
}

/** Only providers implemented by this setup flow can become sheet state. */
function connectPlatform(value: string | null): ConnectAgentPlatform | undefined {
  return value === "retell" || value === "livekit" ? value : undefined;
}

/** Only the three public setup goals can become sheet state. */
function connectGoal(value: string | null): ConnectAgentGoal | undefined {
  return value === "simulation" || value === "monitoring" || value === "both"
    ? value
    : undefined;
}
