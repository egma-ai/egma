"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import {
  getSimulation,
  regradeSimulation,
} from "@egma/platform-api/client";

import type { Refusal } from "../../../../../../../lib/api.ts";
import { roleOf } from "../../../../../../../lib/me.ts";
import {
  platformAnswer,
  platformClient,
} from "../../../../../../../lib/platform-client.ts";
import { projectPath } from "../../../../../../../lib/project-context.ts";
import { canAuthor } from "../../../../../../../lib/roles.ts";
import {
  REGRADE_IS_NOT_A_REPLAY,
  regradeRefusalMessage,
  type RegradeAsked,
  type SimulationEvidence,
} from "../../../../../../../lib/simulations.ts";
import { Button } from "@/components/ui/button";
import { Actions } from "../../../../../../../ui/section.tsx";
import { Problem, Refused } from "../../../../../../../ui/form.tsx";
import { Dialog } from "../../../../../../../ui/dialog.tsx";
import {
  Failure,
  Loading,
  NotFound,
} from "../../../../../../../ui/page-state.tsx";
import { useProjectRead } from "../../../../../../../ui/resource.ts";
import {
  RelativeInstant,
  useMinuteClock,
} from "../../../../../../../ui/relative-time.tsx";
import {
  SimulationEvidenceReview,
  useSimulationEvidenceRecording,
} from "../../../../../../../ui/simulation-evidence.tsx";
import {
  AppShell,
  PageBody,
  PageHeader,
  ProductPage,
  useShellSession,
} from "../../../../../../../ui/shell.tsx";

/**
 * One simulation's evidence: what happened, how it happened, and the grades
 * produced from it.
 *
 * **The page is reached from its run and is not in the navigation.** A
 * simulation is a thing inside a run, not a product area, and a sidebar entry
 * for it would invite somebody to go looking for a simulation without knowing
 * which run they wanted. The address is project-scoped and stable, so it can be
 * pasted into a ticket and open the same simulation next month.
 *
 * **One read supplies the whole page.** `GET /v1/simulations/{id}` answers the
 * pins, the identities, the frozen plan, the measures, the grades and the
 * transcript together, with the transcript's window worked out on the server
 * from the simulation's own stamps. The only second request this page ever
 * makes is the recording's, and only when there is one to hear — a signed link
 * is short-lived, so carrying one in the page answer would make the address
 * stale a quarter of an hour after it loaded.
 *
 * **The facts stay apart.** Simulation execution, grading progress, individual
 * grade results and the display-only combined score answer different questions.
 */
export default function SimulationEvidencePage() {
  const { projectId, runId, simulationId } = useParams<{
    projectId: string;
    runId: string;
    simulationId: string;
  }>();
  return (
    <AppShell>
      <EvidenceView
        projectId={projectId}
        runId={runId}
        simulationId={simulationId}
      />
    </AppShell>
  );
}

/** How often the page asks again while grading is active. */
const AGAIN_MS = 2000;

