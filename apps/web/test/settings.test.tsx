// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import RootPage from "../app/page.tsx";
import NewProjectPage from "../app/new-project/page.tsx";
import ApiKeysPage from "../app/projects/[projectId]/settings/keys/page.tsx";
import OrganizationSettingsPage from "../app/projects/[projectId]/settings/organization/page.tsx";
import PeoplePage from "../app/projects/[projectId]/settings/people/page.tsx";
import ProjectSettingsPage from "../app/projects/[projectId]/settings/project/page.tsx";
import type { Me } from "../lib/me.ts";
import { REPLAY_PRIVATE_ATTRIBUTE } from "../lib/replay-privacy.ts";
import { observeRequest, type FetchInput } from "./platform-request.ts";
import { renderSettingsPage } from "./render-settings-page.tsx";

/**
 * Drive settings pages with stubbed API responses. Check project revision
 * saves, retained drafts, viewer key controls, one-time secret display, and
 * organization-wide scope labels.
 */

const routed = vi.hoisted(() => {
  const push = vi.fn();
  return {
    push,
    /*
     * One router object for the whole run, because that is what Next hands
     * back. A fresh one on every call is not a harmless test convenience: an
     * effect that names the router among its dependencies re-runs on every
     * render, and the entrance's does — so the mock by itself turned reading
     * the session into a loop that never settled.
     */
    router: { push, replace: vi.fn(), back: vi.fn() },
    pathname: "/projects/prj_1/settings/organization",
    projectId: "prj_1",
  };
});

