"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import {
  createRun,
  getAgent,
  listAgents,
  listTests,
  listTestSuites,
} from "@egma/platform-api/client";

import { Button } from "@/components/ui/button";
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
import { Field, Help, Refused } from "../../../../../ui/form.tsx";
import { Empty, Failure, Loading } from "../../../../../ui/page-state.tsx";
import { useProjectRead } from "../../../../../ui/resource.ts";
import { Actions, Section } from "../../../../../ui/section.tsx";
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

  useEffect(() => {
    showing.current = projectId;
    const selected = new URLSearchParams(window.location.search).get("agent")?.trim() ?? "";
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
        action={
          <Button asChild variant="secondary">
            <Link href={`/projects/${encodeURIComponent(projectId)}/runs`}>Cancel</Link>
          </Button>
        }
      />
      <PageBody>
        <div className="flex flex-col gap-8">
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
            <Section title="Test suite" lead="Egma runs the full suite. Individual tests cannot be picked here.">
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
            </Section>
          )}

          <Section title="Agent" lead="Choose the agent under test.">
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
          </Section>

          <Section title="Connection" lead="Choose how Egma reaches this agent.">
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
          </Section>

          <Section title="Run details">
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
          </Section>

          {moreRefused === null ? null : <Refused message={moreRefused.message} />}
          {refused === null ? null : <Refused message={refused.message} />}
          <Actions>
            <Button
              type="button"
              disabled={!mayStart || !ready}
              busy={starting}
              why={whyNot}
              onClick={() => void start()}
            >
              {starting ? "Starting…" : "Start run"}
            </Button>
          </Actions>
        </div>
      </PageBody>
    </ProductPage>
  );
}
