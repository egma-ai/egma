"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { readJson, type Refusal } from "../../../../lib/api.ts";
import { agentsQuery, type AgentPage } from "../../../../lib/agents.ts";
import { firstProjectOf, roleOf } from "../../../../lib/me.ts";
import { projectLanding, projectPath } from "../../../../lib/project-context.ts";
import { canAuthor } from "../../../../lib/roles.ts";
import {
  activeAgents,
  availability,
  testsPath,
  type ListedTest,
  type TestPage,
} from "../../../../lib/tests.ts";
import {
  Toolbar,
  TOOLBAR_FILTER,
  TOOLBAR_SEARCH,
} from "../../../../ui/section.tsx";
import { DataTable, type Column } from "../../../../ui/data-table.tsx";
import { Empty, Failure, Loading, NotFound } from "../../../../ui/page-state.tsx";
import {
  RelativeInstant,
  useMinuteClock,
} from "../../../../ui/relative-time.tsx";
import { useProjectRead } from "../../../../ui/resource.ts";
import {
  AppShell,
  PageBody,
  PageHeader,
  ProductPage,
  useShellSession,
} from "../../../../ui/shell.tsx";

/**
 * Every test this project owns: what each one checks, which agents it applies
 * to, and whether a run could use it right now.
 *
 * **Applicability is on the row, because it is what decides whether a test can
 * run at all.** A test whose every agent has been archived is active and has
 * nowhere to go, and a list that showed only a name would leave somebody
 * choosing it in a run builder and being refused there instead.
 *
 * The project is in the address and in every request. Reload, Back, Forward, a
 * copied link and a second tab on a second project all work for one reason:
 * there is no chosen project anywhere except the address.
 */
export default function TestsPage() {
  const { projectId } = useParams<{ projectId: string }>();
  return (
    <AppShell>
      <Tests projectId={projectId} />
    </AppShell>
  );
}

/** What a row says about the agents a test applies to. */
function Applies({ test }: { readonly test: ListedTest }) {
  const active = activeAgents(test);
  const { runnable } = availability(test);

  if (test.agents.length === 0) {
    // Only an upgrade can produce this, and Restore takes an agent to fix it.
    return <Badge variant="failure">No agent</Badge>;
  }
  if (!runnable && test.archived_at === null) {
    return (
      <Badge variant="warning" title="Every agent this test applies to is archived.">
        {test.agents.length} archived
      </Badge>
    );
  }
  return (
    <span title={active.map((one) => one.name).join(", ")}>
      {active.length === 1
        ? (active[0]?.name ?? "")
        : `${String(active.length)} agents`}
    </span>
  );
}

/**
 * The columns, built for one project so the name can be the way in.
 *
 * The name stays a real link for keyboard and assistive technology. The table
 * also gives pointer users the whole row because every row has one clear
 * destination and no competing action.
 */
function columnsFor(
  projectId: string,
  now: number,
): readonly Column<ListedTest>[] {
  return [
    {
      key: "name",
      header: "Test",
      primary: true,
      cell: (test) => (
        <Link href={projectPath(projectId, "tests", test.id)}>{test.name}</Link>
      ),
    },
    ...restFor(now),
  ];
}

function restFor(now: number): readonly Column<ListedTest>[] {
  return [
    {
      key: "agents",
      header: "Applies to",
      width: "160px",
      cell: (test) => <Applies test={test} />,
    },
    {
      key: "behaviors",
      header: "Expects",
      hideOnMobile: true,
      width: "100px",
      cell: (test) =>
        `${String(test.expected_behaviors.length)} ${
          test.expected_behaviors.length === 1 ? "behavior" : "behaviors"
        }`,
    },
    {
      key: "personas",
      header: "Personas",
      hideOnMobile: true,
      width: "110px",
      cell: (test) => test.personas.map((one) => one.name).join(", "),
    },
    {
      key: "version",
      header: "Version",
      hideOnMobile: true,
      mono: true,
      width: "90px",
      cell: (test) => `v${test.version}`,
    },
    {
      key: "changed",
      header: "Changed",
      mono: true,
      width: "120px",
      cell: (test) => <RelativeInstant instant={test.updated_at} now={now} />,
    },
  ];
}

