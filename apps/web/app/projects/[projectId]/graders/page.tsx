"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useState } from "react";
import { listGraders } from "@egma/platform-api/client";

import { Button } from "@/components/ui/button";
import {
  productionScopeLabel,
  simulationScopeLabel,
  type ProjectGrader,
  type ProjectGradersPage,
} from "../../../../lib/graders.ts";
import { firstProjectOf, roleOf } from "../../../../lib/me.ts";
import {
  platformAnswer,
  platformClient,
} from "../../../../lib/platform-client.ts";
import { graderDisplayName } from "../../../../lib/presentation.ts";
import { projectLanding } from "../../../../lib/project-context.ts";
import { canAuthor } from "../../../../lib/roles.ts";
import { DataTable, type Column } from "../../../../ui/data-table.tsx";
import {
  Empty,
  Failure,
  Loading,
  NotFound,
} from "../../../../ui/page-state.tsx";
import { useProjectRead } from "../../../../ui/resource.ts";
import { Section } from "../../../../ui/section.tsx";
import {
  AppShell,
  PageBody,
  PageHeader,
  ProductPage,
  useShellSession,
} from "../../../../ui/shell.tsx";
import { ThresholdForm } from "./threshold-form.tsx";

export default function GradersPage() {
  const { projectId } = useParams<{ projectId: string }>();
  return (
    <AppShell>
      <ProjectGraders projectId={projectId} />
    </AppShell>
  );
}

function columnsFor(
  mayEdit: boolean,
  edit: (grader: ProjectGrader) => void,
): readonly Column<ProjectGrader>[] {
  return [
    {
      key: "name",
      header: "Grader",
      primary: true,
      cell: (grader) => graderDisplayName(grader.name),
    },
    {
      key: "simulations",
      header: "Simulations",
      cell: simulationScopeLabel,
    },
    {
      key: "production",
      header: "Production",
      cell: productionScopeLabel,
    },
    {
      key: "threshold",
      header: "Pass threshold",
      width: "150px",
      cell: (grader) => (
        <span className="font-mono tabular-nums">
          {grader.passThreshold.toFixed(2)}
        </span>
      ),
    },
    {
      key: "action",
      header: "Action",
      action: true,
      width: "150px",
      cell: (grader) => (
        <Button
          type="button"
          variant="secondary"
          disabled={!mayEdit}
          onClick={() => edit(grader)}
        >
          Edit threshold
        </Button>
      ),
    },
  ];
}

function ProjectGraders({ projectId }: { readonly projectId: string }) {
  const { me } = useShellSession();
  const role = me === null ? null : roleOf(me);
  const mayEdit = role !== null && canAuthor(role);
  const { answer, reload } = useProjectRead<ProjectGradersPage>(
    (selectedProjectId) =>
      platformAnswer(
        listGraders(
          { projectId: selectedProjectId },
          { client: platformClient },
        ),
      ),
    projectId,
  );
  const [editing, setEditing] = useState<ProjectGrader | null>(null);
  const [said, setSaid] = useState<string | null>(null);

  function body() {
    if (answer === null || answer.status === "signed-out") {
      return <Loading what="graders" />;
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

    const graders = answer.value.graders;
    if (graders.length === 0) {
      return (
        <Empty
          title="Expected behaviors is unavailable"
          lead="Every project should have this grader. Retry the read or ask an administrator to check this deployment."
        />
      );
    }

    return (
      <>
        {said === null ? null : <p role="status">{said}</p>}
        <DataTable
          label="Project graders"
          columns={columnsFor(mayEdit, (grader) => {
            setSaid(null);
            setEditing(grader);
          })}
          rows={graders}
          keyOf={(grader) => grader.id}
        />
        {editing === null ? null : (
          <Section
            title={`Edit ${graderDisplayName(editing.name)} threshold`}
            lead="Coverage is fixed to all simulations. Only the individual pass threshold is editable."
          >
            <ThresholdForm
              grader={editing}
              projectId={projectId}
              onCancel={() => setEditing(null)}
              onSaved={() => {
                setEditing(null);
                setSaid("Pass threshold saved.");
                void reload();
              }}
            />
          </Section>
        )}
      </>
    );
  }

  return (
    <ProductPage wide>
      <PageHeader title="Graders" />
      <PageBody>{body()}</PageBody>
    </ProductPage>
  );
}
