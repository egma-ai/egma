"use client";

import { XIcon } from "lucide-react";
import Link from "next/link";
import { useParams, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  listGraderLibrary,
  listGraders,
  removeGrader,
} from "@egma/platform-api/client";

import { Button } from "@/components/ui/button";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import type { Answer, Refusal } from "../../../../lib/api.ts";
import {
  graderDefinitionDisplayName,
  graderOwnerLabel,
  productionScopeSummary,
  simulationScopeSummary,
  type GraderLibraryEntry,
  type GraderLibraryPage,
  type ProjectGrader,
  type ProjectGradersPage,
} from "../../../../lib/graders.ts";
import { firstProjectOf, roleOf } from "../../../../lib/me.ts";
import {
  platformAnswer,
  platformClient,
} from "../../../../lib/platform-client.ts";
import { projectLanding } from "../../../../lib/project-context.ts";
import { canAuthor } from "../../../../lib/roles.ts";
import { DataTable, type Column } from "../../../../ui/data-table.tsx";
import { Dialog } from "../../../../ui/dialog.tsx";
import { Refused } from "../../../../ui/form.tsx";
import { MenuDivider, MenuItem } from "../../../../ui/menu.tsx";
import {
  Empty,
  Failure,
  Loading,
  NotFound,
} from "../../../../ui/page-state.tsx";
import { useProjectRead } from "../../../../ui/resource.ts";
import { DestructiveItem, RowMenu } from "../../../../ui/row-menu.tsx";
import {
  AppShell,
  PageBody,
  PageHeader,
  ProductPage,
  useShellSession,
} from "../../../../ui/shell.tsx";
import {
  ActiveGraderSheet,
  CreateCustomGraderSheet,
  GraderModalityChips,
  GraderTypeChip,
  LibraryGraderSheet,
  ProjectUseChip,
  ScopeValue,
} from "./grader-sheets.tsx";

async function readAllProjectGraders(
  projectId: string,
): Promise<Answer<ProjectGradersPage>> {
  const graders: ProjectGrader[] = [];
  let pageToken: string | undefined;

  for (;;) {
    const answer = await platformAnswer(
      listGraders(
        {
          projectId,
          ...(pageToken === undefined ? {} : { pageToken }),
        },
        { client: platformClient },
      ),
    );
    if (answer.status !== "ready") return answer;

    graders.push(...answer.value.graders);
    if (answer.value.nextPageToken === null) {
      return {
        status: "ready",
        value: { graders, nextPageToken: null },
      };
    }
    pageToken = answer.value.nextPageToken;
  }
}

async function readAllGraderLibrary(
  projectId: string,
): Promise<Answer<GraderLibraryPage>> {
  const graderLibraryEntries: GraderLibraryEntry[] = [];
  let pageToken: string | undefined;

  for (;;) {
    const answer = await platformAnswer(
      listGraderLibrary(
        {
          projectId,
          ...(pageToken === undefined ? {} : { pageToken }),
        },
        { client: platformClient },
      ),
    );
    if (answer.status !== "ready") return answer;

    graderLibraryEntries.push(...answer.value.graderLibraryEntries);
    if (answer.value.nextPageToken === null) {
      return {
        status: "ready",
        value: { graderLibraryEntries, nextPageToken: null },
      };
    }
    pageToken = answer.value.nextPageToken;
  }
}

export default function GradersPage() {
  const { projectId } = useParams<{ projectId: string }>();
  return (
    <AppShell>
      <ProjectGraders projectId={projectId} />
    </AppShell>
  );
}

