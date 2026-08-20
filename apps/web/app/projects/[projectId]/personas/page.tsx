"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { readJson, type Refusal } from "../../../../lib/api.ts";
import { firstProjectOf, roleOf } from "../../../../lib/me.ts";
import {
  personasAfter,
  personasPath,
  type Persona,
  type PersonaPage,
} from "../../../../lib/personas.ts";
import { projectLanding, projectPath } from "../../../../lib/project-context.ts";
import { canAuthor } from "../../../../lib/roles.ts";
import { Choice } from "../../../../ui/controls.tsx";
import { Toolbar } from "../../../../ui/section.tsx";
import { DataTable, type Column } from "../../../../ui/data-table.tsx";
import { Empty, Failure, Loading, NotFound } from "../../../../ui/page-state.tsx";
import { useProjectRead } from "../../../../ui/resource.ts";
import {
  RelativeInstant,
  useMinuteClock,
} from "../../../../ui/relative-time.tsx";
import {
  AppShell,
  PageBody,
  PageHeader,
  ProductPage,
  useShellSession,
} from "../../../../ui/shell.tsx";

/**
 * The personas of one project.
 *
 * **A persona is a first-class thing a project owns, not a field on a test.**
 * They are authored once and called on by many tests, which is what makes a
 * comparison between two prompt variants honest — the same person calls both.
 * A surface that only existed inside a test form would quietly turn a reusable
 * person into a field, which is exactly what this page exists to prevent.
 *
 * Two lists and never one. Active is what somebody authors from; Archived is
 * where the ones taken out of circulation are, and Restore is on their page. A
 * single list with a column saying which is which is a list somebody picks the
 * wrong row out of.
 */
export default function PersonasPage() {
  const { projectId } = useParams<{ projectId: string }>();
  return (
    <AppShell>
      <Personas projectId={projectId} />
    </AppShell>
  );
}

type Shown = "active" | "archived";

function columnsFor(projectId: string, now: number): readonly Column<Persona>[] {
  return [
    {
      key: "name",
      header: "Persona",
      primary: true,
      cell: (persona) => (
        <span className="inline-flex min-w-0 items-center gap-3">
          <Link
            className="no-underline"
            href={projectPath(projectId, "personas", persona.id)}
          >
            {persona.name}
          </Link>
        </span>
      ),
    },
    {
      key: "description",
      header: "Description",
      hideOnMobile: true,
      cell: (persona) => persona.description ?? "—",
    },
    {
      key: "language",
      header: "Language",
      mono: true,
      width: "100px",
      cell: (persona) => persona.traits.language,
    },
    {
      key: "version",
      header: "Version",
      hideOnMobile: true,
      mono: true,
      width: "90px",
      cell: (persona) => `v${persona.version}`,
    },
    {
      key: "updated",
      header: "Updated",
      mono: true,
      width: "120px",
      cell: (persona) => (
        <RelativeInstant instant={persona.updated_at} now={now} />
      ),
    },
  ];
}

