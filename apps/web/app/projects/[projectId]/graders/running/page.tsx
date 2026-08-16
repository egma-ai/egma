"use client";

import { useParams } from "next/navigation";
import { useState } from "react";

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
  GRADER_LIBRARY_PATH,
  GRADERS_PATH,
  GRADERS_SECTION,
  type GraderParameter,
  type LibraryPage,
  type RunningGrader,
  type RunningPage,
} from "../../../../../lib/graders.ts";
import { firstProjectOf, roleOf } from "../../../../../lib/me.ts";
import {
  projectLanding,
  projectPath,
} from "../../../../../lib/project-context.ts";
import { canAuthor } from "../../../../../lib/roles.ts";
import {
  Badge,
  Button,
  ButtonLink,
  Section,
} from "../../../../../ui/controls.tsx";
import { DataTable, type Column } from "../../../../../ui/data-table.tsx";
import { Dialog } from "../../../../../ui/dialog.tsx";
import {
  Empty,
  Failure,
  Loading,
  NotFound,
} from "../../../../../ui/page-state.tsx";
import { useProjectRead } from "../../../../../ui/resource.ts";
import {
  AppShell,
  PageBody,
  PageHeader,
  ProductPage,
  useShellSession,
} from "../../../../../ui/shell.tsx";
import { GraderTabs } from "../tabs.tsx";
import { EditForm, SwitchOffPanel } from "./edit-form.tsx";

/**
 * The running graders of one project: the copies it is actually judged by.
 *
 * **The sibling of the library screen, and the difference between them is the
 * whole redesign.** The shelf holds definitions nobody is judging with; this
 * holds the copies that are. Every row here points back at an entry over there,
 * and the definition — the judge prompt, the words a model is sent — is read
 * through that pointer at judging time rather than shown here, because it lives
 * in exactly one place and this screen is not it.
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
  const assertions = copy.config?.assertions;
  if (!Array.isArray(assertions) || assertions.length === 0) {
    return CONFIG.fromTheTest;
  }
  return CONFIG.counted(assertions.length);
}

/** Which copy has a panel open, and which of the two acts it is. */
type Open =
  | { readonly act: "edit"; readonly copy: RunningGrader }
  | { readonly act: "switch-off"; readonly copy: RunningGrader }
  | null;

/**
 * The columns, in the order they are shown, each beside what fills it.
 *
 * The order is a judgement about scanning: which grader this is, then where it
 * applies, then whether it can fail a run, then what it judges because it is
 * the widest, and the acts last where a reader's eye ends up.
 */
function columnsFor(
  open: (what: Open) => void,
  mayAct: boolean,
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
      cell: (copy) => copy.name,
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
            {scopeOf(copy)} · {String(copy.production_sample_rate)}%
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
          <Badge tone="warn">{REQUIRED.no}</Badge>
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
      width: "200px",
      cell: (copy) => (
        <>
          <Button
            disabled={!mayAct}
            {...(mayAct || whyNotEdit === undefined ? {} : { why: whyNotEdit })}
            onClick={() => open({ act: "edit", copy })}
          >
            {EDIT.open}
          </Button>{" "}
          <Button
            disabled={!mayAct}
            {...(mayAct || whyNotSwitchOff === undefined
              ? {}
              : { why: whyNotSwitchOff })}
            onClick={() => open({ act: "switch-off", copy })}
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
    GRADERS_PATH,
    projectId,
  );
  const { answer: shelf } = useProjectRead<LibraryPage>(
    GRADER_LIBRARY_PATH,
    projectId,
  );

  /** Which copy has a panel open, and nothing while none has. */
  const [open, setOpen] = useState<Open>(null);
  /** What the last act came to, kept until the list is asked again. */
  const [said, setSaid] = useState<string | null>(null);

  const mayAct = role !== null && canAuthor(role);
  const whyNotEdit = role === null ? undefined : EDIT.notYours(role);
  const whyNotSwitchOff = role === null ? undefined : SWITCH_OFF.notYours(role);

  const rows = answer?.status === "ready" ? answer.value.items : [];

  /**
   * What each entry asks for, by the entry's own id.
   *
   * Empty until the shelf lands, which is why the acts wait on it: a form drawn
   * from an empty list is a form that asks nothing, and one grader on this
   * screen genuinely asks nothing.
   */
  const asks = new Map<string, readonly GraderParameter[]>(
    shelf?.status === "ready"
      ? shelf.value.items.map((entry) => [entry.id, entry.params ?? []] as const)
      : [],
  );

  function settled(sentence: string): void {
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
              <ButtonLink href={projectLanding(elsewhere.id)}>
                Open {elsewhere.name}
              </ButtonLink>
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
            <ButtonLink
              href={projectPath(projectId, GRADERS_SECTION)}
              weight="strong"
            >
              Open the library
            </ButtonLink>
          }
        />
      );
    }

    return (
      <DataTable
        label="The graders running in this project"
        columns={columnsFor(setOpen, mayAct, whyNotEdit, whyNotSwitchOff)}
        rows={rows}
        keyOf={(copy) => copy.id}
      />
    );
  }

  return (
    <ProductPage>
      <PageHeader eyebrow="Project" title={RUNNING.title} lead={RUNNING.lead} />
      <PageBody>
        <GraderTabs projectId={projectId} active="running" />

        {/*
          What the last act came to, and it stays until the next one. Both
          sentences say what changed *and* what did not, because the question
          somebody has after saving a tighter bound or switching a grader off is
          always about the runs they have already read.
        */}
        {said === null ? null : <p role="status">{said}</p>}

        {/*
          The edit form, opened on one copy at a time and keyed by it — the Use
          form's rule, for the Use form's reason. The form's state is *this*
          copy's answers, and React keeps a component's state across a re-render
          when only its props change, so opening a second row's form over the
          first would draw the second grader's controls over the first grader's
          values.
        */}
        {open?.act === "edit" ? (
          <Section title={EDIT.title(open.copy.name)}>
            <EditForm
              key={open.copy.id}
              copy={open.copy}
              params={asks.get(open.copy.library_id) ?? []}
              projectId={projectId}
              onCancel={() => setOpen(null)}
              onSaved={(name) => settled(EDIT.saved(name))}
            />
          </Section>
        ) : null}

        {body()}

        {/*
          Switching off asks first, because it is the one act here that cannot
          be undone in place: pressing Use again makes a new copy rather than
          bringing this one back.
        */}
        {open?.act === "switch-off" ? (
          <Dialog
            title={SWITCH_OFF.title(open.copy.name)}
            onClose={() => setOpen(null)}
          >
            {(dismiss) => (
              <SwitchOffPanel
                key={open.copy.id}
                copy={open.copy}
                projectId={projectId}
                theLastOne={rows.length === 1}
                onCancel={dismiss}
                onSwitchedOff={(name) => settled(SWITCH_OFF.done(name))}
              />
            )}
          </Dialog>
        ) : null}
      </PageBody>
    </ProductPage>
  );
}