function EvidenceView({
  projectId,
  runId,
  simulationId,
}: {
  readonly projectId: string;
  readonly runId: string;
  readonly simulationId: string;
}) {
  const { me } = useShellSession();
  // Null until the session read answers. A page that guessed would offer a
  // viewer Regrade, which the server refuses, on every load.
  const role = me === null ? null : roleOf(me);
  const now = useMinuteClock();
  const mayRevisit = role !== null && canAuthor(role);

  const { answer, reload } = useProjectRead<SimulationEvidence>(
    (projectId) =>
      platformAnswer(
        getSimulation(
          { simulationId, projectId },
          { client: platformClient },
        ),
      ),
    projectId,
    simulationId,
  );

  const [refused, setRefused] = useState<Refusal | null>(null);
  const [asked, setAsked] = useState<RegradeAsked | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [working, setWorking] = useState(false);

  // A different simulation in the same page: everything accumulated about the
  // last one goes, including an open control that would otherwise be answered
  // about a simulation nobody opened it for.
  useEffect(() => {
    setRefused(null);
    setAsked(null);
    setConfirming(false);
  }, [simulationId, projectId]);

  useEffect(() => {
    if (answer?.status === "signed-out") window.location.replace("/sign-in");
  }, [answer]);

  const evidence = answer?.status === "ready" ? answer.value : null;
  const recording = useSimulationEvidenceRecording(evidence, projectId);

  const stillGrading =
    evidence !== null &&
    (evidence.gradingState === "pending" ||
      evidence.gradingState === "running");

  useEffect(() => {
    if (!stillGrading) return undefined;
    const timer = setTimeout(() => reload(), AGAIN_MS);
    return () => clearTimeout(timer);
  }, [stillGrading, reload, evidence]);

  async function regrade(): Promise<void> {
    if (!mayRevisit || working) return;
    // Both of these belong to the *last* ask, and a new one is being made. The
    // sentence saying a simulation was queued is the one that must go: a
    // second ask that is refused would otherwise leave a reassurance about work
    // that was queued standing above a refusal saying nothing was — two boxes
    // disagreeing, with the comforting one on top.
    setRefused(null);
    setAsked(null);
    setWorking(true);
    const answered = await platformAnswer(
      regradeSimulation(
        {
          simulationId,
          projectId,
        },
        { client: platformClient },
      ),
    );
    setWorking(false);
    setConfirming(false);
    if (answered.status === "signed-out") {
      window.location.replace("/sign-in");
      return;
    }
    if (answered.status !== "ready") {
      setRefused(answered.refusal);
      return;
    }
    setAsked(answered.value);
    reload();
  }

  if (answer === null || answer.status === "signed-out") {
    return (
      <ProductPage>
        <PageHeader
          title="Simulation"
          breadcrumbs={[
            { label: "Runs", href: projectPath(projectId, "runs") },
            { label: "Run", href: projectPath(projectId, "runs", runId) },
            { label: "Simulation" },
          ]}
        />
        <PageBody>
          <Loading what="this simulation" />
        </PageBody>
      </ProductPage>
    );
  }

  if (answer.status === "missing") {
    return (
      <ProductPage>
        <PageHeader
          title="Simulation"
          breadcrumbs={[
            { label: "Runs", href: projectPath(projectId, "runs") },
            { label: "Run", href: projectPath(projectId, "runs", runId) },
            { label: "Simulation" },
          ]}
        />
        <PageBody>
          <NotFound message={answer.refusal.message} />
        </PageBody>
      </ProductPage>
    );
  }

  if (answer.status === "failed") {
    return (
      <ProductPage>
        <PageHeader
          title="Simulation"
          breadcrumbs={[
            { label: "Runs", href: projectPath(projectId, "runs") },
            { label: "Run", href: projectPath(projectId, "runs", runId) },
            { label: "Simulation" },
          ]}
        />
        <PageBody>
          <Failure message={answer.refusal.message} onRetry={reload} />
        </PageBody>
      </ProductPage>
    );
  }

  const read = answer.value;
  const title = read.test.name ?? "This simulation executed no stored test";
  return (
    <ProductPage wide>
      <PageHeader
        title={title}
        breadcrumbs={[
          { label: "Runs", href: projectPath(projectId, "runs") },
          {
            label: read.runName ?? "Run",
            href: projectPath(projectId, "runs", runId),
          },
          { label: title },
        ]}
        lead={
          <>
            {/*
             * The Personas list, not one persona's own address: a persona is
             * read in a panel over that list now, and it has no page of its
             * own to link to. The name is still where somebody looks for it,
             * and the link still lands where that name is.
             */}
            <Link href={projectPath(projectId, "personas")}>
              {read.persona.name ?? "A persona"}
            </Link>{" "}
            calling{" "}
            <Link href={projectPath(projectId, "agents", read.agent.id)}>
              {read.agent.name ?? "the agent"}
            </Link>
            {` through ${read.connection.name ?? "the connection"}`}
            {read.startedAt === null ? null : (
              <>
                {" · started "}
                <RelativeInstant instant={read.startedAt} now={now} />
              </>
            )}
          </>
        }
        action={
          <Actions>
            {/*
              **A viewer gets no Regrade at all**, rather than a disabled one.
              Every piece of evidence on this page is theirs to read, and this
              is not; a disabled control would be a permanent reminder of
              something they cannot have on a page whose whole subject they can.
            */}
            {!mayRevisit ? null : (
              <Button
                type="button"
                disabled={working}
                onClick={() => setConfirming(true)}
              >
                Regrade
              </Button>
            )}
          </Actions>
        }
      />
      <PageBody>
        {refused === null ? null : (
          <Refused message={regradeRefusalMessage(refused)} />
        )}

        {asked === null ? null : (
          <Problem>
            {asked.reopened > 0
              ? "This simulation is queued for a whole-simulation regrade. New grades appear below as they finish."
              : "This simulation was already queued for grading, so no duplicate work was added."}
          </Problem>
        )}

        {role === null || mayRevisit ? null : (
          <Problem>
            {`Your ${String(role)} role can read every grade here but cannot request a regrade. Ask an organization admin to change your role.`}
          </Problem>
        )}

        {read.status !== "failed" ? null : (
          <Problem>
            <span className="block">
              {read.failureDetail ?? "Egma could not conduct this simulation."}
            </span>
            <span className="mt-1 block">
              This is an execution problem, not a failed grade, and it says
              nothing about the agent.
            </span>
          </Problem>
        )}

        <SimulationEvidenceReview
          evidence={read}
          recording={recording}
        />

      </PageBody>

      {!confirming ? null : (
        <Dialog
          title={`Regrade “${read.test.name ?? `simulation ${String(read.position)}`}”?`}
          onClose={() => setConfirming(false)}
        >
          {(dismiss) => (
            <>
              <p>{REGRADE_IS_NOT_A_REPLAY}</p>
              <Actions>
                <Button type="button" variant="secondary" onClick={() => dismiss()}>
                  Not now
                </Button>
                <Button type="button" busy={working} onClick={() => void regrade()}>
                  {working ? "Requesting…" : "Regrade simulation"}
                </Button>
              </Actions>
            </>
          )}
        </Dialog>
      )}
    </ProductPage>
  );
}
