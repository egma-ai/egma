"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";

import { writeJson, type Refusal } from "../../../../../../../lib/api.ts";
import { asMoment } from "../../../../../../../lib/instants.ts";
import { roleOf } from "../../../../../../../lib/me.ts";
import { projectPath } from "../../../../../../../lib/project-context.ts";
import { canAuthor } from "../../../../../../../lib/roles.ts";
import {
  judgedAssertions,
  planExplanation,
  REGRADE_IS_NOT_A_REPLAY,
  simulationPath,
  simulationRegradePath,
  type EvidenceVerdict,
  type RegradeAsked,
  type SimulationEvidence,
} from "../../../../../../../lib/simulations.ts";
import { VERDICT_WORDS, type VerdictWord } from "../../../../../../../lib/runs.ts";
import { RECORDING } from "../../../../../../../lib/transcript-copy.ts";
import { RecordingPlayer } from "../../../../../../recording-player.tsx";
import {
  Actions,
  Badge,
  Button,
  ButtonLink,
  Facts,
  Field,
  Help,
  Problem,
  Refused,
  Section,
  Select,
  TextArea,
} from "../../../../../../../ui/controls.tsx";
import { Dialog } from "../../../../../../../ui/dialog.tsx";
import {
  ExecutionTimeline,
  GradingPending,
  Measures,
  MockToolEvidence,
  PlanItems,
  Transcript,
  VerdictEvidence,
} from "../../../../../../../ui/evidence.tsx";
import {
  Empty,
  Failure,
  Loading,
  NotFound,
} from "../../../../../../../ui/page-state.tsx";
import { useProjectRead } from "../../../../../../../ui/resource.ts";
import {
  GradingState,
  SimulationStatus,
  shownScore,
  VerdictBadge,
  VerdictTally,
} from "../../../../../../../ui/run-status.tsx";
import {
  AppShell,
  PageBody,
  PageHeader,
  ProductPage,
  useShellSession,
} from "../../../../../../../ui/shell.tsx";
import styles from "./simulation.module.css";

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
        <PageHeader eyebrow="Runs" title="Simulation" />
        <PageBody>
          <Loading what="this simulation" />
        </PageBody>
      </ProductPage>
    );
  }

  if (answer.status === "missing") {
    return (
      <ProductPage>
        <PageHeader eyebrow="Runs" title="Simulation" />
        <PageBody>
          <NotFound
            message={answer.refusal.message}
            action={
              <ButtonLink href={projectPath(projectId, "runs", runId)}>
                Back to the run
              </ButtonLink>
            }
          />
        </PageBody>
      </ProductPage>
    );
  }

  if (answer.status === "failed") {
    return (
      <ProductPage>
        <PageHeader eyebrow="Runs" title="Simulation" />
        <PageBody>
          <Failure message={answer.refusal.message} onRetry={reload} />
        </PageBody>
      </ProductPage>
    );
  }

  const read = answer.value;
  const assertions = judgedAssertions(read.verdicts);
  const turns = read.transcript?.turns ?? [];
  const plan = read.grading_plan;

  return (
    <ProductPage wide>
      <PageHeader
        eyebrow="Runs"
        title={read.test.name ?? "This simulation executed no stored test"}
        lead={
          <>
            {read.persona.name ?? "a persona"} · simulation{" "}
            {String(read.position).padStart(2, "0")} of{" "}
            <Link href={projectPath(projectId, "runs", runId)}>
              {read.run_label ?? "the run"}
            </Link>
            {read.started_at === null
              ? null
              : ` · started ${asMoment(read.started_at)}`}
          </>
        }
        action={
          <Actions>
            <ButtonLink href={projectPath(projectId, "runs", runId)}>
              Back to the run
            </ButtonLink>
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
        {refused === null ? null : <Refused message={refused.message} />}

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

        {/*
          The four facts, kept apart and labelled. A simulation that finished
          is not a simulation that went well, and a verdict nobody has reached
          is blank rather than red.
        */}
        <div className={styles.facts}>
          <div className={styles.fact}>
            <span>Simulation</span>
            <SimulationStatus status={read.status} />
          </div>
          <div className={styles.fact}>
            <span>Grading</span>
            <GradingState grading={read.grading} />
          </div>
          <div className={styles.fact}>
            <span>Verdict</span>
            <VerdictBadge verdict={read.verdict} />
          </div>
          <div className={styles.fact}>
            <span>Checks</span>
            <VerdictTally counts={read.counts} />
          </div>
          <div className={styles.fact}>
            <span>Score</span>
            <strong className={styles.mono}>{shownScore(read.score)}</strong>
          </div>
        </div>

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

        <Section
          title="Verdicts"
          lead="One per judged assertion. A regrade writes a new judgement beside the old one, and the earlier one stays readable underneath it. A grader marked reports only is judged the same way and can fail nothing."
        >
          {stillJudging ? (
            <GradingPending what="Grading is still running. Verdicts appear here as they land, and nothing below is a failure until a grader says so." />
          ) : null}

          {assertions.length === 0 ? (
            <Empty
              title={
                read.grading === "not_required"
                  ? "There was nothing to judge"
                  : "Nobody has judged this yet"
              }
              lead={
                read.grading === "not_required"
                  ? "Egma never conducted this simulation, so no grading job was ever filed and none ever will be."
                  : "The grading engine has not written a verdict for this simulation. That is not a result, and it is certainly not a failure."
              }
            />
          ) : (
            <div className={styles.verdicts}>
              {assertions.map((judged) => (
                <VerdictEvidence
                  key={judged.key}
                  judged={judged}
                  turns={turns}
                />
              ))}
            </div>
          )}
        </Section>

        <Section
          title="What this simulation was"
          lead="The exact frozen versions it executed. The names read as they stand today; these do not move, which is what keeps the evidence interpretable."
        >
          <Facts
            facts={[
              {
                label: "Test",
                value:
                  read.test.id === null ? (
                    <span>No stored test</span>
                  ) : (
                    <span className={styles.identity}>
                      <Link href={projectPath(projectId, "tests", read.test.id)}>
                        {read.test.name ?? read.test.id}
                      </Link>
                      <code>{read.test.version_id}</code>
                    </span>
                  ),
              },
              {
                label: "Persona",
                value: (
                  <span className={styles.identity}>
                    <Link
                      href={projectPath(projectId, "personas", read.persona.id)}
                    >
                      {read.persona.name ?? read.persona.id}
                    </Link>
                    <code>{read.persona.version_id}</code>
                  </span>
                ),
              },
              {
                label: "Scenario",
                value: read.test.scenario ?? <em>not recorded</em>,
              },
              {
                label: "Expected behaviors",
                value:
                  read.test.expected_behaviors === null ? (
                    <em>not recorded</em>
                  ) : (
                    <ol className={styles.behaviors}>
                      {read.test.expected_behaviors.map((one) => (
                        <li key={one}>{one}</li>
                      ))}
                    </ol>
                  ),
              },
              {
                label: "Required capabilities",
                value:
                  read.test.required_capabilities === null ||
                  read.test.required_capabilities.length === 0 ? (
                    "none"
                  ) : (
                    <code>{read.test.required_capabilities.join(", ")}</code>
                  ),
              },
            ]}
          />
        </Section>

        <Section
          title="What it ran against"
          lead="The agent and the connection as they now stand, and the connection exactly as this simulation went over it. Both stay readable after either is archived."
        >
          <Facts
            facts={[
              {
                label: "Agent",
                value: (
                  <span className={styles.identity}>
                    <Link
                      href={projectPath(projectId, "agents", read.agent.id)}
                    >
                      {read.agent.name ?? read.agent.id}
                    </Link>
                    {read.agent.archived === true ? (
                      <Badge tone="warn">Archived</Badge>
                    ) : null}
                  </span>
                ),
              },
              {
                label: "Connection",
                value: (
                  <span className={styles.identity}>
                    {read.connection.name ?? read.connection.id}
                    {read.connection.archived === true ? (
                      <Badge tone="warn">Archived</Badge>
                    ) : null}
                  </span>
                ),
              },
              {
                label: "Transport",
                value: (
                  <code>
                    {read.connection_snapshot.type} ·{" "}
                    {read.connection_snapshot.modality} ·{" "}
                    {read.connection_snapshot.topology}
                  </code>
                ),
              },
              {
                label: "Environment",
                value: (
                  <code>{read.connection_snapshot.environment ?? "none"}</code>
                ),
              },
              {
                // The platform's own name for the exchange: the one join
                // between egma's record and the agent's own telemetry, and what
                // somebody takes to their provider when they doubt this page.
                label: "Provider reference",
                value:
                  read.provider_reference === null ? (
                    <em>none reported</em>
                  ) : (
                    <code>{read.provider_reference}</code>
                  ),
              },
              {
                label: "Simulation identifier",
                value: <code>{read.id}</code>,
              },
            ]}
          />
        </Section>

        {/*
          The audio, where there is any.

          `has_recording` is the simulation's own answer and is what decides
          whether a player is offered at all — the difference between an honest
          absence and a disabled control that reads as a broken feature. What
          the player then does about a link that will not resolve, or a store
          that stops serving one, is its own business and is the same on every
          surface that shows one.
        */}
        {read.has_recording ? (
          <Section
            title="What Egma heard"
            lead="Fetched with your own session when you ask for it, and never carried in this address — a recording link is signed and short-lived."
          >
            <RecordingPlayer
              simulationId={read.id}
              words={RECORDING}
              knownToExist
              project={projectId}
            />
          </Section>
        ) : null}

        <Section
          title="Transcript"
          lead="What the persona and the agent said, in the order they said it. Tool calls and system steps are not folded in here; they are on the clock below."
        >
          {read.transcript === null ? (
            <Empty
              title="No transcript was filed"
              lead="Egma has no spans for this simulation. A simulation that was never conducted filed none, and so did one whose simulator died before its first export."
            />
          ) : (
            <>
              {read.transcript.spans_truncated ? (
                <Problem>
                  {`This simulation filed ${String(read.transcript.span_count)} steps, which is more than one read returns. What is below is the beginning of it, in order.`}
                </Problem>
              ) : null}
              <Transcript transcript={read.transcript} />
            </>
          )}
        </Section>

        {read.transcript === null ? null : (
          <Section
            title="Execution"
            lead="Speech, tool calls and system work on one clock — where they meet, without any of them being folded into the transcript."
          >
            <ExecutionTimeline transcript={read.transcript} />
          </Section>
        )}

        <Section
          title="Outcome"
          lead="What was measured, apart from anything judged. A metric measures and a grader judges, and a measure nobody emitted is absent rather than zero."
        >
          <Measures measures={read.measures} />
        </Section>

        <Section
          title="Mock Tools"
          lead="What Egma answered for, and what ran for real and unobserved. A mocked simulation and an unmocked one are different units."
        >
          <MockToolEvidence
            coverage={read.mock_tool_coverage}
            defaults={read.mock_tools.defaults}
            overrides={read.mock_tools.overrides}
          />
        </Section>

        <Section
          title="What judged this simulation"
          lead={
            plan === null
              ? "This run has no recorded grading plan."
              : planExplanation(plan.state)
          }
        >
          {plan !== null && plan.state !== "run_start" ? (
            <Problem>
              {plan.state === "migration_snapshot"
                ? "This plan was captured while Egma was upgraded rather than when the run started, so it is what the grading used and not what the run decided."
                : "No plan was recorded when this run started. Nothing below is a claim about which graders judged it."}
            </Problem>
          ) : null}
          <PlanItems items={plan?.items ?? []} />
        </Section>

      </PageBody>

      {!confirming ? null : (
        <Dialog
          title={`Judge simulation “${read.id}” again?`}
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
