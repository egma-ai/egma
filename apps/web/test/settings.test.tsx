// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import RootPage from "../app/page.tsx";
import NewProjectPage from "../app/new-project/page.tsx";
import ApiKeysPage from "../app/projects/[projectId]/settings/keys/page.tsx";
import JudgeSettingsPage from "../app/projects/[projectId]/settings/judge/page.tsx";
import OrganizationSettingsPage from "../app/projects/[projectId]/settings/organization/page.tsx";
import PeoplePage from "../app/projects/[projectId]/settings/people/page.tsx";
import ProjectSettingsPage from "../app/projects/[projectId]/settings/page.tsx";
import type { Me } from "../lib/me.ts";

/**
 * The Settings area, rendered and driven the way somebody with a keyboard
 * drives it.
 *
 * **Nothing here asserts that a component exists or that a source file contains
 * a string.** Every test puts the API's real answers in front of a real page
 * and reads what the DOM then says.
 *
 * The claims worth having in the fast lane are the ones these pages decide for
 * themselves: that a save carries the revision it was opened at and a stale one
 * keeps the typing, that a viewer's own-key controls stay live while every
 * other mutation control is present and genuinely inert, that a secret is shown
 * once and never again, and that an organization-wide page says out loud that
 * it is not about the project the selector is showing.
 */

const routed = vi.hoisted(() => ({
  push: vi.fn(),
  pathname: "/projects/prj_1/settings",
  projectId: "prj_1",
}));

