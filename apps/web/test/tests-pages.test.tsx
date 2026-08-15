// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import TestDetailPage from "../app/projects/[projectId]/tests/[testId]/page.tsx";
import TestsPage from "../app/projects/[projectId]/tests/page.tsx";
import NewTestPage from "../app/projects/[projectId]/tests/new/page.tsx";
import type { Me } from "../lib/me.ts";

/**
 * The Tests area, rendered.
 *
 * **Nothing here asserts that a component exists or that a source file contains
 * a string.** Every test drives a rendered page the way somebody with a
 * keyboard would and reads what the DOM then says.
 *
 * The claims worth having in the fast lane are the ones a page decides for
 * itself: that the three kinds of edit send three different requests carrying
 * three different tokens, that a test cannot be saved into a state the platform
 * would refuse, that an archived link stays visible rather than vanishing when
 * somebody opens the editor, that nothing typed for one test can reach another,
 * and that a viewer's controls are present and genuinely inert.
 */

const routed = vi.hoisted(() => ({
  push: vi.fn(),
  pathname: "/projects/prj_1/tests",
  projectId: "prj_1",
  testId: "tst_1",
}));

vi.mock("next/navigation", () => ({
  usePathname: () => routed.pathname,
  useRouter: () => ({ push: routed.push, replace: vi.fn(), back: vi.fn() }),
  useParams: () => ({ projectId: routed.projectId, testId: routed.testId }),
}));

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: unknown }) => (
    <a href={href} {...rest}>
      {children as never}
    </a>
  ),
}));

vi.mock("next/image", () => ({
  default: ({ alt }: { alt: string }) => <img alt={alt} />,
}));

const PROJECTS = [{ id: "prj_1", name: "Default", slug: "default" }];
const ACME = { id: "org_1", name: "Acme", slug: "acme", role: "admin" };

function meWith(role: string): Me {
  return {
    user: { id: "usr_1", email: "ada@acme.example" },
    organizations: [{ ...ACME, role }],
    projects: PROJECTS,
  };
}

const CAPABILITIES = {
  items: [
    { key: "dtmf", label: "DTMF entry", description: "Press digits." },
    { key: "barge_in", label: "Barge-in", description: "Interrupt the agent." },
    { key: "raw_audio", label: "Raw audio", description: "Audio to grade." },
  ],
};

function agentRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "agt_1",
    project_id: "prj_1",
    name: "Front desk",
    description: null,
    revision: "rev_a",
    archived: false,
    archived_at: null,
    created_at: "2026-08-01T10:00:00.000Z",
    updated_at: "2026-08-01T10:00:00.000Z",
    ...overrides,
  };
}

function testRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "tst_1",
    project_id: "prj_1",
    name: "Reschedules a booked appointment",
    description: null,
    version: 1,
    version_id: "tstv_1",
    scenario: "Their cleaning has to move to next week.",
    expected_behaviors: ["confirms the new time back"],
    personas: [{ id: "prs_1", name: "Impatient Rita", archived_at: null }],
    required_capabilities: [],
    override_count: 0,
    agents: [{ id: "agt_1", name: "Front desk", archived_at: null }],
    revision: "rev_1",
    applicability_revision: "rev_app_1",
    archived_at: null,
    archive_reason: null,
    created_at: "2026-08-01T10:00:00.000Z",
    updated_at: "2026-08-01T10:00:00.000Z",
    ...overrides,
  };
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

type Stubbed = { status: number; body: unknown } | "never";

/** Every request the browser makes, in the order it made them. */
let sent: { url: string; method: string; body: unknown }[] = [];

