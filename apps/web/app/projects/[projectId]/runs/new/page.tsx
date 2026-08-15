"use client";

import { useParams, useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";

import { readJson, sendJson, type Refusal } from "../../../../../lib/api.ts";
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
  plannedSimulationCount,
  preselectedAgent,
  runPlanQuery,
  RUNS_PATH,
  skipExplanation,
  whyNotStartable,
  type PlanGrader,
  type PlannedTest,
  type RunPlan,
  type StartedRun,
} from "../../../../../lib/runs.ts";
import {
  activeAgents,
  testsPath,
  testVersionsPath,
  type ListedTest,
  type TestPage,
  type TestVersionPage,
} from "../../../../../lib/tests.ts";
import {
  Badge,
  Button,
  ButtonLink,
  Facts,
  Field,
  Problem,
  Refused,
  Section,
  Select,
  TextInput,
} from "../../../../../ui/controls.tsx";
import { DataTable, type Column } from "../../../../../ui/data-table.tsx";
import { Empty, Failure, Loading } from "../../../../../ui/page-state.tsx";
import { useProjectRead } from "../../../../../ui/resource.ts";
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
 * at which versions, and whether the project has a judge at all — all of it is
 * `GET /api/run-plan`, which is the same resolution `POST /api/runs` performs.
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

/** One numbered step, and whether the choice under it has been made. */
function Step({
  number,
  title,
  lead,
  done,
  children,
}: {
  readonly number: number;
  readonly title: string;
  readonly lead?: string;
  readonly done: boolean;
  readonly children: React.ReactNode;
}) {
  return (
    <div className={styles.step}>
      <div
        className={`${styles.stepNumber} ${done ? styles.stepNumberDone : ""}`}
        aria-hidden="true"
      >
        {number}
      </div>
      <div className={styles.stepBody}>
        <Section title={title} lead={lead}>
          {children}
        </Section>
      </div>
    </div>
  );
}

/** How a connection reads in the chooser: what it is, and where it points. */
function connectionLabel(connection: ListedConnection): string {
  const where =
    connection.environment === null ? "" : ` · ${connection.environment}`;
  return `${connection.name} · ${connection.type} · ${connection.modality}${where}`;
}