/**
 * The row's own name, and the thing that opens it.
 *
 * **A grader is read and edited in a sheet, so the row's name is a button
 * rather than a link.** The boards open the sheet from anywhere on the row; a
 * real control carrying the name is what makes that reachable by keyboard, and
 * it takes the product's Ember focus ring from `globals.css` without asking.
 * The name keeps the row's ordinary weight and turns Ember under a pointer,
 * which is the feedback the shared table already gives a row somebody is
 * pointing at.
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

/**
 * The score a simulation has to reach, as a measure: two places, tabular.
 *
 * **It reads from the lane's left edge, like every other fact in the table.**
 * The column was right-aligned for a morning, and the figures ended up under
 * the tail of a header three times their width — an indent, to an eye that
 * scans this table's five other columns by their shared left edge — welded to
 * the ⋮ lane across a void of spare paper. Right alignment earns its keep when
 * values differ in width; every value here is `N.NN` in tabular numerals, so
 * the digits line up down the column from either edge and the left one is the
 * edge the rest of the table already reads from.
 */
function PassThreshold({ value }: { readonly value: number }) {
  return <span className="tabular-nums">{value.toFixed(2)}</span>;
}

/**
 * **The name lane is stated; the facts share what is left.**
 *
 * `ui/data-table.tsx` gives the slack to the columns that ask for no width, so
 * a list that states a width for all but one of them hands that one column
 * every spare pixel. Every fact on a grader is short — a chip, "All", "20%",
 * "0.80" — so the column that took the slack drew a lane of empty paper mid-
 * table, and the measures ended up pushed against the ⋮ lane far to its right.
 *
 * Personas can state five widths because the column it leaves out is
 * Description, which is prose and fills whatever it is given. This list has no
 * such column, so it states only the 260px name lane the boards give every list
 * and lets the five facts divide the rest between them in proportion to what
 * each one has to say.
 */
function activeColumns(
  mayAuthor: boolean,
  open: (grader: ProjectGrader) => void,
  remove: (grader: ProjectGrader) => void,
): readonly Column<ProjectGrader>[] {
  return [
    {
      key: "name",
      header: "Grader",
      primary: true,
      width: "260px",
      cell: (grader) => (
        <RowOpener
          name={graderDefinitionDisplayName(
            grader.graderDefinitionId,
            grader.name,
          )}
          onOpen={() => open(grader)}
        />
      ),
    },
    {
      key: "type",
      header: "Type",
      hideOnMobile: true,
      cell: (grader) => <GraderTypeChip type={grader.type} />,
    },
    {
      key: "modalities",
      header: "Modalities",
      hideOnMobile: true,
      cell: (grader) => (
        <GraderModalityChips modalities={grader.modalities} />
      ),
    },
    /*
     * **Two evidence sources, two columns.** They were one dot-joined sentence
     * — "All simulations · Production off" — which cannot be scanned down a
     * list: the eye has to read past the first half of every row to find the
     * second. Each has its own lane now, and each says one word where it can.
     */
    {
      key: "simulations",
      header: "Simulations",
      cell: (grader) => (
        <ScopeValue value={simulationScopeSummary(grader.scope)} />
      ),
    },
    {
      key: "production",
      header: "Production",
      cell: (grader) => (
        <ScopeValue value={productionScopeSummary(grader.scope)} />
      ),
    },
    {
      key: "threshold",
      header: "Pass threshold",
      cell: (grader) => <PassThreshold value={grader.passThreshold} />,
    },
    {
      key: "actions",
      header: "Row actions",
      action: true,
      cell: (grader) => {
        const name = graderDefinitionDisplayName(
          grader.graderDefinitionId,
          grader.name,
        );
        return (
          <RowMenu label={`Open the menu for ${name}`}>
            {(close) => (
              <>
                <MenuItem
                  onClick={() => {
                    close();
                    open(grader);
                  }}
                >
                  {/* A viewer's sheet is read-only, and the item says so. */}
                  {mayAuthor ? "Edit" : "View details"}
                </MenuItem>
                {/*
                 * **Only a grader this project may drop offers to be dropped.**
                 * Expected behaviors is not removable, so its menu is one item
                 * rather than one item and a refusal.
                 */}
                {grader.removable ? (
                  <>
                    <MenuDivider />
                    <DestructiveItem
                      disabled={!mayAuthor}
                      onClick={() => {
                        close();
                        remove(grader);
                      }}
                    >
                      Remove grader
                    </DestructiveItem>
                  </>
                ) : null}
              </>
            )}
          </RowMenu>
        );
      },
    },
  ];
}

