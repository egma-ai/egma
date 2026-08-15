"use client";

import { useParams } from "next/navigation";

import { projectPath } from "../../../../lib/project-context.ts";
import { roleOf } from "../../../../lib/me.ts";
import { canAuthor } from "../../../../lib/roles.ts";
import { ButtonLink } from "../../../../ui/controls.tsx";
import { Empty } from "../../../../ui/page-state.tsx";
import {
  AppShell,
  PageBody,
  PageHeader,
  ProductPage,
  useShellSession,
} from "../../../../ui/shell.tsx";

/**
 * Runs, as far as this build goes: the way into the builder.
 *
 * **The history is deliberately not here yet**, and this page says so rather
 * than showing an empty list — an empty list would read as *this project has
 * never run anything*, which is a different and possibly false sentence. The
 * list, its filters, live progress, Cancel and Retry are the next ticket's.
 *
 * What is here is the entry point, because a builder nobody can reach is a
 * builder nobody uses. A viewer sees the page and not the button: hiding it is
 * courtesy rather than authorization, and the server refuses a viewer's start
 * whether or not this page offered one.
 */
export default function RunsPage() {
  const { projectId } = useParams<{ projectId: string }>();
  return (
    <AppShell>
      <Runs projectId={projectId} />
    </AppShell>
  );
}

function Runs({ projectId }: { readonly projectId: string }) {
  const { me } = useShellSession();
  // Null until the session read answers. A page that guessed would offer a
  // viewer a control the server refuses, on every load.
  const role = me === null ? null : roleOf(me);
  const mayStart = role !== null && canAuthor(role);

  return (
    <ProductPage>
      <PageHeader
        eyebrow="Project"
        title="Runs"
        lead="Every execution of a selection of tests against one agent over one connection."
        action={
          mayStart ? (
            <ButtonLink
              weight="strong"
              href={projectPath(projectId, "runs", "new")}
            >
              Plan a run
            </ButtonLink>
          ) : undefined
        }
      />
      <PageBody>
        <Empty
          title="Run history is not in the browser yet"
          lead="Plan and start a run here, then open the address egma prints to read its results. The list, live progress, Cancel and Retry arrive with Run history."
          action={
            mayStart ? (
              <ButtonLink href={projectPath(projectId, "runs", "new")}>
                Plan a run
              </ButtonLink>
            ) : undefined
          }
        />
      </PageBody>
    </ProductPage>
  );
}
