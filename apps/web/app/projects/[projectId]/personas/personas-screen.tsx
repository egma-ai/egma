"use client";

import { EllipsisVerticalIcon } from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import {
  archivePersona,
  forkPersona,
  getPersonaForm,
  listPersonas,
  restorePersona,
  setDefaultPersona,
} from "@egma/platform-api/client";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { Refusal } from "../../../../lib/api.ts";
import { firstProjectOf, roleOf } from "../../../../lib/me.ts";
import {
  ownerSaid,
  type Persona,
  type PersonaForm,
  type PersonaPage,
} from "../../../../lib/personas.ts";
import {
  platformAnswer,
  platformClient,
  type PlatformRequest,
} from "../../../../lib/platform-client.ts";
import {
  projectLanding,
  projectPath,
} from "../../../../lib/project-context.ts";
import { canAuthor } from "../../../../lib/roles.ts";
import { DataTable, type Column } from "../../../../ui/data-table.tsx";
import { Refused } from "../../../../ui/form.tsx";
import { Menu, MenuDivider, MenuItem } from "../../../../ui/menu.tsx";
import {
  Empty,
  Failure,
  Loading,
  NotFound,
} from "../../../../ui/page-state.tsx";
import { useProjectRead } from "../../../../ui/resource.ts";
import {
  RelativeInstant,
  useMinuteClock,
} from "../../../../ui/relative-time.tsx";
import { SearchField } from "../../../../ui/section.tsx";
import {
  PageBody,
  PageHeader,
  ProductPage,
  useShellSession,
} from "../../../../ui/shell.tsx";
import { ArchiveDialog } from "./archive-dialog.tsx";
import { NewPersonaSheet } from "./new-persona-sheet.tsx";
import { PersonaSheet } from "./persona-sheet.tsx";
import { StateChip } from "./sheet-parts.tsx";

/**
 * The personas of one project: one screen, and everything else drawn over it.
 *
 * **A persona is a first-class thing, not a field on a test.** Egma supplies
 * an Egma-provided persona to every project, and a project can author a Custom
 * persona or fork the shared one. They are used by many tests, which makes a
 * comparison between two prompt variants honest — the same person meets both.
 *
 * **Three addresses, one screen.** `/personas` is the list; `/personas/new`
 * and `/personas/{id}` are the same list with a side sheet over it. That is
 * the boards' arrangement (`8TQ-0` and the six sheets on page `C-0`) and it is
 * why they stay addresses rather than becoming state: a link somebody sent
 * still opens the persona it names, Back still means back, and the list behind
 * the panel is still there to compare against.
 *
 * **Two lists and never one.** Active is what somebody authors from; Archived
 * is where the ones taken out of circulation are (`BSS-0`), reached by the
 * footer link and addressable as `?archived=1`. A single list with a column
 * saying which is which is a list somebody picks the wrong row out of.
 *
 * **No count egma has not read.** The footer says how many rows are on screen
 * and links to the other list by name. The list operation carries no totals,
 * so a number beside "Archived" would be a second request on every load — or,
 * worse, a guess.
 */

export type PersonaSheetTarget =
  | { readonly kind: "none" }
  | { readonly kind: "new" }
  | { readonly kind: "persona"; readonly personaId: string };

type Shown = "active" | "archived";

/** How long a person stops typing for before egma asks the server. */
const SEARCH_SETTLE_MS = 300;

/** The row control's lane, and the trigger that sits centred in it. */
const ROW_MENU_TRIGGER = [
  "inline-flex size-9 cursor-pointer items-center justify-center",
  "rounded-button border-0 bg-transparent text-faint",
  "transition-[color,background-color] duration-(--duration-hover) ease-out",
  "pointer-hover:bg-surface-soft pointer-hover:text-foreground",
  "pointer-coarse:size-(--tap-target)",
].join(" ");

/** The quiet underlined link the boards end a table with. */
const FOOTER_LINK =
  "text-sm text-muted-foreground underline underline-offset-[3px] pointer-hover:text-primary";

