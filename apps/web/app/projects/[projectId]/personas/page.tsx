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
 * List Egma-provided and Custom personas for this project. Create, read, and
 * edit in sheets over the list. Deleted personas are excluded from lists and pickers.
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
 * Keep a button on the persona name for keyboard access to the sheet;
 * onRowActivate supplies the larger pointer target.
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
   * Do not render a sheet for another project, even before cleanup effects run.
   * Otherwise its child could request the old persona ID in the new project.
   */
  const openedHere = opened !== null && opened.project === projectId ? opened : null;

  /**
   * Clear project-specific sheets, confirmations, and pending-action state on
   * project change. The shared draft-navigation guard already handles unsaved work.
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
   * Hide actions until the role is known, then show unavailable writes disabled
   * with a reason. The server enforces permissions.
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
   * A clone keeps the original label, so open its editor with the name selected.
   * Ignore a result that arrives after switching projects.
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
              Clone
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
          form={form}
          reloadForm={reloadForm}
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