function Tests({ projectId }: { readonly projectId: string }) {
  const { me } = useShellSession();
  // Null until the session read answers. A page that guessed would tell a
  // member their role cannot do something it can, on every load.
  const role = me === null ? null : roleOf(me);
  const now = useMinuteClock();

  /** Which shelf is being looked at: what can run, or what was taken out. */
  /**
   * Which list this page asks the server for, and for now it is always the
   * active one.
   *
   * **The archive filter's control came off every list page in this batch.**
   * The developer wants a filter row to hold what somebody reaches for daily,
   * and the archive is not that. Nothing under the control moved: the server
   * still keeps the two lists apart, `testsPath` still carries the flag, and
   * every branch below that draws the archive still draws it. Putting the
   * control back is handing a `Choice` the setter this deliberately does not
   * take.
   */
  const [archived] = useState(false);
  /** Narrowed to one agent's coverage, or to none. */
  const [agent, setAgent] = useState("");
  /** What somebody typed in the search box, and what has been asked for. */
  const [typed, setTyped] = useState("");
  const [searching, setSearching] = useState("");

  const path = testsPath({
    archived,
    ...(agent === "" ? {} : { agent }),
    ...(searching === "" ? {} : { name: searching }),
  });
  const { answer, reload } = useProjectRead<TestPage>(path, projectId);
  const { answer: agents } = useProjectRead<AgentPage>(
    agentsQuery({}),
    projectId,
  );

  /**
   * Pages fetched after the first, kept beside it rather than folded into it —
   * **and each one remembers what it was fetched for.**
   *
   * Changing project or filter does not remount this page, so this state
   * outlives the change and a read still in flight comes back into a view that
   * has moved on. Carrying the question in the value means a page fetched for
   * another one can never be *rendered* here, whatever wrote it and whenever it
   * landed.
   */
  const [after, setAfter] = useState<{
    readonly asked: string;
    readonly project: string;
    readonly page: TestPage;
  } | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  /** Why the next page did not arrive, until somebody asks for it again. */
  const [moreRefused, setMoreRefused] = useState<Refusal | null>(null);

  const carried =
    after !== null && after.project === projectId && after.asked === path
      ? after.page
      : null;

  /** Which project this view is showing, readable from inside an await. */
  const showing = useRef(projectId);

  useEffect(() => {
    showing.current = projectId;
    setAfter(null);
    setMoreRefused(null);
    setLoadingMore(false);
  }, [projectId]);

  useEffect(() => {
    setAfter(null);
    setMoreRefused(null);
  }, [answer]);

  useEffect(() => {
    if (answer?.status === "signed-out") window.location.replace("/sign-in");
  }, [answer]);

  /**
   * One page for every role, and the control that changes data is disabled
   * rather than removed. A viewer sees what egma can do here and is told
   * plainly that this part is not theirs; the server refuses their write either
   * way, which is where the boundary actually is.
   *
   * **While the role is unknown there is no control at all.** A disabled one
   * would have to say why, and every sentence it could say would be a claim
   * about somebody egma has not identified yet.
   */
  const mayAuthor = role !== null && canAuthor(role) && answer?.status !== "missing";
  const whyNot =
    role !== null && canAuthor(role)
      ? "There is no project here to write a test in."
      : `Your ${String(role)} role cannot write tests. Ask an organization admin to change your role.`;

  /**
   * The way to write a test, and what it becomes when it is not this
   * person's.
   *
   * **A disabled control is genuinely inert or it is a lie.** A link cannot be
   * disabled: `aria-disabled` on an anchor greys it out and it still follows on
   * click and still takes the keyboard. So when this is not available it stops
   * being a link and becomes a disabled button, which carries the reason where
   * a keyboard and a screen reader can reach it.
   */
  const author = () =>
    role === null ? undefined : mayAuthor ? (
      <Button asChild>
        <Link href={projectPath(projectId, "tests", "new")}>Write a test</Link>
      </Button>
    ) : (
      <Button type="button" disabled why={whyNot}>
        Write a test
      </Button>
    );

  function body() {
    if (answer === null || answer.status === "signed-out") {
      return <Loading what="tests" />;
    }

    if (answer.status === "missing") {
      const elsewhere = me === null ? undefined : firstProjectOf(me);
      return (
        <NotFound
          message={answer.refusal.message}
          action={
            elsewhere === undefined ? undefined : (
              <Button asChild variant="secondary">
                <Link href={projectLanding(elsewhere.id)}>
                  Open {elsewhere.name}
                </Link>
              </Button>
            )
          }
        />
      );
    }

    if (answer.status === "failed") {
      return <Failure message={answer.refusal.message} onRetry={reload} />;
    }

    const items = [...answer.value.items, ...(carried?.items ?? [])];
    const cursor = carried === null ? answer.value.next_cursor : carried.next_cursor;

    /**
     * The next page, and everything that can happen instead of one.
     *
     * A next page that does not arrive is still something that happened.
     * Returning quietly would re-enable the control, say nothing, and leave
     * somebody pressing it — and a session that has expired would leave them
     * pressing it forever, on a page that can no longer read anything.
     */
    async function showMore(): Promise<void> {
      if (cursor === null) return;

      const asked = projectId;
      const question = path;
      setMoreRefused(null);
      setLoadingMore(true);

      const next = await readJson<TestPage>(
        `${question}${question.includes("?") ? "&" : "?"}cursor=${encodeURIComponent(cursor)}`,
        { project: asked },
      );

      setLoadingMore(false);
      if (showing.current !== asked) return;

      if (next.status === "signed-out") {
        window.location.replace("/sign-in");
        return;
      }

      if (next.status !== "ready") {
        setMoreRefused(next.refusal);
        return;
      }

      setAfter({
        project: asked,
        asked: question,
        page: {
          items: [...(carried?.items ?? []), ...next.value.items],
          next_cursor: next.value.next_cursor,
        },
      });
    }

    if (items.length === 0) {
      const narrowed = searching !== "" || agent !== "";
      return (
        <Empty
          title={
            narrowed
              ? "No test here matches that"
              : archived
                ? "No archived tests in this project"
                : "No tests yet"
          }
          lead={
            narrowed
              ? "Clear the search and the agent filter to see everything this project holds."
              : archived
                ? "Tests you archive keep every version and every run that used them, and stay readable here."
                : "A test describes a situation to put an agent in, who calls about it, and what should happen."
          }
          action={narrowed || archived ? undefined : author()}
        />
      );
    }

    return (
      <>
        <DataTable
          label={archived ? "Archived tests" : "Tests in this project"}
          columns={columnsFor(projectId, now)}
          rows={items}
          keyOf={(test) => test.id}
          stretchPrimaryLink
          {...(cursor === null
            ? {}
            : {
                more: {
                  onMore: () => void showMore(),
                  loading: loadingMore,
                  note: `${String(items.length)} tests so far`,
                },
              })}
        />
        {moreRefused === null ? null : (
          <Failure
            title="Egma could not load more tests."
            message={moreRefused.message}
            onRetry={() => void showMore()}
          />
        )}
      </>
    );
  }

  const choosable =
    agents?.status === "ready"
      ? agents.value.items.filter((one) => one.archived_at === null)
      : [];

  return (
    <ProductPage>
      <PageHeader
        eyebrow="Project"
        title="Tests"
        lead="One authored specification each: the situation, who calls about it, and what should happen."
        action={author()}
      />
      <PageBody>
        <Toolbar>
          <Input
            id="tests-search"
            className={TOOLBAR_SEARCH}
            value={typed}
            aria-label="Search tests by name"
            placeholder="Search by name"
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => setTyped(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") setSearching(typed);
              if (event.key === "Escape") {
                setTyped("");
                setSearching("");
              }
            }}
          />
          <Select
            id="tests-agent"
            className={TOOLBAR_FILTER}
            value={agent}
            aria-label="Show only tests that apply to one agent"
            onChange={(event) => setAgent(event.target.value)}
          >
            <option value="">Any agent</option>
            {choosable.map((one) => (
              <option key={one.id} value={one.id}>
                {one.name}
              </option>
            ))}
          </Select>
        </Toolbar>
        {body()}
      </PageBody>
    </ProductPage>
  );
}