function apiAnswers(answers: Record<string, Stubbed | readonly Stubbed[]>): void {
  const asked: Record<string, number> = {};

  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, init?: RequestInit) => {
      const url = new URL(input, "http://egma.test");
      sent.push({
        url: input,
        method: init?.method ?? "GET",
        body:
          typeof init?.body === "string"
            ? (JSON.parse(init.body) as unknown)
            : undefined,
      });

      const held = answers[url.pathname];
      if (held === undefined) throw new Error(`nothing stubbed for ${url.pathname}`);

      const turn = asked[url.pathname] ?? 0;
      asked[url.pathname] = turn + 1;
      const answer = Array.isArray(held)
        ? ((held[Math.min(turn, held.length - 1)] ?? "never") as Stubbed)
        : (held as Stubbed);

      if (answer === "never") return new Promise<Response>(() => undefined);
      return json(answer.status, answer.body);
    }),
  );
}

/** Where the page sent an expired session, if it sent one anywhere. */
let wentTo: string[] = [];

beforeEach(() => {
  sent = [];
  wentTo = [];
  Object.defineProperty(window, "location", {
    configurable: true,
    value: {
      ...window.location,
      replace: (url: string) => wentTo.push(url),
    },
  });
  routed.push.mockReset();
  routed.pathname = "/projects/prj_1/tests";
  routed.projectId = "prj_1";
  routed.testId = "tst_1";
  vi.stubGlobal("scrollTo", vi.fn());
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/** What the page sent to one address, most recent last. */
function sentTo(path: string): { method: string; body: unknown }[] {
  return sent
    .filter((one) => new URL(one.url, "http://egma.test").pathname === path)
    .map((one) => ({ method: one.method, body: one.body }));
}

/**
 * The requests of one method to one path.
 *
 * **A page reads the path it writes to**, so waiting on "anything reached this
 * address" is satisfied by the page's own load and says nothing about the save.
 * Under load the assertion then runs against the GET, and `body` is undefined —
 * which arrives as a TypeError about a property of undefined rather than as
 * anything about the save that had not happened yet.
 */
function sentWith(
  path: string,
  method: string,
): { method: string; body: unknown }[] {
  return sentTo(path).filter((one) => one.method === method);
}

/* ------------------------------------------------------------------------ */

describe("the list of tests", () => {
  function list(role = "admin", tests: unknown[] = [testRow()]) {
    apiAnswers({
      "/api/me": { status: 200, body: meWith(role) },
      "/api/tests": { status: 200, body: { items: tests, next_cursor: null } },
      "/api/agents": {
        status: 200,
        body: { items: [agentRow()], next_cursor: null },
      },
    });
    render(<TestsPage />);
  }

  it("names the agents a test applies to, because that is what decides whether it can run", async () => {
    list();
    // The shared table draws every row twice — once for the wide layout and once
    // for the narrow one — so a name appears as many times as there are layouts.
    expect((await screen.findAllByText("Front desk")).length).toBeGreaterThan(0);
  });

  it("says plainly when every agent a test applies to is archived", async () => {
    list("admin", [
      testRow({
        agents: [
          { id: "agt_1", name: "Front desk", archived_at: "2026-08-02T00:00:00.000Z" },
        ],
      }),
    ]);

    // Active and unavailable is a real state, and the fix is to restore an
    // agent rather than to re-author the test — so it is said rather than left
    // for a run builder to refuse later.
    expect((await screen.findAllByText("1 archived")).length).toBeGreaterThan(0);
  });

  it("asks the server for the search rather than filtering what it already has", async () => {
    list();
    await screen.findAllByText("Front desk");

    const box = screen.getByLabelText("Search tests by name");
    fireEvent.change(box, { target: { value: "reschedules" } });
    fireEvent.keyDown(box, { key: "Enter" });

    await waitFor(() => {
      expect(
        sent.some((one) => one.url.includes("name=reschedules")),
      ).toBe(true);
    });
  });

  it("asks for the archived shelf as a different list, never as a column", async () => {
    list();
    await screen.findAllByText("Front desk");

    fireEvent.click(screen.getByRole("radio", { name: "Archived" }));

    await waitFor(() => {
      expect(sent.some((one) => one.url.includes("archived=true"))).toBe(true);
    });
  });

  it("gives a viewer the same page and a control that is genuinely inert", async () => {
    list("viewer");
    await screen.findAllByText("Front desk");

    const write = screen.getByRole("button", { name: "Write a test" });
    expect(write.hasAttribute("disabled")).toBe(true);
    expect(
      screen.getByText(/Your viewer role cannot write tests/u),
    ).toBeTruthy();
  });
});

/* ------------------------------------------------------------------------ */

describe("writing a test", () => {
  function form(agents: unknown[] = [agentRow()]) {
    routed.pathname = "/projects/prj_1/tests/new";
    apiAnswers({
      "/api/me": { status: 200, body: meWith("admin") },
      "/api/agents": { status: 200, body: { items: agents, next_cursor: null } },
      "/api/personas": { status: 200, body: { items: [], next_cursor: null } },
      "/api/graders": { status: 200, body: { items: [], next_cursor: null } },
      "/api/capabilities": { status: 200, body: CAPABILITIES },
      "/api/tests": { status: 201, body: testRow() },
    });
    render(<NewTestPage />);
  }

  it("will not save until an agent is chosen, and says why", async () => {
    form();
    await screen.findByLabelText("Name");

    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "Reschedules" },
    });
    fireEvent.change(screen.getByLabelText("Scenario"), {
      target: { value: "Their cleaning has to move." },
    });
    fireEvent.change(screen.getByLabelText("Expected behavior 1"), {
      target: { value: "confirms the new time" },
    });

    // The agents this project offers, waited for rather than assumed: the
    // sentence asserted below is the one shown when there *are* agents and none
    // is chosen, and a project still waiting on that read shows a different one.
    const choice = await screen.findByLabelText("Front desk");

    // The platform refuses a test with no target, so the form asks for one
    // rather than letting somebody meet that refusal after writing everything.
    expect(
      screen.getByRole("button", { name: "Write the test" }).hasAttribute("disabled"),
    ).toBe(true);
    expect(
      screen.getByText(/Every test must apply to at least one active agent/u),
    ).toBeTruthy();

    fireEvent.click(choice);

    await waitFor(() => {
      expect(
        screen
          .getByRole("button", { name: "Write the test" })
          .hasAttribute("disabled"),
      ).toBe(false);
    });
  });

  it("will not save a test that could never fail", async () => {
    form();
    await screen.findByLabelText("Name");

    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "Unfalsifiable" },
    });
    fireEvent.change(screen.getByLabelText("Scenario"), {
      target: { value: "Anything at all." },
    });
    fireEvent.click(await screen.findByLabelText("Front desk"));

    expect(
      screen.getByText(/A test needs at least one expected behavior/u),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Write the test" }).hasAttribute("disabled"),
    ).toBe(true);
  });

  /**
   * **A proof about demoting every behavior used to stand here.** It set the
   * one behavior to `P2` and expected the form to refuse, because
   * falsifiability could otherwise be downgraded away one edit at a time. The
   * ladder retired with the grader redesign: a behavior is a plain sentence,
   * every one of them has to hold, and there is no control left to demote one
   * with. The rule it protected still stands and is proved directly by the
   * test above — a test with no behavior at all cannot be saved.
   */

  it("sends the behaviors in the order they are on screen", async () => {
    form();
    await screen.findByLabelText("Name");

    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "Ordered" },
    });
    fireEvent.change(screen.getByLabelText("Scenario"), {
      target: { value: "Anything at all." },
    });
    fireEvent.change(screen.getByLabelText("Expected behavior 1"), {
      target: { value: "first" },
    });
    fireEvent.click(await screen.findByLabelText("Front desk"));
    fireEvent.click(
      screen.getByRole("button", { name: "Add an expected behavior" }),
    );
    fireEvent.change(await screen.findByLabelText("Expected behavior 2"), {
      target: { value: "second" },
    });

    // Order is content: a version that reorders the list says something the
    // version before it did not.
    fireEvent.click(
      screen.getByRole("button", { name: "Move expected behavior 2 up" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Write the test" }));

    await waitFor(() => {
      expect(sentTo("/api/tests").at(-1)?.method).toBe("POST");
    });
    const body = sentTo("/api/tests").at(-1)?.body as {
      expected_behaviors: string[];
    };
    // Plain sentences, in the order the page shows them, and nothing beside
    // them: the write door refuses the `{behavior, priority}` shape by name.
    expect(body.expected_behaviors).toEqual(["second", "first"]);
  });
});

