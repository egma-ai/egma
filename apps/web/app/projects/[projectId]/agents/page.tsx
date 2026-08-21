"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { listAgents } from "@egma/platform-api/client";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { Refusal } from "../../../../lib/api.ts";
import {
  type AgentPage,
  type ListedAgentWithConnections,
} from "../../../../lib/agents.ts";
import { firstProjectOf, roleOf } from "../../../../lib/me.ts";
import { platformAnswer, platformClient } from "../../../../lib/platform-client.ts";
import { projectLanding, projectPath } from "../../../../lib/project-context.ts";
import { canAuthor } from "../../../../lib/roles.ts";
import { Toolbar, TOOLBAR_SEARCH } from "../../../../ui/section.tsx";
import { DataTable, type Column } from "../../../../ui/data-table.tsx";
import { Empty, Failure, Loading, NotFound } from "../../../../ui/page-state.tsx";
import { useProjectRead } from "../../../../ui/resource.ts";
import {
  AppShell,
  PageBody,
  PageHeader,
  ProductPage,
  useShellSession,
} from "../../../../ui/shell.tsx";
import { ConnectionsOnRow } from "./connection-facts.tsx";

/**
 * The agents of one project: the landing page of the product.
 *
 * **You start with the system you are testing.** An agent is the customer's
 * voice agent — the thing egma exists to establish trust in — so this is what a
 * signed-in person sees first, rather than a home page assembled out of
 * fragments of everything else.
 *
 * The project is in the address and in the request, every time. Reload, Back,
 * Forward, a copied link and a second tab on a second project all work for the
 * same reason: there is no chosen project anywhere except the address.
 *
 * **Every row says how egma reaches its agent.** That is the question somebody
 * brings here, and the list read answers it: each row carries its agent's
 * connections, so telling a staging chat connection from a production phone
 * number costs no click, and an agent egma cannot reach at all says so where it
 * is read rather than where a run refuses to start.
 *
 * **Search is asked of the server, never applied to what came back.** A filter
 * that only reached the page already fetched would
 * answer differently depending on how far somebody had scrolled — a list of
 * four hundred agents would find nothing in the three hundred it had not
 * loaded, and would say so as though the project did not hold it.
 */
export default function AgentsPage() {
  const { projectId } = useParams<{ projectId: string }>();
  return (
    <AppShell>
      <Agents projectId={projectId} />
    </AppShell>
  );
}

function columnsFor(projectId: string): readonly Column<ListedAgentWithConnections>[] {
  return [
    {
      key: "name",
      header: "Agent",
      primary: true,
      cell: (agent) => (
        <Link href={projectPath(projectId, "agents", agent.id)}>
          {agent.name}
        </Link>
      ),
    },
    {
      /*
       * Second, because it is what somebody came to read. The width is claimed
       * rather than left to the browser: this cell holds a line per connection
       * and the description beside it would otherwise take the room those lines
       * need. Half the table, because a line here is four facts — the
       * environment, the platform, the channel and whether the target has been
       * measured — and the platform is named in the registry's own words,
       * which are words rather than tokens.
       */
      key: "connections",
      header: "Connections",
      width: "50%",
      cell: (agent) => (
        <ConnectionsOnRow connections={agent.connections} />
      ),
    },
    {
      key: "description",
      header: "Description",
      hideOnMobile: true,
      cell: (agent) => agent.description ?? "—",
    },
  ];
}