vi.mock("next/navigation", () => ({
  usePathname: () => routed.pathname,
  useRouter: () => routed.router,
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

function renderAt(pathname: string, page: ReactElement) {
  routed.pathname = pathname;
  window.location.href = `http://egma.test${pathname}`;
  window.location.pathname = pathname;
  return renderSettingsPage(page);
}

function renderProjectSettings() {
  return renderAt(
    "/projects/prj_1/settings/project",
    <ProjectSettingsPage />,
  );
}

function renderOrganizationSettings() {
  return renderAt(
    "/projects/prj_1/settings/organization",
    <OrganizationSettingsPage />,
  );
}

function renderPeopleSettings() {
  return renderAt("/projects/prj_1/settings/people", <PeoplePage />);
}

function renderApiKeysSettings() {
  return renderAt("/projects/prj_1/settings/keys", <ApiKeysPage />);
}

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
  organizationId: "org_1",
  revision: "rev_1",
  createdAt: "2026-08-01T10:00:00.000Z",
  mayManageProjects: true,
};

const ORGANIZATION = {
  id: "org_1",
  name: "Acme",
  slug: "acme",
  createdAt: "2026-08-01T10:00:00.000Z",
  mayManageOrganization: true,
};

/** What the organization page reads beside the organization itself. */
const PERIOD_USAGE = {
  periodStartedAt: "2026-09-01T10:00:00.000Z",
  resetsAt: "2026-10-01T10:00:00.000Z",
  allowances: [
    { kind: "chat_simulations", unit: "simulations", used: 12 },
    { kind: "web_call_minutes", unit: "minutes", used: 4.5 },
    { kind: "phone_minutes", unit: "minutes", used: 0 },
  ],
};

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

type StubbedResponse = { status: number; body: unknown };
type Stubbed = StubbedResponse | Promise<StubbedResponse> | "never";

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
    vi.fn(async (input: FetchInput, init?: RequestInit) => {
      const request = await observeRequest(input, init);
      const { address: url } = request;
      sent.push({
        url: request.url,
        method: request.method,
        body: request.body,
      });

      const held = answers[url.pathname];
      if (held === undefined) throw new Error(`nothing stubbed for ${url.pathname}`);

      const turn = asked[url.pathname] ?? 0;
      asked[url.pathname] = turn + 1;
      const answer = Array.isArray(held)
        ? ((held[Math.min(turn, held.length - 1)] ?? "never") as Stubbed)
        : (held as Stubbed);

      if (answer === "never") return new Promise<Response>(() => undefined);
      const ready = await answer;
      return json(ready.status, ready.body);
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
      href: "http://egma.test/projects/prj_1/settings/organization",
      search: "",
      pathname: "/projects/prj_1/settings/organization",
      replace: (url: string) => wentTo.push(url),
      assign: (url: string) => wentTo.push(url),
    },
  });
  Object.defineProperty(window, "history", {
    configurable: true,
    value: { ...window.history, pushState: vi.fn() },
  });
  routed.push.mockReset();
  routed.pathname = "/projects/prj_1/settings/organization";
  routed.projectId = "prj_1";
  vi.stubGlobal("scrollTo", vi.fn());
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/* ------------------------------------------------------------------------ */

describe("project settings", () => {
  function open(role = "admin", project: unknown = PROJECT) {
    apiAnswers({
      "/api/me": { status: 200, body: meWith(role) },
      "/v1/projects/prj_1": { status: 200, body: project },
    });
    renderProjectSettings();
  }

  it("shows what is stored, and saves against the revision it was opened at", async () => {
    apiAnswers({
      "/api/me": { status: 200, body: meWith("admin") },
      "/v1/projects/prj_1": [
        { status: 200, body: PROJECT },
        { status: 200, body: { ...PROJECT, name: "Renamed", revision: "rev_2" } },
      ],
    });
    renderProjectSettings();

    const name = (await screen.findByLabelText("Name")) as HTMLInputElement;
    // Waited for rather than read once: the field exists on the first ready
    // render and the stored values arrive on the next.
    await waitFor(() => {
      expect(name.value).toBe("Default");
    });
    expect((screen.getByLabelText("Description") as HTMLTextAreaElement).value).toBe(
      "The first one.",
    );
    expect(screen.queryByText(PROJECT.id)).toBeNull();
    expect(screen.queryByText("Identifier")).toBeNull();

    fireEvent.change(name, { target: { value: "Renamed" } });
    fireEvent.click(screen.getByRole("button", { name: "Save project" }));

    await waitFor(() => {
      expect(sent.some((one) => one.method === "PATCH")).toBe(true);
    });
    expect(sent.find((one) => one.method === "PATCH")?.body).toEqual({
      name: "Renamed",
      slug: "default",
      description: "The first one.",
      expectedRevision: "rev_1",
    });
  });

  it("keeps an edit made while Save reloads the stored project", async () => {
    let finishSave!: (answer: StubbedResponse) => void;
    let finishReload!: (answer: StubbedResponse) => void;
    let finishRetry!: (answer: StubbedResponse) => void;
    const saveAnswer = new Promise<StubbedResponse>((resolve) => {
      finishSave = resolve;
    });
    const reloadAnswer = new Promise<StubbedResponse>((resolve) => {
      finishReload = resolve;
    });
    const retryAnswer = new Promise<StubbedResponse>((resolve) => {
      finishRetry = resolve;
    });
    const renamed = { ...PROJECT, name: "Renamed", revision: "rev_2" };
    const confirm = vi.fn(() => true);
    vi.stubGlobal("confirm", confirm);

    apiAnswers({
      "/api/me": { status: 200, body: meWith("admin") },
      "/v1/projects/prj_1": [
        { status: 200, body: PROJECT },
        saveAnswer,
        reloadAnswer,
        retryAnswer,
      ],
    });
    renderProjectSettings();

    const name = (await screen.findByDisplayValue("Default")) as HTMLInputElement;
    fireEvent.change(name, { target: { value: "Renamed" } });
    fireEvent.click(screen.getByRole("button", { name: "Save project" }));

    expect(await screen.findByRole("button", { name: "Saving…" })).toBeTruthy();
    const settings = screen.getByRole("navigation", { name: "Settings" });
    const judge = within(settings).getByRole("link", { name: "Organization Settings" });
    const click = new MouseEvent("click", {
      bubbles: true,
      cancelable: true,
      button: 0,
    });
    judge.dispatchEvent(click);
    expect(click.defaultPrevented).toBe(true);
    expect(confirm).not.toHaveBeenCalled();

    // Saving does not lock the fields. This edit is a new draft, made after
    // the submitted value was captured and before the confirming read lands.
    fireEvent.change(name, { target: { value: "Rename after saving" } });
    await act(async () => {
      finishSave({ status: 200, body: renamed });
    });
    await waitFor(() => {
      expect(
        sent.filter((request) => request.url === "/v1/projects/prj_1"),
      ).toHaveLength(3);
    });

    const clickWhileConfirming = new MouseEvent("click", {
      bubbles: true,
      cancelable: true,
      button: 0,
    });
    fireEvent(
      within(screen.getByRole("navigation", { name: "Settings" }))
        .getByRole("link", { name: "Organization Settings" }),
      clickWhileConfirming,
    );
    expect(clickWhileConfirming.defaultPrevented).toBe(true);
    expect(screen.getByRole("dialog", { name: "Leave without saving?" }))
      .toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));
    expect(confirm).not.toHaveBeenCalled();

    await act(async () => {
      finishReload({
        status: 503,
        body: { error: "unavailable", message: "Project storage is offline." },
      });
    });
    expect(await screen.findByText("Project storage is offline.")).toBeTruthy();

    const clickAfterFailure = new MouseEvent("click", {
      bubbles: true,
      cancelable: true,
      button: 0,
    });
    fireEvent(
      within(screen.getByRole("navigation", { name: "Settings" }))
        .getByRole("link", { name: "Organization Settings" }),
      clickAfterFailure,
    );
    expect(clickAfterFailure.defaultPrevented).toBe(true);
    expect(screen.getByRole("dialog", { name: "Leave without saving?" }))
      .toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));

    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => {
      expect(
        sent.filter((request) => request.url === "/v1/projects/prj_1"),
      ).toHaveLength(4);
    });
    await act(async () => {
      finishRetry({ status: 200, body: renamed });
    });
    expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe(
      "Rename after saving",
    );
    expect(
      screen
        .getByRole("button", { name: "Save project" })
        .hasAttribute("disabled"),
    ).toBe(false);
    expect(screen.queryByText(/Saved\. Everybody/)).toBeNull();

    const leaving = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(leaving);
    expect(leaving.defaultPrevented).toBe(true);
  });

  it("asks before a Settings link or project switch discards a draft", async () => {
    apiAnswers({
      "/api/me": { status: 200, body: meWith("admin") },
      "/v1/projects/prj_1": { status: 200, body: PROJECT },
    });
    const confirm = vi.fn(() => false);
    vi.stubGlobal("confirm", confirm);
    renderProjectSettings();

    fireEvent.change(await screen.findByDisplayValue("Default"), {
      target: { value: "A draft name" },
    });

    const settings = screen.getByRole("navigation", { name: "Settings" });
    const judge = within(settings).getByRole("link", { name: "Organization Settings" });
    const click = new MouseEvent("click", {
      bubbles: true,
      cancelable: true,
      button: 0,
    });
    fireEvent(judge, click);
    expect(click.defaultPrevented).toBe(true);
    expect(screen.getByRole("dialog", { name: "Leave without saving?" }))
      .toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));

    const selectors = await screen.findAllByRole("button", {
      name: /^Organization Acme, project Default\./,
    });
    fireEvent.click(selectors[0]!);
    const outbound = screen.getByRole("menuitem", { name: "Outbound" });
    fireEvent.click(outbound);
    expect(routed.push).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: "Leave without saving?" }))
      .toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));
    expect(document.activeElement).toBe(selectors[0]);

    fireEvent.click(selectors[0]!);
    fireEvent.click(screen.getByRole("menuitem", { name: "Outbound" }));
    fireEvent.click(screen.getByRole("button", { name: "Discard changes" }));
    expect(routed.push).toHaveBeenCalledWith("/projects/prj_2/settings/project");
    expect(confirm).not.toHaveBeenCalled();
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
      "/v1/projects/prj_1": [
        { status: 200, body: PROJECT },
        {
          status: 409,
          body: {
            error: "identity_conflict",
            message:
              "Project prj_1 changed after you opened it. Read it again, keep or reapply your edits, and send the update with expectedRevision set to its new revision.",
          },
        },
        { status: 200, body: { ...PROJECT, revision: "rev_2" } },
      ],
    });
    renderProjectSettings();

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
   * Use a permitted non-admin to distinguish the API's mayManageProjects
   * answer from a local role guess.
   */
  it("lets a non-admin edit when the server says the permission is theirs", async () => {
    open("member", { ...PROJECT, mayManageProjects: true });

    const name = (await screen.findByLabelText("Name")) as HTMLInputElement;
    await waitFor(() => {
      expect(name.value).toBe("Default");
    });

    expect(name.disabled).toBe(false);
    expect(screen.queryByLabelText("Slug")).toBeNull();
      expect(
        screen
          .getByRole("button", { name: "Save project" })
          .hasAttribute("disabled"),
      ).toBe(true);
      fireEvent.change(name, { target: { value: "Default renamed" } });
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
});

