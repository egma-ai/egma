"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import {
  listGraderLibrary,
  listGraders,
} from "@egma/platform-api/client";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  CONFIG,
  EDIT,
  NOTHING,
  REQUIRED,
  RUNNING,
  RUNNING_COLUMNS,
  SCOPES,
  SWITCH_OFF,
} from "../../../../../lib/grader-running-copy.ts";
import {
  assertionsOf,
  GRADERS_SECTION,
  parametersOf,
  type GraderParameter,
  type LibraryPage,
  type RunningGrader,
  type RunningPage,
} from "../../../../../lib/graders.ts";
import { firstProjectOf, roleOf } from "../../../../../lib/me.ts";
import {
  platformAnswer,
  platformClient,
} from "../../../../../lib/platform-client.ts";
import {
  graderDisplayName,
  GRADER_VIEW_LABELS,
} from "../../../../../lib/presentation.ts";
import {
  projectLanding,
  projectPath,
} from "../../../../../lib/project-context.ts";
import { canAuthor } from "../../../../../lib/roles.ts";
import { DataTable, type Column } from "../../../../../ui/data-table.tsx";
import { Dialog } from "../../../../../ui/dialog.tsx";
import { useDraftNavigation } from "../../../../../ui/draft-navigation.tsx";
import {
  Empty,
  Failure,
  Loading,
  NotFound,
} from "../../../../../ui/page-state.tsx";
import { useProjectRead } from "../../../../../ui/resource.ts";
import { useUnsavedChanges } from "../../../../../ui/settings-read.ts";
import {
  AppShell,
  PageBody,
  PageHeader,
  ProductPage,
  useShellSession,
} from "../../../../../ui/shell.tsx";
import { GraderTabs, VIEW_CONTENT } from "../tabs.tsx";
import { EditForm, SwitchOffPanel } from "./edit-form.tsx";

/**
 * The running graders of one project: the copies it is actually judged by.
 *
 * **The sibling of the library screen, and the difference between them is the
 * whole redesign.** The shelf holds definitions nobody is judging with; this
 * holds the copies that are. Every row here points back at an entry over there.
 * Its grader version pins one immutable shared definition revision — the exact
 * prompt or code that a run executes. This screen does not repeat that
 * definition; the library screen shows the current revision.
 *
 * **Two acts, and they are the ones the shelf cannot do.** Pressing Use over
 * there makes a copy; changing what that copy judges by and switching it off
 * are decisions about a grader that already exists, so they belong here. Before
 * they did, a bound typed too tight was permanent — every run red for ever,
 * with no way back short of somebody editing the database by hand. And there is
 * still nothing to *enable*: a copy that exists judges, and switching it off is
 * deleting the row that was doing the judging. That is the same sentence the
 * start-up backfill is built around — it asks whether a project has *ever* held
 * a copy, switched-off rows included, so a container restarting cannot overrule
 * somebody's decision every morning.
 *
 * **The edit form is drawn from the library entry, not from this page**, which
 * is why this screen reads the shelf beside the copies and hands each copy its
 * own entry's parameters. There is no measure name and no bound anywhere in
 * this file: a form written per grader would be a second copy of the platform's
 * declaration, drifting the first time one changed.
 *
 * **Both reads have to land before a row can be edited**, which is why they are
 * one state here rather than two. A page holding the copies and not yet their
 * entries would draw an edit form with no controls in it, and that reads as a
 * grader asking for nothing rather than as a page still loading.
 *
 * **An empty list is a real state and this page never hides it.** Every project
 * is created holding a copy of the expected-behaviors grader, so an empty list
 * means somebody switched it off — and a run in that project still happens, and
 * comes back with nothing judged. The run door agrees: it stopped demanding a
 * judge for a project whose graders do not ask a model, because a copy that can
 * be switched off cannot also be a thing every run is assumed to carry.
 *
 * **It reads the first page and stops there**, which is honest for a list that
 * starts at one row and grows by however many graders a team switches on. The
 * day a project has more graders than a page is the day it grows the button,
 * and the answer already carries what that needs.
 */
