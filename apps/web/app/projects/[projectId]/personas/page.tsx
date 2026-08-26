"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  forkPersona,
  getPersonaForm,
  listPersonas,
} from "@egma/platform-api/client";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { Refusal } from "../../../../lib/api.ts";
import { firstProjectOf, roleOf } from "../../../../lib/me.ts";
import {
  type Persona,
  type PersonaForm,
  type PersonaPage,
} from "../../../../lib/personas.ts";
import {
  platformAnswer,
  platformClient,
} from "../../../../lib/platform-client.ts";
import { projectLanding } from "../../../../lib/project-context.ts";
import { canAuthor } from "../../../../lib/roles.ts";
import { DataTable, type Column } from "../../../../ui/data-table.tsx";
import { Refused } from "../../../../ui/form.tsx";
import { MenuDivider, MenuItem } from "../../../../ui/menu.tsx";
import {
  Empty,
  Failure,
  Loading,
  NotFound,
} from "../../../../ui/page-state.tsx";
import { ListInstant } from "../../../../ui/relative-time.tsx";
import { useProjectRead } from "../../../../ui/resource.ts";
import { RowMenu } from "../../../../ui/row-menu.tsx";
import { SearchField } from "../../../../ui/section.tsx";
import {
  AppShell,
  PageBody,
  PageHeader,
  ProductPage,
  useShellSession,
} from "../../../../ui/shell.tsx";
import {
  CreatePersonaSheet,
  DeletePersonaDialog,
  PersonaSheet,
} from "./persona-sheets.tsx";
import { PersonaTypeChip } from "./sheet-parts.tsx";

/**
 * The personas of one project: one screen, and everything else drawn over it.
 *
 * **A persona is a first-class thing, not a field on a test.** Egma supplies a
 * Predefined persona to every project, and a project can author a Custom
 * persona or fork the shared one. They are used by many tests, which makes a
 * comparison between two prompt variants honest — the same person meets both.
 *
 * **One address, and the panels are state.** Creating, reading and editing a
 * persona all happen in the side sheet over this list, with no route change and
 * no reload: the list stays exactly where it was, Escape closes what is over
 * it, and nothing that is only a change of view puts a step in the browser's
 * history. It is the arrangement the boards draw, and the one the Graders
 * surface already uses.
 *
 * **One list, and it ends at its last row.** There is no second list of
 * archived personas and no footer line pointing at one: a deleted persona
 * leaves every list for good, and the API refuses to be asked for one.
 */

/** How long a person stops typing for before egma asks the server. */
const SEARCH_SETTLE_MS = 300;

export default function PersonasPage() {
  const { projectId } = useParams<{ projectId: string }>();

  return (
    <AppShell>
      <ProjectPersonas projectId={projectId} />
    </AppShell>
  );
}

/**
 * The row's own name, and the thing that opens it.
 *
 * **A persona is read and edited in a sheet, so the row's name is a button
 * rather than a link.** The boards open the sheet from anywhere on the row; a
 * real control carrying the name is what makes that reachable by keyboard, and
 * it takes the product's Ember focus ring from `globals.css` without asking.
 *
 * The row as a whole answers the pointer through the shared table's
 * `onRowActivate`; this button stays because it is the keyboard path and the
 * one control the accessibility tree holds for the action.
 */
function RowOpener({
  name,
  onOpen,
}: {
  readonly name: string;
  readonly onOpen: () => void;
}) {
  return (
    <button
      className={cn(
        "cursor-pointer border-0 bg-transparent p-0",
        "text-left text-sm text-foreground",
        /* The cell leaves this button unclipped for its focus ring, so the
         * truncation the cell gave up is carried here. */
        "block max-w-full overflow-hidden text-ellipsis whitespace-nowrap",
        "transition-colors duration-(--duration-hover) ease-out",
        "pointer-hover:text-brand",
        "motion-reduce:transition-none",
      )}
      onClick={onOpen}
      type="button"
    >
      {name}
    </button>
  );
}

