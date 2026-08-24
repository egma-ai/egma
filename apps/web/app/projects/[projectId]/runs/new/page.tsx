"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  createRun,
  getAgent,
  listAgents,
  listTests,
  listTestSuites,
} from "@egma/platform-api/client";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import {
  type AgentDetail,
  type AgentPage,
  type ListedAgentWithConnections,
  type ListedConnection,
} from "../../../../../lib/agents.ts";
import type { Refusal } from "../../../../../lib/api.ts";
import { roleOf } from "../../../../../lib/me.ts";
import {
  platformAnswer,
  platformClient,
} from "../../../../../lib/platform-client.ts";
import { canAuthor } from "../../../../../lib/roles.ts";
import {
  shortSuiteId,
  type TestSuite,
  type TestSuitePage,
} from "../../../../../lib/test-suites.ts";
import type { TestPage } from "../../../../../lib/tests.ts";
import {
  Field,
  Form,
  FormActions,
  Help,
  Refused,
} from "../../../../../ui/form.tsx";
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

function connectionLabel(connection: ListedConnection): string {
  const environment = connection.environment === null ? "" : ` · ${connection.environment}`;
  return `${connection.name} · ${connection.productLabel} · ${connection.modality}${environment}`;
}

/**
 * One group of the builder: a legend, the sentence under it, and its fields.
 *
 * **A fieldset rather than the page-level `Section`.** The four groups are
 * parts of one form on one surface, not four blocks of a page: `Section`
 * carries a 24px title and 32px of its own room above it, which on a form
 * inside a card reads as four separate forms 52px apart. This is the shape the
 * grader editor already draws its four groups in — a hairline between, a 16px
 * legend — so the two forms in this product read as one.
 */
function Group({
  title,
  lead,
  children,
}: {
  readonly title: string;
  readonly lead?: string;
  readonly children: ReactNode;
}) {
  return (
    /*
     * **The hairline is on the wrapper and the fieldset carries none.** A
     * `<legend>` sits on its fieldset's top border and the browser drops the
     * border behind it, so a rule drawn on the fieldset would start to the
     * right of the group's name and never to the left of it.
     */
    <div className="min-w-0 not-first:border-t not-first:border-border not-first:pt-5">
      <fieldset className={cn("m-0 grid min-w-0 gap-4 border-0 p-0")}>
        <legend className="m-0 mb-1 p-0 text-base font-medium text-foreground">
          {title}
        </legend>
        {lead === undefined ? null : <Help>{lead}</Help>}
        {children}
      </fieldset>
    </div>
  );
}

function newRunIntentKey(): string {
  return `run:${globalThis.crypto.randomUUID()}`;
}

export default function NewRunPage() {
  const { projectId } = useParams<{ projectId: string }>();
  return (
    <AppShell>
      <RunBuilder projectId={projectId} />
    </AppShell>
  );
}

