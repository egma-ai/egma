"use client";

import { useParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import { readJson, type Refusal } from "../../../../lib/api.ts";
import {
  gradersPath,
  GRADER_REGISTRY_PATH,
  TYPE_SUMMARY,
  type GraderPage,
  type GraderRegistry,
  type ListedGrader,
} from "../../../../lib/graders.ts";
import { asDay } from "../../../../lib/instants.ts";
import { firstProjectOf, roleOf } from "../../../../lib/me.ts";
import { projectLanding, projectPath } from "../../../../lib/project-context.ts";
import { canAuthor } from "../../../../lib/roles.ts";
import { Badge, Button, ButtonLink } from "../../../../ui/controls.tsx";
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
 * Every judgment this project can make: the built-in that is always on, and the
 * graders somebody wrote.
 *
 * **One shelf, two kinds of thing, and the difference stated rather than
 * implied.** The expected-behaviors grader judges every simulation against its
 * own test's written-down expectations, and applying it is part of what running
 * a test *means* — so it is never attached, never detached, never archived, and
 * has no row anywhere (ADR-0004). A shelf listing only authored graders would
 * leave somebody believing that a project with none makes no judgments at all,
 * which is the opposite of true. So it is here, at the top, marked for what it
 * is, and offered no control that would suggest otherwise.
 *
 * The project is in the address and in every request. Reload, Back, Forward, a
 * copied link and a second tab on a second project all work for one reason:
 * there is no chosen project anywhere except the address.
 */
export default function GradersPage() {
  const { projectId } = useParams<{ projectId: string }>();
  return (
    <AppShell>
      <Graders projectId={projectId} />
    </AppShell>
  );
}

const COLUMNS: readonly Column<ListedGrader>[] = [
  { key: "name", header: "Grader", primary: true, cell: (grader) => grader.name },
  {
    key: "type",
    header: "Judges by",
    cell: (grader) => TYPE_SUMMARY[grader.type],
  },
  {
    key: "priority",
    header: "Priority",
    width: "90px",
    cell: (grader) => (
      <Badge tone={grader.priority === "P0" ? "bad" : "neutral"}>
        {grader.priority}
      </Badge>
    ),
  },
  { key: "scope", header: "Applies to", width: "110px", cell: (grader) => grader.scope },
  {
    key: "modalities",
    header: "Scores",
    width: "120px",
    cell: (grader) => grader.modalities.join(", "),
  },
  {
    key: "version",
    header: "Version",
    mono: true,
    width: "90px",
    cell: (grader) => `v${grader.version}`,
  },
  {
    key: "changed",
    header: "Changed",
    mono: true,
    width: "120px",
    cell: (grader) => asDay(grader.updated_at),
  },
];

function Graders({ projectId }: { readonly projectId: string }) {
  const { me } = useShellSession();
  // Null until the session read answers. A page that guessed would tell an
  // admin their role cannot do something it can, on every load.
  const role = me === null ? null : roleOf(me);

  /** Which shelf is being looked at: what applies now, or what was removed. */
  const [archived, setArchived] = useState(false);

  const { answer, reload } = useProjectRead<GraderPage>(
    gradersPath({ archived }),
    projectId,
  );
  const { answer: registry } = useProjectRead<GraderRegistry>(
    GRADER_REGISTRY_PATH,
    projectId,
  );

  /**
   * Pages fetched after the first, kept beside it rather than folded into it —
   * **and each one remembers the project it was fetched for.**
   *
   * Changing project does not remount this page: it is the same route with
   * another project in it, so this state outlives the change and a read still
   * in flight comes back into a view that has moved on. Carrying the project in
   * the value means a page fetched for somewhere else can never be *rendered*
   * here, whatever wrote it and whenever it landed.
   */
  const [after, setAfter] = useState<{
    readonly project: string;
    readonly archived: boolean;
    readonly page: GraderPage;
  } | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  /** Why the next page did not arrive, until somebody asks for it again. */
  const [moreRefused, setMoreRefused] = useState<Refusal | null>(null);

  const carried =
    after !== null && after.project === projectId && after.archived === archived
      ? after.page
      : null;

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
   * **While the role is unknown there is no control at all.** A disabled one
   * would have to say why, and every sentence it could say would be a claim
   * about somebody egma has not identified yet.
   */
  const mayAuthor = role !== null && canAuthor(role) && answer?.status !== "missing";
  const whyNot =
    role !== null && canAuthor(role)
      ? "There is no project here to write a grader in."
      : `Your ${String(role)} role cannot write graders. Ask an organization admin to change your role.`;

  const author = (weight: "strong" | "quiet") =>
    role === null ? undefined : (
      <ButtonLink
        href={projectPath(projectId, "graders", "new")}
        weight={weight}
        disabled={!mayAuthor}
        why={mayAuthor ? undefined : whyNot}
      >
        Write a grader
      </ButtonLink>
    );

  const header = (
    <PageHeader
      eyebrow="Project"
      title="Graders"
      lead="Every judgment egma can make here. A metric measures; a grader judges."
      action={
        <>
          <ButtonLink href={projectPath(projectId, "graders", "judge")}>
            Judge settings
          </ButtonLink>
          {author("strong")}
        </>
      }
    />
  );

  function body() {
    if (answer === null || answer.status === "signed-out") {
      return <Loading what="graders" />;
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

      const asked = projectId;
      const shelf = archived;
      setMoreRefused(null);
      setLoadingMore(true);

      const next = await readJson<GraderPage>(
        gradersPath({ archived: shelf, cursor }),
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
        archived: shelf,
        page: {
          items: [...(carried?.items ?? []), ...next.value.items],
          next_cursor: next.value.next_cursor,
        },
      });
    }

    return (
      <>
        {archived ? null : <BuiltIn registry={registry?.status === "ready" ? registry.value : null} />}

        {items.length === 0 ? (
          <Empty
            title={
              archived
                ? "No archived graders in this project"
                : "No graders of your own yet"
            }
            lead={
              archived
                ? "Graders you archive keep their history and stay readable here."
                : "Every test is already judged against its own expected behaviors. Write a grader to add a judgment of your own on top."
            }
            action={archived ? undefined : author("strong")}
          />
        ) : (
          <DataTable
            label={archived ? "Archived graders" : "Graders in this project"}
            columns={COLUMNS}
            rows={items}
            keyOf={(grader) => grader.id}
            {...(cursor === null
              ? {}
              : {
                  more: {
                    onMore: () => void showMore(),
                    loading: loadingMore,
                    note: `${items.length} graders so far`,
                  },
                })}
          />
        )}

        {moreRefused === null ? null : (
          <Failure
            title="Egma could not load more graders."
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
        <p>
          <Button onClick={() => setArchived(!archived)}>
            {archived ? "Show active graders" : "Show archived graders"}
          </Button>
        </p>
        {body()}
      </PageBody>
    </ProductPage>
  );
}

/**
 * The built-in, shown as what it is and never as a row.
 *
 * It carries no link, no edit and no archive control, because there is nothing
 * on the other end of any of them: it is not a record, it has no identity, and
 * it cannot be turned off. Saying all three plainly is cheaper than letting
 * somebody discover them one failed click at a time.
 */
function BuiltIn({ registry }: { readonly registry: GraderRegistry | null }) {
  if (registry === null) return null;

  return (
    <section aria-label="Built-in graders">
      <h2>Built in</h2>
      {registry.built_in.map((built) => (
        <article key={built.key}>
          <h3>
            {built.name} <Badge tone="good">Always active</Badge>{" "}
            <Badge>Built in</Badge>
          </h3>
          <p>{built.description}</p>
          <p>
            It applies to every test in this project and is never attached or
            removed. There is nothing to edit and nothing to archive.
          </p>
          <p>
            Reads {built.reads.join(", ")}. Scores {built.modalities.join(" and ")}.
          </p>
        </article>
      ))}
    </section>
  );
}