function Agents({ projectId }: { readonly projectId: string }) {
  const { me } = useShellSession();
  // Null until the session read answers. A page that guessed would tell an
  // admin their role cannot do something it can, on every load.
  const role = me === null ? null : roleOf(me);

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

  const { answer, reload } = useProjectRead<AgentPage>(
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
   * so that asking again always starts from a clean first page — **and each
   * one remembers the project it was fetched for.**
   *
   * That is not belt and braces. Changing project does not remount this page:
   * it is the same route with another project in it, so this state outlives
   * the change and a read still in flight comes back into a view that has
   * moved on. Carrying the project in the value means a page fetched for
   * somewhere else can never be *rendered* here, whatever wrote it and
   * whenever it landed — a render-time fact, which no race can get past.
   */
  const [after, setAfter] = useState<{
    readonly project: string;
    readonly page: AgentPage;
  } | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  /** Why the next page did not arrive, until somebody asks for it again. */
  const [moreRefused, setMoreRefused] = useState<Refusal | null>(null);

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

  /**
   * One page for every role, and the control that changes data is disabled
   * rather than removed. A viewer sees what egma can do here and is told
   * plainly that this part is not theirs; the server refuses their write
   * either way, which is where the boundary actually is.
   *
   * It is disabled for the same reason on a project this organization does not
   * hold: there is no project here to connect an agent to.
   *
   * **While the role is unknown there is no control at all.** A disabled one
   * would have to say why, and every sentence it could say would be a claim
   * about somebody egma has not identified yet.
   */
  const mayConnect = role !== null && canAuthor(role) && answer?.status !== "missing";
  const whyNot =
    role !== null && canAuthor(role)
      ? "There is no project here to connect an agent to."
      : `Your ${String(role)} role cannot connect agents. Ask an organization admin to change your role.`;

  /**
   * The one action this page is for, and the same control wherever it stands.
   *
   * It opens the onboarding flow at its first stage — the agent's details, then
   * the first connection — because that is how an agent joins egma. The label
   * names the outcome rather than the record: a person wants egma able to reach
   * their agent, and registering one is the first half of that.
   */
  const connect = () =>
    role === null ? undefined : mayConnect ? (
      <Button asChild>
        <Link href={projectPath(projectId, "agents", "new")}>Connect agent</Link>
      </Button>
    ) : (
      <Button type="button" disabled why={whyNot}>
        Connect agent
      </Button>
    );

  const header = (
    <PageHeader
      eyebrow="Project"
      title="Agents"
      lead="The voice agents Egma can test in this project, and how Egma reaches each one."
    />
  );

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
                <Link href={projectLanding(elsewhere.id)}>
                  Open {elsewhere.name}
                </Link>
              </Button>
            )
          }
        />
      );
    }

    if (answer.status === "failed") {
      return <Failure message={answer.refusal.message} onRetry={reload} />;
    }

    const items = [...answer.value.agents, ...(carried?.agents ?? [])];
    const cursor =
      carried === null
        ? answer.value.nextPageToken
        : carried.nextPageToken;

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

      // The project this read is for. Somebody may choose another one before
      // it comes back, and the answer is then not this view's to show.
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
          columns={columnsFor(projectId)}
          rows={items}
          keyOf={(agent) => agent.id}
          stretchPrimaryLink
          {...(cursor === null
            ? {}
            : {
                more: {
                  onMore: () => void showMore(),
                  loading: loadingMore,
                  note: `${items.length} agents so far`,
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
   * to search is a control that carries no meaning, and a second Connect agent
   * above the one in the middle of the empty state would leave somebody
   * choosing between two identical primary buttons. Everywhere else — while the
   * read is in flight, over a list, over a search that matched nothing — the
   * toolbar stays exactly where it was, because a search box that vanished
   * under the keystroke that filled it would be unusable.
   */
  const nothingHereYet =
    answer?.status === "ready" &&
    answer.value.agents.length === 0 &&
    search.trim() === "";

  return (
    <ProductPage>
      {header}
      <PageBody>
        {/*
         * Search left and held to a readable width, Connect agent hard right.
         *
         * It read the other way round until the developer put it beside a
         * competitor's dashboard: the button led the row, which made it look
         * bigger than it is — it was and still is the default size — and the
         * search box took every remaining pixel behind it, running past
         * 1400px on a wide screen for a field holding an agent's name.
         *
         * The comment this replaces described a flex fight between the two,
         * where the search box's `width: 100%` squeezed the button until the
         * toolbar's gap disappeared. That fight is over rather than won: the
         * action is its own `flex-none` slot now, and the search box has a
         * maximum, so neither one is under pressure from the other.
         */}
        {nothingHereYet ? null : (
          <Toolbar action={connect()}>
            <Input
              id="agent-search"
              className={TOOLBAR_SEARCH}
              value={typed}
              aria-label="Search agents by name"
              placeholder="Search by name"
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => setTyped(event.target.value)}
            />
          </Toolbar>
        )}
        {body()}
      </PageBody>
    </ProductPage>
  );
}
