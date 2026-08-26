"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { XIcon } from "lucide-react";
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
  Sheet,
  SheetBody,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetTitle,
} from "@/components/ui/sheet";
import type {
  AgentDetail,
  AgentPage,
  ListedAgentWithConnections,
} from "../../../../lib/agents.ts";
import type { Refusal } from "../../../../lib/api.ts";
import { useDraftNavigation } from "../../../../ui/draft-navigation.tsx";
import { roleOf } from "../../../../lib/me.ts";
import {
  platformAnswer,
  platformClient,
} from "../../../../lib/platform-client.ts";
import { canAuthor } from "../../../../lib/roles.ts";
import {
  shortSuiteId,
  type TestSuite,
  type TestSuitePage,
} from "../../../../lib/test-suites.ts";
import type { TestPage } from "../../../../lib/tests.ts";
import { Field, Refused } from "../../../../ui/form.tsx";
import { Empty, Failure, Loading } from "../../../../ui/page-state.tsx";
import { useProjectRead } from "../../../../ui/resource.ts";
import { useUnsavedChanges } from "../../../../ui/settings-read.ts";
import { useShellSession } from "../../../../ui/shell.tsx";

function newRunIntentKey(): string {
  return `run:${globalThis.crypto.randomUUID()}`;
}

export function CreateRunSheet({
  projectId,
  initialAgentPage,
  onClose,
}: {
  readonly projectId: string;
  readonly initialAgentPage?: AgentPage;
  readonly onClose?: () => void;
}) {
  const router = useRouter();
  const draftNavigation = useDraftNavigation();
  const listPath = `/projects/${encodeURIComponent(projectId)}/runs`;
  const { me } = useShellSession();
  const role = me === null ? null : roleOf(me);
  const mayStart = role !== null && canAuthor(role);
  const { answer: suitePage, reload: reloadSuites } =
    useProjectRead<TestSuitePage>(
      (projectId) =>
        platformAnswer(
          listTestSuites({ projectId }, { client: platformClient }),
        ),
      projectId,
    );
  const { answer: readAgentPage, reload: reloadAgents } = useProjectRead<AgentPage>(
    (projectId) =>
      platformAnswer(listAgents({ projectId }, { client: platformClient })),
    initialAgentPage === undefined ? projectId : null,
  );
  const agentPage =
    initialAgentPage === undefined
      ? readAgentPage
      : ({ status: "ready", value: initialAgentPage } as const);

  const [suiteId, setSuiteId] = useState("");
  const [wantedSuite, setWantedSuite] = useState("");
  const [agentId, setAgentId] = useState("");
  const [connectionId, setConnectionId] = useState("");
  const [name, setName] = useState("");
  const [idempotencyKey, setIdempotencyKey] = useState(newRunIntentKey);
  const [moreSuites, setMoreSuites] = useState<readonly TestSuite[]>([]);
  const [suiteCursor, setSuiteCursor] = useState<string | null>(null);
  const [moreAgents, setMoreAgents] = useState<
    readonly ListedAgentWithConnections[]
  >([]);
  const [agentCursor, setAgentCursor] = useState<string | null>(null);
  const [loadingSuites, setLoadingSuites] = useState(false);
  const [loadingAgents, setLoadingAgents] = useState(false);
  const [moreRefused, setMoreRefused] = useState<Refusal | null>(null);
  const [starting, setStarting] = useState(false);
  const [refused, setRefused] = useState<Refusal | null>(null);
  const showing = useRef(projectId);
  const sheet = useRef<HTMLDivElement>(null);

  const { answer: agentDetail } = useProjectRead<AgentDetail>(
    (projectId) =>
      platformAnswer(
        getAgent({ agentId, projectId }, { client: platformClient }),
      ),
    agentId === "" ? null : projectId,
    agentId,
  );
  const { answer: suiteTests } = useProjectRead<TestPage>(
    (projectId) =>
      platformAnswer(
        listTests({ suiteId, projectId }, { client: platformClient }),
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

  const suites =
    suitePage?.status === "ready"
      ? [...suitePage.value.testSuites, ...moreSuites]
      : [];
  const suiteNameCounts = new Map<string, number>();
  for (const suite of suites) {
    suiteNameCounts.set(suite.name, (suiteNameCounts.get(suite.name) ?? 0) + 1);
  }
  const agents =
    agentPage?.status === "ready"
      ? [...agentPage.value.agents, ...moreAgents].filter(
          (agent) => !agent.archived,
        )
      : [];
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
    (suiteTests.value.tests.length > 0 ||
      suiteTests.value.nextPageToken !== null);
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

  async function start(): Promise<void> {
    if (!mayStart || starting || !ready) return;
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
    router.push(
      `/projects/${encodeURIComponent(projectId)}/runs/${encodeURIComponent(written.value.id)}`,
    );
  }

  function close(): void {
    if (onClose === undefined) {
      draftNavigation.push(listPath);
      return;
    }
    draftNavigation.request(onClose);
  }

  function formContent() {
    if (suitePage === null || agentPage === null) {
      return <Loading what="test suites and agents" />;
    }
    if (suitePage.status === "signed-out" || agentPage.status === "signed-out") {
      return null;
    }
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

    return (
      <>
        {suites.length === 0 ? (
          <Empty
            title="This project has no test suite"
            lead="Create a test suite before you start a run."
            action={
              <Button asChild variant="secondary">
                <Link href={`/projects/${encodeURIComponent(projectId)}/tests`}>
                  Open test suites
                </Link>
              </Button>
            }
          />
        ) : (
          <div className="flex flex-col gap-3">
            <Field label="Test suite *" htmlFor="run-suite">
              <Select
                id="run-suite"
                className={suiteId === "" ? "text-faint" : undefined}
                required
                aria-required="true"
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
                      {duplicate
                        ? `${suite.name} · ${shortSuiteId(suite.id)}`
                        : suite.name}
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
          </div>
        )}

        <div className="flex flex-col gap-3">
          {agents.length === 0 ? (
            <Empty title="This project has no active agent" />
          ) : (
            <>
              <Field label="Agent *" htmlFor="run-agent">
                <Select
                  id="run-agent"
                  className={agentId === "" ? "text-faint" : undefined}
                  required
                  aria-required="true"
                  value={agentId}
                  onChange={(event) => {
                    beginNewIntent();
                    setConnectionId("");
                    setAgentId(event.target.value);
                  }}
                >
                  <option value="">Choose an agent</option>
                  {agents.map((agent) => (
                    <option key={agent.id} value={agent.id}>
                      {agent.name}
                    </option>
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
        </div>

        {agentId === "" ? null : (
          <div className="flex flex-col gap-3">
            {agentDetail === null ? (
              <Loading what="this agent's connections" />
            ) : agentDetail.status === "ready" && connections.length > 0 ? (
              <Field label="Connection *" htmlFor="run-connection">
                <Select
                  id="run-connection"
                  className={connectionId === "" ? "text-faint" : undefined}
                  required
                  aria-required="true"
                  value={connectionId}
                  onChange={(event) => {
                    beginNewIntent();
                    setConnectionId(event.target.value);
                  }}
                >
                  <option value="">Choose a connection</option>
                  {connections.map((connection) => (
                    <option key={connection.id} value={connection.id}>
                      {connection.name}
                    </option>
                  ))}
                </Select>
              </Field>
            ) : agentDetail.status === "ready" ? (
              <Empty title="This agent has no active connection" />
            ) : agentDetail.status === "signed-out" ? null : (
              <Failure message={agentDetail.refusal.message} />
            )}
          </div>
        )}

        {connectionId === "" ? null : (
          <div>
            <Field label="Run name [optional]" htmlFor="run-name">
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
          </div>
        )}

        {moreRefused === null ? null : (
          <Refused message={moreRefused.message} />
        )}
        {refused === null ? null : <Refused message={refused.message} />}
      </>
    );
  }

  return (
    <Sheet
      open
      onOpenChange={(next) => {
        if (!next) close();
      }}
    >
      <SheetContent
        ref={sheet}
        className="gap-0 p-0"
        style={{ outline: "none", outlineOffset: 0 }}
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          sheet.current?.focus({ preventScroll: true });
        }}
      >
        <div
          data-slot="sheet-header"
          className="flex flex-none flex-col gap-2 border-b border-border px-6 py-5"
        >
          <div className="flex w-full items-center justify-between gap-4">
            <SheetTitle className="shrink-0 font-medium">
              Create a run
            </SheetTitle>
            <SheetClose asChild>
              <Button
                type="button"
                size="lg"
                variant="secondary"
                className="w-(--control-lg) px-0"
                aria-label="Close"
              >
                <XIcon className="size-4 stroke-[1.5]" />
              </Button>
            </SheetClose>
          </div>
          <SheetDescription>
            Run one test suite against one agent.
          </SheetDescription>
        </div>
        <form
          className="flex min-h-0 flex-1 flex-col gap-0"
          onSubmit={(event) => {
            event.preventDefault();
            void start();
          }}
        >
          <SheetBody className="gap-6 bg-surface p-6">
            {formContent()}
          </SheetBody>
          {role === null ? null : (
            <SheetFooter className="h-[calc(var(--control-lg)+var(--space-7))] justify-end border-t border-border bg-surface px-6 py-4">
              <Button
                type="button"
                size="lg"
                variant="secondary"
                className="px-4"
                disabled={starting}
                onClick={close}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                size="lg"
                className="px-4 disabled:opacity-[0.45]"
                disabled={!mayStart || !ready || starting}
                busy={starting}
                why={!mayStart ? whyNot : undefined}
              >
                {starting ? "Starting…" : "Start run"}
              </Button>
            </SheetFooter>
          )}
        </form>
      </SheetContent>
    </Sheet>
  );
}
