"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { getAgent, listTests, setTestAgents } from "@egma/platform-api/client";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import type { Refusal } from "../../../../../../lib/api.ts";
import type { AgentDetail } from "../../../../../../lib/agents.ts";
import { roleOf } from "../../../../../../lib/me.ts";
import { platformAnswer, platformClient } from "../../../../../../lib/platform-client.ts";
import { projectPath } from "../../../../../../lib/project-context.ts";
import { canAuthor } from "../../../../../../lib/roles.ts";
import type { ListedTest, TestPage } from "../../../../../../lib/tests.ts";
import { Actions, Section } from "../../../../../../ui/section.tsx";
import {
  Form,
  FormActions,
  Help,
  Problem,
} from "../../../../../../ui/form.tsx";
import { Empty, Failure, Loading, NotFound } from "../../../../../../ui/page-state.tsx";
import { useProjectRead } from "../../../../../../ui/resource.ts";
import { useUnsavedChanges } from "../../../../../../ui/settings-read.ts";
import {
  AppShell,
  PageBody,
  PageHeader,
  ProductPage,
  useShellSession,
} from "../../../../../../ui/shell.tsx";
import { AgentOnboardingProgress } from "../../onboarding-progress.tsx";

type SelectorPage = {
  readonly tests: readonly ListedTest[];
  readonly nextCursor: string | null;
};

/**
 * The two strips under the list of tests: the pager, and a read refusal beside
 * the way to ask again.
 *
 * One declaration because the stylesheet had one rule for both, and the reason
 * holds: they sit under the same list, they space themselves the same way, and
 * they both stop being a row once the row runs out of width. Only how they line
 * up across that row differs, and each says that for itself.
 */
const UNDER_LIST =
  "mt-4 flex justify-between gap-4 " +
  "max-[40rem]:flex-col max-[40rem]:items-stretch";

export default function AgentOnboardingPage() {
  const { projectId, agentId } = useParams<{
    projectId: string;
    agentId: string;
  }>();

  return (
    <AppShell>
      <AttachTests projectId={projectId} agentId={agentId} />
    </AppShell>
  );
}

