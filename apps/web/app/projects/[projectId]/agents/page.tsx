"use client";

import { useParams } from "next/navigation";
import { useEffect, useState } from "react";

import { readJson } from "../../../../lib/api.ts";
import {
  AGENTS_PATH,
  agentsAfter,
  type AgentPage,
  type ListedAgent,
} from "../../../../lib/agents.ts";
import { asDay } from "../../../../lib/instants.ts";
import { firstProjectOf, roleOf } from "../../../../lib/me.ts";
import { projectLanding, projectPath } from "../../../../lib/project-context.ts";
import { canAuthor } from "../../../../lib/roles.ts";
import { ButtonLink } from "../../../../ui/controls.tsx";
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
 * Registering, editing, archiving and connections arrive with Agents proper.
 * What this page owns is the read, its five states, and the fact that a viewer
 * is offered no control they may not use.
 */
export default function AgentsPage() {
  const { projectId } = useParams<{ projectId: string }>();
  return (
    <AppShell>
      <Agents projectId={projectId} />
    </AppShell>
  );
}

const COLUMNS: readonly Column<ListedAgent>[] = [
  {
    key: "name",
    header: "Agent",
    primary: true,
    cell: (agent) => agent.name,
  },
  {
    key: "description",
    header: "Description",
    cell: (agent) => agent.description ?? "—",
  },
  { key: "id", header: "Identifier", mono: true, width: "220px", cell: (agent) => agent.id },
  {
    key: "created",
    header: "Registered",
    mono: true,
    width: "120px",
    cell: (agent) => asDay(agent.created_at),
  },
];

function Agents({ projectId }: { readonly projectId: string }) {
  const { me } = useShellSession();
  // Null until the session read answers. A page that guessed would tell an
  // admin their role cannot do something it can, on every load.
  const role = me === null ? null : roleOf(me);
  const { answer, reload } = useProjectRead<AgentPage>(AGENTS_PATH, projectId);

  // Pages fetched after the first, kept beside it rather than folded into it,
  // so that asking again always starts from a clean first page.
  const [after, setAfter] = useState<AgentPage | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);

  useEffect(() => {
    setAfter(null);
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

    const items = [...answer.value.items, ...(after?.items ?? [])];
    const cursor = after === null ? answer.value.next_cursor : after.next_cursor;

    if (items.length === 0) {
      return (
        <Empty
          title="No agents in this project yet"
          lead="Register the voice agent you want to test, then give egma a way to reach it."
          action={register("strong")}
        />
      );
    }

    async function showMore(): Promise<void> {
      if (cursor === null) return;
      setLoadingMore(true);
      const next = await readJson<AgentPage>(agentsAfter(cursor), {
        project: projectId,
      });
      setLoadingMore(false);
      if (next.status !== "ready") return;
      setAfter({
        items: [...(after?.items ?? []), ...next.value.items],
        next_cursor: next.value.next_cursor,
      });
    }

    return (
      <DataTable
        label="Agents in this project"
        columns={COLUMNS}
        rows={items}
        keyOf={(agent) => agent.id}
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
    );
  }

  return (
    <ProductPage>
      {header}
      <PageBody>{body()}</PageBody>
    </ProductPage>
  );
}