function ProjectPersonas({ projectId }: { readonly projectId: string }) {
  const { me } = useShellSession();
  // Null until the session read answers. A page that guessed would tell an
  // admin their role cannot do something it can, on every load.
  const role = me === null ? null : roleOf(me);

  /** What somebody has typed, and what egma has been asked for. */
  const [typed, setTyped] = useState("");
  const [search, setSearch] = useState("");

  useEffect(() => {
    // A search is about one project's personas. Carrying it into the next
    // project would filter a list nobody filtered.
    setTyped("");
    setSearch("");
  }, [projectId]);

  useEffect(() => {
    if (typed === search) return undefined;
    const settle = window.setTimeout(() => setSearch(typed), SEARCH_SETTLE_MS);
    return () => window.clearTimeout(settle);
  }, [typed, search]);

  const { answer, reload, refresh } = useProjectRead<PersonaPage>(
    (project) =>
      platformAnswer(
        listPersonas(
          {
            projectId: project,
            ...(search === "" ? {} : { search }),
          },
          { client: platformClient },
        ),
      ),
    projectId,
    search,
  );

  /**
   * The authoring choices, read once for the screen and lent to whichever
   * panel is open. It is a fact about the project rather than about one
   * persona, so reading it per sheet would be the same request again on every
   * row somebody opens — and the read view wants it too, to say `OpenAI` where
   * a persona stores `openai`.
   */
  const { answer: form, reload: reloadForm } = useProjectRead<PersonaForm>(
    (project) =>
      platformAnswer(
        getPersonaForm({ projectId: project }, { client: platformClient }),
      ),
    projectId,
  );

  /**
   * Pages fetched after the first, kept beside it — **and each one remembers
   * the project and the search it was fetched for.**
   *
   * Changing either does not remount this screen, so a read still in flight
   * comes back into a view that has moved on. Carrying both in the value means
   * a page fetched for somewhere else can never be *rendered* here, whatever
   * wrote it and whenever it landed.
   */
  const [after, setAfter] = useState<{
    readonly project: string;
    readonly search: string;
    readonly page: PersonaPage;
  } | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  /** Why the next page did not arrive, until somebody asks for it again. */
  const [moreRefused, setMoreRefused] = useState<Refusal | null>(null);

  const carried =
    after !== null && after.project === projectId && after.search === search
      ? after.page
      : null;

  /** What this view is showing, readable from inside an await. */
  const showing = useRef({ projectId, search });

  useEffect(() => {
    showing.current = { projectId, search };
    setAfter(null);
    setMoreRefused(null);
    setLoadingMore(false);
  }, [projectId, search]);

  useEffect(() => {
    setAfter(null);
    setMoreRefused(null);
  }, [answer]);

  useEffect(() => {
    if (answer?.status === "signed-out") window.location.replace("/sign-in");
  }, [answer]);

  /** A write this screen is running, and what it was refused with. */
  const [running, setRunning] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<Refusal | null>(null);

  /**
   * Which panel is open over the list, and which record it is about — **and
   * which project that record belongs to.**
   *
   * The project travels with it for the reason the page cache above carries
   * one: changing project does not remount this screen, so a panel opened in
   * the last project is still in hand on the first render of the next one.
   */
  const [creating, setCreating] = useState(false);
  const [opened, setOpened] = useState<{
    readonly project: string;
    readonly persona: Persona;
    readonly editing: boolean;
    readonly focusName: boolean;
  } | null>(null);
  const [openedOpen, setOpenedOpen] = useState(false);
  const [deleting, setDeleting] = useState<Persona | null>(null);

  /**
   * The open record, and only while it is this project's.
   *
   * **It is a rendering rule rather than a cleanup, because cleanup is one
   * commit too late.** A child's effects run before its parent's, so a sheet
   * still drawn on the render where the project changed would ask the new
   * project for the old project's persona before the effect below could close
   * it — and the new project has never heard of that id, so the panel would
   * fill with "not found" over a list that is perfectly fine. Not drawing it
   * is what stops the request from being made at all.
   */
  const openedHere = opened !== null && opened.project === projectId ? opened : null;

  /**
   * Another project, and nothing of the last one carried over.
   *
   * Every panel here is about one project's record: a sheet on a persona the
   * next project does not have, a confirmation about deleting it, or — worst
   * of the three — a half-typed new persona, which would quietly be created in
   * whichever project somebody switched to. `running` goes with them because a
   * fork that was in flight drops its answer on a project change and would
   * otherwise leave every row menu disabled for good.
   *
   * **A dirty editor has already been protected before this runs.** The
   * project control navigates through `draftNavigation.push`, so somebody with
   * unsaved work has already been asked and has already answered. Asking again
   * here would be one decision and two questions.
   */
  useEffect(() => {
    setCreating(false);
    setOpened(null);
    setOpenedOpen(false);
    setDeleting(null);
    setRunning(null);
    setRefusal(null);
  }, [projectId]);

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
  const mayAuthor =
    role !== null && canAuthor(role) && answer?.status !== "missing";
  const whyNot =
    role !== null && canAuthor(role)
      ? "There is no project here to author a persona in."
      : `Your ${String(role)} role cannot author personas. Ask an organization admin to change your role.`;

  function open(persona: Persona, editing = false, focusName = false): void {
    setRefusal(null);
    setOpened({ project: projectId, persona, editing, focusName });
    setOpenedOpen(true);
  }

  /**
   * A fork, and where it lands.
   *
   * `forkPersona` copies the name verbatim and takes no name of its own, so a
   * fork of "Impatient Rita" is a second row also called "Impatient Rita".
   * Landing in the editor with that name selected is what makes renaming the
   * next keystroke instead of a thing somebody has to notice later.
   *
   * Whatever comes back is not this screen's to show if the screen has moved to
   * another project — the same rule the list's paging follows, on the write
   * path.
   */
  async function fork(persona: Persona): Promise<void> {
    const asked = projectId;
    setRunning(`fork:${persona.id}`);
    setRefusal(null);

    const written = await platformAnswer(
      forkPersona(
        { personaId: persona.id, projectId },
        { client: platformClient },
      ),
    );

    if (showing.current.projectId !== asked) return;
    setRunning(null);

    if (written.status === "signed-out") {
      window.location.replace("/sign-in");
      return;
    }
    if (written.status !== "ready") {
      setRefusal(written.refusal);
      return;
    }

    refresh();
    open(written.value, true, true);
  }

  /**
   * The row's own menu: the two things the row cannot do with a click.
   *
   * Opening the record is the row itself, and editing is inside the record, so
   * neither is here. What is left is a copy and a removal — and a Predefined
   * persona can only be copied, so its menu is one item rather than one item
   * and a refusal.
   */
  function rowMenu(persona: Persona): ReactNode {
    const predefined = persona.owner === "egma";
    const inert = !mayAuthor || running !== null;

    return (
      <RowMenu label={`Open the menu for ${persona.name}`}>
        {(close) => (
          <>
            <MenuItem
              disabled={inert}
              onClick={() => {
                close();
                void fork(persona);
              }}
            >
              Fork
            </MenuItem>
            {predefined ? null : (
              <>
                <MenuDivider />
                <MenuItem
                  disabled={inert}
                  onClick={() => {
                    close();
                    setRefusal(null);
                    setDeleting(persona);
                  }}
                >
                  <span className="text-failure">Delete</span>
                </MenuItem>
              </>
            )}
          </>
        )}
      </RowMenu>
    );
  }

  function columns(): readonly Column<Persona>[] {
    return [
      {
        key: "name",
        header: "Name",
        primary: true,
        width: "260px",
        cell: (persona) => (
          <RowOpener name={persona.name} onOpen={() => open(persona)} />
        ),
      },
      {
        key: "type",
        header: "Type",
        width: "140px",
        cell: (persona) => <PersonaTypeChip owner={persona.owner} />,
      },
      {
        key: "language",
        header: "Language",
        width: "110px",
        cell: (persona) => persona.language,
      },
      {
        key: "description",
        header: "Description",
        hideOnMobile: true,
        cell: (persona) =>
          persona.description === null || persona.description === "" ? (
            <span className="text-faint">No description</span>
          ) : (
            persona.description
          ),
      },
      {
        key: "version",
        header: "Version",
        hideOnMobile: true,
        mono: true,
        width: "90px",
        cell: (persona) => `v${String(persona.version)}`,
      },
      {
        key: "updated",
        header: "Updated",
        width: "130px",
        cell: (persona) => <ListInstant instant={persona.updatedAt} />,
      },
      {
        key: "actions",
        header: "Row actions",
        action: true,
        cell: (persona) => rowMenu(persona),
      },
    ];
  }

  /**
   * The way to author a persona, and what it becomes when it is not this
   * person's. It opens a panel rather than following an address, so it is a
   * button either way and a disabled one is genuinely inert.
   */
  function author(): ReactNode {
    if (role === null) return undefined;
    return (
      <Button
        type="button"
        disabled={!mayAuthor}
        {...(mayAuthor ? {} : { why: whyNot })}
        onClick={() => {
          setRefusal(null);
          setCreating(true);
        }}
      >
        New persona
      </Button>
    );
  }

  function body(): ReactNode {
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

    const items = [...answer.value.personas, ...(carried?.personas ?? [])];
    const cursor =
      carried === null ? answer.value.nextPageToken : carried.nextPageToken;

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

      const asked = { projectId, search };
      setMoreRefused(null);
      setLoadingMore(true);

      const next = await platformAnswer(
        listPersonas(
          {
            projectId: asked.projectId,
            pageToken: cursor,
            ...(asked.search === "" ? {} : { search: asked.search }),
          },
          { client: platformClient },
        ),
      );

      setLoadingMore(false);
      if (
        showing.current.projectId !== asked.projectId ||
        showing.current.search !== asked.search
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
        search: asked.search,
        page: {
          personas: [...(carried?.personas ?? []), ...next.value.personas],
          nextPageToken: next.value.nextPageToken,
        },
      });
    }

    if (items.length === 0) {
      if (search !== "") {
        return (
          <Empty
            title="No persona here matches that"
            lead="Clear the search to see every persona in this project."
            action={
              <Button
                type="button"
                variant="secondary"
                onClick={() => setTyped("")}
              >
                Clear search
              </Button>
            }
          />
        );
      }
      return (
        <Empty
          title="No personas in this project yet"
          lead="A persona is the synthetic person who speaks with the agent — who they are, never what they want in one simulation."
          action={author()}
        />
      );
    }

    return (
      <>
        <DataTable
          label="Personas in this project"
          columns={columns()}
          rows={items}
          keyOf={(persona) => persona.id}
          onRowActivate={(persona) => open(persona)}
          {...(openedOpen && openedHere !== null
            ? { currentKey: openedHere.persona.id }
            : {})}
          {...(cursor === null
            ? {}
            : {
                more: {
                  onMore: () => void showMore(),
                  loading: loadingMore,
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

  return (
    <ProductPage>
      <PageHeader
        title="Personas"
        toolbar={
          <SearchField
            aria-label="Search personas by name"
            placeholder="Search by name"
            value={typed}
            onChange={(event) => setTyped(event.target.value)}
          />
        }
        action={author()}
      />
      <PageBody>
        {refusal === null ? null : (
          <div className="pb-4">
            <Refused message={refusal.message} />
          </div>
        )}
        {body()}
      </PageBody>

      <CreatePersonaSheet
        projectId={projectId}
        open={creating}
        form={form}
        reloadForm={reloadForm}
        role={role}
        mayAuthor={mayAuthor}
        whyNot={mayAuthor ? undefined : whyNot}
        onClose={() => setCreating(false)}
        onCreated={(persona) => {
          setCreating(false);
          refresh();
          open(persona);
        }}
      />

      {openedHere === null ? null : (
        <PersonaSheet
          key={openedHere.persona.id}
          projectId={projectId}
          personaId={openedHere.persona.id}
          open={openedOpen}
          form={form?.status === "ready" ? form.value : null}
          role={role}
          mayAuthor={mayAuthor}
          whyNot={mayAuthor ? undefined : whyNot}
          startEditing={openedHere.editing}
          focusName={openedHere.focusName}
          busy={running !== null}
          onClose={() => setOpenedOpen(false)}
          onWritten={refresh}
          onFork={(persona) => void fork(persona)}
          onDelete={(persona) => {
            setOpenedOpen(false);
            setDeleting(persona);
          }}
        />
      )}

      {deleting === null ? null : (
        <DeletePersonaDialog
          persona={deleting}
          projectId={projectId}
          onClose={() => setDeleting(null)}
          onDeleted={() => {
            setDeleting(null);
            setOpenedOpen(false);
            refresh();
          }}
        />
      )}
    </ProductPage>
  );
}
