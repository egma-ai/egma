"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";

import { writeJson, type Refusal } from "../../../../../../../lib/api.ts";
import { roleOf } from "../../../../../../../lib/me.ts";
import { projectPath } from "../../../../../../../lib/project-context.ts";
import { canAuthor } from "../../../../../../../lib/roles.ts";
import {
  REGRADE_IS_NOT_A_REPLAY,
  simulationPath,
  simulationRegradePath,
  type RegradeAsked,
  type SimulationEvidence,
} from "../../../../../../../lib/simulations.ts";
import {
  Actions,
  Button,
  Problem,
  Refused,
} from "../../../../../../../ui/controls.tsx";
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
} from "../../../../../../../ui/simulation-evidence-workspace.tsx";
import {
  AppShell,
  PageBody,
  PageHeader,
  ProductPage,
  useShellSession,
} from "../../../../../../../ui/shell.tsx";

/**
 * One simulation's evidence: what happened, how it happened, how egma judged it,
 * and any later human correction.
 *
 * **The page is reached from its run and is not in the navigation.** A
 * simulation is a thing inside a run, not a product area, and a sidebar entry
 * for it would invite somebody to go looking for a simulation without knowing
 * which run they wanted. The address is project-scoped and stable, so it can be
 * pasted into a ticket and open the same simulation next month.
 *
 * **One read supplies the whole page.** `GET /api/simulations/{id}` answers the
 * pins, the identities, the frozen plan, the measures, the verdicts and the
 * transcript together, with the transcript's window worked out on the server
 * from the simulation's own stamps. The only second request this page ever
 * makes is the recording's, and only when there is one to hear — a signed link
 * is short-lived, so carrying one in the page answer would make the address
 * stale a quarter of an hour after it loaded.
 *
 * **The four facts stay apart, everywhere.** The simulation's machinery, where
 * the grading stands, what was decided, and null for *nobody has decided yet*. A
 * simulation still being judged shows a pending line beside its behaviours and
 * nothing red — turning the page into a failure while the engine is still
 * working is the single worst thing this surface could do.
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

/** How often the page asks again while anything is still being judged. */
const AGAIN_MS = 2000;

/** User-facing regrade copy never repeats storage identifiers from the API. */
function regradeRefusalMessage(refusal: Refusal): string {
  if (refusal.error === "unprocessable") {
    return "This simulation has no grading to ask for again. It was not conducted or did not finish, so there is nothing to judge again.";
  }
  if (refusal.error === "narrower_grading_in_flight") {
    return "One grader is already judging this simulation and does not cover what you asked for. Nothing was queued. Ask again after those verdicts arrive.";
  }
  return refusal.message
    .replace(/\bsimulation\s+sim_[a-z0-9]+\b/giu, "this simulation")
    .replace(/\bsim_[a-z0-9]+\b/giu, "this simulation");
}

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
    simulationPath(simulationId),
    projectId,
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

  /**
   * Whether anything is still being judged.
   *
   * Read off the grading job rather than off the verdict rows, because those are
   * two different questions: a simulation with rows may still have a re-grade
   * outstanding, and a simulation with none may have nothing queued at all.
   */
  const stillJudging =
    evidence !== null &&
    evidence.grading_jobs.some((job) =>
      ["pending", "claimed"].includes(job.status),
    );

  useEffect(() => {
    if (!stillJudging) return undefined;
    const timer = setTimeout(() => reload(), AGAIN_MS);
    return () => clearTimeout(timer);
  }, [stillJudging, reload, evidence]);

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
    const answered = await writeJson<RegradeAsked>(
      simulationRegradePath(simulationId),
      { method: "POST", project: projectId, body: {} },
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

  /*
   * **There was a `correct` here, and it goes with the endpoint.** ADR-0009
   * takes a person's disagreement out of v0; it returns as the reserved `human`
   * grader type, writing rows of its own under a grader id of its own.
   */

  if (answer === null || answer.status === "signed-out") {
    return (
      <ProductPage>
        <PageHeader
          eyebrow="Simulation runs"
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
          eyebrow="Simulation runs"
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
          eyebrow="Simulation runs"
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
  return (
    <ProductPage wide>
      <PageHeader
        eyebrow="Simulation runs"
        title={read.test.name ?? "This simulation executed no stored test"}
        breadcrumbs={[
          { label: "Runs", href: projectPath(projectId, "runs") },
          {
            label: read.run_label ?? "Run",
            href: projectPath(projectId, "runs", runId),
          },
          { label: `Simulation ${String(read.position).padStart(2, "0")}` },
        ]}
        lead={
          <>
            <Link href={projectPath(projectId, "personas", read.persona.id)}>
              {read.persona.name ?? "A persona"}
            </Link>{" "}
            calling{" "}
            <Link href={projectPath(projectId, "agents", read.agent.id)}>
              {read.agent.name ?? "the agent"}
            </Link>
            {` through ${read.connection.name ?? "the connection"}`}
            {read.started_at === null ? null : (
              <>
                {" · started "}
                <RelativeInstant instant={read.started_at} now={now} />
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
                weight="strong"
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
              ? "This simulation is queued to be judged again. Verdicts appear below as they land."
              : "This simulation was already waiting to be judged, so nothing was asked twice. Verdicts appear below as they land."}
          </Problem>
        )}

        {role === null || mayRevisit ? null : (
          <Problem>
            {`Your ${String(role)} role can read every piece of evidence here and cannot change a verdict. Ask an organization admin to change your role.`}
          </Problem>
        )}

        {read.skip_reason === null ? null : (
          <Problem>
            {read.skip_reason === "required_capability_unsupported"
              ? `This connection was measured and does not support ${(read.skipped_capabilities ?? []).join(", ")}. Egma conducted nothing and says nothing about the agent.`
              : `Nobody has measured whether this connection supports ${(read.skipped_capabilities ?? []).join(", ")}. Egma conducted nothing and says nothing about the agent.`}
          </Problem>
        )}

        {read.status !== "failed" ? null : (
          <Problem>
            {read.reason ?? "Egma could not conduct this simulation."} This is
            an execution problem, not a failed grader verdict, and it says
            nothing about the agent.
          </Problem>
        )}

        <SimulationEvidenceReview evidence={read} recording={recording} />

      </PageBody>

      {!confirming ? null : (
        <Dialog
          title={`Judge “${read.test.name ?? `simulation ${String(read.position)}`}” again?`}
          onClose={() => setConfirming(false)}
        >
          {(dismiss) => (
            <>
              <p>{REGRADE_IS_NOT_A_REPLAY}</p>
              <Actions>
                <Button onClick={dismiss}>Not now</Button>
                <Button
                  weight="strong"
                  disabled={working}
                  onClick={() => void regrade()}
                >
                  {working ? "Asking…" : "Judge it again"}
                </Button>
              </Actions>
            </>
          )}
        </Dialog>
      )}
    </ProductPage>
  );
}
