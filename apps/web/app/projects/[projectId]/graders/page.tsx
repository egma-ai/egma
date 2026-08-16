"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useState } from "react";

import {
  COLUMNS,
  LIBRARY,
  NOTHING,
  OWNERS,
  TYPES,
  USE,
} from "../../../../lib/grader-library-copy.ts";
import {
  GRADER_LIBRARY_PATH,
  GRADERS_SECTION,
  RUNNING_GRADERS_STEP,
  type LibraryEntry,
  type LibraryPage,
} from "../../../../lib/graders.ts";
import { firstProjectOf, roleOf } from "../../../../lib/me.ts";
import { graderDisplayName } from "../../../../lib/presentation.ts";
import { projectLanding, projectPath } from "../../../../lib/project-context.ts";
import { canAuthor } from "../../../../lib/roles.ts";
import { Button, ButtonLink, Section } from "../../../../ui/controls.tsx";
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
import styles from "./graders.module.css";
import { GraderTabs } from "./tabs.tsx";
import { UseForm } from "./use-form.tsx";

/**
 * The grader library, read in one project: the shelf of definitions a
 * developer picks from.
 *
 * **Nothing here is authored, and one thing here is pressed.** v0 ships a small
 * set of graders egma maintains, so there is nothing on this page to create and
 * nothing to edit — a team meets judgment logic that already works instead of
 * being asked to design some on their first day. What a developer does here is
 * press **Use**, which puts a running copy of an entry on *this* project; the
 * screen beside it lists those copies, and the strip under the heading is how
 * somebody gets between the two.
 *
 * **The shelf is the same in every project and the act is not.** An entry egma
 * owns belongs to nobody in particular, which is what makes it everybody's — so
 * this list reads the same wherever it is opened. Pressing Use is the opposite:
 * it writes one row into one project, and which project that is has to be the
 * one in the address rather than one the API resolves for itself. That is the
 * whole reason this screen lives under `/projects/:projectId/graders`; its
 * organization-wide ancestor could not name a project and quietly used the
 * first in the viewer's list.
 *
 * **The Use form is drawn from the entry it is opened on.** Every entry
 * declares what pressing Use asks for, and that declaration arrives on this
 * answer — so latency draws a measure dropdown and a bound, expected behaviors
 * draws nothing at all, and this page has no opinion about either. A form
 * written per grader would be a copy of the platform's own declaration,
 * drifting the first time one changed.
 *
 * **Owner is the entry's own answer, printed rather than worked out.** The API
 * derives it from who the entry belongs to, so a row saying `egma` and a row a
 * team wrote can never be confused by anything this page decides.
 */
export default function GraderLibraryPage() {
  const { projectId } = useParams<{ projectId: string }>();
  return (
    <AppShell>
      <GraderLibrary projectId={projectId} />
    </AppShell>
  );
}

function typeOf(entry: LibraryEntry): string {
  return TYPES[entry.type] ?? entry.type;
}

function ownerOf(entry: LibraryEntry): string {
  return OWNERS[entry.owner] ?? entry.owner;
}

/**
 * The columns, in the order they are shown, each beside what fills it.
 *
 * The order is a judgement about scanning: which grader this is, then what kind
 * of thing it does, then whose it is, then the sentence because it is the
 * widest, and the act last where a reader's eye ends up.
 *
 * A function rather than a constant because the last column presses something,
 * and what it presses belongs to the page's state rather than to this module.
 */