/* ------------------------------------------------------------------------ */

describe("one test's page", () => {
  function detail(
    role = "admin",
    test: Record<string, unknown> = testRow(),
    agents: unknown[] = [agentRow()],
  ) {
    routed.pathname = "/projects/prj_1/tests/tst_1";
    apiAnswers({
      "/api/me": { status: 200, body: meWith(role) },
      "/api/tests/tst_1": { status: 200, body: test },
      "/api/tests/tst_1/versions": {
        status: 200,
        body: {
          items: [
            {
              ...testRow(),
              id: "tstv_1",
              test_id: "tst_1",
              test_name: "Reschedules a booked appointment",
              current: true,
            },
          ],
          next_cursor: null,
        },
      },
      "/api/tests/tst_1/agents": { status: 200, body: test },
      "/api/agents": { status: 200, body: { items: agents, next_cursor: null } },
      "/api/personas": { status: 200, body: { items: [], next_cursor: null } },
      "/api/graders": { status: 200, body: { items: [], next_cursor: null } },
      "/api/capabilities": { status: 200, body: CAPABILITIES },
    });
    render(<TestDetailPage />);
  }

  it("saves a rename with the identity revision alone", async () => {
    detail();
    await screen.findByLabelText("Name");

    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "Renamed" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save settings" }));

    await waitFor(() => {
      expect(sentWith("/api/tests/tst_1", "PATCH").length).toBeGreaterThan(0);
    });
    const body = sentWith("/api/tests/tst_1", "PATCH").at(-1)?.body as Record<string, unknown>;
    expect(body.name).toBe("Renamed");
    expect(body.expected_revision).toBe("rev_1");
    // Sending the version too would make a rename fail because somebody else
    // sharpened a scenario, which is a conflict that never existed.
    expect(body.expected_version_id).toBeUndefined();
  });

  it("saves content with the version alone, and never mentions the overrides it does not edit", async () => {
    detail("admin", testRow({ override_count: 2 }));
    await screen.findByLabelText("Scenario");

    fireEvent.change(screen.getByLabelText("Scenario"), {
      target: { value: "They call from the station." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save version" }));

    await waitFor(() => {
      expect(sentWith("/api/tests/tst_1", "PATCH").length).toBeGreaterThan(0);
    });
    const body = sentWith("/api/tests/tst_1", "PATCH").at(-1)?.body as Record<string, unknown>;
    expect(body.expected_version_id).toBe("tstv_1");
    expect(body.expected_revision).toBeUndefined();
    // The whole of what stops a partial form erasing hidden versioned content:
    // the form does not edit the overrides, so it does not send them.
    expect("mock_tools" in body).toBe(false);
  });

  it("says the overrides are there without showing or editing them", async () => {
    detail("admin", testRow({ override_count: 2 }));
    expect(await screen.findByText("Overrides present")).toBeTruthy();
  });

  it("saves the applicable agents through their own door, with their own token", async () => {
    detail("admin", testRow(), [agentRow(), agentRow({ id: "agt_2", name: "Weekend desk" })]);
    await screen.findByLabelText("Weekend desk");

    fireEvent.click(await screen.findByLabelText("Weekend desk"));
    fireEvent.click(
      screen.getByRole("button", { name: "Save applicable agents" }),
    );

    await waitFor(() => {
      expect(sentWith("/api/tests/tst_1/agents", "POST").length).toBeGreaterThan(0);
    });
    const call = sentWith("/api/tests/tst_1/agents", "POST").at(-1);
    expect(call?.method).toBe("POST");
    const body = call?.body as Record<string, unknown>;
    expect(body.agents).toEqual(["agt_1", "agt_2"]);
    expect(body.expected_applicability_revision).toBe("rev_app_1");
    // Target coverage is neither the live identity nor the versioned content.
    expect(body.expected_revision).toBeUndefined();
    expect(body.expected_version_id).toBeUndefined();
  });

  it("will not let the last applicable agent be saved away", async () => {
    detail();
    await screen.findByLabelText("Front desk");

    fireEvent.click(await screen.findByLabelText("Front desk"));

    expect(
      screen
        .getByRole("button", { name: "Save applicable agents" })
        .hasAttribute("disabled"),
    ).toBe(true);
    expect(
      screen.getByText(/Every test must apply to at least one active agent/u),
    ).toBeTruthy();
  });

  it("keeps an archived agent visible in the editor, so saving cannot drop it silently", async () => {
    detail(
      "admin",
      testRow({
        agents: [
          { id: "agt_1", name: "Front desk", archived_at: null },
          { id: "agt_9", name: "Retired desk", archived_at: "2026-08-02T00:00:00.000Z" },
        ],
      }),
    );

    // The project's active list does not hold it, and offering only that list
    // would drop the link the moment anybody saved.
    const gone = await screen.findByLabelText(/Retired desk/u);
    expect((gone as HTMLInputElement).checked).toBe(true);
    expect(screen.getAllByText("Archived").length).toBeGreaterThan(0);
  });

  it("shows the refusal's own sentence and keeps everything typed", async () => {
    routed.pathname = "/projects/prj_1/tests/tst_1";
    apiAnswers({
      "/api/me": { status: 200, body: meWith("admin") },
      "/api/tests/tst_1": [
        { status: 200, body: testRow() },
        {
          status: 409,
          body: {
            error: "identity_conflict",
            message: "Test tst_1 changed after you opened it.",
          },
        },
      ],
      "/api/tests/tst_1/versions": {
        status: 200,
        body: { items: [], next_cursor: null },
      },
      "/api/agents": {
        status: 200,
        body: { items: [agentRow()], next_cursor: null },
      },
      "/api/personas": { status: 200, body: { items: [], next_cursor: null } },
      "/api/graders": { status: 200, body: { items: [], next_cursor: null } },
      "/api/capabilities": { status: 200, body: CAPABILITIES },
    });
    render(<TestDetailPage />);
    await screen.findByLabelText("Name");

    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "Typed and refused" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save settings" }));

    expect(
      await screen.findByText("Test tst_1 changed after you opened it."),
    ).toBeTruthy();
    // A refusal that cleared the fields would make somebody retype their work to
    // find out whether the second attempt fails the same way.
    expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe(
      "Typed and refused",
    );
  });

  it("carries nothing from one test to another: not the typing, not the refusal", async () => {
    routed.pathname = "/projects/prj_1/tests/tst_1";
    apiAnswers({
      "/api/me": { status: 200, body: meWith("admin") },
      "/api/tests/tst_1": [
        { status: 200, body: testRow() },
        {
          status: 409,
          body: { error: "identity_conflict", message: "Test tst_1 moved." },
        },
      ],
      "/api/tests/tst_2": {
        status: 200,
        body: testRow({ id: "tst_2", name: "A different test", revision: "rev_2" }),
      },
      "/api/tests/tst_1/versions": {
        status: 200,
        body: { items: [], next_cursor: null },
      },
      "/api/tests/tst_2/versions": {
        status: 200,
        body: { items: [], next_cursor: null },
      },
      "/api/agents": {
        status: 200,
        body: { items: [agentRow()], next_cursor: null },
      },
      "/api/personas": { status: 200, body: { items: [], next_cursor: null } },
      "/api/graders": { status: 200, body: { items: [], next_cursor: null } },
      "/api/capabilities": { status: 200, body: CAPABILITIES },
    });
    const view = render(<TestDetailPage />);
    await screen.findByLabelText("Name");

    // Type into one test and have the save refused, which leaves a retry.
    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "Typed for the first test" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save settings" }));
    expect(await screen.findByText("Test tst_1 moved.")).toBeTruthy();

    // Then open another one. Everything that meant "for the test on screen"
    // has to go with it — a retry left behind would send this typing against
    // the other test's revision and report success for a test nobody was
    // looking at.
    routed.testId = "tst_2";
    routed.pathname = "/projects/prj_1/tests/tst_2";
    view.rerender(<TestDetailPage />);

    await waitFor(() => {
      expect(
        (screen.getByLabelText("Name") as HTMLInputElement).value,
      ).toBe("A different test");
    });
    expect(screen.queryByText("Test tst_1 moved.")).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Read the test again" }),
    ).toBeNull();
  });

  it("reads an older version without offering to make it current", async () => {
    routed.pathname = "/projects/prj_1/tests/tst_1";
    apiAnswers({
      "/api/me": { status: 200, body: meWith("admin") },
      "/api/tests/tst_1": { status: 200, body: testRow({ version: 2 }) },
      "/api/tests/tst_1/versions": {
        status: 200,
        body: {
          items: [
            {
              ...testRow(),
              id: "tstv_2",
              test_id: "tst_1",
              test_name: "Reschedules",
              version: 2,
              current: true,
            },
            {
              ...testRow(),
              id: "tstv_1",
              test_id: "tst_1",
              test_name: "Reschedules",
              version: 1,
              current: false,
              scenario: "What it used to say.",
            },
          ],
          next_cursor: null,
        },
      },
      "/api/agents": {
        status: 200,
        body: { items: [agentRow()], next_cursor: null },
      },
      "/api/personas": { status: 200, body: { items: [], next_cursor: null } },
      "/api/graders": { status: 200, body: { items: [], next_cursor: null } },
      "/api/capabilities": { status: 200, body: CAPABILITIES },
    });
    render(<TestDetailPage />);

    const readers = await screen.findAllByRole("button", { name: "Read" });
    fireEvent.click(readers[1] as HTMLElement);

    expect(await screen.findByText("What it used to say.")).toBeTruthy();
    // Making an old version current is an edit somebody makes deliberately by
    // carrying it forward, never a control on a page opened to look at history.
    expect(screen.queryByRole("button", { name: /Restore this version/u })).toBeNull();
    expect(screen.queryByRole("button", { name: /Make current/u })).toBeNull();
  });

  it("gives a viewer every read and controls that are present and inert", async () => {
    detail("viewer");
    await screen.findByLabelText("Name");

    for (const name of [
      "Save settings",
      "Save version",
      "Save applicable agents",
      "Clone",
      "Archive",
    ]) {
      expect(
        screen.getByRole("button", { name }).hasAttribute("disabled"),
        name,
      ).toBe(true);
    }
    expect(
      screen.getAllByText(/Your viewer role cannot change tests/u).length,
    ).toBeGreaterThan(0);
  });

  it("takes an agent in the Restore of a test an upgrade left with none", async () => {
    detail(
      "admin",
      testRow({
        archived_at: "2026-08-02T00:00:00.000Z",
        archive_reason: "needs_agent",
        agents: [],
      }),
    );
    await screen.findByLabelText("Front desk");

    // The state and the reason are both said, because the person finding it did
    // not choose it and the fix is to link an agent.
    expect(
      screen.getByText(/Archived during an upgrade/u),
    ).toBeTruthy();

    fireEvent.click(await screen.findByLabelText("Front desk"));
    fireEvent.click(screen.getByRole("button", { name: "Restore" }));

    await waitFor(() => {
      expect(sentTo("/api/tests/tst_1/restore").length).toBeGreaterThan(0);
    });
    const body = sentTo("/api/tests/tst_1/restore").at(-1)?.body as Record<
      string,
      unknown
    >;
    // In the same request, so there is never an instant in which the test is
    // active and unusable.
    expect(body.agents).toEqual(["agt_1"]);
  });
});