function libraryColumns(
  mayAuthor: boolean,
  open: (entry: GraderLibraryEntry) => void,
  use: (entry: GraderLibraryEntry) => void,
  openActive: (projectGraderId: string) => void,
  activeGraderOf: (projectGraderId: string) => ProjectGrader | undefined,
  remove: (grader: ProjectGrader) => void,
): readonly Column<GraderLibraryEntry>[] {
  return [
    {
      key: "name",
      header: "Grader",
      primary: true,
      width: "260px",
      cell: (entry) => (
        <RowOpener
          name={graderDefinitionDisplayName(entry.id, entry.name)}
          onOpen={() => open(entry)}
        />
      ),
    },
    {
      key: "owner",
      header: "Owner",
      hideOnMobile: true,
      cell: (entry) => graderOwnerLabel(entry.owner),
    },
    {
      key: "type",
      header: "Type",
      hideOnMobile: true,
      cell: (entry) => <GraderTypeChip type={entry.type} />,
    },
    {
      key: "modalities",
      header: "Modalities",
      hideOnMobile: true,
      cell: (entry) => <GraderModalityChips modalities={entry.modalities} />,
    },
    {
      key: "status",
      header: "Project use",
      cell: (entry) => (
        <ProjectUseChip active={entry.activeProjectGraderId !== null} />
      ),
    },
    {
      key: "actions",
      header: "Row actions",
      action: true,
      cell: (entry) => {
        const name = graderDefinitionDisplayName(entry.id, entry.name);
        const activeId = entry.activeProjectGraderId;
        const active = activeId === null ? undefined : activeGraderOf(activeId);
        return (
          <RowMenu label={`Open the menu for ${name}`}>
            {(close) =>
              activeId === null ? (
                <MenuItem
                  disabled={!mayAuthor}
                  onClick={() => {
                    close();
                    use(entry);
                  }}
                >
                  Use in project
                </MenuItem>
              ) : (
                <>
                  <MenuItem
                    onClick={() => {
                      close();
                      openActive(activeId);
                    }}
                  >
                    View active grader
                  </MenuItem>
                  {/*
                   * The library row can drop the grader this project is
                   * running, and only when that grader is one the project may
                   * drop. Whether it is, is a fact about the active grader —
                   * the library entry does not carry it — so the row reads it
                   * off the active list beside it.
                   */}
                  {active !== undefined && active.removable ? (
                    <>
                      <MenuDivider />
                      <DestructiveItem
                        disabled={!mayAuthor}
                        onClick={() => {
                          close();
                          remove(active);
                        }}
                      >
                        Remove grader
                      </DestructiveItem>
                    </>
                  ) : null}
                </>
              )
            }
          </RowMenu>
        );
      },
    },
  ];
}