function columnsFor(
  use: (entry: LibraryEntry) => void,
  mayUse: boolean,
  /**
   * Why it is not theirs — and **nothing at all while egma has not identified
   * them yet**. A disabled control has to be able to say why, and every
   * sentence it could say about an unsettled session would be a claim about
   * somebody nobody has read. So the control is inert and silent for the moment
   * the session read is in flight, and speaks once there is a role to name.
   */
  whyNot: string | undefined,
): readonly Column<LibraryEntry>[] {
  return [
    {
      key: "name",
      header: COLUMNS.name,
      primary: true,
      cell: (entry) => graderDisplayName(entry.name),
    },
    { key: "type", header: COLUMNS.type, width: "140px", cell: typeOf },
    {
      key: "owner",
      header: COLUMNS.owner,
      hideOnMobile: true,
      width: "120px",
      cell: ownerOf,
    },
    {
      key: "description",
      header: COLUMNS.description,
      hideOnMobile: true,
      cell: (entry) => entry.description ?? NOTHING,
    },
    {
      key: "use",
      header: COLUMNS.use,
      width: "110px",
      cell: (entry) => (
        <Button
          disabled={!mayUse}
          {...(mayUse || whyNot === undefined ? {} : { why: whyNot })}
          onClick={() => use(entry)}
        >
          {USE.open}
        </Button>
      ),
    },
  ];
}

function GraderLibrary({ projectId }: { readonly projectId: string }) {
  const { me } = useShellSession();
  // Null until the session read answers. A page that guessed would tell an
  // admin their role cannot do something it can, on every load.
  const role = me === null ? null : roleOf(me);

  const { answer, reload } = useProjectRead<LibraryPage>(
    GRADER_LIBRARY_PATH,
    projectId,
  );

  /** The entry whose form is open, and nothing while none is. */
  const [using, setUsing] = useState<LibraryEntry | null>(null);
  /** What the last press came to, kept after the form closes so it can be read. */
  const [started, setStarted] = useState<string | null>(null);

  const mayUse = role !== null && canAuthor(role);
  const whyNot = role === null ? undefined : USE.notYours(role);

  function body() {
    if (answer === null || answer.status === "signed-out") {
      return <Loading what={LIBRARY.loading} />;
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

    const entries = answer.value.items;

    /*
     * **It reads the first page and stops there**, which is honest for a shelf
     * holding exactly what egma ships. The endpoint pages like every other
     * list and hands back where it stopped; this screen ignores that, because
     * a **Show more** button under two rows would be a control nobody could
     * ever press. The day the shelf grows past a page — custom entries, which
     * is the same change that gives this screen something to author — is the
     * day it grows the button, and the answer already carries what that needs.
     */
    if (entries.length === 0) {
      return <Empty title="The library is empty" lead={LIBRARY.empty} />;
    }

    return (
      <DataTable
        label="The grader library"
        columns={columnsFor(setUsing, mayUse, whyNot)}
        rows={entries}
        keyOf={(entry) => entry.id}
      />
    );
  }

  return (
    <ProductPage wide>
      <PageHeader eyebrow="Project" title={LIBRARY.title} lead={LIBRARY.lead} />
      <PageBody>
        <GraderTabs projectId={projectId} active="library" />
        <div className={styles.viewContent}>
          {/*
            What the last press came to, and it stays until the next one. A copy
            is judging from the moment it exists, so the sentence says that and
            points at the screen where it now appears.
          */}
          {started === null ? null : (
            <p role="status">
              {USE.started(started)}{" "}
              <Link
                href={projectPath(
                  projectId,
                  GRADERS_SECTION,
                  RUNNING_GRADERS_STEP,
                )}
              >
                {USE.seeRunning}
              </Link>
            </p>
          )}

          {/*
            The form, opened on one entry at a time and drawn from that entry's
            own declaration. Inline rather than in a dialog: the table stays
            available, so pressing Use on another row can safely replace it.

            **Keyed by the entry, which is what makes switching between two of
            them safe.** The form's state is the answers to *this* entry's
            questions, and React keeps a component's state across a re-render when
            only its props change. The key makes the two forms two components, so
            the second starts from its own defaults.
          */}
          {using === null ? null : (
            <Section title={USE.title(graderDisplayName(using.name))}>
              <UseForm
                key={using.id}
                entry={using}
                projectId={projectId}
                onCancel={() => setUsing(null)}
                onStarted={(name) => {
                  setUsing(null);
                  setStarted(graderDisplayName(name));
                }}
              />
            </Section>
          )}

          {body()}
        </div>
      </PageBody>
    </ProductPage>
  );
}