/* ------------------------------------------------------------------------ */

describe("making a project", () => {
  it("keeps the draft and shows the refusal when the slug is taken", async () => {
    apiAnswers({
      "/api/me": { status: 200, body: meWith("admin") },
      "/v1/projects": {
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
});

/* ------------------------------------------------------------------------ */

describe("organization settings", () => {
  it("renames the organization and leaves its short name alone", async () => {
    apiAnswers({
      "/api/me": { status: 200, body: meWith("admin") },
      "/v1/organization": [
        { status: 200, body: ORGANIZATION },
        { status: 200, body: { ...ORGANIZATION, name: "Acme Voice" } },
        { status: 200, body: { ...ORGANIZATION, name: "Acme Voice" } },
      ],
      "/api/organization/usage": { status: 200, body: PERIOD_USAGE },
    });
    renderOrganizationSettings();

    // Waited for the stored name, not just the field. The field exists on the
    // first ready render and what was read lands on the next, so typing on
    // sight let the answer overwrite the draft — the PATCH then carried "Acme"
    // and the test failed on a name nobody had typed. About one run in eight.
    await screen.findByDisplayValue(ORGANIZATION.name);
    const save = screen.getByRole("button", { name: "Save organization" });
    expect(save.hasAttribute("disabled")).toBe(true);
    fireEvent.change(screen.getByLabelText("Organization name*"), {
      target: { value: "Acme Voice" },
    });
    expect(save.hasAttribute("disabled")).toBe(false);
    fireEvent.click(save);

    await waitFor(() => {
      expect(sent.some((one) => one.method === "PATCH")).toBe(true);
    });
    // The name, and nothing else. The slug is what invitation links were sent
    // under, so this door does not offer it.
    expect(sent.find((one) => one.method === "PATCH")?.body).toEqual({
      name: "Acme Voice",
    });
    expect(await screen.findByText("Saved.")).toBeTruthy();
    expect(screen.queryByText(ORGANIZATION.id)).toBeNull();
    expect(screen.queryByText("Identifier")).toBeNull();
    const savedButton = screen.getByRole("button", {
      name: "Save organization",
    });
    expect(savedButton.hasAttribute("disabled")).toBe(true);
    fireEvent.change(screen.getByLabelText("Organization name*"), {
      target: { value: "Acme Voice Labs" },
    });
    expect(screen.queryByText("Saved.")).toBeNull();
    expect(savedButton.hasAttribute("disabled")).toBe(false);
  });

  it("keeps a newer organization name typed while Save is confirming", async () => {
    let finishSave!: (answer: StubbedResponse) => void;
    let finishReload!: (answer: StubbedResponse) => void;
    let finishRetry!: (answer: StubbedResponse) => void;
    const saveAnswer = new Promise<StubbedResponse>((resolve) => {
      finishSave = resolve;
    });
    const reloadAnswer = new Promise<StubbedResponse>((resolve) => {
      finishReload = resolve;
    });
    const retryAnswer = new Promise<StubbedResponse>((resolve) => {
      finishRetry = resolve;
    });
    const renamed = { ...ORGANIZATION, name: "Acme Voice" };
    const confirm = vi.fn(() => false);
    vi.stubGlobal("confirm", confirm);

    apiAnswers({
      "/api/me": { status: 200, body: meWith("admin") },
      "/v1/organization": [
        { status: 200, body: ORGANIZATION },
        saveAnswer,
        reloadAnswer,
        retryAnswer,
      ],
      "/api/organization/usage": { status: 200, body: PERIOD_USAGE },
    });
    renderOrganizationSettings();

    const name = (await screen.findByDisplayValue("Acme")) as HTMLInputElement;
    fireEvent.change(name, { target: { value: "Acme Voice" } });
    fireEvent.click(screen.getByRole("button", { name: "Save organization" }));
    expect(await screen.findByRole("button", { name: "Saving…" })).toBeTruthy();

    fireEvent.change(name, { target: { value: "Acme Voice Labs" } });
    await act(async () => {
      finishSave({ status: 200, body: renamed });
    });
    await waitFor(() => {
      expect(
        sent.filter((request) => request.url === "/v1/organization"),
      ).toHaveLength(3);
    });

    const clickWhileConfirming = new MouseEvent("click", {
      bubbles: true,
      cancelable: true,
      button: 0,
    });
    fireEvent(
      within(screen.getByRole("navigation", { name: "Settings" }))
        .getByRole("link", { name: "Project Settings" }),
      clickWhileConfirming,
    );
    expect(clickWhileConfirming.defaultPrevented).toBe(true);
    expect(screen.getByRole("dialog", { name: "Leave without saving?" }))
      .toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));
    expect(confirm).not.toHaveBeenCalled();

    await act(async () => {
      finishReload({
        status: 503,
        body: {
          error: "unavailable",
          message: "Organization storage is offline.",
        },
      });
    });
    expect(
      await screen.findByText("Organization storage is offline."),
    ).toBeTruthy();

    const clickAfterFailure = new MouseEvent("click", {
      bubbles: true,
      cancelable: true,
      button: 0,
    });
    fireEvent(
      within(screen.getByRole("navigation", { name: "Settings" }))
        .getByRole("link", { name: "Project Settings" }),
      clickAfterFailure,
    );
    expect(clickAfterFailure.defaultPrevented).toBe(true);
    expect(screen.getByRole("dialog", { name: "Leave without saving?" }))
      .toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));

    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => {
      expect(
        sent.filter((request) => request.url === "/v1/organization"),
      ).toHaveLength(4);
    });
    await act(async () => {
      finishRetry({ status: 200, body: renamed });
    });
    expect((screen.getByLabelText("Organization name*") as HTMLInputElement).value).toBe(
      "Acme Voice Labs",
    );
    expect(
      screen
        .getByRole("button", { name: "Save organization" })
        .hasAttribute("disabled"),
    ).toBe(false);
    expect(screen.queryByText("Saved.")).toBeNull();
  });
});