function ProjectGraders({ projectId }: { readonly projectId: string }) {
  const searchParams = useSearchParams();
  const linkedGraderId = searchParams.get("grader");
  const linkedDefinitionId = searchParams.get("graderDefinition");
  const linkedDefinitionVersionValue = Number(
    searchParams.get("definitionVersion"),
  );
  const linkedDefinitionVersion =
    linkedDefinitionId !== null &&
    Number.isSafeInteger(linkedDefinitionVersionValue) &&
    linkedDefinitionVersionValue > 0
      ? linkedDefinitionVersionValue
      : null;
  const { me } = useShellSession();
  const role = me === null ? null : roleOf(me);
  const mayAuthor = role !== null && canAuthor(role);
  const active = useProjectRead<ProjectGradersPage>(
    readAllProjectGraders,
    projectId,
  );
  const library = useProjectRead<GraderLibraryPage>(
    readAllGraderLibrary,
    projectId,
  );
  const [tab, setTab] = useState("active");
  const [creating, setCreating] = useState(false);
  const [libraryEntry, setLibraryEntry] = useState<GraderLibraryEntry | null>(
    null,
  );
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [libraryDefinitionVersion, setLibraryDefinitionVersion] = useState<
    number | undefined
  >(undefined);
  /** Which half of the library sheet its opener asked for. */
  const [libraryMode, setLibraryMode] = useState<"details" | "use">("details");
  const [activeGrader, setActiveGrader] = useState<ProjectGrader | null>(null);
  const [activeOpen, setActiveOpen] = useState(false);
  const [removing, setRemoving] = useState<ProjectGrader | null>(null);
  const [said, setSaid] = useState<string | null>(null);
  const openedLinkedGrader = useRef<string | null>(null);
  const openedLinkedDefinition = useRef<string | null>(null);

  useEffect(() => {
    if (
      active.answer?.status === "signed-out" ||
      library.answer?.status === "signed-out"
    ) {
      window.location.replace("/sign-in");
    }
  }, [active.answer, library.answer]);

  useEffect(() => {
    if (linkedDefinitionId !== null && linkedDefinitionVersion !== null) return;
    const key = linkedGraderId === null ? null : `${projectId}:${linkedGraderId}`;
    if (key === null || openedLinkedGrader.current === key) return;
    const answer = active.answer;
    if (answer?.status !== "ready") return;
    openedLinkedGrader.current = key;
    const grader = answer.value.graders.find((one) => one.id === linkedGraderId);
    if (grader === undefined) {
      setSaid("This grader definition is no longer active in this project.");
      return;
    }
    setTab("active");
    setActiveGrader(grader);
    setActiveOpen(true);
  }, [
    active.answer,
    linkedDefinitionId,
    linkedDefinitionVersion,
    linkedGraderId,
    projectId,
  ]);

  useEffect(() => {
    if (linkedDefinitionId === null || linkedDefinitionVersion === null) return;
    const key = `${projectId}:${linkedDefinitionId}:${String(linkedDefinitionVersion)}`;
    if (openedLinkedDefinition.current === key) return;
    const answer = library.answer;
    if (answer?.status !== "ready") return;
    openedLinkedDefinition.current = key;
    const entry = answer.value.graderLibraryEntries.find(
      (one) => one.id === linkedDefinitionId,
    );
    if (entry === undefined) {
      setSaid("This grader definition is no longer available.");
      return;
    }
    setTab("library");
    setLibraryEntry(entry);
    setLibraryDefinitionVersion(linkedDefinitionVersion);
    setLibraryMode("details");
    setLibraryOpen(true);
  }, [
    library.answer,
    linkedDefinitionId,
    linkedDefinitionVersion,
    projectId,
  ]);

  const whyNot =
    mayAuthor || role === null
      ? undefined
      : `Your ${String(role)} role can view graders but cannot change them.`;

  function refreshAll(message: string): void {
    setSaid(message);
    active.refresh();
    library.refresh();
  }

  function missingAction(): ReactNode {
    const elsewhere = me === null ? undefined : firstProjectOf(me);
    return elsewhere === undefined ? undefined : (
      <Button asChild variant="secondary">
        <Link href={projectLanding(elsewhere.id)}>Open {elsewhere.name}</Link>
      </Button>
    );
  }

  function openGrader(grader: ProjectGrader): void {
    setSaid(null);
    setActiveGrader(grader);
    setActiveOpen(true);
  }

  function openLibrary(
    entry: GraderLibraryEntry,
    mode: "details" | "use",
  ): void {
    setSaid(null);
    setLibraryEntry(entry);
    setLibraryDefinitionVersion(undefined);
    setLibraryMode(mode);
    setLibraryOpen(true);
  }

  /**
   * Which active grader a library entry is running as, when the list beside it
   * has been read. It answers one question the entry cannot: whether the
   * project may drop it.
   */
  function activeGraderOf(projectGraderId: string): ProjectGrader | undefined {
    const answer = active.answer;
    return answer?.status === "ready"
      ? answer.value.graders.find((one) => one.id === projectGraderId)
      : undefined;
  }

  /** The one destructive path, opened from a row menu in either list. */
  function askToRemove(grader: ProjectGrader): void {
    setSaid(null);
    setActiveOpen(false);
    setLibraryOpen(false);
    setRemoving(grader);
  }

  function activePanel(): ReactNode {
    const answer = active.answer;
    if (answer === null || answer.status === "signed-out") {
      return <Loading what="active graders" />;
    }
    if (answer.status === "missing") {
      return (
        <NotFound message={answer.refusal.message} action={missingAction()} />
      );
    }
    if (answer.status === "failed") {
      return <Failure message={answer.refusal.message} onRetry={active.reload} />;
    }
    if (answer.value.graders.length === 0) {
      return (
        <Empty
          title="No active graders"
          lead="Use a grader from the library, or ask an administrator to check why Expected behaviors is missing."
        />
      );
    }
    return (
      <DataTable
        label="Active graders"
        columns={activeColumns(mayAuthor, openGrader, askToRemove)}
        rows={answer.value.graders}
        keyOf={(grader) => grader.id}
        onRowActivate={openGrader}
        stackWhenConstrained
      />
    );
  }

  function libraryPanel(): ReactNode {
    const answer = library.answer;
    if (answer === null || answer.status === "signed-out") {
      return <Loading what="grader library" />;
    }
    if (answer.status === "missing") {
      return (
        <NotFound message={answer.refusal.message} action={missingAction()} />
      );
    }
    if (answer.status === "failed") {
      return <Failure message={answer.refusal.message} onRetry={library.reload} />;
    }
    if (answer.value.graderLibraryEntries.length === 0) {
      return (
        <Empty
          title="No graders in the library"
          lead="Create a custom grader for this organization."
        />
      );
    }
    return (
      <DataTable
        label="Grader library"
        columns={libraryColumns(
          mayAuthor,
          (entry) => openLibrary(entry, "details"),
          (entry) => openLibrary(entry, "use"),
          openActive,
          activeGraderOf,
          askToRemove,
        )}
        rows={answer.value.graderLibraryEntries}
        keyOf={(entry) => entry.id}
        onRowActivate={(entry) => openLibrary(entry, "details")}
        stackWhenConstrained
      />
    );
  }

  function openActive(projectGraderId: string): void {
    const grader = activeGraderOf(projectGraderId);
    setLibraryOpen(false);
    if (grader !== undefined) {
      openGrader(grader);
      return;
    }
    setSaid("This grader is active. Refresh Active graders to open its policy.");
    setTab("active");
    active.reload();
  }

  return (
    <ProductPage wide>
      <Tabs className="contents" value={tab} onValueChange={setTab}>
        <PageHeader
          title="Graders"
          toolbar={
            <TabsList variant="line" aria-label="Grader views">
              <TabsTrigger value="active">Active graders</TabsTrigger>
              <TabsTrigger value="library">Grader library</TabsTrigger>
            </TabsList>
          }
          action={
            role === null ? undefined : (
              <Button
                type="button"
                disabled={!mayAuthor}
                {...(whyNot === undefined ? {} : { why: whyNot })}
                onClick={() => {
                  setSaid(null);
                  setCreating(true);
                }}
              >
                Create custom grader
              </Button>
            )
          }
        />
        <PageBody>
          {said === null ? null : (
            /*
             * The notice stays until it is dismissed. No timer, on purpose: a
             * line that removes itself is gone before a person who looked away
             * could read it. The way out is the same dismiss control the
             * product's feedback banner uses, and one control serves all four
             * of this page's messages because refreshAll writes them all here.
             */
            <div className="mb-4 flex items-center justify-between gap-3">
              <p className="m-0 text-sm text-success" role="status">
                {said}
              </p>
              <button
                className={cn(
                  "grid size-(--control-sm) shrink-0 cursor-pointer place-items-center p-0",
                  "rounded-button border-0 bg-transparent text-muted-foreground",
                  "transition-transform duration-(--duration-press) ease-out",
                  "pointer-hover:bg-surface-soft pointer-hover:text-foreground",
                  "[&:active:not(:focus-visible)]:scale-97",
                  "motion-reduce:transition-none",
                  "motion-reduce:[&:active:not(:focus-visible)]:scale-100",
                )}
                type="button"
                aria-label={`Dismiss ${said}`}
                onClick={() => setSaid(null)}
              >
                <XIcon className="size-4" />
              </button>
            </div>
          )}
          <TabsContent value="active">{activePanel()}</TabsContent>
          <TabsContent value="library">{libraryPanel()}</TabsContent>
        </PageBody>
      </Tabs>

      <CreateCustomGraderSheet
        projectId={projectId}
        open={creating}
        onClose={() => setCreating(false)}
        onCreated={() => {
          setCreating(false);
          setTab("active");
          refreshAll("Custom grader created and added to Active graders.");
        }}
      />
      {libraryEntry === null ? null : (
        <LibraryGraderSheet
          key={`${libraryEntry.id}:${String(libraryDefinitionVersion ?? "current")}`}
          entry={libraryEntry}
          projectId={projectId}
          open={libraryOpen}
          mode={libraryMode}
          definitionVersion={libraryDefinitionVersion}
          mayAuthor={mayAuthor}
          onClose={() => setLibraryOpen(false)}
          onUsed={() => {
            setLibraryOpen(false);
            setTab("active");
            refreshAll("Grader added to Active graders.");
          }}
          onEditActive={openActive}
        />
      )}
      {activeGrader === null ? null : (
        <ActiveGraderSheet
          key={activeGrader.id}
          grader={activeGrader}
          projectId={projectId}
          open={activeOpen}
          mayAuthor={mayAuthor}
          onClose={() => setActiveOpen(false)}
          onSaved={() => {
            setActiveOpen(false);
            refreshAll("Grader changes saved.");
          }}
        />
      )}
      {removing === null ? null : (
        <RemoveGraderDialog
          grader={removing}
          projectId={projectId}
          onClose={() => setRemoving(null)}
          onRemoved={() => {
            setRemoving(null);
            refreshAll("Grader removed from Active graders.");
          }}
        />
      )}
    </ProductPage>
  );
}