export default function RunningGradersPage() {
  const { projectId } = useParams<{ projectId: string }>();
  return (
    <AppShell>
      <RunningGraders projectId={projectId} />
    </AppShell>
  );
}

/**
 * The stored word turned into the one a person reads — and left alone when it
 * is a word this page has never heard of.
 *
 * A platform newer than the page reading it is an ordinary thing on a
 * self-hosted product, and an unfamiliar word is a better answer than a blank
 * cell: one says "this is something you have not met", the other says "this row
 * has nothing in it".
 */
function scopeOf(copy: RunningGrader): string {
  return SCOPES[copy.scope] ?? copy.scope;
}

/**
 * What this copy checks, in one cell.
 *
 * **No filled-in values is a complete answer here.** A grader whose assertions
 * are the test's own expected behaviors has nothing for anybody to type, so the
 * cell says what it judges instead of showing a zero — a count of nought would
 * read as a grader somebody forgot to finish.
 */
function configOf(copy: RunningGrader): string {
  const assertions = assertionsOf(copy);
  if (assertions.length === 0) {
    return CONFIG.fromTheTest;
  }
  return CONFIG.counted(assertions.length);
}

/** Which copy has a panel open, and which of the two acts it is. */
type Open =
  | { readonly act: "edit"; readonly copy: RunningGrader }
  | { readonly act: "switch-off"; readonly copy: RunningGrader }
  | null;

/** The stable relationship between a row's Edit button and its editor. */
function editorPanelId(copyId: string): string {
  return `grader-editor-${copyId}`;
}

/**
 * The columns, in the order they are shown, each beside what fills it.
 *
 * The order is a judgement about scanning: which grader this is, then where it
 * applies, then whether it can fail a run, then what it judges because it is
 * the widest, and the acts last where a reader's eye ends up.
 */
function columnsFor(
  show: (what: Open) => void,
  open: Open,
  mayAct: boolean,
  editorBusy: boolean,
  editButtons: Map<string, HTMLButtonElement>,
  /**
   * Why it is not theirs — and nothing at all while egma has not identified
   * them yet, on the library screen's terms and for its reason: a sentence
   * about an unsettled session is a claim about somebody nobody has read.
   */
  whyNotEdit: string | undefined,
  whyNotSwitchOff: string | undefined,
): readonly Column<RunningGrader>[] {
  return [
    {
      key: "name",
      header: RUNNING_COLUMNS.name,
      primary: true,
      cell: (copy) => graderDisplayName(copy.name),
    },
    {
      key: "scope",
      header: RUNNING_COLUMNS.scope,
      width: "170px",
      cell: (copy) =>
        copy.scope === "simulations" ? (
          scopeOf(copy)
        ) : (
          // Live traffic is sampled, and the share decides what a project pays
          // for. A scope cell that said only "live traffic" would leave the one
          // number that matters on a screen nobody has built.
          <span>
            {scopeOf(copy)} · {String(copy.productionSampleRate)}%
          </span>
        ),
    },
    {
      key: "required",
      header: RUNNING_COLUMNS.required,
      width: "130px",
      cell: (copy) =>
        copy.required ? (
          <Badge>{REQUIRED.yes}</Badge>
        ) : (
          <Badge variant="warning">{REQUIRED.no}</Badge>
        ),
    },
    {
      key: "config",
      header: RUNNING_COLUMNS.config,
      hideOnMobile: true,
      cell: (copy) => (copy.config === null ? NOTHING : configOf(copy)),
    },
    {
      key: "acts",
      header: RUNNING_COLUMNS.actions,
      /*
       * A row control, said to the table rather than only drawn like one.
       *
       * The shared table keeps an `action` cell at the trailing edge and lets
       * it out of the one-line ellipsis every other cell gets. That second
       * half is why this is here: the ellipsis comes from `overflow: hidden`
       * on the cell, and an outline is clipped by an ancestor's overflow, so a
       * control in an unmarked cell had the Ember focus ring cut off on every
       * side. Other row controls were already marked; these were the same
       * concept drawn two ways.
       */
      action: true,
      width: "200px",
      cell: (copy) => (
        <>
          <Button
            type="button"
            variant="secondary"
            disabled={!mayAct || editorBusy}
            {...(mayAct || whyNotEdit === undefined ? {} : { why: whyNotEdit })}
            aria-expanded={open?.act === "edit" && open.copy.id === copy.id}
            aria-controls={editorPanelId(copy.id)}
            ref={(button) => {
              if (button === null) editButtons.delete(copy.id);
              else editButtons.set(copy.id, button);
            }}
            onClick={() => show({ act: "edit", copy })}
          >
            {EDIT.open}
          </Button>{" "}
          {/*
            **The one destructive act on this row, as a text action in the
            failure colour.** `DESIGN.md`: the control that opens a destructive
            confirmation is text, and the filled failure-coloured button lives
            inside the confirmation it opens. Two outlined buttons side by side
            said that switching a grader off and editing it were the same size
            of decision.
          */}
          <Button
            type="button"
            variant="ghost"
            className="text-failure pointer-hover:text-failure"
            disabled={!mayAct || editorBusy}
            {...(mayAct || whyNotSwitchOff === undefined
              ? {}
              : { why: whyNotSwitchOff })}
            onClick={() => show({ act: "switch-off", copy })}
          >
            {SWITCH_OFF.open}
          </Button>
        </>
      ),
    },
  ];
}