vi.mock("next/navigation", () => ({
  usePathname: () => routed.pathname,
  useRouter: () => ({ push: routed.push, replace: vi.fn(), back: vi.fn() }),
  useParams: () => ({ projectId: routed.projectId }),
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

const PROJECTS = [
  { id: "prj_1", name: "Default", slug: "default" },
  { id: "prj_2", name: "Outbound", slug: "outbound" },
];

function meWith(role: string): Me {
  return {
    user: { id: "usr_1", email: "ada@acme.example" },
    organizations: [{ id: "org_1", name: "Acme", slug: "acme", role }],
    projects: PROJECTS,
  };
}

const PROJECT = {
  id: "prj_1",
  name: "Default",
  slug: "default",
  description: "The first one.",
  organization_id: "org_1",
  revision: "rev_1",
  created_at: "2026-08-01T10:00:00.000Z",
  may_manage_projects: true,
};

const ORGANIZATION = {
  id: "org_1",
  name: "Acme",
  slug: "acme",
  created_at: "2026-08-01T10:00:00.000Z",
  may_manage_organization: true,
};

const CREDENTIAL = {
  id: "jcr_1",
  label: "Acme production",
  provider: "openai",
  hint: "1234",
  revision: "rev_1",
  created_at: "2026-08-01T10:00:00.000Z",
  updated_at: "2026-08-01T10:00:00.000Z",
};

const NEEDS_SETUP = {
  state: "needs_setup",
  provider: null,
  model: null,
  source: null,
  credential_id: null,
  hint: null,
};

const REGISTRY = {
  providers: [{ provider: "openai", model_is_free_text: true }],
  platform_sentinel: "platform",
  platform_judge_available: false,
};

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

type Stubbed = { status: number; body: unknown } | "never";

/** Every request the browser made, in order. */
let sent: { url: string; method: string; body: unknown }[] = [];

/**
 * Whatever egma is standing in for, keyed by **path**. A page that asks for
 * something nothing is stubbed for fails loudly rather than quietly rendering
 * an empty state, because a test that passes on a request nobody meant to make
 * is a test proving nothing.
 */
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

/** Where a page sent the browser, if it sent it anywhere. */
let wentTo: string[] = [];

beforeEach(() => {
  sent = [];
  wentTo = [];
  Object.defineProperty(window, "location", {
    configurable: true,
    value: {
      ...window.location,
      href: "http://egma.test/projects/prj_1/settings",
      search: "",
      pathname: "/projects/prj_1/settings",
      replace: (url: string) => wentTo.push(url),
      assign: (url: string) => wentTo.push(url),
    },
  });
  Object.defineProperty(window, "history", {
    configurable: true,
    value: { ...window.history, pushState: vi.fn() },
  });
  routed.push.mockReset();
  routed.pathname = "/projects/prj_1/settings";
  routed.projectId = "prj_1";
  vi.stubGlobal("scrollTo", vi.fn());
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/* ------------------------------------------------------------------------ */

/**
 * The three Settings pages whose subject is the organization rather than the
 * project the address names, and the sentence each one says about that.
 *
 * Every one of them is here rather than one standing in for the rest: the note
 * is written per page, in that page's own words about that page's own subject,
 * so a page that lost it would go on passing a test written against a sibling.
 */
const ORGANIZATION_WIDE: readonly {
  readonly page: string;
  readonly answers: Record<string, Stubbed | readonly Stubbed[]>;
  readonly open: () => void;
  readonly says: RegExp;
}[] = [
  {
    page: "Organization",
    answers: {
      "/api/organization": { status: 200, body: ORGANIZATION },
      "/api/judge-credentials": { status: 200, body: { items: [] } },
    },
    open: () => render(<OrganizationSettingsPage />),
    says: /Everything on this page belongs to the whole organization/,
  },
  {
    page: "People",
    answers: {
      "/api/members": {
        status: 200,
        body: { members: [], may_manage_members: true },
      },
      "/api/invitations": { status: 200, body: { invitations: [] } },
    },
    open: () => render(<PeoplePage />),
    says: /Membership belongs to the whole organization/,
  },
  {
    page: "API keys",
    answers: { "/api/keys": { status: 200, body: { keys: [] } } },
    open: () => render(<ApiKeysPage />),
    says: /Keys belong to the organization/,
  },
];

describe("the Settings navigation", () => {
  it("says which settings belong to the project and which to the organization", async () => {
    apiAnswers({
      "/api/me": { status: 200, body: meWith("admin") },
      "/api/projects/prj_1": { status: 200, body: PROJECT },
    });
    render(<ProjectSettingsPage />);

    const nav = await screen.findByRole("navigation", { name: "Settings" });
    expect(nav.textContent).toContain("This project");
    expect(nav.textContent).toContain("Organization");

    // Every address carries the project, including the organization-wide ones:
    // the shell reads the project out of the address, and Settings has to stay
    // inside the product shell for the selector to be there at all.
    const people = within(nav).getByRole("link", { name: "People" });
    expect(people.getAttribute("href")).toBe("/projects/prj_1/settings/people");
    expect(
      within(nav).getByRole("link", { name: "Judge" }).getAttribute("href"),
    ).toBe("/projects/prj_1/settings/judge");
  });

  /**
   * The note is the whole reason an organization-wide page can live under a
   * project's address. The selector is still on screen and still naming a
   * project; without a sentence saying otherwise, that reads as a claim.
   *
   * Both halves of that are asserted here, because the arrangement only works
   * if both are true at once: a selector with no note is a page making a claim
   * about a project, and a note with no selector is a page nobody can leave.
   */
  it.each(ORGANIZATION_WIDE)(
    "keeps the selector on $page and says the project it names is not the subject",
    async ({ answers, open, says }) => {
      apiAnswers({
        "/api/me": { status: 200, body: meWith("admin") },
        ...answers,
      });
      open();

      // The note is drawn only once the page's own read has answered, so
      // finding it is also what says the page is showing itself rather than a
      // loading or a failure state.
      expect(await screen.findByText(says)).toBeTruthy();

      // And the selector is still on screen, naming the project the address
      // does. Waited for rather than read on sight: the shell draws the
      // control before `/api/me` lands and it says "No organization" until
      // then, so an immediate read would pass on a session nobody had.
      const selectors = await screen.findAllByRole("button", {
        name: /^Organization Acme, project Default\./,
      });
      expect(selectors.length).toBeGreaterThan(0);
    },
  );
});

/* ------------------------------------------------------------------------ */

describe("project settings", () => {
  function open(role = "admin", project: unknown = PROJECT) {
    apiAnswers({
      "/api/me": { status: 200, body: meWith(role) },
      "/api/projects/prj_1": { status: 200, body: project },
    });
    render(<ProjectSettingsPage />);
  }

  it("shows what is stored, and saves against the revision it was opened at", async () => {
    apiAnswers({
      "/api/me": { status: 200, body: meWith("admin") },
      "/api/projects/prj_1": [
        { status: 200, body: PROJECT },
        { status: 200, body: { ...PROJECT, name: "Renamed", revision: "rev_2" } },
      ],
    });
    render(<ProjectSettingsPage />);

    const name = (await screen.findByLabelText("Name")) as HTMLInputElement;
    // Waited for rather than read once: the field exists on the first ready
    // render and the stored values arrive on the next.
    await waitFor(() => {
      expect(name.value).toBe("Default");
    });
    expect((screen.getByLabelText("Description") as HTMLTextAreaElement).value).toBe(
      "The first one.",
    );

    fireEvent.change(name, { target: { value: "Renamed" } });
    fireEvent.click(screen.getByRole("button", { name: "Save project" }));

    await waitFor(() => {
      expect(sent.some((one) => one.method === "PATCH")).toBe(true);
    });
    expect(sent.find((one) => one.method === "PATCH")?.body).toEqual({
      name: "Renamed",
      slug: "default",
      description: "The first one.",
      expected_revision: "rev_1",
    });
  });

  /**
   * Two admins with this page open in two tabs. The refusal is shown in its own
   * words, **what was typed is still there**, and the way out is to read the
   * project again rather than to retype anything.
   */
  it("keeps the draft when a stale save is refused, and offers a way to recover", async () => {
    // Queued once, before the first render, rather than swapped after it.
    // Swapping mid-test raced the page's own load: a read still in flight when
    // the answers changed took the 409 meant for the save, the save then got
    // the success behind it, and no conflict was ever shown. It failed about
    // one run in four. The answers a test needs are all known before it starts,
    // so there is no reason to change them while it is running.
    apiAnswers({
      "/api/me": { status: 200, body: meWith("admin") },
      "/api/projects/prj_1": [
        { status: 200, body: PROJECT },
        {
          status: 409,
          body: {
            error: "identity_conflict",
            message:
              "Project prj_1 changed after you opened it. Read it again, keep or reapply your edits, and send the update with expected_revision set to its new revision.",
          },
        },
        { status: 200, body: { ...PROJECT, revision: "rev_2" } },
      ],
    });
    render(<ProjectSettingsPage />);

    const name = (await screen.findByLabelText("Name")) as HTMLInputElement;
    // The stored name arrives a render after the field exists, so the draft is
    // typed only once the page is showing what it read. Typing sooner would be
    // overwritten by the answer landing behind it.
    await screen.findByDisplayValue(PROJECT.name as string);
    fireEvent.change(name, { target: { value: "My careful rename" } });

    fireEvent.click(screen.getByRole("button", { name: "Save project" }));

    expect(
      await screen.findByText(/changed after you opened it/),
    ).toBeTruthy();
    expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe(
      "My careful rename",
    );
    expect(
      screen.getByRole("button", { name: "Read this project again" }),
    ).toBeTruthy();
  });

  /**
   * Disable, do not hide. A viewer reads the same page, sees the same fields
   * and what is in them, and every control that would change data is genuinely
   * inert — with the sentence that says whose decision it is.
   */
  it.each(["viewer", "member"] as const)(
    "leaves a %s every control in place and truly disabled",
    async (role) => {
      open(role, { ...PROJECT, may_manage_projects: false });

      const name = (await screen.findByLabelText("Name")) as HTMLInputElement;
      await waitFor(() => {
        expect(name.value).toBe("Default");
      });
      expect(name.disabled).toBe(true);
      expect((screen.getByLabelText("Slug") as HTMLInputElement).disabled).toBe(true);

      const save = screen.getByRole("button", { name: "Save project" });
      expect(save.hasAttribute("disabled")).toBe(true);
      expect(
        screen.getByText(
          `Your ${role} role cannot change project settings. Ask an organization admin.`,
        ),
      ).toBeTruthy();
    },
  );

  /**
   * The server says who may edit, and this page believes it.
   *
   * The two tests above cannot tell the difference, and that is the point: for
   * a viewer, *not an admin* and *not permitted* are true at the same time, so
   * a page reading either one passes. They part company only here — somebody
   * the server permits who is not an admin.
   *
   * `may_manage_projects` is computed by the API from the same permission check
   * that decides whether the write lands. A page deriving it from the role
   * instead is a second opinion about what `manage_projects` means, and the
   * moment that permission moves the two disagree: controls withheld from
   * somebody who may act, or controls offered whose writes come back refused.
   */
  it("lets a non-admin edit when the server says the permission is theirs", async () => {
    open("member", { ...PROJECT, may_manage_projects: true });

    const name = (await screen.findByLabelText("Name")) as HTMLInputElement;
    await waitFor(() => {
      expect(name.value).toBe("Default");
    });

    expect(name.disabled).toBe(false);
    expect((screen.getByLabelText("Slug") as HTMLInputElement).disabled).toBe(
      false,
    );
    expect(
      screen
        .getByRole("button", { name: "Save project" })
        .hasAttribute("disabled"),
    ).toBe(false);
    // And no sentence telling them a role they hold forbids what they may do.
    expect(
      screen.queryByText(/role cannot change project settings/),
    ).toBeNull();
  });

  it("says so, and offers a retry, when egma refuses the read", async () => {
    apiAnswers({
      "/api/me": { status: 200, body: meWith("admin") },
      "/api/projects/prj_1": {
        status: 500,
        body: { error: "unavailable", message: "Egma could not answer that." },
      },
    });
    render(<ProjectSettingsPage />);

    expect(await screen.findByText("Egma could not answer that.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
  });

  it("sends an expired session to sign-in rather than showing a retry that cannot work", async () => {
    apiAnswers({
      "/api/me": { status: 401, body: { error: "not_signed_in", message: "no" } },
      "/api/projects/prj_1": {
        status: 401,
        body: { error: "not_signed_in", message: "no" },
      },
    });
    render(<ProjectSettingsPage />);

    await waitFor(() => {
      expect(wentTo).toContain("/sign-in");
    });
  });
});

/* ------------------------------------------------------------------------ */

describe("making a project", () => {
  it("asks for a name, and lands in the project it made", async () => {
    apiAnswers({
      "/api/me": { status: 200, body: meWith("admin") },
      "/api/projects": {
        status: 201,
        body: { ...PROJECT, id: "prj_9", name: "Outbound sales" },
      },
    });
    render(<NewProjectPage />);

    fireEvent.change(await screen.findByLabelText("Name"), {
      target: { value: "Outbound sales" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create project" }));

    await waitFor(() => {
      expect(wentTo).toContain("/projects/prj_9/agents");
    });
    expect(sent.find((one) => one.method === "POST")?.body).toEqual({
      name: "Outbound sales",
      description: "",
    });
  });

  /**
   * The slug is the server's to derive and to number, so the form does not ask
   * for one. A second copy of that rule in the browser would be a copy that is
   * wrong the day the rule changes, and silently.
   */
  it("does not ask for a slug", async () => {
    apiAnswers({
      "/api/me": { status: 200, body: meWith("admin") },
      "/api/projects": "never",
    });
    render(<NewProjectPage />);

    await screen.findByLabelText("Name");
    expect(screen.queryByLabelText("Slug")).toBeNull();
  });

  it.each(["viewer", "member"] as const)(
    "leaves a %s the page, disabled, and says who to ask",
    async (role) => {
      apiAnswers({
        "/api/me": { status: 200, body: meWith(role) },
        "/api/projects": "never",
      });
      render(<NewProjectPage />);

      expect((await screen.findByLabelText("Name")).hasAttribute("disabled")).toBe(
        true,
      );
      expect(
        screen.getByRole("button", { name: "Create project" }).hasAttribute("disabled"),
      ).toBe(true);
      // Twice on purpose: once as the sentence under the heading, and once as
      // the control's own reason, which is what a keyboard and a screen reader
      // reach through `aria-describedby`.
      expect(
        screen.getAllByText(new RegExp(`Your ${role} role cannot create a project`))
          .length,
      ).toBeGreaterThan(0);
    },
  );

  it("keeps the draft and shows the refusal when the slug is taken", async () => {
    apiAnswers({
      "/api/me": { status: 200, body: meWith("admin") },
      "/api/projects": {
        status: 409,
        body: {
          error: "project_slug_taken",
          message:
            "Project slug outbound is already in use in this organization. Choose a different slug and save the project again.",
        },
      },
    });
    render(<NewProjectPage />);

    fireEvent.change(await screen.findByLabelText("Name"), {
      target: { value: "Outbound" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create project" }));

    expect(await screen.findByText(/already in use in this organization/)).toBeTruthy();
    expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe(
      "Outbound",
    );
    expect(wentTo).toEqual([]);
  });
});

/**
 * An organization that holds no project.
 *
 * Signup provisions one, so this is rare — and the person who meets it is
 * standing in front of a product shell with nothing in it, which is exactly
 * when a dead end is worst. There has to be a way forward from the entrance
 * itself, and a viewer or a member has to be told whose decision it is rather
 * than left looking at an empty page with no explanation.
 */
describe("an organization with no project", () => {
  it("offers an admin the way to make the first one", async () => {
    apiAnswers({
      "/api/me": {
        status: 200,
        body: { ...meWith("admin"), projects: [] },
      },
    });
    render(<RootPage />);

    const create = await screen.findByRole("link", {
      name: "Create the first project",
    });
    expect(create.getAttribute("href")).toBe("/new-project");
    // And it did not quietly send anybody into a project that is not there.
    expect(wentTo).toEqual([]);
  });

  it.each(["viewer", "member"] as const)(
    "tells a %s who to ask, with the control present and inert",
    async (role) => {
      apiAnswers({
        "/api/me": { status: 200, body: { ...meWith(role), projects: [] } },
      });
      render(<RootPage />);

      const create = await screen.findByRole("button", {
        name: "Create the first project",
      });
      expect(create.hasAttribute("disabled")).toBe(true);
      expect(
        screen.getByText(
          `Your ${role} role cannot create a project. Ask an organization admin to make the first one.`,
        ),
      ).toBeTruthy();
    },
  );
});

/* ------------------------------------------------------------------------ */

describe("organization settings", () => {
  function open(
    role = "admin",
    organization: unknown = ORGANIZATION,
    credentials: unknown[] = [],
  ) {
    apiAnswers({
      "/api/me": { status: 200, body: meWith(role) },
      "/api/organization": { status: 200, body: organization },
      "/api/judge-credentials": { status: 200, body: { items: credentials } },
    });
    render(<OrganizationSettingsPage />);
  }

  it("renames the organization and leaves its short name alone", async () => {
    apiAnswers({
      "/api/me": { status: 200, body: meWith("admin") },
      "/api/organization": [
        { status: 200, body: ORGANIZATION },
        { status: 200, body: { ...ORGANIZATION, name: "Acme Voice" } },
        { status: 200, body: { ...ORGANIZATION, name: "Acme Voice" } },
      ],
      "/api/judge-credentials": { status: 200, body: { items: [] } },
    });
    render(<OrganizationSettingsPage />);

    // Waited for the stored name, not just the field. The field exists on the
    // first ready render and what was read lands on the next, so typing on
    // sight let the answer overwrite the draft — the PATCH then carried "Acme"
    // and the test failed on a name nobody had typed. About one run in eight.
    await screen.findByDisplayValue(ORGANIZATION.name);
    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "Acme Voice" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save organization" }));

    await waitFor(() => {
      expect(sent.some((one) => one.method === "PATCH")).toBe(true);
    });
    // The name, and nothing else. The slug is what invitation links were sent
    // under, so this door does not offer it.
    expect(sent.find((one) => one.method === "PATCH")?.body).toEqual({
      name: "Acme Voice",
    });
  });

  it.each(["viewer", "member"] as const)(
    "leaves a %s the page, disabled, with the reason beside it",
    async (role) => {
      open(role, { ...ORGANIZATION, may_manage_organization: false });

      const name = (await screen.findByLabelText("Name")) as HTMLInputElement;
      await waitFor(() => {
        expect(name.value).toBe("Acme");
      });
      expect(name.disabled).toBe(true);
      expect(
        screen
          .getByRole("button", { name: "Save organization" })
          .hasAttribute("disabled"),
      ).toBe(true);
      expect(
        screen.getByText(
          `Your ${role} role cannot change organization settings. Ask an organization admin.`,
        ),
      ).toBeTruthy();
    },
  );

  /**
   * The whole point of the credential design, asserted from the page: what is
   * shown is a label and four characters, and the typed key is never rendered
   * back anywhere.
   */
  it("shows a label and a hint, and never a stored key", async () => {
    open("admin", ORGANIZATION, [CREDENTIAL]);

    const keys = await screen.findByRole("region", { name: "Judge credentials" });
    expect(keys.textContent).toContain("Acme production");
    expect(keys.textContent).toContain("…1234");
    expect(keys.textContent).toContain("never the key itself");
  });

  it("sends a typed key once and does not keep it on the page", async () => {
    apiAnswers({
      "/api/me": { status: 200, body: meWith("admin") },
      "/api/organization": { status: 200, body: ORGANIZATION },
      /**
       * Three answers, in the order the page actually asks for them: the list
       * it opens with, the created credential, and **the list again**. Naming
       * every answer is what makes the ordering the test's rather than the
       * machine's — with only two, the refetch was served the create's own
       * reply, which has no `items`.
       */
      "/api/judge-credentials": [
        { status: 200, body: { items: [] } },
        { status: 201, body: CREDENTIAL },
        { status: 200, body: { items: [CREDENTIAL] } },
      ],
    });
    render(<OrganizationSettingsPage />);

    fireEvent.change(await screen.findByLabelText("Label"), {
      target: { value: "Acme production" },
    });
    fireEvent.change(screen.getByLabelText("OpenAI key"), {
      target: { value: "sk-typed-once-and-never-shown" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add key" }));

    await waitFor(() => {
      expect(
        within(
          screen.getByRole("region", { name: "Judge credentials" }),
        ).getAllByText(/Acme production/),
      ).not.toHaveLength(0);
    });
    expect((screen.getByLabelText("OpenAI key") as HTMLInputElement).value).toBe("");

    const post = sent.find((one) => one.method === "POST");
    expect(post?.body).toEqual({
      label: "Acme production",
      provider: "openai",
      key: "sk-typed-once-and-never-shown",
    });
    expect(document.body.textContent).not.toContain("sk-typed-once");
  });

  /**
   * The shape guard, from the outside. A read whose shape is not the expected
   * one is a deployment mid-upgrade or a proxy answering for something else,
   * and the cost of trusting it is `undefined.map` — which takes the page down
   * and with it the thing somebody came to change.
   */
  it("survives a credentials answer in a shape it does not expect", async () => {
    apiAnswers({
      "/api/me": { status: 200, body: meWith("admin") },
      "/api/organization": { status: 200, body: ORGANIZATION },
      "/api/judge-credentials": { status: 200, body: { id: "jcr_1" } },
    });
    render(<OrganizationSettingsPage />);

    expect(await screen.findByLabelText("Label")).toBeTruthy();
    expect(
      screen.getByRole("region", { name: "Judge credentials" }).textContent,
    ).toContain("No judge credentials yet.");
  });

  it("offers an empty field for a replacement and never prefills the stored key", async () => {
    open("admin", ORGANIZATION, [CREDENTIAL]);

    const keys = await screen.findByRole("table", { name: "Organization keys" });
    fireEvent.click(within(keys).getByRole("button", { name: "Replace key" }));

    const field = screen.getByLabelText("New key") as HTMLInputElement;
    expect(field.value).toBe("");
    expect(field.type).toBe("password");
    expect(screen.getByText(/egma will not show it to you/)).toBeTruthy();
  });

  /**
   * A failure has to report the thing that failed, and its retry has to be the
   * action that was refused rather than the one beside it.
   */
  it("reports the key that failed, and retries adding the key", async () => {
    apiAnswers({
      "/api/me": { status: 200, body: meWith("admin") },
      "/api/organization": { status: 200, body: ORGANIZATION },
      "/api/judge-credentials": [
        { status: 200, body: { items: [] } },
        {
          status: 422,
          body: {
            error: "unprocessable",
            message: "a judge key is at least 8 characters.",
          },
        },
      ],
    });
    render(<OrganizationSettingsPage />);

    fireEvent.change(await screen.findByLabelText("Label"), {
      target: { value: "Acme production" },
    });
    fireEvent.change(screen.getByLabelText("OpenAI key"), {
      target: { value: "sk-short" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add key" }));

    expect(
      await screen.findByText("a judge key is at least 8 characters."),
    ).toBeTruthy();
    expect(screen.getByText("Egma did not add this key.")).toBeTruthy();

    const before = sent.filter((one) => one.method === "POST").length;
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => {
      expect(sent.filter((one) => one.method === "POST").length).toBe(before + 1);
    });
  });

  /**
   * **The form is drawn once, for whichever key is open, so what is typed into
   * it belongs to that key and to no other.**
   *
   * Leaving it behind when a different row opens is a silent cross-row write of
   * a secret: the key typed for A is saved to B, so B starts spending on a key
   * nobody chose for it while A keeps the one it was supposed to lose — and
   * nothing on the page says so.
   */
  it("clears a replacement typed for one key when another key opens", async () => {
    open("admin", ORGANIZATION, [
      CREDENTIAL,
      { ...CREDENTIAL, id: "jcr_2", label: "Acme staging", hint: "5678" },
    ]);

    // Scoped to the wide layout's table: one column definition draws the rows
    // twice, so an unscoped query would hand back four openers for two keys.
    const keys = await screen.findByRole("table", { name: "Organization keys" });
    const [openFirst, openSecond] = within(keys).getAllByRole("button", {
      name: "Replace key",
    });

    fireEvent.click(openFirst as HTMLElement);
    fireEvent.change(screen.getByLabelText("New key"), {
      target: { value: "sk-meant-for-production" },
    });

    fireEvent.click(openSecond as HTMLElement);

    expect((screen.getByLabelText("New key") as HTMLInputElement).value).toBe("");
    // And with nothing typed for this one, there is nothing to send.
    expect(
      screen.getByRole("button", { name: "Save new key" }).hasAttribute("disabled"),
    ).toBe(true);
  });

  /**
   * The second half, and the one a field-clearing fix does not close: a failed
   * rotation leaves a **Try again** bound to the key that failed, while the
   * action it calls reads the field as it stands when it is pressed. Fail on A,
   * open B, type B's key, press it — and B's key is written to A and reported
   * as success for a credential nobody is looking at.
   */
  it("takes the failed retry away with it when another key opens", async () => {
    apiAnswers({
      "/api/me": { status: 200, body: meWith("admin") },
      "/api/organization": { status: 200, body: ORGANIZATION },
      "/api/judge-credentials": {
        status: 200,
        body: {
          items: [
            CREDENTIAL,
            { ...CREDENTIAL, id: "jcr_2", label: "Acme staging", hint: "5678" },
          ],
        },
      },
      "/api/judge-credentials/jcr_1": {
        status: 422,
        body: {
          error: "unprocessable",
          message: "a judge key is at least 8 characters.",
        },
      },
    });
    render(<OrganizationSettingsPage />);

    const keys = await screen.findByRole("table", { name: "Organization keys" });
    const [openProduction, openStaging] = within(keys).getAllByRole("button", {
      name: "Replace key",
    });

    fireEvent.click(openProduction as HTMLElement);
    fireEvent.change(screen.getByLabelText("New key"), {
      target: { value: "sk-short" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save new key" }));

    expect(
      await screen.findByText(/Egma did not replace the key for Acme production/),
    ).toBeTruthy();

    // A different key opens. The retry that would have written into the first
    // one has to go with it.
    fireEvent.click(openStaging as HTMLElement);

    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
    expect(
      screen.queryByText(/Egma did not replace the key for Acme production/),
    ).toBeNull();
    expect((screen.getByLabelText("New key") as HTMLInputElement).value).toBe("");
  });

  it("leaves a member the key controls in place and truly disabled", async () => {
    open("member", { ...ORGANIZATION, may_manage_organization: false }, [CREDENTIAL]);

    expect(
      (await screen.findByLabelText("Label")).hasAttribute("disabled"),
    ).toBe(true);
    expect(
      screen.getByRole("button", { name: "Add key" }).hasAttribute("disabled"),
    ).toBe(true);
    expect(
      screen
        .getAllByRole("button", { name: "Replace key" })
        .every((one) => one.hasAttribute("disabled")),
    ).toBe(true);
  });
});

/* ------------------------------------------------------------------------ */

describe("judge settings", () => {
  function open(
    role = "admin",
    judge: unknown = NEEDS_SETUP,
    credentials: unknown[] = [],
    registry: unknown = REGISTRY,
  ) {
    apiAnswers({
      "/api/me": { status: 200, body: meWith(role) },
      "/api/judge": { status: 200, body: judge },
      "/api/judge/registry": { status: 200, body: registry },
      "/api/judge-credentials": { status: 200, body: { items: credentials } },
    });
    render(<JudgeSettingsPage />);
  }

  /**
   * `needs_setup` is a state and not an empty form. A project in it cannot ask a
   * model anything, which means the built-in cannot judge — so a run started
   * this way comes back errored after real calls have been paid for.
   */
  it("says plainly that a project with no judge cannot grade with a model", async () => {
    open();

    expect(await screen.findByText(/Needs setup/)).toBeTruthy();
    expect(screen.getByText(/LLM grading is unavailable/)).toBeTruthy();
  });

  /**
   * The separation this Settings area is built on, said on the page that would
   * otherwise be the natural place to keep the keys: the choice belongs to a
   * project, the keys belong to the organization.
   */
  it("points at organization settings for the keys themselves", async () => {
    open("admin", NEEDS_SETUP, [CREDENTIAL]);

    const link = await screen.findByRole("link", {
      name: "Organization settings",
    });
    expect(link.getAttribute("href")).toBe(
      "/projects/prj_1/settings/organization",
    );
    // And no key custody on this page at all.
    expect(screen.queryByRole("button", { name: "Add key" })).toBeNull();
  });

  it("offers the deployment's own judge while the project is on a credential of its own", async () => {
    open(
      "admin",
      {
        state: "configured",
        project_id: "prj_1",
        provider: "openai",
        model: "gpt-4.1-mini",
        source: "credential",
        credential_id: "jcr_1",
        hint: "1234",
        updated_at: "2026-08-01T10:00:00.000Z",
      },
      [CREDENTIAL],
      { ...REGISTRY, platform_judge_available: true },
    );

    const key = (await screen.findByLabelText("Key")) as HTMLSelectElement;
    // Found rather than fetched: the select exists as soon as the judge read
    // answers, but this option is drawn from the *registry* read, which is a
    // separate request that can land after it. Reading synchronously raced the
    // second answer and failed about one run in six, on an option that was
    // always going to arrive.
    const offered = (await within(key).findByRole("option", {
      name: "This deployment's own judge",
    })) as HTMLOptionElement;
    expect(offered.value).toBe("platform");

    fireEvent.change(key, { target: { value: "platform" } });
    fireEvent.click(screen.getByRole("button", { name: "Save judge" }));

    await waitFor(() => {
      expect(sent.some((one) => one.method === "PUT")).toBe(true);
    });
    expect(sent.find((one) => one.method === "PUT")?.body).toMatchObject({
      source: "platform",
      provider: "openai",
    });
  });

  it("offers nothing of the sort on a deployment that configured no judge", async () => {
    open("admin", NEEDS_SETUP, [CREDENTIAL]);

    const key = (await screen.findByLabelText("Key")) as HTMLSelectElement;
    // The credential option first, and waited for. It comes from the same
    // second request the platform option would come from, so its arrival is
    // what says both reads have landed. Asserting the platform option is
    // absent before then would pass because nothing had answered yet — the
    // right result for the wrong reason, which is the kind of test that goes
    // on passing after the behaviour it guards is gone.
    expect(
      await within(key).findByRole("option", { name: /Acme production/ }),
    ).toBeTruthy();
    expect(
      within(key).queryByRole("option", {
        name: "This deployment's own judge",
      }),
    ).toBeNull();
  });

  /**
   * **A failed read is not a fact.** A registry read that failed must not be
   * rendered as "this deployment has no judge of its own" — that would take the
   * way back to the platform judge off the page, silently, over a blip.
   */
  it("says egma could not ask, rather than answering for it, when the registry read fails", async () => {
    apiAnswers({
      "/api/me": { status: 200, body: meWith("admin") },
      "/api/judge": { status: 200, body: NEEDS_SETUP },
      "/api/judge/registry": {
        status: 500,
        body: { error: "unavailable", message: "Egma could not answer that." },
      },
      "/api/judge-credentials": { status: 200, body: { items: [] } },
    });
    render(<JudgeSettingsPage />);

    expect(await screen.findByText("Egma could not answer that.")).toBeTruthy();
    expect(screen.queryByLabelText("Key")).toBeNull();
    expect(screen.queryByLabelText("Provider")).toBeNull();
    expect(
      screen.getByRole("button", { name: "Save judge" }).hasAttribute("disabled"),
    ).toBe(true);
  });

  it("says the deployment's own judge has nothing to rotate", async () => {
    open("admin", {
      state: "configured",
      project_id: "prj_1",
      provider: "openai",
      model: "gpt-4o",
      source: "platform",
      credential_id: null,
      hint: null,
      updated_at: "2026-08-01T10:00:00.000Z",
    });

    expect(
      await screen.findByText(/nothing here to rotate and no key to see/),
    ).toBeTruthy();
  });

  it("leaves a member every control in place and truly disabled", async () => {
    open("member");

    expect(
      await screen.findByText(/role cannot change judge settings/),
    ).toBeTruthy();
    expect(
      (screen.getByLabelText("Provider") as HTMLSelectElement).disabled,
    ).toBe(true);
    expect(
      screen.getByRole("button", { name: "Save judge" }).hasAttribute("disabled"),
    ).toBe(true);
  });

  it("sends the provider, the model and the credential, and no key at all", async () => {
    apiAnswers({
      "/api/me": { status: 200, body: meWith("admin") },
      "/api/judge": [
        { status: 200, body: NEEDS_SETUP },
        {
          status: 200,
          body: {
            state: "configured",
            project_id: "prj_1",
            provider: "openai",
            model: "gpt-4.1-mini",
            source: "credential",
            credential_id: "jcr_1",
            hint: "1234",
            updated_at: "2026-08-01T10:00:00.000Z",
          },
        },
      ],
      "/api/judge/registry": { status: 200, body: REGISTRY },
      "/api/judge-credentials": { status: 200, body: { items: [CREDENTIAL] } },
    });
    render(<JudgeSettingsPage />);

    fireEvent.change(await screen.findByLabelText("Model"), {
      target: { value: "gpt-4.1-mini" },
    });
    const key = screen.getByLabelText("Key") as HTMLSelectElement;
    // The option is drawn from the credentials read, which answers separately
    // from the judge read that put the select on the page. Selecting a value
    // with no option behind it yet leaves the select empty rather than failing,
    // so the body assertion below would report the wrong thing about a page
    // that was only slow.
    await within(key).findByRole("option", { name: /Acme production/ });
    fireEvent.change(key, { target: { value: "jcr_1" } });
    fireEvent.click(screen.getByRole("button", { name: "Save judge" }));

    await waitFor(() => {
      expect(sent.some((one) => one.method === "PUT")).toBe(true);
    });
    const put = sent.find((one) => one.method === "PUT");
    expect(put?.body).toEqual({
      provider: "openai",
      model: "gpt-4.1-mini",
      source: "jcr_1",
      project: "prj_1",
    });
  });
});

/* ------------------------------------------------------------------------ */

const ADA = {
  user_id: "usr_1",
  email: "ada@acme.example",
  name: "Ada",
  role: "admin",
  joined_at: "2026-08-01T10:00:00.000Z",
  deactivated_at: null,
};

const BOB = {
  user_id: "usr_2",
  email: "bob@acme.example",
  name: "Bob",
  role: "viewer",
  joined_at: "2026-08-02T10:00:00.000Z",
  deactivated_at: null,
};

/**
 * Two invitations differing in exactly one thing: whether their day has passed.
 *
 * Measured from now rather than written out as a date, so what is asserted is
 * the page's reading of the field and not the calendar the suite happens to be
 * run on. A fixed date would make this test pass until it silently stopped
 * testing anything.
 */
const A_WEEK = 7 * 24 * 60 * 60 * 1000;

const WAITING_INVITATION = {
  id: "inv_1",
  email: "cleo@acme.example",
  role: "member",
  expires_at: new Date(Date.now() + A_WEEK).toISOString(),
  created_at: new Date(Date.now() - A_WEEK).toISOString(),
};

const DEAD_INVITATION = {
  id: "inv_2",
  email: "dev@acme.example",
  role: "viewer",
  expires_at: new Date(Date.now() - A_WEEK).toISOString(),
  created_at: new Date(Date.now() - 2 * A_WEEK).toISOString(),
};

describe("people and invitations", () => {
  function open(
    role = "admin",
    mayManage = true,
    members: unknown[] = [ADA, BOB],
    invitations: unknown[] = [],
  ) {
    apiAnswers({
      "/api/me": { status: 200, body: meWith(role) },
      "/api/members": {
        status: 200,
        body: { members, may_manage_members: mayManage },
      },
      "/api/invitations": { status: 200, body: { invitations } },
      "/api/members/usr_2/role": { status: 200, body: { ...BOB, role: "member" } },
      "/api/members/usr_2/remove": {
        status: 200,
        body: { user_id: "usr_2", keys_revoked: 1 },
      },
    });
    render(<PeoplePage />);
  }

  it("lists everybody, with a role control an admin can change", async () => {
    open();

    const table = await screen.findByRole("table", { name: "Members" });
    expect(table.textContent).toContain("ada@acme.example");
    expect(table.textContent).toContain("bob@acme.example");

    fireEvent.change(screen.getAllByLabelText("bob@acme.example role")[0]!, {
      target: { value: "member" },
    });

    await waitFor(() => {
      expect(
        sent.some((one) => one.url.includes("/api/members/usr_2/role")),
      ).toBe(true);
    });
    expect(
      sent.find((one) => one.url.includes("/api/members/usr_2/role"))?.body,
    ).toEqual({ role: "member" });
  });

  /**
   * Removing somebody is not a click. The dialog says what happens and to whom,
   * and closing it leaves the page exactly as it was.
   */
  it("asks before removing somebody, and posts only once it is answered", async () => {
    open();

    fireEvent.click(
      (await screen.findAllByRole("button", { name: "Remove" }))[1]!,
    );

    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toContain("bob@acme.example");
    expect(sent.some((one) => one.url.includes("/remove"))).toBe(false);

    fireEvent.click(within(dialog).getByRole("button", { name: "Remove" }));
    await waitFor(() => {
      expect(sent.some((one) => one.url.includes("/api/members/usr_2/remove"))).toBe(
        true,
      );
    });
  });

  /**
   * Everybody may read who their colleagues are — a member who cannot see them
   * cannot work out who to ask for anything — and the controls that would
   * change the roster are not offered to somebody the server would refuse.
   */
  it.each(["viewer", "member"] as const)(
    "shows a %s the roster and no roster controls",
    async (role) => {
      open(role, false);

      const table = await screen.findByRole("table", { name: "Members" });
      expect(table.textContent).toContain("bob@acme.example");
      expect(screen.queryByLabelText("bob@acme.example role")).toBeNull();
      expect(
        screen
          .getAllByRole("button", { name: "Deactivate" })[0]
          ?.hasAttribute("disabled"),
      ).toBe(true);
      expect(
        screen.queryByRole("radio", { name: "Invitations" }),
      ).toBeNull();
    },
  );

  it("hands the invitation link back when there was nowhere to post it", async () => {
    apiAnswers({
      "/api/me": { status: 200, body: meWith("admin") },
      "/api/members": {
        status: 200,
        body: { members: [ADA], may_manage_members: true },
      },
      "/api/invitations": [
        { status: 200, body: { invitations: [] } },
        {
          status: 201,
          body: {
            id: "inv_1",
            email: "bob@acme.example",
            role: "viewer",
            delivered: false,
            accept_url: "http://egma.test/invite?token=abc",
            expires_at: "2026-09-01T10:00:00.000Z",
            created_at: "2026-08-15T10:00:00.000Z",
          },
        },
        { status: 200, body: { invitations: [] } },
      ],
    });
    render(<PeoplePage />);

    fireEvent.click(await screen.findByRole("radio", { name: "Invitations" }));

    fireEvent.change(await screen.findByLabelText("Email"), {
      target: { value: "bob@acme.example" },
    });
    fireEvent.change(screen.getByLabelText("Role"), {
      target: { value: "viewer" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send invitation" }));

    expect(await screen.findByText(/Here is the link/)).toBeTruthy();
    expect(document.body.textContent).toContain(
      "http://egma.test/invite?token=abc",
    );
  });

  it("says the invitation is on its way when a transport delivered it", async () => {
    apiAnswers({
      "/api/me": { status: 200, body: meWith("admin") },
      "/api/members": {
        status: 200,
        body: { members: [ADA], may_manage_members: true },
      },
      "/api/invitations": [
        { status: 200, body: { invitations: [] } },
        {
          status: 201,
          body: {
            id: "inv_1",
            email: "bob@acme.example",
            role: "viewer",
            delivered: true,
            expires_at: "2026-09-01T10:00:00.000Z",
            created_at: "2026-08-15T10:00:00.000Z",
          },
        },
        { status: 200, body: { invitations: [] } },
      ],
    });
    render(<PeoplePage />);

    fireEvent.click(await screen.findByRole("radio", { name: "Invitations" }));
    fireEvent.change(await screen.findByLabelText("Email"), {
      target: { value: "bob@acme.example" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send invitation" }));

    expect(
      await screen.findByText(/on its way to bob@acme.example/),
    ).toBeTruthy();
    expect(screen.queryByText(/Here is the link/)).toBeNull();
  });

  /**
   * The list route answers with every invitation nobody has accepted, and the
   * ones whose day has passed are in it. Drawn the same as the rest, they read
   * as waiting when nothing is coming — so somebody waits for a person who can
   * no longer accept, and the invitation that would let them in is never sent.
   */
  it("tells an invitation nobody can accept any more from one still waiting", async () => {
    open("admin", true, [ADA], [WAITING_INVITATION, DEAD_INVITATION]);

    fireEvent.click(await screen.findByRole("radio", { name: "Invitations" }));

    // The invitations are their own read, answered after the roster that drew
    // this tab. Finding the table is what says that second answer landed —
    // and the *absence* asserted at the end is only worth anything once it
    // has, because an empty page has no control on it either.
    const table = await screen.findByRole("table", { name: "Invitations" });
    const rows = await within(table).findAllByRole("row");
    const waiting = rows.find((row) =>
      row.textContent?.includes(WAITING_INVITATION.email),
    )!;
    const dead = rows.find((row) =>
      row.textContent?.includes(DEAD_INVITATION.email),
    )!;

    expect(waiting.textContent).toContain("Pending");
    expect(waiting.textContent).not.toContain("Expired");
    expect(dead.textContent).toContain("Expired");

    // And what each one offers matches what it is. A live invitation is waited
    // on and carries no control; a dead one cannot be waited on, so the one
    // move left is on it and only on it.
    expect(within(dead).getByRole("button", { name: "Send again" })).toBeTruthy();
    expect(
      within(waiting).queryByRole("button", { name: "Send again" }),
    ).toBeNull();
  });

  /**
   * Sending again goes the same way a first invitation does, which is what
   * makes it worth offering: on an install with no mail transport the new link
   * comes back to the person who asked for it, exactly as the form's does.
   */
  it("sends another invitation for a dead one, and hands the new link back", async () => {
    apiAnswers({
      "/api/me": { status: 200, body: meWith("admin") },
      "/api/members": {
        status: 200,
        body: { members: [ADA], may_manage_members: true },
      },
      // Named in the order the page asks: the list it opens with, the new
      // invitation, and the list again once one has been sent.
      "/api/invitations": [
        { status: 200, body: { invitations: [DEAD_INVITATION] } },
        {
          status: 201,
          body: {
            ...DEAD_INVITATION,
            id: "inv_9",
            delivered: false,
            accept_url: "http://egma.test/invite?token=xyz",
          },
        },
        { status: 200, body: { invitations: [DEAD_INVITATION] } },
      ],
    });
    render(<PeoplePage />);

    fireEvent.click(await screen.findByRole("radio", { name: "Invitations" }));

    const table = await screen.findByRole("table", { name: "Invitations" });
    fireEvent.click(within(table).getByRole("button", { name: "Send again" }));

    expect(await screen.findByText(/Here is the link/)).toBeTruthy();
    expect(document.body.textContent).toContain(
      "http://egma.test/invite?token=xyz",
    );
    // The same person, at the same role, and nothing retyped to get there.
    expect(sent.find((one) => one.method === "POST")?.body).toEqual({
      email: DEAD_INVITATION.email,
      role: DEAD_INVITATION.role,
    });
  });

  it("shows the refusal in its own words when the last admin is protected", async () => {
    apiAnswers({
      "/api/me": { status: 200, body: meWith("admin") },
      "/api/members": {
        status: 200,
        body: { members: [ADA], may_manage_members: true },
      },
      "/api/invitations": { status: 200, body: { invitations: [] } },
      "/api/members/usr_1/role": {
        status: 409,
        body: {
          error: "last_admin",
          message:
            "this is the organization's last admin, and an organization with no admin is one nobody can invite, re-role or remove anybody in ever again. Make somebody else an admin first.",
        },
      },
    });
    render(<PeoplePage />);

    fireEvent.change(
      (await screen.findAllByLabelText("ada@acme.example role"))[0]!,
      { target: { value: "viewer" } },
    );

    expect(
      await screen.findByText(/Make somebody else an admin first/),
    ).toBeTruthy();
  });
});

/* ------------------------------------------------------------------------ */

const MY_KEY = {
  id: "key_1",
  name: "My laptop",
  scope: "organization",
  organization_id: "org_1",
  project_id: null,
  looks_like: "egma_sk_ab…WXYZ",
  created_by_user_id: "usr_1",
  created_at: "2026-08-01T10:00:00.000Z",
  last_used_at: null,
  revoked_at: null,
};

const SOMEBODY_ELSES = {
  ...MY_KEY,
  id: "key_2",
  name: "Bob's CI",
  scope: "project",
  project_id: "prj_2",
  created_by_user_id: "usr_2",
};

describe("API keys", () => {
  function open(role = "admin", keys: unknown[] = [MY_KEY]) {
    apiAnswers({
      "/api/me": { status: 200, body: meWith(role) },
      "/api/keys": { status: 200, body: { keys } },
    });
    render(<ApiKeysPage />);
  }

  /**
   * **The one page where a viewer's controls stay live.** Every other mutation
   * in the product is shown to a viewer disabled; here creating and revoking
   * their own key is something every role does, because `egma login` mints one
   * as its last step and a credential you cannot rotate is one you cannot keep
   * safe.
   */
  it("keeps a viewer's own-key controls live rather than disabling them", async () => {
    open("viewer");

    const create = await screen.findByRole("button", { name: "Create key" });
    expect(create.hasAttribute("disabled")).toBe(false);
    expect((screen.getByLabelText("Name") as HTMLInputElement).disabled).toBe(false);
    // Twice in the DOM, because one column definition draws the wide table and
    // the narrow list. Both are the same control and both are live.
    expect(
      screen
        .getAllByRole("button", { name: "Revoke" })
        .every((one) => !one.hasAttribute("disabled")),
    ).toBe(true);
  });

  it("shows a new key's secret once, and nothing that could show it again", async () => {
    apiAnswers({
      "/api/me": { status: 200, body: meWith("viewer") },
      "/api/keys": [
        { status: 200, body: { keys: [] } },
        { status: 201, body: { ...MY_KEY, secret: "egma_sk_the_only_time" } },
        { status: 200, body: { keys: [MY_KEY] } },
      ],
    });
    render(<ApiKeysPage />);

    fireEvent.change(await screen.findByLabelText("Name"), {
      target: { value: "My laptop" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create key" }));

    expect(await screen.findByText("egma_sk_the_only_time")).toBeTruthy();
    expect(screen.getByText(/only its hash was kept/)).toBeTruthy();

    // What survives on the row is what a person can tell two keys apart by,
    // and it is not the key.
    await waitFor(() => {
      expect(
        screen.getByRole("table", { name: "Your API keys" }).textContent,
      ).toContain("egma_sk_ab…WXYZ");
    });
    expect(
      screen.getByRole("table", { name: "Your API keys" }).textContent,
    ).not.toContain("egma_sk_the_only_time");
  });

  it("scopes a key to one project when one is chosen", async () => {
    apiAnswers({
      "/api/me": { status: 200, body: meWith("member") },
      "/api/keys": [
        { status: 200, body: { keys: [] } },
        { status: 201, body: { ...MY_KEY, secret: "s" } },
        { status: 200, body: { keys: [MY_KEY] } },
      ],
    });
    render(<ApiKeysPage />);

    fireEvent.change(await screen.findByLabelText("Scope"), {
      target: { value: "prj_2" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create key" }));

    await waitFor(() => {
      expect(sent.some((one) => one.method === "POST")).toBe(true);
    });
    expect(sent.find((one) => one.method === "POST")?.body).toEqual({
      name: "",
      project_id: "prj_2",
    });
  });

  /**
   * Only an admin is answered with anybody else's key, and the rows say who
   * holds each one and what it reaches — which is what responding to a leak
   * needs, and is the whole of what a row may say about somebody else's key.
   */
  it("shows an admin every key, with its owner and its scope and no secret", async () => {
    open("admin", [MY_KEY, SOMEBODY_ELSES]);

    const others = await screen.findByRole("table", {
      name: "Other people's API keys",
    });
    expect(others.textContent).toContain("Bob's CI");
    expect(others.textContent).toContain("usr_2");
    expect(others.textContent).toContain("Project · Outbound");
    expect(others.textContent).toContain("egma_sk_ab…WXYZ");
  });

  /**
   * The other half: the read never carries somebody else's key to a viewer, so
   * the page has no section for one. An empty heading would suggest a list
   * being withheld rather than a list that is not theirs.
   */
  it("shows no other-people section to somebody the server answers with none", async () => {
    open("viewer", [MY_KEY]);

    await screen.findByRole("table", { name: "Your API keys" });
    expect(
      screen.queryByRole("table", { name: "Other people's API keys" }),
    ).toBeNull();
  });

  it("says which project or organization each of your own keys reaches", async () => {
    open("member", [MY_KEY, { ...MY_KEY, id: "key_3", project_id: "prj_2", scope: "project" }]);

    const mine = await screen.findByRole("table", { name: "Your API keys" });
    expect(mine.textContent).toContain("Whole organization");
    expect(mine.textContent).toContain("Project · Outbound");
  });
});