/* ------------------------------------------------------------------------ */

const ADA = {
  userId: "usr_1",
  email: "ada@acme.example",
  name: "Ada",
  role: "admin",
  joinedAt: "2026-08-01T10:00:00.000Z",
  deactivatedAt: null,
};

const BOB = {
  userId: "usr_2",
  email: "bob@acme.example",
  name: "Bob",
  role: "viewer",
  joinedAt: "2026-08-02T10:00:00.000Z",
  deactivatedAt: null,
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
  expiresAt: new Date(Date.now() + A_WEEK).toISOString(),
  createdAt: new Date(Date.now() - A_WEEK).toISOString(),
};

const DEAD_INVITATION = {
  id: "inv_2",
  email: "dev@acme.example",
  role: "viewer",
  expiresAt: new Date(Date.now() - A_WEEK).toISOString(),
  createdAt: new Date(Date.now() - 2 * A_WEEK).toISOString(),
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
      "/v1/members": {
        status: 200,
        body: { members, mayManageMembers: mayManage },
      },
      "/v1/invitations": { status: 200, body: { invitations } },
      "/v1/members/usr_2/role": { status: 200, body: { ...BOB, role: "member" } },
      "/v1/members/usr_2/remove": {
        status: 200,
        body: { userId: "usr_2", keys_revoked: 1 },
      },
    });
    renderPeopleSettings();
  }

  it("lists everybody, with a role control an admin can change", async () => {
    open();

    const table = await screen.findByRole("table", { name: "Members" });
    expect(table.textContent).toContain("ada@acme.example");
    expect(table.textContent).toContain("bob@acme.example");

    // The words are the product's; the values are the contract's. A control
    // that sent `Member` would be refused by the route it posts to.
    const control = screen.getAllByLabelText(
      "bob@acme.example role",
    )[0]! as HTMLSelectElement;
    expect([...control.options].map((one) => one.text)).toEqual([
      "Admin",
      "Member",
      "Viewer",
    ]);
    expect([...control.options].map((one) => one.value)).toEqual([
      "admin",
      "member",
      "viewer",
    ]);

    fireEvent.change(control, { target: { value: "member" } });

    await waitFor(() => {
      expect(
        sent.some((one) => one.url.includes("/v1/members/usr_2/role")),
      ).toBe(true);
    });
    expect(
      sent.find((one) => one.url.includes("/v1/members/usr_2/role"))?.body,
    ).toEqual({ role: "member" });
  });

  it("hands the invitation link back when there was nowhere to post it", async () => {
    apiAnswers({
      "/api/me": { status: 200, body: meWith("admin") },
      "/v1/members": {
        status: 200,
        body: { members: [ADA], mayManageMembers: true },
      },
      "/v1/invitations": [
        { status: 200, body: { invitations: [] } },
        {
          status: 201,
          body: {
            id: "inv_1",
            email: "bob@acme.example",
            role: "viewer",
            delivered: false,
            acceptUrl: "http://egma.test/invite?token=abc",
            expiresAt: "2026-09-01T10:00:00.000Z",
            createdAt: "2026-08-15T10:00:00.000Z",
          },
        },
        { status: 200, body: { invitations: [] } },
      ],
    });
    renderPeopleSettings();

    fireEvent.click(await screen.findByRole("tab", { name: "Invitations" }));

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

    fireEvent.click(screen.getByRole("tab", { name: "People" }));
    expect(screen.getByRole("dialog", { name: "Leave without saving?" }))
      .toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));
    expect(document.body.textContent).toContain(
      "http://egma.test/invite?token=abc",
    );
  });

  it("defaults a new invitation to Viewer", async () => {
    open("admin", true, [ADA], []);

    fireEvent.click(await screen.findByRole("tab", { name: "Invitations" }));
    expect((await screen.findByLabelText("Role") as HTMLSelectElement).value).toBe(
      "viewer",
    );
  });

  /**
   * The list route answers with every invitation nobody has accepted, and the
   * ones whose day has passed are in it. Drawn the same as the rest, they read
   * as waiting when nothing is coming — so somebody waits for a person who can
   * no longer accept, and the invitation that would let them in is never sent.
   */
  it("tells an invitation nobody can accept any more from one still waiting", async () => {
    open("admin", true, [ADA], [WAITING_INVITATION, DEAD_INVITATION]);

    fireEvent.click(await screen.findByRole("tab", { name: "Invitations" }));

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
    // And the role beside it is a word rather than the contract's key.
    expect(waiting.textContent).toContain("Member");

    // And what each one offers matches what it is. A live invitation is waited
    // on and carries no menu; a dead one cannot be waited on, so the one move
    // left is in its menu and only in its menu.
    expect(
      within(waiting).queryByRole("button", {
        name: `Open the menu for ${WAITING_INVITATION.email}`,
      }),
    ).toBeNull();
    fireEvent.click(
      within(dead).getByRole("button", {
        name: `Open the menu for ${DEAD_INVITATION.email}`,
      }),
    );
    expect(
      await screen.findByRole("menuitem", { name: "Send again" }),
    ).toBeTruthy();
  });

  /**
   * Sending again goes the same way a first invitation does, which is what
   * makes it worth offering: on an install with no mail transport the new link
   * comes back to the person who asked for it, exactly as the form's does.
   */
  it("sends another invitation for a dead one, and hands the new link back", async () => {
    apiAnswers({
      "/api/me": { status: 200, body: meWith("admin") },
      "/v1/members": {
        status: 200,
        body: { members: [ADA], mayManageMembers: true },
      },
      // Named in the order the page asks: the list it opens with, the new
      // invitation, and the list again once one has been sent.
      "/v1/invitations": [
        { status: 200, body: { invitations: [DEAD_INVITATION] } },
        {
          status: 201,
          body: {
            ...DEAD_INVITATION,
            id: "inv_9",
            delivered: false,
            acceptUrl: "http://egma.test/invite?token=xyz",
          },
        },
        { status: 200, body: { invitations: [DEAD_INVITATION] } },
      ],
    });
    renderPeopleSettings();

    fireEvent.click(await screen.findByRole("tab", { name: "Invitations" }));

    const table = await screen.findByRole("table", { name: "Invitations" });
    fireEvent.click(
      within(table).getByRole("button", {
        name: `Open the menu for ${DEAD_INVITATION.email}`,
      }),
    );
    fireEvent.click(await screen.findByRole("menuitem", { name: "Send again" }));

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
      "/v1/members": {
        status: 200,
        body: { members: [ADA], mayManageMembers: true },
      },
      "/v1/invitations": { status: 200, body: { invitations: [] } },
      "/v1/members/usr_1/role": {
        status: 409,
        body: {
          error: "lastAdmin",
          message:
            "this is the organization's last admin, and an organization with no admin is one nobody can invite, re-role or remove anybody in ever again. Make somebody else an admin first.",
        },
      },
    });
    renderPeopleSettings();

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
  organizationId: "org_1",
  projectId: null,
  looksLike: "egma_sk_ab…WXYZ",
  createdByUserId: "usr_1",
  createdByEmail: "ada@acme.example",
  createdAt: "2026-08-01T10:00:00.000Z",
  lastUsedAt: null,
  revokedAt: null,
};

