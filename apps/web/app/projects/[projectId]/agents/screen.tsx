"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { archiveAgent, listAgents } from "@egma/platform-api/client";

import { Button } from "@/components/ui/button";
import type { Refusal } from "@/lib/api.ts";
import {
  agentPlatformText,
  NO_PLATFORM,
  type AgentPage,
  type ListedAgentWithConnections,
} from "@/lib/agents.ts";
import { firstProjectOf, roleOf } from "@/lib/me.ts";
import { platformAnswer, platformClient } from "@/lib/platform-client.ts";
import { projectLanding, projectPath } from "@/lib/project-context.ts";
import { canAuthor } from "@/lib/roles.ts";
import { DataTable, type Column } from "@/ui/data-table.tsx";
import { Empty, Failure, Loading, NotFound } from "@/ui/page-state.tsx";
import { ListInstant } from "@/ui/relative-time.tsx";
import { useProjectRead } from "@/ui/resource.ts";
import { SearchField } from "@/ui/section.tsx";
import { PageBody, PageHeader, ProductPage, useShellSession } from "@/ui/shell.tsx";

import { ArchiveConfirm } from "./archive.tsx";
import { ConnectAgentSheet } from "./connect-sheet.tsx";
import { ConnectionsOnRow } from "./connection-facts.tsx";
import { ConnectionSheet } from "./connection-sheet.tsx";
import { RowMenu, RowMenuDestructive, RowMenuLink } from "./row-menu.tsx";

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
 * list (`DESIGN.md`, Side sheets). The four addresses that used to be pages of
 * their own — `agents/new`, `connections/new`, `connections/:id` — still work
 * and each opens the panel it names, so a link in the CLI, the docs or
 * somebody's notes lands exactly where it always did.
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
  | { readonly kind: "connect"; readonly agentId?: string; readonly onboarding?: boolean }
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
  /** The agent a confirmation is standing in front of. */
  const [archiving, setArchiving] = useState<ListedAgentWithConnections | null>(null);

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

  const home = projectPath(projectId, "agents");
  const sheet = openSheet(forced, query);

  /** Every environment label this screen can see, offered as a suggestion. */
  const environments = [
    ...new Set(
      items.flatMap((agent) =>
        agent.connections.flatMap((one) =>
          one.environment === null ? [] : [one.environment],
        ),
      ),
    ),
  ];

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

  /**
   * The one action this screen is for, and the same control wherever it stands.
   *
   * `/agents/new` is still its address. The panel it opens is drawn over this
   * list either way, so the address is kept rather than swapped for a query —
   * it is the one every CLI message and every piece of documentation already
   * points at.
   */
  const connect = () =>
    role === null ? undefined : mayConnect ? (
      <Button asChild>
        <Link href={projectPath(projectId, "agents", "new")}>Connect an agent</Link>
      </Button>
    ) : (
      <Button type="button" disabled why={whyNot}>
        Connect an agent
      </Button>
    );

  function columns(): readonly Column<ListedAgentWithConnections>[] {
    return [
      {
        key: "name",
        header: "Name",
        primary: true,
        width: "260px",
        /*
         * **The agent's name is plain text until a pointer is on it**, which
         * is what `6ZJ-0` draws: only the connections are underlined, because
         * the row itself is the way into the agent and the underline is what
         * tells the two apart. The shared table underlines every cell link, so
         * this is said here rather than there — the connection links in the
         * next column keep it, and so do the connection names on the agent
         * page.
         */
        cell: (agent) => (
          <Link
            className="text-foreground no-underline pointer-hover:underline"
            href={projectPath(projectId, "agents", agent.id)}
          >
            {agent.name}
          </Link>
        ),
      },
      {
        /*
         * **Read from the connections first.** An agent's own platform column
         * is written only when Start monitoring binds it, so an agent with a
         * live Retell connection still says nothing about itself. What a person
         * means by "which platform is this on" is answered by the way in.
         *
         * **And by every way in.** An agent reached on Retell and on LiveKit
         * is on both, so the cell names both rather than whichever connection
         * was made first.
         */
        key: "platform",
        header: "Platform",
        width: "160px",
        cell: (agent) => agentPlatformText(agent) ?? NO_PLATFORM,
      },
      {
        key: "connections",
        header: "Connections",
        width: "360px",
        cell: (agent) => (
          <ConnectionsOnRow
            agentHref={projectPath(projectId, "agents", agent.id)}
            connections={agent.connections}
            hrefOf={(one) =>
              `${home}?sheet=connection&agent=${encodeURIComponent(agent.id)}&connection=${encodeURIComponent(one.id)}`
            }
          />
        ),
      },
      {
        key: "created",
        header: "Created",
        hideOnMobile: true,
        cell: (agent) => <ListInstant instant={agent.createdAt} />,
      },
      {
        key: "menu",
        header: "Actions",
        action: true,
        cell: (agent) => (
          <RowMenu label={`Actions for ${agent.name}`}>
            <RowMenuLink href={projectPath(projectId, "agents", agent.id)}>
              Open agent
            </RowMenuLink>
            <RowMenuLink
              href={`${home}?sheet=connect&agent=${encodeURIComponent(agent.id)}`}
            >
              Connect
            </RowMenuLink>
            <RowMenuDestructive
              onSelect={() => setArchiving(agent)}
              why={whyNotChange}
            >
              Archive agent
            </RowMenuDestructive>
          </RowMenu>
        ),
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
          lead="Connect the voice agent you want to test: Egma asks for its details, then for a way to reach it."
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
          stretchPrimaryLink
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
          onboarding={sheet.onboarding === true}
          mayAuthor={mayAuthor}
          role={role}
          onClose={close}
          onConnected={(result) => {
            /*
             * **A create lands on the record it just made.**
             *
             * Registering an agent writes two things — the agent and the first
             * way in to it — and the page that holds both is the agent's own:
             * its identity, whether egma pulls its production calls, and its
             * connections. Closing onto the list instead left somebody who had
             * just made something looking at a list of everything, with the
             * one row they wanted to see somewhere in it.
             *
             * It replaces rather than pushes, because the address behind is
             * `…/agents/new` — the panel they just finished with. Back should
             * be the list they opened it from, not the form opening again. The
             * onboarding forward above keeps its push: that flow began on the
             * agent's own page and the step behind it is a real one.
             *
             * Adding a connection to an agent that already existed is the
             * other half of this panel and is not a create: that one closes
             * onto the list it was opened over, which is where the row it
             * changed is.
             */
            if (sheet.onboarding === true) {
              router.push(projectPath(projectId, "agents", result.agentId));
              return;
            }
            if (result.created) {
              router.replace(projectPath(projectId, "agents", result.agentId));
              return;
            }
            router.replace(home);
            refresh();
          }}
        />
      ) : null}

      {sheet?.kind === "connection" ? (
        <ConnectionSheet
          projectId={projectId}
          agentId={sheet.agentId}
          connectionId={sheet.connectionId}
          environments={environments}
          mayAuthor={mayAuthor}
          role={role}
          onClose={close}
          onChanged={refresh}
        />
      ) : null}

      {archiving === null ? null : (
        <ArchiveConfirm
          title="Archive agent"
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
            reload();
          }}
        >
          {`Egma stops testing “${archiving.name}”. Every connection on it is archived with it and every run waiting on it stops. Transcripts already stored stay stored, and this screen has no way to bring it back.`}
        </ArchiveConfirm>
      )}
    </ProductPage>
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
    return { kind: "connect", ...(agentId === null ? {} : { agentId }) };
  }
  if (kind === "connection" && agentId !== null && connectionId !== null) {
    return { kind: "connection", agentId, connectionId };
  }
  return null;
}