function RemoveGraderDialog({
  grader,
  projectId,
  onClose,
  onRemoved,
}: {
  readonly grader: ProjectGrader;
  readonly projectId: string;
  readonly onClose: () => void;
  readonly onRemoved: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [refused, setRefused] = useState<Refusal | null>(null);

  async function remove(): Promise<void> {
    if (busy) return;
    setBusy(true);
    setRefused(null);
    const answer = await platformAnswer(
      removeGrader(
        { graderId: grader.id, projectId },
        { client: platformClient },
      ),
    );
    setBusy(false);
    if (answer.status === "signed-out") {
      window.location.replace("/sign-in");
      return;
    }
    if (answer.status !== "ready") {
      setRefused(answer.refusal);
      return;
    }
    onRemoved();
  }

  return (
    <Dialog
      title={`Remove ${graderDefinitionDisplayName(
        grader.graderDefinitionId,
        grader.name,
      )}?`}
      onClose={onClose}
    >
      {(dismiss) => (
        <>
          <p className="m-0 text-sm leading-(--line-normal) text-muted-foreground">
            This removes the grader from Active graders. Its definition stays in
            the Grader library, and earlier grades stay unchanged.
          </p>
          {refused === null ? null : <Refused message={refused.message} />}
          <div className="flex flex-wrap items-center gap-3">
            <Button
              type="button"
              size="lg"
              variant="destructive"
              busy={busy}
              onClick={() => void remove()}
            >
              {busy ? "Removing…" : "Remove grader"}
            </Button>
            <Button
              type="button"
              size="lg"
              variant="secondary"
              disabled={busy}
              onClick={() => dismiss()}
            >
              Cancel
            </Button>
          </div>
        </>
      )}
    </Dialog>
  );
}