/** One grader a run would freeze, said in a line. */
function graderLine(grader: PlanGrader): {
  readonly name: string;
  readonly note: string;
} {
  if (grader.kind === "built_in") {
    return {
      name: "Expected behaviors",
      note: `built in · engine ${grader.engine_version} · one verdict per behavior, each at its own priority`,
    };
  }
  const origin =
    grader.origin === "scenario_specific"
      ? "on this test"
      : "project default";
  const judge =
    grader.judge.tag === "configured"
      ? `${grader.judge.provider}/${grader.judge.model}`
      : grader.judge.tag === "not_required"
        ? "no judge needed"
        : "no judge recorded";
  return {
    name: grader.name,
    note: `${origin} · ${grader.priority} · ${judge}`,
  };
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
  useEffect(() => {
    const named = preselectedAgent(window.location.search);
    if (named !== null) setAgentId(named);
  }, []);

  const [connectionId, setConnectionId] = useState("");
  const [chosen, setChosen] = useState<readonly string[]>([]);
  const [label, setLabel] = useState("");

  /**
   * Which test row has its detail panel open, what its history read answered,
   * and whatever went wrong reading it.
   *
   * **All three belong to the open row, and all three are cleared when a
   * different row opens.** The panel is drawn once, under the table, because a
   * table draws every row twice — once wide and once narrow — so a panel inside
   * a cell would be two panels over one piece of state. That makes every value
   * here shared by every row, and each one is a different way of showing
   * somebody the wrong thing:
   *
   * - `history` would put one test's versions under another test's heading, and
   *   the heading is the only thing on screen saying which test it is.
   * - `openFailure` is worse, because it survives a closed panel and carries a
   *   *Try again* bound to the row that failed. Left behind, pressing it reads
   *   the old test again and draws its answer under the new one — a wrong
   *   reading, attributed to a test nobody asked about, reported as a success.
   *
   * Clearing the first does not clear the second, which is exactly why they are
   * two lines rather than one.
   */
  const [openTest, setOpenTest] = useState<string | null>(null);
  const [history, setHistory] = useState<TestVersionPage | null>(null);
  const [openFailure, setOpenFailure] = useState<{
    readonly message: string;
    readonly again: () => void;
  } | null>(null);

  /**
   * The open test's version history, read when a row opens.
   *
   * It answers the one question a review cannot answer for itself: whether the
   * version this run would pin is the one somebody last looked at. The read is
   * per row because history is per test, and it is what makes the panel's state
   * genuinely the open row's rather than the page's.
   */
  async function readHistory(testId: string): Promise<void> {
    const answered = await readJson<TestVersionPage>(
      testVersionsPath(testId),
      { project: projectId },
    );
    if (answered.status === "signed-out") {
      window.location.replace("/sign-in");
      return;
    }
    if (answered.status !== "ready") {
      setOpenFailure({
        message: answered.refusal.message,
        again: () => void readHistory(testId),
      });
      return;
    }
    // **Cleared on the way in and not on the way out**, deliberately: a read
    // that has not answered yet has cleared nothing, so a row opened while a
    // previous row's failure is on screen must be cleared by whoever changed
    // the row rather than by whoever eventually answers.
    setOpenFailure(null);
    setHistory(answered.value);
  }

  const [starting, setStarting] = useState(false);
  const [refused, setRefused] = useState<Refusal | null>(null);

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
    setOpenTest(null);
    setOpenFailure(null);
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

  /**
   * The word this attempt is remembered by.
   *
   * **One key per selection, and a new one when the selection changes.** Sending
   * the same request twice under one key answers the original run; sending a
   * different selection under it is refused out loud. So the key has to move
   * exactly when the request does, which is what tying it to the selection
   * does — and what makes a second click, or a browser retrying a request whose
   * answer was lost, land on the run that already exists.
   */
  const idempotencyKey = useMemo(() => {
    if (!readyToPlan) return "";
    return `run:${agentId}:${connectionId}:${[...selection].join(",")}`;
  }, [readyToPlan, agentId, connectionId, selection]);

  async function start(): Promise<void> {
    if (!mayStart || starting || !readyToPlan) return;
    setRefused(null);
    setStarting(true);
    const written = await sendJson<StartedRun>(RUNS_PATH, {
      method: "POST",
      project: projectId,
      body: {
        agent: agentId,
        connection: connectionId,
        test_versions: [...selection],
        idempotency_key: idempotencyKey,
        ...(label.trim() === "" ? {} : { label: label.trim() }),
      },
    });
    setStarting(false);
    if (written.status === "signed-out") {
      window.location.replace("/sign-in");
      return;
    }
    if (written.status !== "ready") {
      setRefused(written.refusal);
      return;
    }
    router.push(projectPath(projectId, "runs"));
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

  return (
    <ProductPage>
      <PageHeader
        eyebrow="Runs"
        title="Plan a run"
        lead="A run executes a selection of tests against one agent over one connection. Every simulation it produces is pinned to the exact test, persona and grader versions egma froze when it started."
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

        <div className={styles.steps}>
          <Step
            number={1}
            title="Agent"
            lead="The agent under test. It decides which connections and which tests are available below."
            done={agentId !== ""}
          >
            {active.length === 0 ? (
              <Empty
                title="This project has no active agent."
                lead="Register an agent and give it a connection, then come back and plan a run."
              />
            ) : (
              <Field label="Agent" htmlFor="run-agent">
                <Select
                  id="run-agent"
                  value={agentId}
                  onChange={setAgentId}
                  options={[
                    { value: "", label: "Choose an agent" },
                    ...active.map((one) => ({ value: one.id, label: one.name })),
                  ]}
                />
              </Field>
            )}
          </Step>

          <Step
            number={2}
            title="Connection"
            lead="How egma reaches the agent. The modality, the environment and the transport are all this choice, and what it was measured to support decides which tests can run."
            done={connectionId !== ""}
          >
            {agentId === "" ? (
              <p>Choose an agent first.</p>
            ) : detail === null ? (
              <Loading what="this agent's connections" />
            ) : detail.status === "signed-out" ? (
              <Failure
                title="This session has ended."
                message="Sign in again, then plan the run."
              />
            ) : detail.status !== "ready" ? (
              <Failure
                title="Egma could not read this agent."
                message={detail.refusal.message}
              />
            ) : connections.length === 0 ? (
              <Empty
                title="This agent has no active connection."
                lead="Add a connection on the agent's page, then come back and plan a run."
              />
            ) : (
              <Field label="Connection" htmlFor="run-connection">
                <Select
                  id="run-connection"
                  value={connectionId}
                  onChange={setConnectionId}
                  options={[
                    { value: "", label: "Choose a connection" },
                    ...connections.map((one) => ({
                      value: one.id,
                      label: connectionLabel(one),
                    })),
                  ]}
                />
              </Field>
            )}
          </Step>

          <Step
            number={3}
            title="Tests"
            lead="Only the project's active tests that apply to this agent. A test that does not apply cannot start against it, so it is not offered."
            done={selection.length > 0}
          >
            {agentId === "" ? (
              <p>Choose an agent first.</p>
            ) : tests === null ? (
              <Loading what="the tests that apply to this agent" />
            ) : tests.status === "signed-out" ? (
              <Failure
                title="This session has ended."
                message="Sign in again, then plan the run."
              />
            ) : tests.status !== "ready" ? (
              <Failure
                title="Egma could not list the tests for this agent."
                message={tests.refusal.message}
              />
            ) : testRows.length === 0 ? (
              <Empty
                title="No active test applies to this agent."
                lead="Link a test to this agent on the Tests page, then come back and plan a run."
              />
            ) : (
              <TestChoices
                tests={testRows}
                chosen={chosen}
                onChoose={setChosen}
                openTest={openTest}
                onOpen={(testId) => {
                  // One panel under the table means one `history` and one
                  // `openFailure` for every row, so opening a different row has
                  // to empty both.
                  //
                  // `history`: another test's versions would sit under this
                  // test's heading, and the heading is the only thing on screen
                  // saying which test the panel is about.
                  //
                  // `openFailure`: worse, because it survives a closed panel.
                  // Its `again` is bound to the row that failed, so pressing it
                  // here reads that row again and draws its history under this
                  // one — a wrong reading, attributed to a test nobody asked
                  // about, and reported as a success.
                  setHistory(null);
                  setOpenFailure(null);
                  const opening = openTest === testId ? null : testId;
                  setOpenTest(opening);
                  if (opening !== null) void readHistory(opening);
                }}
                history={history}
                plan={planned}
                planLoading={readyToPlan && plan === null}
                failure={openFailure}
              />
            )}
          </Step>

          <Step
            number={4}
            title="Review"
            lead="Exactly what egma would freeze, and what it would not conduct. Nothing here is decided by this page: it is the same resolution the start performs."
            done={planned !== null && blocked === null}
          >
            {!readyToPlan ? (
              <p>Choose an agent, a connection and at least one test.</p>
            ) : plan === null ? (
              <Loading what="what this run would freeze" />
            ) : plan.status === "signed-out" ? (
              <Failure
                title="This session has ended."
                message="Sign in again, then plan the run."
              />
            ) : plan.status !== "ready" ? (
              <Failure
                title="Egma could not plan this run."
                message={plan.refusal.message}
                onRetry={replan}
              />
            ) : (
              <Review
                plan={plan.value}
                label={label}
                onLabel={setLabel}
                mayStart={mayStart}
                starting={starting}
                blocked={blocked}
                refused={refused}
                onStart={() => void start()}
              />
            )}
          </Step>
        </div>
      </PageBody>
    </ProductPage>
  );
}

/**
 * The tests on offer, with the one open row's detail drawn once beneath them.
 *
 * The detail is what the plan says about that test — the version that would be
 * pinned, who would call at which persona version, and every grader that would
 * judge it. It is read off the plan rather than fetched per row, so the panel
 * and the review can never disagree.
 */
function TestChoices({
  tests,
  chosen,
  onChoose,
  openTest,
  onOpen,
  history,
  plan,
  planLoading,
  failure,
}: {
  readonly tests: readonly ListedTest[];
  readonly chosen: readonly string[];
  readonly onChoose: (chosen: readonly string[]) => void;
  readonly openTest: string | null;
  readonly onOpen: (testId: string) => void;
  /** The open row's versions, and nobody else's. */
  readonly history: TestVersionPage | null;
  readonly plan: RunPlan | null;
  readonly planLoading: boolean;
  readonly failure: {
    readonly message: string;
    readonly again: () => void;
  } | null;
}) {
  const columns: readonly Column<ListedTest>[] = [
    {
      key: "chosen",
      header: "",
      width: "44px",
      cell: (test) => (
        <input
          type="checkbox"
          aria-label={`Include ${test.name}`}
          checked={chosen.includes(test.id)}
          onChange={() =>
            onChoose(
              chosen.includes(test.id)
                ? chosen.filter((one) => one !== test.id)
                : [...chosen, test.id],
            )
          }
        />
      ),
    },
    {
      key: "name",
      header: "Test",
      primary: true,
      cell: (test) => test.name,
    },
    {
      key: "personas",
      header: "Personas",
      width: "150px",
      cell: (test) => test.personas.map((one) => one.name).join(", "),
    },
    {
      key: "version",
      header: "Version",
      mono: true,
      width: "90px",
      cell: (test) => `v${test.version}`,
    },
    {
      key: "requires",
      header: "Requires",
      width: "160px",
      cell: (test) =>
        test.required_capabilities.length === 0
          ? "—"
          : test.required_capabilities.join(", "),
    },
    {
      key: "detail",
      header: "",
      width: "110px",
      cell: (test) => (
        <Button onClick={() => onOpen(test.id)}>
          {openTest === test.id ? "Hide" : "Details"}
        </Button>
      ),
    },
  ];

  const opened = tests.find((one) => one.id === openTest);
  const planned =
    opened === undefined
      ? undefined
      : plan?.tests.find((one) => one.test_id === opened.id);

  return (
    <div className={styles.selection}>
      <DataTable
        label="Tests that apply to this agent"
        columns={columns}
        rows={tests}
        keyOf={(test) => test.id}
      />

      {/*
       * Drawn once, under the table, for whichever row is open — never inside a
       * cell. A table draws every row twice, once wide and once narrow, so a
       * panel living in a cell would be two panels over one piece of state.
       */}
      {opened === undefined ? null : (
        <div className={styles.openRow}>
          <h3 className={styles.openRowTitle}>{opened.name}</h3>
          {failure === null ? null : (
            <Failure
              title="Egma could not read this test's history."
              message={failure.message}
              onRetry={failure.again}
            />
          )}
          <p className={styles.graderNote}>
            {history === null
              ? failure === null
                ? "Reading this test's version history…"
                : "No version history read."
              : `${String(history.items.length)} ${
                  history.items.length === 1 ? "version" : "versions"
                }; this run would pin v${String(
                  history.items.find((one) => one.current)?.version ??
                    opened.version,
                )}.`}
          </p>
          {planned === undefined ? (
            <p>
              {planLoading
                ? "Reading what this test would freeze…"
                : "Choose this test to see the versions and graders a run would freeze for it."}
            </p>
          ) : (
            <PlannedTestDetail planned={planned} />
          )}
        </div>
      )}
    </div>
  );
}

/** What one selected test would freeze, exactly as the plan answered it. */
function PlannedTestDetail({ planned }: { readonly planned: PlannedTest }) {
  return (
    <>
      <Facts
        facts={[
          { label: "Test version", value: planned.test_version_id },
          {
            label: "Personas",
            value: planned.personas
              .map((one) => `${one.name} (${one.persona_version_id})`)
              .join(", "),
          },
          {
            label: "Requires",
            value:
              planned.required_capabilities.length === 0
                ? "nothing of the connection"
                : planned.required_capabilities.join(", "),
          },
        ]}
      />
      {planned.skip === null ? null : (
        <Problem>{skipExplanation(planned.skip)}</Problem>
      )}
      <ul className={styles.graders}>
        {planned.graders.map((grader) => {
          const line = graderLine(grader);
          return (
            <li
              className={styles.grader}
              key={
                grader.kind === "built_in"
                  ? grader.grader_key
                  : grader.grader_id
              }
            >
              <span className={styles.graderName}>{line.name}</span>
              <span className={styles.graderNote}>{line.note}</span>
            </li>
          );
        })}
      </ul>
    </>
  );
}

/** The review step: what would be frozen, what would be skipped, and Start. */
function Review({
  plan,
  label,
  onLabel,
  mayStart,
  starting,
  blocked,
  refused,
  onStart,
}: {
  readonly plan: RunPlan;
  readonly label: string;
  readonly onLabel: (label: string) => void;
  readonly mayStart: boolean;
  readonly starting: boolean;
  readonly blocked: string | null;
  readonly refused: Refusal | null;
  readonly onStart: () => void;
}) {
  return (
    <>
      <div className={styles.tally}>
        <div className={styles.tallyItem}>
          <span className={styles.tallyNumber}>
            {plannedSimulationCount(plan)}
          </span>
          <span className={styles.tallyLabel}>simulations planned</span>
        </div>
        <div className={styles.tallyItem}>
          <span className={styles.tallyNumber}>
            {plan.runnable_simulation_count}
          </span>
          <span className={styles.tallyLabel}>would be conducted</span>
        </div>
        <div className={styles.tallyItem}>
          <span className={styles.tallyNumber}>
            {plan.skipped_simulation_count}
          </span>
          <span className={styles.tallyLabel}>
            would be skipped, not failed
          </span>
        </div>
      </div>

      <Facts
        facts={[
          {
            label: "Connection",
            value: `${plan.connection.type} · ${plan.connection.modality}${
              plan.connection.environment === null
                ? ""
                : ` · ${plan.connection.environment}`
            }`,
          },
          {
            label: "Capabilities",
            value:
              plan.connection.capabilities.state === "unknown" ? (
                <Badge tone="warn">
                  Unknown — nobody has measured this connection
                </Badge>
              ) : (
                `measured ${plan.connection.capabilities.measured.join(", ") || "nothing"}; supports ${
                  plan.connection.capabilities.supported.join(", ") || "nothing"
                }`
              ),
          },
          {
            label: "Judge",
            value:
              plan.judge.state === "needs_setup" ? (
                <Badge tone="bad">Not configured</Badge>
              ) : (
                `${plan.judge.provider}/${plan.judge.model} · ${
                  plan.judge.source === "platform"
                    ? "this deployment's own key"
                    : `credential ${plan.judge.source}`
                }`
              ),
          },
        ]}
      />

      {/*
       * Every selected test, said in full, in the review itself.
       *
       * It belongs here rather than only in the open row's panel because the
       * panel shows one test at a time and somebody about to press Start is
       * approving all of them. The exact version that would be pinned, the
       * exact persona version each conversation would carry, every grader that
       * would judge it at the version it would be frozen at — and, where egma
       * would conduct nothing, the reason, said as a skip and never as a
       * failure of the agent.
       */}
      {plan.tests.map((one) => (
        <Section key={one.test_version_id} title={one.test_name}>
          <PlannedTestDetail planned={one} />
        </Section>
      ))}

      <Field
        label="Label"
        htmlFor="run-label"
        hint="Optional. Something to recognise this run by in the list."
      >
        <TextInput id="run-label" value={label} onChange={onLabel} />
      </Field>

      {blocked === null ? null : <Problem>{blocked}</Problem>}
      {refused === null ? null : (
        <Refused message={refused.message} />
      )}

      <Button
        weight="strong"
        disabled={!mayStart || starting || blocked !== null}
        onClick={onStart}
      >
        {starting ? "Starting…" : "Start run"}
      </Button>
    </>
  );
}