function AttachTests({
  projectId,
  agentId,
}: {
  readonly projectId: string;
  readonly agentId: string;
}) {
  const router = useRouter();
  const { me } = useShellSession();
  const role = me === null ? null : roleOf(me);
  const mayAuthor = role !== null && canAuthor(role);
  const detailPath = projectPath(projectId, "agents", agentId);
  const { answer: parentAgent, reload: reloadAgent } = useProjectRead<AgentDetail>(
    (projectId) =>
      platformAnswer(
        getAgent({ agentId, projectId }, { client: platformClient }),
      ),
    projectId,
    agentId,
  );

  const [typedSearch, setTypedSearch] = useState("");
  const [search, setSearch] = useState("");
  const [pages, setPages] = useState<readonly SelectorPage[]>([]);
  const [page, setPage] = useState(0);
  const [loadingTests, setLoadingTests] = useState(true);
  const [readRefused, setReadRefused] = useState<Refusal | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [attached, setAttached] = useState<ReadonlySet<string>>(new Set());
  const [saving, setSaving] = useState(false);
  const [refused, setRefused] = useState<Refusal | null>(null);
  const knownTests = useRef(new Map<string, ListedTest>());
  const generation = useRef(0);

  useEffect(() => {
    const timer = window.setTimeout(() => setSearch(typedSearch.trim()), 200);
    return () => window.clearTimeout(timer);
  }, [typedSearch]);

  useEffect(() => {
    knownTests.current.clear();
    setSelected(new Set());
    setAttached(new Set());
  }, [agentId, projectId]);

  useEffect(() => {
    const controller = new AbortController();
    const heldGeneration = generation.current + 1;
    generation.current = heldGeneration;
    setPages([]);
    setPage(0);
    setLoadingTests(true);
    setReadRefused(null);
    setRefused(null);

    void platformAnswer(
      listTests(
        {
          projectId,
          ...(search === "" ? {} : { name: search }),
        },
        { client: platformClient },
      ),
    ).then((answer) => {
      if (
        controller.signal.aborted ||
        generation.current !== heldGeneration
      ) {
        return;
      }
      setLoadingTests(false);
      if (answer.status === "signed-out") {
        window.location.replace("/sign-in");
        return;
      }
      if (answer.status !== "ready") {
        setReadRefused(answer.refusal);
        return;
      }
      const tests = answer.value.tests.filter((test) => test.archivedAt === null);
      for (const test of tests) knownTests.current.set(test.id, test);
      const already = tests
        .filter((test) => test.agents.some((agent) => agent.id === agentId))
        .map((test) => test.id);
      setAttached((held) => new Set([...held, ...already]));
      setSelected((held) => new Set([...held, ...already]));
      setPages([{ tests, nextCursor: answer.value.nextPageToken }]);
    });

    return () => {
      controller.abort();
      if (generation.current === heldGeneration) generation.current += 1;
    };
  }, [agentId, attempt, projectId, search]);

  useEffect(() => {
    if (parentAgent?.status === "signed-out") window.location.replace("/sign-in");
  }, [parentAgent]);

  const pendingSearch = typedSearch.trim() !== search;
  const busyTests = loadingTests || pendingSearch;
  const current = pages[page];
  const pageTests = busyTests ? [] : (current?.tests ?? []);
  const pinnedTests = [...selected]
    .map((id) => knownTests.current.get(id))
    .filter((test): test is ListedTest => test !== undefined)
    .filter((test) => !pageTests.some((shown) => shown.id === test.id));
  const shownTests = [...pinnedTests, ...pageTests];
  const pending = useMemo(
    () =>
      [...selected]
        .map((id) => knownTests.current.get(id))
        .filter((test): test is ListedTest => test !== undefined)
        .filter((test) => !attached.has(test.id)),
    [attached, current, selected],
  );
  useUnsavedChanges(pending.length > 0 && !saving, saving);

  async function showNext(): Promise<void> {
    if (current === undefined || current.nextCursor === null || loadingTests) return;
    const cached = pages[page + 1];
    if (cached !== undefined) {
      setPage(page + 1);
      return;
    }

    const heldGeneration = generation.current;
    setLoadingTests(true);
    setReadRefused(null);
    const answer = await platformAnswer(
      listTests(
        {
          projectId,
          pageToken: current.nextCursor,
          ...(search === "" ? {} : { name: search }),
        },
        { client: platformClient },
      ),
    );
    if (generation.current !== heldGeneration) return;
    setLoadingTests(false);
    if (answer.status === "signed-out") {
      window.location.replace("/sign-in");
      return;
    }
    if (answer.status !== "ready") {
      setReadRefused(answer.refusal);
      return;
    }
    const tests = answer.value.tests.filter((test) => test.archivedAt === null);
    for (const test of tests) knownTests.current.set(test.id, test);
    const already = tests
      .filter((test) => test.agents.some((agent) => agent.id === agentId))
      .map((test) => test.id);
    setAttached((held) => new Set([...held, ...already]));
    setSelected((held) => new Set([...held, ...already]));
    setPages((held) => [
      ...held,
      { tests, nextCursor: answer.value.nextPageToken },
    ]);
    setPage(page + 1);
  }

  async function attachAndFinish(): Promise<void> {
    if (!mayAuthor || saving) return;
    if (pending.length === 0) {
      router.push(detailPath);
      return;
    }

    setSaving(true);
    setRefused(null);
    const completed = new Set(attached);

    for (const test of pending) {
      const answer = await platformAnswer(
        setTestAgents(
          {
            testId: test.id,
            projectId,
            agents: [
              ...test.agents.map((agent) => agent.id),
              ...(test.agents.some((agent) => agent.id === agentId)
                ? []
                : [agentId]),
            ],
            expectedApplicabilityRevision: test.applicabilityRevision,
          },
          { client: platformClient },
        ),
      );

      if (answer.status === "signed-out") {
        window.location.replace("/sign-in");
        return;
      }
      if (answer.status !== "ready") {
        setAttached(completed);
        setSaving(false);
        setRefused(answer.refusal);
        return;
      }
      completed.add(test.id);
      setAttached(new Set(completed));
    }

    setSaving(false);
    router.push(detailPath);
  }

  const agentName =
    parentAgent?.status === "ready" ? parentAgent.value.agent.name : "Agent";
  const header = (
    <PageHeader
      eyebrow="Agent setup"
      title="Attach tests"
      breadcrumbs={[
        { label: "Agents", href: projectPath(projectId, "agents") },
        { label: agentName, href: detailPath },
        { label: "Attach tests" },
      ]}
      lead={`Choose the existing project tests that should run against ${agentName}.`}
    />
  );

  if (parentAgent === null || parentAgent.status === "signed-out") {
    return (
      <ProductPage>
        {header}
        <PageBody>
          <Loading what="this agent" />
        </PageBody>
      </ProductPage>
    );
  }
  if (parentAgent.status === "missing") {
    return (
      <ProductPage>
        {header}
        <PageBody>
          <NotFound message={parentAgent.refusal.message} />
        </PageBody>
      </ProductPage>
    );
  }
  if (parentAgent.status === "failed") {
    return (
      <ProductPage>
        {header}
        <PageBody>
          <Failure message={parentAgent.refusal.message} onRetry={reloadAgent} />
        </PageBody>
      </ProductPage>
    );
  }
  if (role !== null && !mayAuthor) {
    return (
      <ProductPage>
        {header}
        <PageBody>
          <NotFound
            message={`Your ${role} role cannot attach tests. Ask an organization admin to change your role, then try again.`}
          />
        </PageBody>
      </ProductPage>
    );
  }

  return (
    <ProductPage>
      {header}
      <PageBody>
        {/*
          * Somebody can be standing here with the connection stage behind them
          * and no connection on the agent, and the bar must not count that as
          * work done. This page already holds the agent's connections, so it is
          * the one place that can see it without a second read.
          *
          * **The word says the state, not how it got there**, and that is the
          * whole of the wording. An empty list has two histories: "Skip
          * connection for now", and a connection that was made and later
          * archived — this read returns the active ones. They are the same list
          * and nothing here can tell them apart, so a word like "Skipped" would
          * be right for one person and wrong for the other. "Needs a
          * connection" is true either way: the agent has none now, and
          * `DESIGN.md` gives the warning tone to exactly that — limited, or
          * needs attention.
          *
          * Reading the archived connections too would only buy a nicer word for
          * one of the two, at the cost of a second request on every visit to
          * this page. The state is what the reader has to act on either way.
          */}
        <AgentOnboardingProgress
          current="tests"
          unfinished={
            parentAgent.value.connections.length === 0
              ? { connection: "Needs a connection" }
              : {}
          }
        />

        {pages.length === 0 && busyTests ? (
          <Loading what="this project's tests" />
        ) : pages.length === 0 && readRefused !== null ? (
          <Failure
            title="Egma could not list this project's tests."
            message={readRefused.message}
            onRetry={() => setAttempt((current) => current + 1)}
          />
        ) : search === "" && pageTests.length === 0 && selected.size === 0 ? (
          <Empty
            title="This project has no active tests yet"
            lead="Finish this agent now, then write a test when you are ready to check it."
            action={
              <Actions>
                <Button asChild variant="secondary">
                  <Link href={projectPath(projectId, "tests", "new")}>
                    Leave setup and write a test
                  </Link>
                </Button>
                <Button asChild>
                  <Link href={detailPath}>Finish setup</Link>
                </Button>
              </Actions>
            }
          />
        ) : (
          <Form onSubmit={() => void attachAndFinish()}>
            <Input
              id="agent-onboarding-test-search"
              aria-label="Search tests by name"
              placeholder="Search tests"
              value={typedSearch}
              disabled={saving}
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => setTypedSearch(event.target.value)}
            />
            <Section
              title="Project tests"
              lead="Select tests from this page. Your choices stay selected while you search or move between pages."
              action={
                <Actions>
                  <Button
                    type="button"
                    variant="secondary"
                    disabled={
                      saving ||
                      busyTests ||
                      pageTests.length === 0 ||
                      pageTests.every((test) => selected.has(test.id))
                    }
                    onClick={() =>
                      setSelected(
                        (held) =>
                          new Set([
                            ...held,
                            ...pageTests.map((test) => test.id),
                          ]),
                      )
                    }
                  >
                    Select page
                  </Button>
                  <Button
                    type="button"
                    variant="secondary"
                    disabled={saving || pending.length === 0}
                    onClick={() => setSelected(new Set(attached))}
                  >
                    Clear new choices
                  </Button>
                </Actions>
              }
            >
              <ul
                className={
                  "m-0 grid list-none p-0 " +
                  // The rows have their own edges, so the card's radius has to
                  // clip them or the first and last rows square off its corners.
                  "overflow-hidden rounded-card border border-border"
                }
                aria-label="Tests to attach"
              >
                {shownTests.length === 0 ? (
                  <li className="p-6 text-muted-foreground">
                    {busyTests
                      ? "Searching tests…"
                      : `No tests match “${search}”.`}
                  </li>
                ) : shownTests.map((test) => {
                  const alreadyAttached = attached.has(test.id);
                  const field = `onboarding-test-${test.id}`;
                  return (
                    <li
                      className={
                        // Three columns: the checkbox's own control width, the
                        // copy, and the link. `var(--control-lg)` is egma's
                        // control size and there is no grid-template key for it.
                        "grid grid-cols-[var(--control-lg)_minmax(0,1fr)_auto] " +
                        "min-h-16 items-center bg-surface px-4 py-3 " +
                        // What the stylesheet said as `.test + .test`. The row
                        // that follows another carries the line between them, so
                        // the first row leaves the card's own top edge alone.
                        "not-first:border-t not-first:border-border " +
                        // No room for a third column, so the link leaves it.
                        "max-[40rem]:grid-cols-[var(--control-lg)_minmax(0,1fr)]"
                      }
                      key={test.id}
                    >
                      <Checkbox
                        id={field}
                        checked={selected.has(test.id)}
                        disabled={saving || alreadyAttached}
                        onChange={(event) => {
                          const checked = event.target.checked;
                          setSelected((held) => {
                            const next = new Set(held);
                            if (checked) next.add(test.id);
                            else next.delete(test.id);
                            return next;
                          });
                          setRefused(null);
                        }}
                      />
                      <label
                        className="grid min-w-0 cursor-pointer gap-1"
                        htmlFor={field}
                      >
                        <span className="text-foreground">{test.name}</span>
                        <span className="overflow-hidden text-sm text-ellipsis whitespace-nowrap text-muted-foreground">
                          {alreadyAttached
                            ? "Already attached"
                            : test.description ??
                              `${String(test.expectedBehaviors.length)} expected behaviors`}
                        </span>
                      </label>
                      <Link
                        className={
                          "ms-4 text-foreground " +
                          // Under the copy it belongs to once the row is two
                          // columns, rather than beside it.
                          "max-[40rem]:col-start-2 max-[40rem]:mt-2 max-[40rem]:ms-0"
                        }
                        href={projectPath(projectId, "tests", test.id)}
                      >
                        View test
                      </Link>
                    </li>
                  );
                })}
              </ul>

              <div className={`${UNDER_LIST} items-center`}>
                <span className="text-sm text-muted-foreground">
                  {busyTests ? "Loading…" : `Page ${String(page + 1)}`}
                </span>
                <Actions>
                  <Button
                    type="button"
                    variant="secondary"
                    disabled={saving || busyTests || page === 0}
                    onClick={() => setPage(page - 1)}
                  >
                    Previous
                  </Button>
                  <Button
                    type="button"
                    variant="secondary"
                    disabled={
                      saving ||
                      busyTests ||
                      (current?.nextCursor ?? null) === null
                    }
                    onClick={() => void showNext()}
                  >
                    Next
                  </Button>
                </Actions>
              </div>
              {readRefused === null ? null : (
                <div className={`${UNDER_LIST} items-start`}>
                  <Problem>{readRefused.message}</Problem>
                  <Button
                    type="button"
                    variant="secondary"
                    onClick={() => setAttempt((held) => held + 1)}
                  >
                    Try again
                  </Button>
                </div>
              )}
            </Section>

            {refused === null ? null : <Problem>{refused.message}</Problem>}

            <FormActions>
              <Button
                type="submit"
                disabled={saving || !mayAuthor || selected.size === 0}
                busy={saving}
              >
                {saving
                  ? "Attaching tests…"
                  : pending.length === 0
                    ? "Finish setup"
                    : `Attach ${String(pending.length)} ${pending.length === 1 ? "test" : "tests"} and finish`}
              </Button>
              {attached.size === 0 ? (
                <Button asChild variant="secondary">
                  <Link href={detailPath}>Skip tests for now</Link>
                </Button>
              ) : null}
            </FormActions>
            {attached.size === 0 ? (
              <Help>
                Without an attached test, this agent will have no test to select
                in a run. You can attach tests later from this agent's page.
              </Help>
            ) : null}
          </Form>
        )}
      </PageBody>
    </ProductPage>
  );
}