function RunningGraders({ projectId }: { readonly projectId: string }) {
  const { me } = useShellSession();
  // Null until the session read answers. A page that guessed would tell an
  // admin their role cannot do something it can, on every load.
  const role = me === null ? null : roleOf(me);

  const { answer, reload } = useProjectRead<RunningPage>(
    (projectId) =>
      platformAnswer(listGraders({ projectId }, { client: platformClient })),
    projectId,
  );
  const { answer: shelf } = useProjectRead<LibraryPage>(
    (projectId) =>
      platformAnswer(
        listGraderLibrary({ projectId }, { client: platformClient }),
      ),
    projectId,
  );

  /** Which copy has a panel open, and nothing while none has. */
  const [open, setOpen] = useState<Open>(null);
  /** What the open editor would lose if another act replaced it now. */
  const [editorState, setEditorState] = useState({
    atRisk: false,
    busy: false,
  });
  /** What the last act came to, kept until the list is asked again. */
  const [said, setSaid] = useState<string | null>(null);
  const editorHeading = useRef<HTMLHeadingElement>(null);
  const editButtons = useRef(new Map<string, HTMLButtonElement>());
  const returnFocusTo = useRef<string | null>(null);
  const draftNavigation = useDraftNavigation();

  useUnsavedChanges(editorState.atRisk, editorState.busy);

  // The panel appears beside the table on wide screens and before it on a
  // narrow one. Put the reading position on its heading in either layout, so
  // opening Edit never leaves a keyboard or screen reader back in the row.
  useEffect(() => {
    if (open?.act === "edit") {
      editorHeading.current?.focus();
      return;
    }

    const copyId = returnFocusTo.current;
    if (copyId === null) return;
    returnFocusTo.current = null;
    editButtons.current.get(copyId)?.focus();
  }, [open]);

  const mayAct = role !== null && canAuthor(role);
  const whyNotEdit = role === null ? undefined : EDIT.notYours(role);
  const whyNotSwitchOff = role === null ? undefined : SWITCH_OFF.notYours(role);

  const rows = answer?.status === "ready" ? answer.value.graders : [];

  /**
   * What each entry asks for, by the entry's own id.
   *
   * Empty until the shelf lands, which is why the acts wait on it: a form drawn
   * from an empty list is a form that asks nothing, and one grader on this
   * screen genuinely asks nothing.
   */
  const asks = new Map<string, readonly GraderParameter[]>(
    shelf?.status === "ready"
      ? shelf.value.graderLibraryEntries.map(
          (entry) => [entry.id, parametersOf(entry)] as const,
        )
      : [],
  );

  /**
   * Replace the open act without silently throwing an editor away.
   *
   * The shared draft guard already owns links, project changes, reload and tab
   * close. These row buttons are not navigation, so they ask here before they
   * replace the editor with another grader or with the switch-off dialog.
   */
  function show(next: Open): void {
    const sameEditor =
      open?.act === "edit" &&
      next?.act === "edit" &&
      open.copy.id === next.copy.id;

    if (sameEditor) {
      editorHeading.current?.focus();
      return;
    }

    // A row cannot replace an editor while its write is in flight. Its action
    // buttons are disabled too; this guard keeps programmatic callers honest.
    if (open?.act === "edit" && editorState.busy) return;

    const replaceOpen = () => {
      if (open?.act === "edit" && next === null) {
        returnFocusTo.current = open.copy.id;
      }
      setEditorState({ atRisk: false, busy: false });
      setOpen(next);
    };

    if (open?.act === "edit" && editorState.atRisk) {
      draftNavigation.request(replaceOpen);
      return;
    }

    replaceOpen();
  }

  function settled(sentence: string): void {
    setEditorState({ atRisk: false, busy: false });
    setOpen(null);
    setSaid(sentence);
    // Read the list again rather than editing this page's copy of it. What is
    // judging this project is the server's answer, and a page that patched its
    // own rows would be a second opinion about it the moment two people are
    // looking.
    reload();
  }

  function body() {
    if (
      answer === null ||
      shelf === null ||
      answer.status === "signed-out" ||
      shelf.status === "signed-out"
    ) {
      return <Loading what={RUNNING.loading} />;
    }

    // Either read answering "not here" is the same absence: both name the
    // project in the address, and neither can be read in a project that is not
    // this person's. The refusal's own sentence is shown rather than a second
    // one written here.
    const missing =
      answer.status === "missing"
        ? answer.refusal
        : shelf.status === "missing"
          ? shelf.refusal
          : undefined;

    if (missing !== undefined) {
      const elsewhere = me === null ? undefined : firstProjectOf(me);
      return (
        <NotFound
          message={missing.message}
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

    const failed =
      answer.status === "failed"
        ? answer.refusal
        : shelf.status === "failed"
          ? shelf.refusal
          : undefined;

    if (failed !== undefined) {
      return <Failure message={failed.message} onRetry={reload} />;
    }

    if (rows.length === 0) {
      return (
        <Empty
          title="Nothing is judging this project"
          lead={RUNNING.empty}
          action={
            <Button asChild>
              <Link href={projectPath(projectId, GRADERS_SECTION)}>
                Open the library
              </Link>
            </Button>
          }
        />
      );
    }

    return (
      <DataTable
        label="The graders running in this project"
        columns={columnsFor(
          show,
          open,
          mayAct,
          editorState.busy,
          editButtons.current,
          whyNotEdit,
          whyNotSwitchOff,
        )}
        rows={rows}
        keyOf={(copy) => copy.id}
      />
    );
  }

  return (
    <ProductPage wide>
      {/* The trail and the title, and the strip under them. See the library. */}
      <PageHeader
        title={RUNNING.title}
        breadcrumbs={[
          {
            label: "Graders",
            href: projectPath(projectId, GRADERS_SECTION),
          },
          { label: GRADER_VIEW_LABELS.running },
        ]}
      />
      <PageBody>
        {/*
          **Add grader opens the library, because adopting an entry is the only
          way a grader starts.** There is no create-a-grader flow in this
          product and this button does not pretend there is one: a grader is a
          copy of a library entry, made by pressing Use on the entry itself, and
          the Use form is drawn from the entry it is opened on — so there is no
          entry-less form for a page-level button to open. It takes somebody to
          the shelf where the Use affordance is, which is the same journey this
          screen's empty state has always offered, now offered before the screen
          is empty as well.

          It is on this screen and not the library's. There, the same button
          would link to the page it is already on, and a control that does
          nothing is worse than no control.
        */}
        <GraderTabs
          projectId={projectId}
          active="running"
          action={
            <Button asChild>
              <Link href={projectPath(projectId, GRADERS_SECTION)}>
                Add grader
              </Link>
            </Button>
          }
        />
        <div className={VIEW_CONTENT}>
          {/*
            What the last act came to, and it stays until the next one. Both
            sentences say what changed *and* what did not, because the question
            somebody has after saving a tighter bound or switching a grader off is
            always about the runs they have already read.
          */}
          {said === null ? null : <p role="status">{said}</p>}

          {/*
            One column while nothing is open, two while an editor is.

            The 230px shell leaves about 1170px of work area at a 1400px
            viewport, and below that the five-column table and the 440px editor
            are both cramped — so the editor goes above the list rather than
            beside it. The width that decides is the whole product frame rather
            than a phone.
          */}
          <div
            className={
              "min-w-0 " +
              "data-[editing=true]:grid data-[editing=true]:items-start " +
              "data-[editing=true]:gap-6 " +
              "data-[editing=true]:grid-cols-[minmax(0,1fr)_minmax(360px,440px)] " +
              "max-[1400px]:data-[editing=true]:grid-cols-[minmax(0,1fr)]"
            }
            data-editing={open?.act === "edit" ? "true" : "false"}
          >
            {/*
              The editor comes first in the document because it comes first on
              a narrow screen. The wide layout places it in the second column,
              while this shared order keeps reading and focus aligned on mobile.
              It is keyed by the running copy, so one copy's values cannot sit
              under another copy's fields.
            */}
            {open?.act === "edit" ? (
              <section
                id={editorPanelId(open.copy.id)}
                className={
                  "sticky top-6 col-start-2 row-start-1 min-w-0 " +
                  "border-l border-border pl-6 " +
                  "max-[1400px]:static max-[1400px]:col-start-1 " +
                  "max-[1400px]:row-auto max-[1400px]:border-l-0 " +
                  "max-[1400px]:border-b max-[1400px]:pt-0 max-[1400px]:pr-0 " +
                  "max-[1400px]:pb-5 max-[1400px]:pl-0"
                }
                aria-labelledby={`${editorPanelId(open.copy.id)}-title`}
              >
                <header className="mb-4">
                  <h2
                    ref={editorHeading}
                    className="m-0 text-lg font-medium text-foreground"
                    id={`${editorPanelId(open.copy.id)}-title`}
                    tabIndex={-1}
                  >
                    {EDIT.title(graderDisplayName(open.copy.name))}
                  </h2>
                </header>
                <EditForm
                  key={open.copy.id}
                  copy={open.copy}
                  params={asks.get(open.copy.libraryId) ?? []}
                  projectId={projectId}
                  onProtectionChange={setEditorState}
                  onCancel={() => show(null)}
                  onSaved={(name) =>
                    settled(EDIT.saved(graderDisplayName(name)))
                  }
                />
              </section>
            ) : null}

            <div
              className={
                "min-w-0 in-data-[editing=true]:col-start-1 " +
                "in-data-[editing=true]:row-start-1 " +
                "max-[1400px]:in-data-[editing=true]:row-auto"
              }
            >
              {body()}
            </div>
          </div>

          {/*
            Switching off asks first, because it is the one act here that cannot
            be undone in place: pressing Use again makes a new copy rather than
            bringing this one back.
          */}
          {open?.act === "switch-off" ? (
            <Dialog
              title={SWITCH_OFF.title(graderDisplayName(open.copy.name))}
              onClose={() => show(null)}
            >
              {(dismiss) => (
                <SwitchOffPanel
                  key={open.copy.id}
                  copy={open.copy}
                  projectId={projectId}
                  theLastOne={rows.length === 1}
                  onCancel={dismiss}
                  onSwitchedOff={(name) =>
                    settled(SWITCH_OFF.done(graderDisplayName(name)))
                  }
                />
              )}
            </Dialog>
          ) : null}
        </div>
      </PageBody>
    </ProductPage>
  );
}