function Personas({ projectId }: { readonly projectId: string }) {
  const { me } = useShellSession();
  const now = useMinuteClock();
  // Null until the session read answers. A page that guessed would tell an
  // admin their role cannot do something it can, on every load.
  const role = me === null ? null : roleOf(me);

  const [shown, setShown] = useState<Shown>("active");
  const archived = shown === "archived";
  const { answer, reload } = useProjectRead<PersonaPage>(
    personasPath(archived),
    projectId,
  );

  /**
   * Pages fetched after the first, kept beside it — **and each one remembers
   * the project and the list it was fetched for.**
   *
   * Changing project does not remount this page and neither does changing the
   * filter: both are the same component with another value in it, so this
   * state outlives the change and a read still in flight comes back into a
   * view that has moved on. Carrying both in the value means a page fetched
   * for somewhere else can never be *rendered* here, whatever wrote it and
   * whenever it landed.
   */
  const [after, setAfter] = useState<{
    readonly project: string;
    readonly shown: Shown;
    readonly page: PersonaPage;
  } | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  /** Why the next page did not arrive, until somebody asks for it again. */
  const [moreRefused, setMoreRefused] = useState<Refusal | null>(null);

  const carried =
    after !== null && after.project === projectId && after.shown === shown
      ? after.page
      : null;

  /** What this view is showing, readable from inside an await. */
  const showing = useRef({ projectId, shown });

  useEffect(() => {
    showing.current = { projectId, shown };
    setAfter(null);
    setMoreRefused(null);
    setLoadingMore(false);
  }, [projectId, shown]);

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
      ? "There is no project here to author a persona in."
      : `Your ${String(role)} role cannot author personas. Ask an organization admin to change your role.`;

  /**
   * The way to author a persona, and what it becomes when it is not this
   * person's.
   *
   * **A disabled control is genuinely inert or it is a lie.** A link cannot be
   * disabled: `aria-disabled` on an anchor greys it out and it still follows on
   * click and still takes the keyboard. So when this is not available it stops
   * being a link and becomes a disabled button, which carries the reason where
   * a keyboard and a screen reader can reach it.
   */
  const author = () =>
    role === null ? undefined : mayAuthor ? (
      <Button asChild>
        <Link href={projectPath(projectId, "personas", "new")}>
          New persona
        </Link>
      </Button>
    ) : (
      <Button type="button" disabled why={whyNot}>
        New persona
      </Button>
    );

  function body() {
    if (answer === null || answer.status === "signed-out") {
      return <Loading what="personas" />;
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

      // What this read is for. Somebody may choose another project or the
      // other list before it comes back, and the answer is then not this
      // view's to show.
      const asked = { projectId, shown };
      setMoreRefused(null);
      setLoadingMore(true);

      const next = await readJson<PersonaPage>(
        personasAfter(cursor, asked.shown === "archived"),
        { project: asked.projectId },
      );

      setLoadingMore(false);
      if (
        showing.current.projectId !== asked.projectId ||
        showing.current.shown !== asked.shown
      ) {
        return;
      }

      if (next.status === "signed-out") {
        window.location.replace("/sign-in");
        return;
      }

      if (next.status !== "ready") {
        setMoreRefused(next.refusal);
        return;
      }

      setAfter({
        project: asked.projectId,
        shown: asked.shown,
        page: {
          items: [...(carried?.items ?? []), ...next.value.items],
          next_cursor: next.value.next_cursor,
        },
      });
    }

    if (items.length === 0) {
      return archived ? (
        <Empty
          title="Nothing has been archived here"
          lead="A persona somebody archives leaves the active list and lands here, with everything about them intact."
        />
      ) : (
        <Empty
          title="No personas in this project yet"
          lead="A persona is the synthetic person who calls the agent — who they are, never what they want on a given occasion."
          action={author()}
        />
      );
    }

    return (
      <>
        <DataTable
          label={`${archived ? "Archived" : "Active"} personas in this project`}
          columns={columnsFor(projectId, now)}
          rows={items}
          keyOf={(persona) => persona.id}
          stretchPrimaryLink
          {...(cursor === null
            ? {}
            : {
                more: {
                  onMore: () => void showMore(),
                  loading: loadingMore,
                  note: `${items.length} personas so far`,
                },
              })}
        />
        {moreRefused === null ? null : (
          <Failure
            title="Egma could not load more personas."
            message={moreRefused.message}
            onRetry={() => void showMore()}
          />
        )}
      </>
    );
  }

  /**
   * The filter stays on screen while the list it chose is loading.
   *
   * Rendering it inside the state fold would unmount it on every change —
   * which loses the keyboard's place in it, and makes the control somebody
   * just pressed disappear while they are still looking at it. It goes when
   * there is no list to filter at all, and only then.
   */
  const filterable = answer === null || answer.status === "ready";

  return (
    <ProductPage>
      <PageHeader
        eyebrow="Project"
        title="Personas"
        lead="The synthetic people who call the agents in this project. One persona calls about many situations; what they want on a given occasion is the test's."
        action={author()}
      />
      <PageBody>
        {filterable ? (
          <Toolbar>
            <Choice<Shown>
              label="Which personas to show"
              value={shown}
              options={[
                { value: "active", label: "Active" },
                { value: "archived", label: "Archived" },
              ]}
              onChange={setShown}
            />
          </Toolbar>
        ) : null}
        {body()}
      </PageBody>
    </ProductPage>
  );
}