function RunBuilder({ projectId }: { readonly projectId: string }) {
  const router = useRouter();
  const { me } = useShellSession();
  const role = me === null ? null : roleOf(me);
  const mayStart = role !== null && canAuthor(role);
  const { answer: suitePage, reload: reloadSuites } = useProjectRead<TestSuitePage>(
    (projectId) =>
      platformAnswer(
        listTestSuites({ projectId }, { client: platformClient }),
      ),
    projectId,
  );
  const { answer: agentPage, reload: reloadAgents } = useProjectRead<AgentPage>(
    (projectId) =>
      platformAnswer(
        listAgents({ projectId }, { client: platformClient }),
      ),
    projectId,
  );

  const [suiteId, setSuiteId] = useState("");
  /** The suite the address asked for, until the loaded list confirms it. */
  const [wantedSuite, setWantedSuite] = useState("");
  const [agentId, setAgentId] = useState("");
  const [connectionId, setConnectionId] = useState("");
  const [name, setName] = useState("");
  const [idempotencyKey, setIdempotencyKey] = useState(newRunIntentKey);
  const [moreSuites, setMoreSuites] = useState<readonly TestSuite[]>([]);
  const [suiteCursor, setSuiteCursor] = useState<string | null>(null);
  const [moreAgents, setMoreAgents] = useState<readonly ListedAgentWithConnections[]>([]);
  const [agentCursor, setAgentCursor] = useState<string | null>(null);
  const [loadingSuites, setLoadingSuites] = useState(false);
  const [loadingAgents, setLoadingAgents] = useState(false);
  const [moreRefused, setMoreRefused] = useState<Refusal | null>(null);
  const [starting, setStarting] = useState(false);
  const [refused, setRefused] = useState<Refusal | null>(null);
  const showing = useRef(projectId);

  const { answer: agentDetail } = useProjectRead<AgentDetail>(
    (projectId) =>
      platformAnswer(
        getAgent(
          { agentId, projectId },
          { client: platformClient },
        ),
      ),
    agentId === "" ? null : projectId,
    agentId,
  );
  const { answer: suiteTests } = useProjectRead<TestPage>(
    (projectId) =>
      platformAnswer(
        listTests(
          { suiteId, projectId },
          { client: platformClient },
        ),
      ),
    suiteId === "" ? null : projectId,
    suiteId,
  );

  function beginNewIntent(): void {
    setIdempotencyKey(newRunIntentKey());
    setRefused(null);
  }

  /**
   * The two records this page can be opened *about*, read out of the address.
   *
   * A suite page's "Run suite" and an agent page's "Run this agent" both land
   * here, and both name what they came from. Neither is trusted: the value is
   * matched against what this project can actually see, further down, and a
   * parameter naming something else simply selects nothing — which is how the
   * agent parameter has always behaved and is the only safe reading of an
   * identifier somebody can type into a URL bar.
   */
  useEffect(() => {
    showing.current = projectId;
    const address = new URLSearchParams(window.location.search);
    const selected = address.get("agent")?.trim() ?? "";
    setWantedSuite(address.get("suite")?.trim() ?? "");
    setSuiteId("");
    setAgentId(selected);
    setConnectionId("");
    setName("");
    setMoreSuites([]);
    setSuiteCursor(null);
    setMoreAgents([]);
    setAgentCursor(null);
    setMoreRefused(null);
    setRefused(null);
    setIdempotencyKey(newRunIntentKey());
  }, [projectId]);

  useEffect(() => {
    if (suitePage?.status === "ready") {
      setSuiteCursor(suitePage.value.nextPageToken);
    }
  }, [suitePage]);

  /**
   * The suite the address asked for, selected once this project has confirmed
   * it exists — and never otherwise.
   *
   * The check is against the suites already loaded rather than a read of its
   * own, so an identifier belonging to another project, or to nothing, leaves
   * the field on "Choose a test suite" instead of putting a name on screen
   * that the person cannot open. A suite that has not been paged to yet is
   * picked up the moment "Load more suites" brings it in, because the ask is
   * held until it is answered.
   */
  useEffect(() => {
    if (wantedSuite === "" || suitePage?.status !== "ready") return;
    const known = [...suitePage.value.testSuites, ...moreSuites].some(
      (suite) => suite.id === wantedSuite,
    );
    if (!known) return;
    setSuiteId(wantedSuite);
    setWantedSuite("");
    setIdempotencyKey(newRunIntentKey());
  }, [wantedSuite, suitePage, moreSuites]);

  useEffect(() => {
    if (agentPage?.status === "ready") {
      setAgentCursor(agentPage.value.nextPageToken);
    }
  }, [agentPage]);

  useEffect(() => {
    if (
      suitePage?.status === "signed-out" ||
      agentPage?.status === "signed-out" ||
      agentDetail?.status === "signed-out" ||
      suiteTests?.status === "signed-out"
    ) {
      window.location.replace("/sign-in");
    }
  }, [suitePage, agentPage, agentDetail, suiteTests]);

  useEffect(() => {
    setConnectionId("");
  }, [agentId]);

  useUnsavedChanges(
    suiteId !== "" || agentId !== "" || connectionId !== "" || name !== "",
    starting,
  );

  async function loadMoreSuites(): Promise<void> {
    if (suiteCursor === null || loadingSuites) return;
    setLoadingSuites(true);
    setMoreRefused(null);
    const next = await platformAnswer(
      listTestSuites(
        { projectId, pageToken: suiteCursor },
        { client: platformClient },
      ),
    );
    setLoadingSuites(false);
    if (showing.current !== projectId) return;
    if (next.status === "signed-out") {
      window.location.replace("/sign-in");
      return;
    }
    if (next.status !== "ready") {
      setMoreRefused(next.refusal);
      return;
    }
    setMoreSuites((held) => [...held, ...next.value.testSuites]);
    setSuiteCursor(next.value.nextPageToken);
  }

  async function loadMoreAgents(): Promise<void> {
    if (agentCursor === null || loadingAgents) return;
    setLoadingAgents(true);
    setMoreRefused(null);
    const next = await platformAnswer(
      listAgents(
        { projectId, pageToken: agentCursor },
        { client: platformClient },
      ),
    );
    setLoadingAgents(false);
    if (showing.current !== projectId) return;
    if (next.status === "signed-out") {
      window.location.replace("/sign-in");
      return;
    }
    if (next.status !== "ready") {
      setMoreRefused(next.refusal);
      return;
    }
    setMoreAgents((held) => [...held, ...next.value.agents]);
    setAgentCursor(next.value.nextPageToken);
  }

  async function start(): Promise<void> {
    if (
      !mayStart ||
      starting ||
      suiteId === "" ||
      !suiteHasTests ||
      agentId === "" ||
      connectionId === ""
    ) {
      return;
    }
    setStarting(true);
    setRefused(null);
    const trimmedName = name.trim();
    const written = await platformAnswer(
      createRun(
        {
        projectId,
        suiteId,
        agentId,
        connectionId,
        idempotencyKey,
        ...(trimmedName === "" ? {} : { name: trimmedName }),
        },
        { client: platformClient },
      ),
    );
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
    router.push(`/projects/${encodeURIComponent(projectId)}/runs/${encodeURIComponent(written.value.id)}`);
  }

  if (suitePage === null || agentPage === null) {
    return <Loading what="test suites and agents" />;
  }
  if (suitePage.status === "signed-out" || agentPage.status === "signed-out") return null;
  if (suitePage.status !== "ready") {
    return (
      <Failure
        title="Egma could not list this project's test suites."
        message={suitePage.refusal.message}
        onRetry={reloadSuites}
      />
    );
  }
  if (agentPage.status !== "ready") {
    return (
      <Failure
        title="Egma could not list this project's agents."
        message={agentPage.refusal.message}
        onRetry={reloadAgents}
      />
    );
  }

  const suites = [...suitePage.value.testSuites, ...moreSuites];
  const suiteNameCounts = new Map<string, number>();
  for (const suite of suites) {
    suiteNameCounts.set(suite.name, (suiteNameCounts.get(suite.name) ?? 0) + 1);
  }
  const agents = [...agentPage.value.agents, ...moreAgents].filter((agent) => !agent.archived);
  const connections =
    agentDetail?.status === "ready"
      ? agentDetail.value.connections.filter((connection) => !connection.archived)
      : [];
  const emptySuite =
    suiteTests?.status === "ready" &&
    suiteTests.value.tests.length === 0 &&
    suiteTests.value.nextPageToken === null;
  const suiteHasTests =
    suiteTests?.status === "ready" &&
    (suiteTests.value.tests.length > 0 || suiteTests.value.nextPageToken !== null);
  const ready =
    suiteId !== "" &&
    suiteHasTests &&
    agentId !== "" &&
    connectionId !== "";
  const whyNot = !mayStart
    ? "Your role cannot start a run."
    : emptySuite
      ? "This test suite is empty. Write at least one test before starting a run."
    : !ready
      ? "Choose one test suite, one agent, and one connection."
      : undefined;

  return (
    <ProductPage>
      <PageHeader
        title="Create a run"
        breadcrumbs={[
          { label: "Simulation runs", href: `/projects/${encodeURIComponent(projectId)}/runs` },
          { label: "New run" },
        ]}
        lead="Run every current test in one suite against one agent and one connection."
      />
      <PageBody>
        {/*
          **One form on one Pure Paper surface**, which is what `DESIGN.md`
          asks of a page that groups fields — and what the shared `Form`
          already draws, first group flush with its top edge. The page used to
          stack four bare sections straight onto the canvas, each paying its
          own top margin over a wrapper's gap, so the groups sat 64px apart on
          no surface at all.
        */}
        <Form onSubmit={() => void start()}>
          {suites.length === 0 ? (
            <Empty
              title="This project has no test suite"
              lead="Create a test suite before you start a run."
              action={
                <Button asChild variant="secondary">
                  <Link href={`/projects/${encodeURIComponent(projectId)}/tests`}>Open test suites</Link>
                </Button>
              }
            />
          ) : (
            <Group
              title="Test suite"
              lead="Egma runs the full suite. Individual tests cannot be picked here."
            >
              <Field label="Test suite" htmlFor="run-suite">
                <Select
                  id="run-suite"
                  value={suiteId}
                  onChange={(event) => {
                    beginNewIntent();
                    setSuiteId(event.target.value);
                  }}
                >
                  <option value="">Choose a test suite</option>
                  {suites.map((suite) => {
                    const duplicate = (suiteNameCounts.get(suite.name) ?? 0) > 1;
                    return (
                      <option key={suite.id} value={suite.id}>
                        {duplicate ? `${suite.name} · ${shortSuiteId(suite.id)}` : suite.name}
                      </option>
                    );
                  })}
                </Select>
              </Field>
              {suiteId !== "" && suiteTests === null ? (
                <Loading what="this suite's tests" />
              ) : emptySuite ? (
                <Refused message="This test suite is empty. Write at least one test before starting a run." />
              ) : suiteTests !== null &&
                suiteTests.status !== "ready" &&
                suiteTests.status !== "signed-out" ? (
                <Failure message={suiteTests.refusal.message} />
              ) : null}
              {suiteCursor === null ? null : (
                <Button
                  type="button"
                  variant="secondary"
                  busy={loadingSuites}
                  onClick={() => void loadMoreSuites()}
                >
                  {loadingSuites ? "Loading…" : "Load more suites"}
                </Button>
              )}
            </Group>
          )}

          <Group title="Agent" lead="Choose the agent under test.">
            {agents.length === 0 ? (
              <Empty title="This project has no active agent" />
            ) : (
              <>
                <Field label="Agent" htmlFor="run-agent">
                  <Select
                    id="run-agent"
                    value={agentId}
                    onChange={(event) => {
                      beginNewIntent();
                      setAgentId(event.target.value);
                    }}
                  >
                    <option value="">Choose an agent</option>
                    {agents.map((agent) => (
                      <option key={agent.id} value={agent.id}>{agent.name}</option>
                    ))}
                  </Select>
                </Field>
                {agentCursor === null ? null : (
                  <Button
                    type="button"
                    variant="secondary"
                    busy={loadingAgents}
                    onClick={() => void loadMoreAgents()}
                  >
                    {loadingAgents ? "Loading…" : "Load more agents"}
                  </Button>
                )}
              </>
            )}
          </Group>

          <Group title="Connection" lead="Choose how Egma reaches this agent.">
            {agentId === "" ? (
              <p className="m-0 text-sm text-muted-foreground">Choose an agent first.</p>
            ) : agentDetail === null ? (
              <Loading what="this agent's connections" />
            ) : agentDetail.status === "ready" && connections.length > 0 ? (
              <Field label="Connection" htmlFor="run-connection">
                <Select
                  id="run-connection"
                  value={connectionId}
                  onChange={(event) => {
                    beginNewIntent();
                    setConnectionId(event.target.value);
                  }}
                >
                  <option value="">Choose a connection</option>
                  {connections.map((connection) => (
                    <option key={connection.id} value={connection.id}>
                      {connectionLabel(connection)}
                    </option>
                  ))}
                </Select>
              </Field>
            ) : agentDetail.status === "ready" ? (
              <Empty title="This agent has no active connection" />
            ) : agentDetail.status === "signed-out" ? null : (
              <Failure message={agentDetail.refusal.message} />
            )}
          </Group>

          <Group title="Run details">
            <Field label="Run name (optional)" htmlFor="run-name">
              <Input
                id="run-name"
                value={name}
                placeholder="Pre-release check"
                autoComplete="off"
                spellCheck={false}
                onChange={(event) => {
                  beginNewIntent();
                  setName(event.target.value);
                }}
              />
            </Field>
            <Help>Leave this blank and Egma will use the test suite name.</Help>
          </Group>

          {moreRefused === null ? null : <Refused message={moreRefused.message} />}
          {refused === null ? null : <Refused message={refused.message} />}
          {/*
            The answer and the way out, together at the leading edge — the
            footer shape `7DA-0` draws on every panel in this product. `Start
            run` is the wash primary and a real submit, so the return key in
            the name field starts the run rather than doing nothing.
          */}
          <FormActions>
            <Button
              type="submit"
              disabled={!mayStart || !ready}
              busy={starting}
              why={whyNot}
            >
              {starting ? "Starting…" : "Start run"}
            </Button>
            <Button asChild variant="secondary">
              <Link href={`/projects/${encodeURIComponent(projectId)}/runs`}>
                Cancel
              </Link>
            </Button>
          </FormActions>
        </Form>
      </PageBody>
    </ProductPage>
  );
}