describe("API keys", () => {
  function open(role = "admin", keys: unknown[] = [MY_KEY]) {
    apiAnswers({
      "/api/me": { status: 200, body: meWith(role) },
      "/v1/keys": { status: 200, body: { keys } },
    });
    renderApiKeysSettings();
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

    fireEvent.click(
      screen.getByRole("button", { name: "Open the menu for My laptop" }),
    );
    expect(
      (await screen.findByRole("menuitem", { name: "Revoke" })).hasAttribute(
        "disabled",
      ),
    ).toBe(false);
  });

  it("shows a new key's secret once, and nothing that could show it again", async () => {
    apiAnswers({
      "/api/me": { status: 200, body: meWith("viewer") },
      "/v1/keys": [
        { status: 200, body: { keys: [] } },
        { status: 201, body: { ...MY_KEY, secret: "egma_sk_the_only_time" } },
        { status: 200, body: { keys: [MY_KEY] } },
      ],
    });
    renderApiKeysSettings();

    fireEvent.change(await screen.findByLabelText("Name"), {
      target: { value: "My laptop" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create key" }));

    expect(await screen.findByText("egma_sk_the_only_time")).toBeTruthy();
    expect(screen.getByText(/only its hash was kept/)).toBeTruthy();

    // And session replay does not read it. A replay records the rest of these
    // pages, so this element is the whole of what `lib/replay-privacy.ts` hides.
    expect(
      screen
        .getByText("egma_sk_the_only_time")
        .hasAttribute(REPLAY_PRIVATE_ATTRIBUTE),
    ).toBe(true);

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

  it("keeps the one-time receipt through a failed refresh, then copies and dismisses it", async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    apiAnswers({
      "/api/me": { status: 200, body: meWith("viewer") },
      "/v1/keys": [
        { status: 200, body: { keys: [] } },
        { status: 201, body: { ...MY_KEY, secret: "egma_sk_keep_me" } },
        {
          status: 500,
          body: { error: "unavailable", message: "The key list is offline." },
        },
      ],
    });
    renderApiKeysSettings();

    fireEvent.click(await screen.findByRole("button", { name: "Create key" }));

    expect(await screen.findByText("The key list is offline.")).toBeTruthy();
    expect(screen.getByText("egma_sk_keep_me")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Copy key" }));
    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith("egma_sk_keep_me");
    });
    expect(screen.getByText("Copied.")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByText("egma_sk_keep_me")).toBeNull();
  });

  it("protects a one-time key while creation is still in flight", async () => {
    apiAnswers({
      "/api/me": { status: 200, body: meWith("viewer") },
      "/v1/keys": [
        { status: 200, body: { keys: [] } },
        "never",
      ],
    });
    const confirm = vi.fn(() => false);
    vi.stubGlobal("confirm", confirm);
    renderApiKeysSettings();

    fireEvent.click(await screen.findByRole("button", { name: "Create key" }));
    expect(await screen.findByRole("button", { name: "Creating…" })).toBeTruthy();

    const settings = screen.getByRole("navigation", { name: "Settings" });
    const people = within(settings).getByRole("link", { name: "People" });
    const click = new MouseEvent("click", {
      bubbles: true,
      cancelable: true,
      button: 0,
    });
    people.dispatchEvent(click);

    expect(click.defaultPrevented).toBe(true);
    expect(confirm).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Creating…" })).toBeTruthy();
  });

  it("defaults a new key to the current project", async () => {
    apiAnswers({
      "/api/me": { status: 200, body: meWith("member") },
      "/v1/keys": [
        { status: 200, body: { keys: [] } },
        { status: 201, body: { ...MY_KEY, projectId: "prj_1", secret: "s" } },
        { status: 200, body: { keys: [] } },
      ],
    });
    renderApiKeysSettings();

    expect((await screen.findByLabelText("Scope") as HTMLSelectElement).value).toBe(
      "prj_1",
    );
    fireEvent.click(screen.getByRole("button", { name: "Create key" }));
    await waitFor(() => {
      expect(sent.some((one) => one.method === "POST")).toBe(true);
    });
    expect(sent.find((one) => one.method === "POST")?.body).toEqual({
      name: "",
      projectId: "prj_1",
    });
  });

  it("asks before revoking an API key", async () => {
    apiAnswers({
      "/api/me": { status: 200, body: meWith("admin") },
      "/v1/keys": { status: 200, body: { keys: [MY_KEY] } },
      "/v1/keys/key_1/revoke": { status: 200, body: MY_KEY },
    });
    renderApiKeysSettings();

    const table = await screen.findByRole("table", { name: "Your API keys" });
    fireEvent.click(
      within(table).getByRole("button", {
        name: "Open the menu for My laptop",
      }),
    );
    fireEvent.click(await screen.findByRole("menuitem", { name: "Revoke" }));

    const dialog = await screen.findByRole("dialog", {
      name: "Revoke API key “My laptop”?",
    });
    expect(dialog.textContent).toContain("My laptop");
    expect(
      sent.some((one) => one.url.includes("/revoke") && one.method === "POST"),
    ).toBe(false);

    fireEvent.click(within(dialog).getByRole("button", { name: "Revoke key" }));
    await waitFor(() => {
      expect(
        sent.some((one) => one.url.includes("/revoke") && one.method === "POST"),
      ).toBe(true);
    });
  });

  it("scopes a key to one project when one is chosen", async () => {
    apiAnswers({
      "/api/me": { status: 200, body: meWith("member") },
      "/v1/keys": [
        { status: 200, body: { keys: [] } },
        { status: 201, body: { ...MY_KEY, secret: "s" } },
        { status: 200, body: { keys: [MY_KEY] } },
      ],
    });
    renderApiKeysSettings();

    fireEvent.change(await screen.findByLabelText("Scope"), {
      target: { value: "prj_2" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create key" }));

    await waitFor(() => {
      expect(sent.some((one) => one.method === "POST")).toBe(true);
    });
    expect(sent.find((one) => one.method === "POST")?.body).toEqual({
      name: "",
      projectId: "prj_2",
    });
  });

  it("says which project or organization each of your own keys reaches", async () => {
    open("member", [
      MY_KEY,
      { ...MY_KEY, id: "key_3", projectId: "prj_2", scope: "project" },
      {
        ...MY_KEY,
        id: "key_revoked",
        name: "Old revoked key",
        revokedAt: "2026-08-16T10:00:00.000Z",
      },
    ]);

    const mine = await screen.findByRole("table", { name: "Your API keys" });
    expect(mine.textContent).toContain("Whole organization");
    expect(mine.textContent).toContain("Project · Outbound");
    expect(mine.textContent).not.toContain("Old revoked key");
  });
});
