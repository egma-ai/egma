"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import { readJson, type Refusal } from "../../../../lib/api.ts";
import {
  agentsQuery,
  type AgentPage,
  type ArchiveFilter,
  type ListedAgent,
} from "../../../../lib/agents.ts";
import { asDay } from "../../../../lib/instants.ts";
import { firstProjectOf, roleOf } from "../../../../lib/me.ts";
import { projectLanding, projectPath } from "../../../../lib/project-context.ts";
import { canAuthor } from "../../../../lib/roles.ts";
import {
  ButtonLink,
  Choice,
  TextInput,
  Toolbar,
} from "../../../../ui/controls.tsx";
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
 * **The search and the archive filter are asked of the server, never applied to
 * what came back.** A filter that only reached the page already fetched would
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

function columnsFor(projectId: string): readonly Column<ListedAgent>[] {
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
      key: "description",
      header: "Description",
      hideOnMobile: true,
      cell: (agent) => agent.description ?? "—",
    },
    {
      key: "updated",
      header: "Last changed",
      mono: true,
      width: "120px",
      cell: (agent) => asDay(agent.updated_at),
    },
    {
      key: "created",
      header: "Registered",
      hideOnMobile: true,
      mono: true,
      width: "120px",
      cell: (agent) => asDay(agent.created_at),
    },
  ];
}

const FILTERS: readonly { value: ArchiveFilter; label: string }[] = [
  { value: "active", label: "Active" },
  { value: "archived", label: "Archived" },
];

function Agents({ projectId }: { readonly projectId: string }) {
  const { me } = useShellSession();
  // Null until the session read answers. A page that guessed would tell an
  // admin their role cannot do something it can, on every load.
  const role = me === null ? null : roleOf(me);

  const [typed, setTyped] = useState("");
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<ArchiveFilter>("active");

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
    agentsQuery({ search, filter }),
    projectId,
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
   * hold: there is nothing to register an agent in.
   *
   * **While the role is unknown there is no control at all.** A disabled one
   * would have to say why, and every sentence it could say would be a claim
   * about somebody egma has not identified yet.
   */
  const mayRegister = role !== null && canAuthor(role) && answer?.status !== "missing";
  const whyNot =
    role !== null && canAuthor(role)
      ? "There is no project here to register an agent in."
      : `Your ${String(role)} role cannot register agents. Ask an organization admin to change your role.`;

  const register = (weight: "strong" | "quiet") =>
    role === null ? undefined : (
      <ButtonLink
        href={projectPath(projectId, "agents", "new")}
        weight={weight}
        disabled={!mayRegister}
        why={mayRegister ? undefined : whyNot}
      >
        Register agent
      </ButtonLink>
    );

  const header = (
    <PageHeader
      eyebrow="Project"
      title="Agents"
      lead="The voice agents egma can test in this project."
      action={register("strong")}
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
              <ButtonLink href={projectLanding(elsewhere.id)}>
                Open {elsewhere.name}
              </ButtonLink>
            )
          }
        />
      );
    }

    if (answer.status === "failed") {
      return <Failure message={answer.refusal.message} onRetry={reload} />;
    }

    const items = [...answer.value.items, ...(carried?.items ?? [])];
    const cursor = carried === null ? answer.value.next_cursor : carried.next_cursor;

    if (items.length === 0) {
      // Three different absences, and they point somewhere different: a
      // project with nothing in it, a search that matched nothing, and an
      // archive nobody has put anything in.
      if (search.trim() !== "") {
        return (
          <Empty
            title={`No ${filter} agents match “${search.trim()}”`}
            lead="Try part of another name, or clear the search."
          />
        );
      }
      return filter === "archived" ? (
        <Empty
          title="No archived agents in this project"
          lead="Archiving an agent takes it out of new work and keeps its history readable. Nothing here has been archived."
        />
      ) : (
        <Empty
          title="No agents in this project yet"
          lead="Register the voice agent you want to test, then give egma a way to reach it."
          action={register("strong")}
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

      const next = await readJson<AgentPage>(
        agentsQuery({ search, filter, cursor }),
        { project: asked },
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
          items: [...(carried?.items ?? []), ...next.value.items],
          next_cursor: next.value.next_cursor,
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
          rowHref={(agent) => projectPath(projectId, "agents", agent.id)}
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

  return (
    <ProductPage>
      {header}
      <PageBody>
        <Toolbar>
          <TextInput
            id="agent-search"
            value={typed}
            label="Search agents by name"
            placeholder="Search by name"
            onChange={setTyped}
          />
          <Choice
            label="Which agents"
            value={filter}
            options={FILTERS}
            onChange={setFilter}
          />
        </Toolbar>
        {body()}
      </PageBody>
    </ProductPage>
  );
}
