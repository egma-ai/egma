"use client";

import { useParams } from "next/navigation";
import { useState } from "react";

import { deleteJson, type Refusal } from "../../../../../lib/api.ts";
import {
  CONFIG,
  NOTHING,
  REMOVE,
  REQUIRED,
  RUNNING,
  RUNNING_COLUMNS,
  SCOPES,
} from "../../../../../lib/grader-running-copy.ts";
import {
  graderPath,
  GRADERS_PATH,
  GRADERS_SECTION,
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
  Actions,
  Badge,
  Button,
  ButtonLink,
  Refused,
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
 * **One act, and it is Delete.** There is nothing to author here, because the
 * act that makes a row is pressing Use on the shelf. There is nothing to switch
 * off either, because there is no switch: a copy that exists judges, and
 * deleting it is how a project stops being judged by it. That is the same
 * sentence the start-up backfill is built around — it asks whether a project
 * has *ever* held a copy, deleted rows included, so that a container restarting
 * cannot overrule somebody's decision every morning.
 *
 * **An empty list is a real state and this page never hides it.** Every project
 * is created holding a copy of the expected-behaviors grader, so an empty list
 * means somebody deleted it — and a run in that project still happens, and
 * comes back with nothing judged. The run door agrees: it stopped demanding a
 * judge for a project whose graders do not ask a model, because a copy that is
 * deletable cannot also be a thing every run is assumed to carry.
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

/**
 * The columns, in the order they are shown, each beside what fills it.
 *
 * The order is a judgement about scanning: which grader this is, then where it
 * applies, then whether it can fail a run, then what it judges because it is
 * the widest, and the act last where a reader's eye ends up.
 */
function columnsFor(
  remove: (copy: RunningGrader) => void,
  mayRemove: boolean,
  /**
   * Why it is not theirs — and nothing at all while egma has not identified
   * them yet, on the library screen's terms and for its reason: a sentence
   * about an unsettled session is a claim about somebody nobody has read.
   */
  whyNot: string | undefined,
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
      cell: (copy) => (copy.config === null ? NOTHING : configOf(copy)),
    },
    {
      key: "delete",
      header: "",
      width: "110px",
      cell: (copy) => (
        <Button
          disabled={!mayRemove}
          {...(mayRemove || whyNot === undefined ? {} : { why: whyNot })}
          onClick={() => remove(copy)}
        >
          {REMOVE.open}
        </Button>
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

  /** The copy whose confirmation is open, and nothing while none is. */
  const [removing, setRemoving] = useState<RunningGrader | null>(null);
  const [busy, setBusy] = useState(false);
  const [refused, setRefused] = useState<Refusal | null>(null);
  /** What the last delete came to, kept until the list is asked again. */
  const [removed, setRemoved] = useState<string | null>(null);

  const mayRemove = role !== null && canAuthor(role);
  const whyNot = role === null ? undefined : REMOVE.notYours(role);

  const rows = answer?.status === "ready" ? answer.value.items : [];

  async function remove(copy: RunningGrader): Promise<void> {
    setBusy(true);
    setRefused(null);

    const answered = await deleteJson<unknown>(graderPath(copy.id), {
      project: projectId,
    });

    setBusy(false);

    if (answered.status === "signed-out") {
      window.location.replace("/sign-in");
      return;
    }

    if (answered.status !== "ready") {
      setRefused(answered.refusal);
      return;
    }

    setRemoving(null);
    setRemoved(REMOVE.gone(copy.name));
    // Read the list again rather than dropping the row here. What is judging
    // this project is the server's answer, and a page that edited its own copy
    // of the list would be a second opinion about it the moment two people are
    // looking.
    reload();
  }

  function body() {
    if (answer === null || answer.status === "signed-out") {
      return <Loading what={RUNNING.loading} />;
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
        columns={columnsFor(setRemoving, mayRemove, whyNot)}
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

        {removed === null ? null : <p role="status">{removed}</p>}

        {body()}

        {removing === null ? null : (
          <Dialog
            title={REMOVE.title(removing.name)}
            onClose={() => {
              setRemoving(null);
              setRefused(null);
            }}
          >
            <p>{REMOVE.lead}</p>
            {/*
              The consequence of deleting the last one, said before it is taken
              rather than discovered on a run that came back with nothing
              judged. A project is allowed to run no graders — the run door lets
              it through — so this is a warning and never a refusal.
            */}
            {rows.length === 1 ? <p>{REMOVE.theLastOne}</p> : null}
            {refused === null ? null : <Refused message={refused.message} />}
            <Actions>
              <Button
                onClick={() => {
                  setRemoving(null);
                  setRefused(null);
                }}
              >
                {REMOVE.cancel}
              </Button>
              <Button
                weight="strong"
                disabled={busy}
                onClick={() => void remove(removing)}
              >
                {busy ? REMOVE.confirming : REMOVE.confirm}
              </Button>
            </Actions>
          </Dialog>
        )}
      </PageBody>
    </ProductPage>
  );
}
