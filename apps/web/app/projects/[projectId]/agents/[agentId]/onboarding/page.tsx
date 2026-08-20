"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";

import { readJson, writeJson, type Refusal } from "../../../../../../lib/api.ts";
import {
  agentDetailQuery,
  type AgentDetail,
} from "../../../../../../lib/agents.ts";
import { roleOf } from "../../../../../../lib/me.ts";
import { projectPath } from "../../../../../../lib/project-context.ts";
import { canAuthor } from "../../../../../../lib/roles.ts";
import {
  testAgentsPath,
  testsPath,
  type ListedTest,
  type TestPage,
} from "../../../../../../lib/tests.ts";
import { Actions, Section } from "../../../../../../ui/section.tsx";
import {
  Button,
  ButtonLink,
  Checkbox,
  TextInput,
} from "../../../../../../ui/controls.tsx";
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
import styles from "./tests-onboarding.module.css";

type SelectorPage = {
  readonly tests: readonly ListedTest[];
  readonly nextCursor: string | null;
};

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
    agentDetailQuery(agentId, "active"),
    projectId,
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

    void readJson<TestPage>(testsPath({ archived: false, name: search }), {
      project: projectId,
      signal: controller.signal,
    }).then((answer) => {
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
      const tests = answer.value.items.filter((test) => test.archived_at === null);
      for (const test of tests) knownTests.current.set(test.id, test);
      const already = tests
        .filter((test) => test.agents.some((agent) => agent.id === agentId))
        .map((test) => test.id);
      setAttached((held) => new Set([...held, ...already]));
      setSelected((held) => new Set([...held, ...already]));
      setPages([{ tests, nextCursor: answer.value.next_cursor }]);
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
    const answer = await readJson<TestPage>(
      testsPath({
        archived: false,
        name: search,
        cursor: current.nextCursor,
      }),
      { project: projectId },
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
    const tests = answer.value.items.filter((test) => test.archived_at === null);
    for (const test of tests) knownTests.current.set(test.id, test);
    const already = tests
      .filter((test) => test.agents.some((agent) => agent.id === agentId))
      .map((test) => test.id);
    setAttached((held) => new Set([...held, ...already]));
    setSelected((held) => new Set([...held, ...already]));
    setPages((held) => [
      ...held,
      { tests, nextCursor: answer.value.next_cursor },
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
      const answer = await writeJson<ListedTest>(testAgentsPath(test.id), {
        method: "POST",
        project: projectId,
        body: {
          agents: [
            ...test.agents.map((agent) => agent.id),
            ...(test.agents.some((agent) => agent.id === agentId) ? [] : [agentId]),
          ],
          expected_applicability_revision: test.applicability_revision,
        },
      });

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
        <AgentOnboardingProgress current="tests" />

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
                <ButtonLink href={projectPath(projectId, "tests", "new")}>
                  Leave setup and write a test
                </ButtonLink>
                <ButtonLink href={detailPath} weight="strong">
                  Finish setup
                </ButtonLink>
              </Actions>
            }
          />
        ) : (
          <Form onSubmit={() => void attachAndFinish()}>
            <TextInput
              id="agent-onboarding-test-search"
              label="Search tests by name"
              placeholder="Search tests"
              value={typedSearch}
              disabled={saving}
              onChange={setTypedSearch}
            />
            <Section
              title="Project tests"
              lead="Select tests from this page. Your choices stay selected while you search or move between pages."
              action={
                <Actions>
                  <Button
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
                    disabled={saving || pending.length === 0}
                    onClick={() => setSelected(new Set(attached))}
                  >
                    Clear new choices
                  </Button>
                </Actions>
              }
            >
              <ul className={styles.tests} aria-label="Tests to attach">
                {shownTests.length === 0 ? (
                  <li className={styles.filteredEmpty}>
                    {busyTests
                      ? "Searching tests…"
                      : `No tests match “${search}”.`}
                  </li>
                ) : shownTests.map((test) => {
                  const alreadyAttached = attached.has(test.id);
                  const field = `onboarding-test-${test.id}`;
                  return (
                    <li className={styles.test} key={test.id}>
                      <Checkbox
                        id={field}
                        checked={selected.has(test.id)}
                        disabled={saving || alreadyAttached}
                        onChange={(checked) => {
                          setSelected((held) => {
                            const next = new Set(held);
                            if (checked) next.add(test.id);
                            else next.delete(test.id);
                            return next;
                          });
                          setRefused(null);
                        }}
                      />
                      <label className={styles.testCopy} htmlFor={field}>
                        <span className={styles.testName}>{test.name}</span>
                        <span className={styles.testDescription}>
                          {alreadyAttached
                            ? "Already attached"
                            : test.description ??
                              `${String(test.expected_behaviors.length)} expected behaviors`}
                        </span>
                      </label>
                      <Link
                        className={styles.testLink}
                        href={projectPath(projectId, "tests", test.id)}
                      >
                        View test
                      </Link>
                    </li>
                  );
                })}
              </ul>

              <div className={styles.pager}>
                <span>{busyTests ? "Loading…" : `Page ${String(page + 1)}`}</span>
                <Actions>
                  <Button
                    disabled={saving || busyTests || page === 0}
                    onClick={() => setPage(page - 1)}
                  >
                    Previous
                  </Button>
                  <Button
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
                <div className={styles.readProblem}>
                  <Problem>{readRefused.message}</Problem>
                  <Button onClick={() => setAttempt((held) => held + 1)}>
                    Try again
                  </Button>
                </div>
              )}
            </Section>

            {refused === null ? null : <Problem>{refused.message}</Problem>}

            <FormActions>
              <Button
                type="submit"
                weight="strong"
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
                <ButtonLink href={detailPath}>Skip tests for now</ButtonLink>
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
