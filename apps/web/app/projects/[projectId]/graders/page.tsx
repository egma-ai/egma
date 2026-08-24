"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
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
import type { Answer, Refusal } from "../../../../lib/api.ts";
import {
  graderDefinitionDisplayName,
  graderModalitiesLabel,
  graderOwnerLabel,
  graderTypeLabel,
  scopeSummary,
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
import { MenuItem } from "../../../../ui/menu.tsx";
import {
  Empty,
  Failure,
  Loading,
  NotFound,
} from "../../../../ui/page-state.tsx";
import { useProjectRead } from "../../../../ui/resource.ts";
import { RowMenu } from "../../../../ui/row-menu.tsx";
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
  LibraryGraderSheet,
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

function activeColumns(
  mayAuthor: boolean,
  open: (grader: ProjectGrader) => void,
): readonly Column<ProjectGrader>[] {
  return [
    {
      key: "name",
      header: "Grader",
      primary: true,
      width: "240px",
      cell: (grader) =>
        graderDefinitionDisplayName(grader.graderDefinitionId, grader.name),
    },
    {
      key: "owner",
      header: "Owner",
      width: "120px",
      hideOnMobile: true,
      cell: (grader) => graderOwnerLabel(grader.owner),
    },
    {
      key: "type",
      header: "Type",
      width: "140px",
      hideOnMobile: true,
      cell: (grader) => graderTypeLabel(grader.type),
    },
    {
      key: "scope",
      header: "Scope",
      cell: (grader) => scopeSummary(grader.scope),
    },
    {
      key: "threshold",
      header: "Pass threshold",
      width: "150px",
      mono: true,
      cell: (grader) => grader.passThreshold.toFixed(2),
    },
    {
      key: "action",
      header: "Actions",
      action: true,
      cell: (grader) => (
        <RowMenu
          label={`Open the menu for ${graderDefinitionDisplayName(
            grader.graderDefinitionId,
            grader.name,
          )}`}
        >
          {(close) => (
            <MenuItem
              onClick={() => {
                close();
                open(grader);
              }}
            >
              {mayAuthor ? "View and edit" : "View details"}
            </MenuItem>
          )}
        </RowMenu>
      ),
    },
  ];
}

function libraryColumns(
  open: (entry: GraderLibraryEntry) => void,
): readonly Column<GraderLibraryEntry>[] {
  return [
    {
      key: "name",
      header: "Grader",
      primary: true,
      width: "260px",
      cell: (entry) => graderDefinitionDisplayName(entry.id, entry.name),
    },
    {
      key: "owner",
      header: "Owner",
      width: "120px",
      hideOnMobile: true,
      cell: (entry) => graderOwnerLabel(entry.owner),
    },
    {
      key: "type",
      header: "Type",
      width: "140px",
      hideOnMobile: true,
      cell: (entry) => graderTypeLabel(entry.type),
    },
    {
      key: "modalities",
      header: "Modalities",
      width: "150px",
      hideOnMobile: true,
      cell: (entry) => graderModalitiesLabel(entry.modalities),
    },
    {
      key: "status",
      header: "Project use",
      cell: (entry) =>
        entry.activeProjectGraderId === null ? "Available" : "Active",
    },
    {
      key: "action",
      header: "Actions",
      action: true,
      cell: (entry) => (
        <RowMenu
          label={`Open the menu for ${graderDefinitionDisplayName(
            entry.id,
            entry.name,
          )}`}
        >
          {(close) => (
            <MenuItem
              onClick={() => {
                close();
                open(entry);
              }}
            >
              View details
            </MenuItem>
          )}
        </RowMenu>
      ),
    },
  ];
}

function ProjectGraders({ projectId }: { readonly projectId: string }) {
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
  const [activeGrader, setActiveGrader] = useState<ProjectGrader | null>(null);
  const [activeOpen, setActiveOpen] = useState(false);
  const [removing, setRemoving] = useState<ProjectGrader | null>(null);
  const [said, setSaid] = useState<string | null>(null);

  useEffect(() => {
    if (
      active.answer?.status === "signed-out" ||
      library.answer?.status === "signed-out"
    ) {
      window.location.replace("/sign-in");
    }
  }, [active.answer, library.answer]);

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
        columns={activeColumns(mayAuthor, (grader) => {
          setSaid(null);
          setActiveGrader(grader);
          setActiveOpen(true);
        })}
        rows={answer.value.graders}
        keyOf={(grader) => grader.id}
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
        columns={libraryColumns((entry) => {
          setSaid(null);
          setLibraryEntry(entry);
          setLibraryOpen(true);
        })}
        rows={answer.value.graderLibraryEntries}
        keyOf={(entry) => entry.id}
        stackWhenConstrained
      />
    );
  }

  function openActive(projectGraderId: string): void {
    const answer = active.answer;
    const grader =
      answer?.status === "ready"
        ? answer.value.graders.find((one) => one.id === projectGraderId)
        : undefined;
    setLibraryOpen(false);
    if (grader !== undefined) {
      setActiveGrader(grader);
      setActiveOpen(true);
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
            <p className="m-0 mb-4 text-sm text-success" role="status">
              {said}
            </p>
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
          key={libraryEntry.id}
          entry={libraryEntry}
          projectId={projectId}
          open={libraryOpen}
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
          onRemove={() => {
            setRemoving(activeGrader);
            setActiveOpen(false);
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
