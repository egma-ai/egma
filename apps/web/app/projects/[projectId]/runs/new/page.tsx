"use client";

import { useParams, useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";

import { writeJson, type Refusal } from "../../../../../lib/api.ts";
import {
  agentsQuery,
  agentDetailQuery,
  type AgentDetail,
  type AgentPage,
  type ListedConnection,
} from "../../../../../lib/agents.ts";
import { roleOf } from "../../../../../lib/me.ts";
import { projectPath } from "../../../../../lib/project-context.ts";
import { canAuthor } from "../../../../../lib/roles.ts";
import {
  judgesNothing,
  preselectedAgent,
  runPlanQuery,
  RUNS_PATH,
  whyNotStartable,
  type RunPlan,
  type StartedRun,
} from "../../../../../lib/runs.ts";
import {
  activeAgents,
  testsPath,
  type ListedTest,
  type TestPage,
} from "../../../../../lib/tests.ts";
import {
  Button,
  ButtonLink,
  Checkbox,
  Field,
  Problem,
  Refused,
  Select,
  TextInput,
} from "../../../../../ui/controls.tsx";
import { Dialog } from "../../../../../ui/dialog.tsx";
import { Empty, Failure, Loading } from "../../../../../ui/page-state.tsx";
import { useProjectRead } from "../../../../../ui/resource.ts";
import { useUnsavedChanges } from "../../../../../ui/settings-read.ts";
import {
  AppShell,
  PageBody,
  PageHeader,
  ProductPage,
  useShellSession,
} from "../../../../../ui/shell.tsx";
import styles from "./builder.module.css";

/**
 * Planning a run, and starting it.
 *
 * **The order of the steps is the safety.** An agent decides which connections
 * exist; a connection decides which capabilities have been measured; and both
 * decide which of the project's tests can honestly be executed at all. Offering
 * the four choices at once would let somebody assemble a selection that is
 * refused on Start, at which point they would have to work out which of the
 * four was wrong.
 *
 * **Nothing on this page decides anything.** Which versions would be pinned,
 * which conversations would be skipped and why, which graders would judge and
 * at which versions — all of it is `GET /api/run-plan`, which is the same
 * resolution `POST /api/runs` performs.
 * A page that worked any of it out for itself would be a second opinion, and
 * the moment the two disagreed somebody would approve one run and start
 * another.
 *
 * **Start carries an idempotency key.** A run dials a real agent and spends a
 * real judge, so an answer lost on the way back must never become a second
 * conversation. The key is minted once for the selection on screen and reused
 * by every retry of that selection; changing the selection mints a new one,
 * because it is a different run.
 */
export default function NewRunPage() {
  const { projectId } = useParams<{ projectId: string }>();
  return (
    <AppShell>
      <RunBuilder projectId={projectId} />
    </AppShell>
  );
}

/** One ordered step, with its number and heading on the same visual row. */
function Step({
  number,
  title,
  lead,
  children,
}: {
  readonly number: number;
  readonly title: string;
  readonly lead?: string;
  readonly children: React.ReactNode;
}) {
  const headingId = `run-step-${String(number)}-title`;

  return (
    <li className={styles.step}>
      <section
        className={styles.stepSection}
        aria-label={`Step ${String(number)} of 3: ${title}`}
      >
        <header className={styles.stepHeader}>
          <div
            className={styles.stepNumber}
            aria-hidden="true"
          >
            {number}
          </div>
          <div className={styles.stepHeading}>
            <h2 id={headingId}>{title}</h2>
            {lead === undefined ? null : <p className={styles.stepLead}>{lead}</p>}
          </div>
        </header>
        <div className={styles.stepContent}>{children}</div>
      </section>
    </li>
  );
}

/** How a connection reads in the chooser: what it is, and where it points. */
function connectionLabel(connection: ListedConnection): string {
  const where =
    connection.environment === null ? "" : ` · ${connection.environment}`;
  return `${connection.name} · ${connection.product_label} · ${connection.modality}${where}`;
}

/** A fresh browser intent, reused only while that same start is retried. */
function newRunIntentKey(): string {
  return `run:${globalThis.crypto.randomUUID()}`;
}

function RunBuilder({ projectId }: { readonly projectId: string }) {
  const router = useRouter();
  const { me } = useShellSession();
  // Null until the session read answers. A page that guessed would tell a
  // member their role cannot start a run, on every load.
  const role = me === null ? null : roleOf(me);
  const mayStart = role !== null && canAuthor(role);

  /**
   * The agent this builder opened on, when it was opened from one.
   *
   * Read once, from the address, and then owned by the field like any other
   * choice. It preselects and bypasses nothing: the connection still has to be
   * that agent's, every test still has to apply to it, and the project still
   * has to have a judge — all of it checked on the server, exactly as it is for
   * somebody who chose the agent from the list.
   */
  const [agentId, setAgentId] = useState<string>("");
  const [initialAgentId, setInitialAgentId] = useState("");
  useEffect(() => {
    const named = preselectedAgent(window.location.search);
    if (named !== null) {
      setInitialAgentId(named);
      setAgentId(named);
    }
  }, []);

  const [connectionId, setConnectionId] = useState("");
  const [chosen, setChosen] = useState<readonly string[]>([]);
  const [runName, setRunName] = useState("");
  const [runNameError, setRunNameError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [idempotencyKey, setIdempotencyKey] = useState(newRunIntentKey);

  /** A changed target is a new start, not a retry of the earlier selection. */
  function beginNewIntent(): void {
    setIdempotencyKey(newRunIntentKey());
  }

  const [starting, setStarting] = useState(false);
  const [refused, setRefused] = useState<Refusal | null>(null);
  const changed =
    agentId !== initialAgentId ||
    connectionId !== "" ||
    chosen.length > 0 ||
    runName !== "";
  useUnsavedChanges(changed && !starting, starting);

  const { answer: agents } = useProjectRead<AgentPage>(
    agentsQuery({}),
    projectId,
  );
  const { answer: detail } = useProjectRead<AgentDetail>(
    agentId === "" ? "" : agentDetailQuery(agentId, "active"),
    agentId === "" ? null : projectId,
  );
  const { answer: tests } = useProjectRead<TestPage>(
    agentId === "" ? "" : testsPath({ archived: false, agent: agentId }),
    agentId === "" ? null : projectId,
  );

  const agentRows = agents?.status === "ready" ? agents.value.items : [];
  const connections =
    detail?.status === "ready"
      ? detail.value.connections.filter((one) => !one.archived)
      : [];
  /**
   * The tests a run could use: active, and applying to the chosen agent with an
   * agent that is itself active.
   *
   * The applicability filter is the server's — the list was asked for this
   * agent — and this only removes the ones whose every linked agent has since
   * been archived, which are active tests with nowhere to run.
   */
  const testRows: readonly ListedTest[] =
    tests?.status === "ready"
      ? tests.value.items.filter((one) => activeAgents(one).length > 0)
      : [];

  /**
   * A choice that is no longer on offer is no choice at all.
   *
   * Changing the agent changes which connections and which tests exist, so
   * anything selected under the old agent is dropped rather than carried
   * forward — a connection of another agent would be refused on Start, and a
   * test that does not apply would be refused with it.
   */
  useEffect(() => {
    setConnectionId("");
    setChosen([]);
    setRefused(null);
  }, [agentId]);

  const selection = useMemo(
    () =>
      testRows
        .filter((one) => chosen.includes(one.id))
        .map((one) => one.version_id),
    [testRows, chosen],
  );

  const readyToPlan = agentId !== "" && connectionId !== "" && selection.length > 0;
  const { answer: plan, reload: replan } = useProjectRead<RunPlan>(
    readyToPlan
      ? runPlanQuery({ agentId, connectionId, testVersionIds: selection })
      : "",
    readyToPlan ? projectId : null,
  );

  async function start(): Promise<void> {
    const name = runName.trim();
    if (name === "") {
      setRunNameError("Enter a run name.");
      setConfirming(false);
      return;
    }
    if (!mayStart || starting || !readyToPlan) return;
    setConfirming(false);
    setRefused(null);
    setStarting(true);
    const written = await writeJson<StartedRun>(RUNS_PATH, {
      method: "POST",
      project: projectId,
      body: {
        agent: agentId,
        connection: connectionId,
        test_versions: [...selection],
        idempotency_key: idempotencyKey,
        label: name,
      },
    });
    if (written.status === "signed-out") {
      setStarting(false);
      window.location.replace("/sign-in");
      return;
    }
    if (written.status !== "ready") {
      setStarting(false);
      setRefused(written.refusal);
      return;
    }
    // Stay busy until the successful navigation unmounts this builder. If the
    // draft guard is re-enabled first, it mistakes the submitted run for an
    // unsaved edit and blocks the product's own redirect.
    router.push(projectPath(projectId, "runs", written.value.id));
  }

  if (agents === null) return <Loading what="the agents in this project" />;
  if (agents.status === "signed-out") {
    window.location.replace("/sign-in");
    return null;
  }
  if (agents.status !== "ready") {
    return (
      <Failure
        title="Egma could not list this project's agents."
        message={agents.refusal.message}
      />
    );
  }

  const active = agentRows.filter((one) => !one.archived);
  const planned = plan?.status === "ready" ? plan.value : null;
  const blocked = planned === null ? null : whyNotStartable(planned);

  function requestConfirmation(): void {
    if (runName.trim() === "") {
      setRunNameError("Enter a run name.");
      return;
    }
    setRunNameError(null);
    setConfirming(true);
  }

  return (
    <>
      <ProductPage>
        <PageHeader
          eyebrow="Simulation runs"
          title="Create a run"
          breadcrumbs={[
            { label: "Runs", href: projectPath(projectId, "runs") },
            { label: "New run" },
          ]}
          lead="Choose one agent, one connection and the tests to run."
          action={
            <ButtonLink href={projectPath(projectId, "runs")}>Cancel</ButtonLink>
          }
        />
        <PageBody>
          {mayStart ? null : (
            <Problem>
              Your role can read this page and cannot start a run. Ask an
              organization admin to change your role, then try again.
            </Problem>
          )}

          <div className={styles.builderLayout}>
            <ol className={styles.steps} aria-label="Run setup">
              <Step
                number={1}
                title="Agent"
                lead="Select the agent under test."
              >
                {active.length === 0 ? (
                  <Empty
                    title="This project has no active agent."
                    lead="Register an agent and give it a connection, then come back and create a run."
                  />
                ) : (
                  <Select
                    id="run-agent"
                    label="Agent"
                    value={agentId}
                    onChange={(next) => {
                      beginNewIntent();
                      setAgentId(next);
                    }}
                    options={[
                      { value: "", label: "Choose an agent" },
                      ...active.map((one) => ({
                        value: one.id,
                        label: one.name,
                      })),
                    ]}
                  />
                )}
              </Step>

              <Step
                number={2}
                title="Connection"
                lead="Select how Egma reaches the agent."
              >
                {agentId === "" ? (
                  <p>Choose an agent first.</p>
                ) : detail === null ? (
                  <Loading what="this agent's connections" />
                ) : detail.status === "signed-out" ? (
                  <Failure
                    title="This session has ended."
                    message="Sign in again, then create the run."
                  />
                ) : detail.status !== "ready" ? (
                  <Failure
                    title="Egma could not read this agent."
                    message={detail.refusal.message}
                  />
                ) : connections.length === 0 ? (
                  <Empty
                    title="This agent has no active connection."
                    lead="Add a connection on the agent's page, then come back and create a run."
                  />
                ) : (
                  <Select
                    id="run-connection"
                    label="Connection"
                    value={connectionId}
                    onChange={(next) => {
                      beginNewIntent();
                      setConnectionId(next);
                    }}
                    options={[
                      { value: "", label: "Choose a connection" },
                      ...connections.map((one) => ({
                        value: one.id,
                        label: connectionLabel(one),
                      })),
                    ]}
                  />
                )}
              </Step>

              <Step
                number={3}
                title="Tests"
                lead="Select the tests to run."
              >
                {agentId === "" ? (
                  <p>Choose an agent first.</p>
                ) : tests === null ? (
                  <Loading what="the tests that apply to this agent" />
                ) : tests.status === "signed-out" ? (
                  <Failure
                    title="This session has ended."
                    message="Sign in again, then create the run."
                  />
                ) : tests.status !== "ready" ? (
                  <Failure
                    title="Egma could not list the tests for this agent."
                    message={tests.refusal.message}
                  />
                ) : testRows.length === 0 ? (
                  <Empty
                    title="No active test applies to this agent."
                    lead="Link a test to this agent on the Tests page, then come back and create a run."
                  />
                ) : (
                  <TestChoices
                    tests={testRows}
                    chosen={chosen}
                    onChoose={(next) => {
                      beginNewIntent();
                      setChosen(next);
                    }}
                  />
                )}
              </Step>
            </ol>

            <section
              className={styles.startPanel}
              aria-labelledby="start-run-title"
            >
              <header className={styles.startHeader}>
                <h2 id="start-run-title">Start run</h2>
              </header>

              <div className={styles.runNameField}>
                <Field label="Run name" htmlFor="run-name">
                  <TextInput
                    id="run-name"
                    placeholder="Name this run"
                    value={runName}
                    required
                    invalid={runNameError !== null}
                    describedBy={runNameError === null ? undefined : "run-name-error"}
                    onChange={(next) => {
                      beginNewIntent();
                      setRunName(next);
                      if (next.trim() !== "") setRunNameError(null);
                    }}
                  />
                </Field>
                {runNameError === null ? null : (
                  <p className={styles.fieldError} id="run-name-error" role="alert">
                    {runNameError}
                  </p>
                )}
              </div>

              {!readyToPlan ? (
                <StartWaiting reason="Choose an agent, a connection and at least one test." />
              ) : plan === null ? (
                <StartWaiting reason="Reading this run…" busy />
              ) : plan.status === "signed-out" ? (
                <Failure
                  title="This session has ended."
                  message="Sign in again, then create the run."
                />
              ) : plan.status !== "ready" ? (
                <>
                  <Failure
                    title="Egma could not create this run."
                    message={plan.refusal.message}
                    onRetry={replan}
                  />
                  <StartWaiting reason="Egma must read this run before it can start." />
                </>
              ) : (
                <StartControls
                  plan={plan.value}
                  mayStart={mayStart}
                  starting={starting}
                  blocked={blocked}
                  refused={refused}
                  onStart={requestConfirmation}
                />
              )}
            </section>
          </div>
        </PageBody>
      </ProductPage>

      {confirming && planned !== null ? (
        <Dialog title="Start this run?" onClose={() => setConfirming(false)}>
          {(dismiss) => (
            <>
              <p className={styles.confirmationCopy}>
                {planned.runnable_simulation_count}{" "}
                {planned.runnable_simulation_count === 1
                  ? "simulation"
                  : "simulations"}{" "}
                will be conducted.
              </p>
              <div className={styles.confirmationActions}>
                <Button onClick={dismiss}>Cancel</Button>
                <Button weight="strong" busy={starting} onClick={() => void start()}>
                  Start run
                </Button>
              </div>
            </>
          )}
        </Dialog>
      ) : null}
    </>
  );
}

/** Every applicable test, kept in one compact list without a clipped table. */
function TestChoices({
  tests,
  chosen,
  onChoose,
}: {
  readonly tests: readonly ListedTest[];
  readonly chosen: readonly string[];
  readonly onChoose: (chosen: readonly string[]) => void;
}) {
  return (
    <div className={styles.selection}>
      <div className={styles.testActions} aria-label="Test selection">
        <Button onClick={() => onChoose(tests.map((test) => test.id))}>
          Select all
        </Button>
        <Button onClick={() => onChoose([])}>Clear all</Button>
      </div>
      <ul className={styles.testList} aria-label="Tests that apply to this agent">
        {tests.map((test) => {
          const inputId = `include-test-${test.id}`;
          return (
            <li className={styles.testChoice} key={test.id}>
              <Checkbox
                id={inputId}
                label={`Include ${test.name}`}
                checked={chosen.includes(test.id)}
                onChange={(checked) =>
                  onChoose(
                    checked
                      ? [...chosen, test.id]
                      : chosen.filter((one) => one !== test.id),
                  )
                }
              />
              <label className={styles.testChoiceCopy} htmlFor={inputId}>
                <span className={styles.testChoiceName}>{test.name}</span>
              </label>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** A stable final action while the choices or server plan are incomplete. */
function StartWaiting({
  reason,
  busy = false,
}: {
  readonly reason: string;
  readonly busy?: boolean;
}) {
  return (
    <div className={styles.startAction}>
      <Button weight="strong" disabled busy={busy} why={reason}>
        Start run
      </Button>
    </div>
  );
}

/** The final action, after the server has confirmed the selection can start. */
function StartControls({
  plan,
  mayStart,
  starting,
  blocked,
  refused,
  onStart,
}: {
  readonly plan: RunPlan;
  readonly mayStart: boolean;
  readonly starting: boolean;
  readonly blocked: string | null;
  readonly refused: Refusal | null;
  readonly onStart: () => void;
}) {
  return (
    <>
      {/*
       * A run that would judge nothing, said before it is started and never as
       * a refusal.
       *
       * A project's graders are all deletable, the seeded expected-behaviors
       * copy included, so a project judging with nothing is a decision somebody
       * took on the Graders screen rather than a state to protect them from.
       * What they are owed is the consequence in advance: this run happens,
       * records everything it sees, and comes back with no verdicts at all —
       * which on a results page looks very like everything having passed.
       */}
      {blocked === null && judgesNothing(plan) ? (
        <div className={styles.attention}>
          <p className={styles.attentionTitle}>Attention</p>
          <p>
            No grader is running in this project, so this run will conduct every
            simulation and come back with nothing judged. Press Use on a grader
            in the library to judge it.
          </p>
        </div>
      ) : null}

      {blocked === null ? null : <Refused message={blocked} />}
      {refused === null ? null : (
        <Refused message={refused.message} />
      )}

      <div className={styles.startAction}>
        <Button
          weight="strong"
          disabled={!mayStart || blocked !== null}
          busy={starting}
          why={
            !mayStart
              ? "Your role cannot start a run."
              : blocked === null
                ? undefined
                : "Resolve the refusal above before starting this run."
          }
          onClick={onStart}
        >
          {starting ? "Starting…" : "Start run"}
        </Button>
      </div>
    </>
  );
}