export function PersonasScreen({
  projectId,
  sheet,
}: {
  readonly projectId: string;
  readonly sheet: PersonaSheetTarget;
}) {
  const { me } = useShellSession();
  const router = useRouter();
  const now = useMinuteClock();
  // Null until the session read answers. A page that guessed would tell an
  // admin their role cannot do something it can, on every load.
  const role = me === null ? null : roleOf(me);

  const archived = useSearchParams().get("archived") === "1";
  const shown: Shown = archived ? "archived" : "active";

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
    const settle = window.setTimeout(
      () => setSearch(typed),
      SEARCH_SETTLE_MS,
    );
    return () => window.clearTimeout(settle);
  }, [typed, search]);

  const { answer, reload, refresh } = useProjectRead<PersonaPage>(
    (project) =>
      platformAnswer(
        listPersonas(
          {
            projectId: project,
            ...(archived ? { archived: "true" } : {}),
            ...(search === "" ? {} : { search }),
          },
          { client: platformClient },
        ),
      ),
    projectId,
    `${shown}:${search}`,
  );

  /**
   * The authoring choices, read once for the screen and lent to whichever
   * panel is open. It is a fact about the project rather than about one
   * persona, so reading it per sheet would be the same request again on every
   * row somebody opens — and the read view wants it too, to say `OpenAI`
   * where a persona stores `openai`.
   */
  const { answer: form, reload: reloadForm } = useProjectRead<PersonaForm>(
    (project) =>
      platformAnswer(getPersonaForm({ projectId: project }, { client: platformClient })),
    projectId,
  );

  /**
   * Pages fetched after the first, kept beside it — **and each one remembers
   * the project, the list and the search it was fetched for.**
   *
   * Changing any of the three does not remount this screen, so a read still in
   * flight comes back into a view that has moved on. Carrying all three in the
   * value means a page fetched for somewhere else can never be *rendered*
   * here, whatever wrote it and whenever it landed.
   */
  const [after, setAfter] = useState<{
    readonly project: string;
    readonly shown: Shown;
    readonly search: string;
    readonly page: PersonaPage;
  } | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  /** Why the next page did not arrive, until somebody asks for it again. */
  const [moreRefused, setMoreRefused] = useState<Refusal | null>(null);

  const carried =
    after !== null &&
    after.project === projectId &&
    after.shown === shown &&
    after.search === search
      ? after.page
      : null;

  /** What this view is showing, readable from inside an await. */
  const showing = useRef({ projectId, shown, search });

  useEffect(() => {
    showing.current = { projectId, shown, search };
    setAfter(null);
    setMoreRefused(null);
    setLoadingMore(false);
  }, [projectId, shown, search]);

  useEffect(() => {
    setAfter(null);
    setMoreRefused(null);
  }, [answer]);

  useEffect(() => {
    if (answer?.status === "signed-out") window.location.replace("/sign-in");
  }, [answer]);

  /**
   * A write this screen is running, and what it was refused with.
   *
   * Both carry **which** write they are about. A refusal about the archive
   * somebody is confirming belongs inside that confirmation, in front of the
   * choice that caused it; a refusal about a fork belongs above the list. Two
   * copies of one sentence on one screen is one sentence too many.
   */
  const [running, setRunning] = useState<string | null>(null);
  /** How many of this screen's own writes have landed, for the open panel. */
  const [written, setWritten] = useState(0);
  const [refusal, setRefusal] = useState<{
    readonly what: string;
    readonly said: Refusal;
  } | null>(null);
  /** The persona a confirmation is open about. */
  const [archiving, setArchiving] = useState<Persona | null>(null);
  /** Which persona the panel is editing, and whether its name is in hand. */
  const [editing, setEditing] = useState<{
    readonly personaId: string;
    readonly focusName: boolean;
  } | null>(null);

  const here = projectPath(projectId, "personas");
  const listPath = archived ? `${here}?archived=1` : here;
  const personaPath = (personaId: string) =>
    archived
      ? `${projectPath(projectId, "personas", personaId)}?archived=1`
      : projectPath(projectId, "personas", personaId);

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

  /**
   * One write that is not a save: fork, make default, archive, restore.
   *
   * Whatever comes back is not this screen's to show if the screen has moved
   * to another project — the same rule the list's paging follows, on the write
   * path.
   */
  async function lifecycle(
    request: PlatformRequest<Persona>,
    what: string,
  ): Promise<Persona | null> {
    const asked = projectId;
    setRunning(what);
    setRefusal(null);

    const written = await platformAnswer(request);

    if (showing.current.projectId !== asked) return null;
    setRunning(null);

    if (written.status === "signed-out") {
      window.location.replace("/sign-in");
      return null;
    }
    if (written.status !== "ready") {
      setRefusal({ what, said: written.refusal });
      return null;
    }

    refresh();
    setWritten((one) => one + 1);
    return written.value;
  }

  /**
   * A fork, and where it lands.
   *
   * `forkPersona` copies the name verbatim and takes no name of its own, so a
   * fork of "Impatient Rita" is a second row also called "Impatient Rita".
   * Landing in the editor with that name selected is what makes renaming the
   * next keystroke instead of a thing somebody has to notice later.
   */
  async function fork(persona: Persona): Promise<void> {
    const made = await lifecycle(
      forkPersona(
        { personaId: persona.id, projectId },
        { client: platformClient },
      ),
      `fork:${persona.id}`,
    );
    if (made === null) return;
    setEditing({ personaId: made.id, focusName: true });
    router.push(projectPath(projectId, "personas", made.id));
  }

  async function makeDefault(persona: Persona): Promise<void> {
    if (persona.archivedAt !== null || persona.isDefault) return;
    await lifecycle(
      setDefaultPersona(
        { personaId: persona.id, projectId },
        { client: platformClient },
      ),
      `default:${persona.id}`,
    );
  }

  async function restore(persona: Persona): Promise<void> {
    await lifecycle(
      restorePersona(
        {
          personaId: persona.id,
          projectId,
          expectedRevision: persona.revision,
        },
        { client: platformClient },
      ),
      `restore:${persona.id}`,
    );
  }

  async function archive(
    persona: Persona,
    replacement: string | undefined,
  ): Promise<void> {
    const done = await lifecycle(
      archivePersona(
        {
          personaId: persona.id,
          projectId,
          expectedRevision: persona.revision,
          ...(replacement === undefined
            ? {}
            : { replacementPersonaId: replacement }),
        },
        { client: platformClient },
      ),
      `archive:${persona.id}`,
    );
    if (done !== null) setArchiving(null);
  }

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

  /**
   * The row's own menu.
   *
   * A viewer and a session egma has not identified yet get **Open** and
   * nothing else. A menu of five dead words says less than one live one, and
   * the sentence explaining why the other four are not theirs belongs beside
   * the control in the panel, where there is room to write it.
   */
  function rowMenu(persona: Persona) {
    const egmaProvided = persona.owner === "egma";
    const isArchived = persona.archivedAt !== null;

    return (
      <Menu
        label={`Actions for ${persona.name}`}
        placement="below-end"
        panelClassName="min-w-[210px]"
        trigger={<EllipsisVerticalIcon aria-hidden="true" className="size-4" />}
        triggerClassName={ROW_MENU_TRIGGER}
      >
        {(close) => (
          <>
            <MenuItem href={personaPath(persona.id)} onClick={close}>
              Open
            </MenuItem>
            {!mayAuthor ? null : (
              <>
                {egmaProvided || isArchived ? null : (
                  <MenuItem
                    onClick={() => {
                      close();
                      setEditing({
                        personaId: persona.id,
                        focusName: false,
                      });
                      router.push(personaPath(persona.id));
                    }}
                  >
                    Edit
                  </MenuItem>
                )}
                <MenuItem
                  onClick={() => {
                    close();
                    void fork(persona);
                  }}
                >
                  Fork
                </MenuItem>
                {isArchived || persona.isDefault ? null : (
                  <MenuItem
                    onClick={() => {
                      close();
                      void makeDefault(persona);
                    }}
                  >
                    Make project default
                  </MenuItem>
                )}
                {egmaProvided ? null : (
                  <>
                    <MenuDivider />
                    {isArchived ? (
                      <MenuItem
                        onClick={() => {
                          close();
                          void restore(persona);
                        }}
                      >
                        Restore
                      </MenuItem>
                    ) : (
                      <MenuItem
                        onClick={() => {
                          close();
                          setArchiving(persona);
                        }}
                      >
                        <span className="text-failure">Archive</span>
                      </MenuItem>
                    )}
                  </>
                )}
              </>
            )}
          </>
        )}
      </Menu>
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
          <span className="inline-flex min-w-0 items-center gap-2.5">
            <Link
              className="no-underline"
              href={personaPath(persona.id)}
            >
              {persona.name}
            </Link>
            {persona.isDefault ? (
              <StateChip tone="current">Default</StateChip>
            ) : null}
          </span>
        ),
      },
      {
        key: "type",
        header: "Type",
        width: "140px",
        cell: (persona) => ownerSaid(persona.owner),
      },
      {
        key: "language",
        header: "Language",
        width: "110px",
        cell: (persona) => persona.traits.language,
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
        cell: (persona) => (
          <RelativeInstant instant={persona.updatedAt} now={now} />
        ),
      },
      {
        key: "actions",
        header: "Row actions",
        action: true,
        cell: (persona) => rowMenu(persona),
      },
    ];
  }

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

      const asked = { projectId, shown, search };
      setMoreRefused(null);
      setLoadingMore(true);

      const next = await platformAnswer(
        listPersonas(
          {
            projectId: asked.projectId,
            pageToken: cursor,
            ...(asked.shown === "archived" ? { archived: "true" } : {}),
            ...(asked.search === "" ? {} : { search: asked.search }),
          },
          { client: platformClient },
        ),
      );

      setLoadingMore(false);
      if (
        showing.current.projectId !== asked.projectId ||
        showing.current.shown !== asked.shown ||
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
        shown: asked.shown,
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
      return archived ? (
        <Empty
          title="Nothing has been archived here"
          lead="A persona somebody archives leaves the active list and lands here, with everything about them intact."
        />
      ) : (
        <Empty
          title="No personas in this project yet"
          lead="A persona is the synthetic person who speaks with the agent — who they are, never what they want in one simulation."
          action={author()}
        />
      );
    }

    const counted = `${String(items.length)} ${archived ? "archived" : "active"} ${
      items.length === 1 ? "persona" : "personas"
    }${cursor === null ? "" : " so far"} ·`;

    return (
      <>
        <DataTable
          label={`${archived ? "Archived" : "Active"} personas in this project`}
          columns={columns()}
          rows={items}
          keyOf={(persona) => persona.id}
          stretchPrimaryLink
          {...(cursor === null
            ? {}
            : {
                more: {
                  onMore: () => void showMore(),
                  loading: loadingMore,
                },
              })}
        />
        {/*
         * The board's footer line: what is on screen, and the other list by
         * name. There is no number beside "Archived" because the list
         * operation carries no totals — a count egma has not read is a number
         * it would sometimes get wrong.
         */}
        <div className="flex flex-wrap items-center gap-1.5 px-4 pt-3">
          <span className="text-sm text-faint">{counted}</span>
          <Link
            className={FOOTER_LINK}
            href={archived ? here : `${here}?archived=1`}
          >
            {archived ? "Back to active" : "Archived"}
          </Link>
        </div>
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

  const projectName =
    me?.projects.find((one) => one.id === projectId)?.name ?? null;
  const archivingKey =
    archiving === null ? null : `archive:${archiving.id}`;

  return (
    <ProductPage>
      <PageHeader
        title="Personas"
        toolbar={
          <SearchField
            aria-label={
              archived
                ? "Search archived personas by name"
                : "Search personas by name"
            }
            placeholder={
              archived ? "Search archived by name" : "Search by name"
            }
            value={typed}
            onChange={(event) => setTyped(event.target.value)}
          />
        }
        action={author()}
      />
      <PageBody>
        {archived ? (
          /*
           * What an archived persona is, said above the list that holds them
           * rather than on each row (`BYC-0`). Every row here is archived, so
           * a column saying so would be the same word all the way down.
           */
          <div className="flex flex-wrap items-center gap-2.5 pb-3">
            <Badge shape="count" className="px-1.5 text-sm">
              Archived
            </Badge>
            <span className="text-sm text-muted-foreground">
              Out of the lists a test is authored from. Every version stays.
              Restore puts them back.
            </span>
          </div>
        ) : null}

        {refusal === null || refusal.what === archivingKey ? null : (
          <div className="pb-4">
            <Refused message={refusal.said.message} />
          </div>
        )}

        {body()}
      </PageBody>

      {sheet.kind === "new" ? (
        <NewPersonaSheet
          projectId={projectId}
          projectName={projectName}
          form={form}
          reloadForm={reloadForm}
          role={role}
          mayAuthor={mayAuthor}
          whyNot={whyNot}
          onCreated={(persona) => {
            refresh();
            router.push(projectPath(projectId, "personas", persona.id));
          }}
          onClose={() => router.push(listPath)}
        />
      ) : null}

      {sheet.kind === "persona" ? (
        <PersonaSheet
          projectId={projectId}
          personaId={sheet.personaId}
          form={form?.status === "ready" ? form.value : null}
          role={role}
          mayAuthor={mayAuthor}
          whyNot={whyNot}
          editing={editing?.personaId === sheet.personaId}
          writtenAt={written}
          focusName={
            editing?.personaId === sheet.personaId && editing.focusName
          }
          busy={running !== null}
          onEdit={() =>
            setEditing({ personaId: sheet.personaId, focusName: false })
          }
          onRead={() => setEditing(null)}
          onFork={(persona) => void fork(persona)}
          onMakeDefault={(persona) => void makeDefault(persona)}
          onRestore={(persona) => void restore(persona)}
          onArchive={(persona) => setArchiving(persona)}
          onWritten={refresh}
          onClose={() => {
            setEditing(null);
            router.push(listPath);
          }}
        />
      ) : null}

      {archiving === null ? null : (
        <ArchiveDialog
          persona={archiving}
          projectId={projectId}
          busy={running === archivingKey}
          refusal={
            refusal !== null && refusal.what === archivingKey
              ? refusal.said
              : null
          }
          onClose={() => setArchiving(null)}
          onArchive={(replacement) => void archive(archiving, replacement)}
        />
      )}
    </ProductPage>
  );
}
