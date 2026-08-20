import { describe, expect, it } from "vitest";

import { CODES } from "../../api/src/http/refusals.ts";
import { projectOutsideOrganization } from "../../api/src/http/refusals.ts";
import { answerFor, PROJECT_OUTSIDE_ORGANIZATION, unreachable } from "../lib/api.ts";
import {
  firstProjectOf,
  organizationOf,
  projectsMatching,
  roleOf,
  type Me,
} from "../lib/me.ts";
import {
  activeSectionIn,
  EVERY_NAVIGATION_ITEM,
  navigationFor,
  NAVIGATION_GROUPS,
} from "../lib/navigation.ts";
import {
  inProject,
  projectIdIn,
  projectLanding,
  projectPath,
  sectionIn,
} from "../lib/project-context.ts";
import { canAuthor, roleFrom } from "../lib/roles.ts";

/**
 * The decisions the product shell makes for itself: which project a tab is in,
 * where the navigation goes, what a role may be offered, and what an answer
 * from the API means to a page.
 *
 * Each is a function rather than a branch inside a component, because each is a
 * promise the product makes and a render branch is a promise nothing can
 * check.
 */

const ADA: Me = {
  user: { id: "usr_1", email: "ada@acme.example" },
  organizations: [{ id: "org_1", name: "Acme", slug: "acme", role: "member" }],
  projects: [
    { id: "prj_1", name: "Default", slug: "default" },
    { id: "prj_2", name: "Outbound", slug: "outbound" },
  ],
};

describe("which project a tab is looking at", () => {
  it("is read out of the address, and only out of the address", () => {
    expect(projectIdIn("/projects/prj_2/agents")).toBe("prj_2");
    expect(projectIdIn("/projects/prj_2/runs/run_9")).toBe("prj_2");
    expect(projectIdIn("/projects/prj_2")).toBe("prj_2");
  });

  it("is nothing at all on a page that names none", () => {
    expect(projectIdIn("/new-project")).toBeNull();
    expect(projectIdIn("/")).toBeNull();
    expect(projectIdIn("/projects/")).toBeNull();
  });

  it("builds an address a copied link reopens unchanged", () => {
    expect(projectPath("prj_2", "agents")).toBe("/projects/prj_2/agents");
    expect(projectPath("prj_2", "runs", "run_9")).toBe("/projects/prj_2/runs/run_9");
    expect(projectLanding("prj_2")).toBe("/projects/prj_2/agents");
  });

  /**
   * The area survives a change of project and the resource does not. One
   * project's agent is not in another project, so carrying the id across would
   * send somebody straight to a refusal from a control that looks like it just
   * moved them sideways.
   */
  it("keeps the product area when the project changes, and drops the resource", () => {
    expect(inProject("/projects/prj_1/agents", "prj_2")).toBe("/projects/prj_2/agents");
    expect(inProject("/projects/prj_1/runs/run_9", "prj_2")).toBe("/projects/prj_2/runs");
    expect(sectionIn("/projects/prj_1/runs/run_9")).toBe("runs");
  });

  it("sends a page that never named a project to the new project's landing", () => {
    expect(inProject("/new-project", "prj_2")).toBe("/projects/prj_2/agents");
    expect(inProject("/", "prj_2")).toBe("/projects/prj_2/agents");
  });

  /**
   * Two tabs, two projects. Neither address is changed by the other existing,
   * which is the whole of what makes them independent.
   */
  it("lets two addresses disagree about the project without either being wrong", () => {
    const first = projectLanding("prj_1");
    const second = inProject(first, "prj_2");

    expect(projectIdIn(first)).toBe("prj_1");
    expect(projectIdIn(second)).toBe("prj_2");
    expect(inProject(second, "prj_1")).toBe(first);
  });
});

describe("the product navigation", () => {
  /**
   * **The addresses this bar offered before it had groups.**
   *
   * Written out rather than derived, because deriving them from the module
   * under test would make this assertion agree with whatever the module says
   * today.
   *
   * Five are the addresses the flat bar offered, unmoved by the regroup: the
   * groups are presentation, and a person who copied one of those links opens
   * the same page afterwards. Graders is the sixth and it points one step
   * deeper now, the way Monitoring already did — its strip leads with Running,
   * and the bar opens the tab the strip leads with. The library did not move
   * and `/projects/prj_2/graders` still opens it; this list says where the bar
   * points.
   */
  const BAR_HREFS = [
    "/projects/prj_2/agents",
    "/projects/prj_2/graders/running",
    "/projects/prj_2/monitoring/transcripts",
    "/projects/prj_2/personas",
    "/projects/prj_2/runs",
    "/projects/prj_2/tests",
  ];

  const everyLink = (projectId: string) =>
    navigationFor(projectId).flatMap((group) => group.items);

  /**
   * **Two jobs are named and the pair above them is not.** The top group used
   * to say "Global". The developer dropped the word on first sight of the built
   * bar rather than replace it, and `null` is how the group says it has decided
   * to stay quiet — an absent key would only mean nobody had got to it yet.
   */
  it("names the two jobs, and leaves the standing pair above them unnamed", () => {
    expect(NAVIGATION_GROUPS.map((group) => group.label)).toEqual([
      null,
      "Simulations",
      "Monitoring",
    ]);
  });

  /**
   * Agents stays the first row and stays the signed-in landing area. Graders
   * sits beside it: a grader is switched on once and then judges everything in
   * its scope, which is what makes it standing rather than part of either job.
   */
  it("puts Agents and Graders in the unlabelled top group, Agents first", () => {
    const global = NAVIGATION_GROUPS[0];
    expect(global?.id).toBe("global");
    expect(global?.label).toBeNull();
    expect(global?.items.map((item) => item.label)).toEqual([
      "Agents",
      "Graders",
    ]);
    expect(everyLink("prj_2")[0]?.href).toBe(projectLanding("prj_2"));
  });

  /**
   * Personas rises out of the old library shelf and into Simulations — the one
   * rank change a person feels. A persona is authored on its own and reused
   * across tests, so it belongs beside the tests that use it.
   */
  it("puts Tests, Personas and Runs under Simulations", () => {
    const simulations = NAVIGATION_GROUPS[1];
    expect(simulations?.id).toBe("simulations");
    expect(simulations?.items.map((item) => item.label)).toEqual([
      "Tests",
      "Personas",
      "Runs",
    ]);
  });

  /**
   * **"Simulation runs" is now "Runs", and only the words changed.** The group
   * supplies the other word, so the pairing a person reads — Simulations →
   * Runs — keeps saying which kind of traffic that surface holds. The address
   * does not move and the stored word stays `run`.
   */
  it("renames the runs surface without moving one address", () => {
    const runs = everyLink("prj_2").find((link) => link.id === "runs");
    expect(runs?.label).toBe("Runs");
    expect(runs?.href).toBe("/projects/prj_2/runs");
    expect(activeSectionIn("/projects/prj_2/runs/run_9")).toBe("runs");
  });

  /**
   * **The word "Monitoring" moved up to the group label, so the item says what
   * its page is.** The item is the same item: same id, same `opens`, same
   * address — the transcript list, reached without a redirect and without a
   * reserved neighbour under the area being able to become the landing.
   */
  it("puts one Transcripts item under Monitoring, opening the transcript list", () => {
    const monitoring = NAVIGATION_GROUPS[2];
    expect(monitoring?.id).toBe("monitoring");
    expect(monitoring?.items.map((item) => item.label)).toEqual(["Transcripts"]);

    const transcripts = everyLink("prj_2").find(
      (link) => link.id === "monitoring",
    );
    expect(transcripts?.label).toBe("Transcripts");
    expect(transcripts?.href).toBe("/projects/prj_2/monitoring/transcripts");
  });

  /**
   * **The groups moved no page.** This is the assertion the whole regroup rests
   * on: six links before, the same six addresses after, whatever group each one
   * is drawn under now.
   */
  it("offers the addresses the bar points at, five of them unmoved by the groups", () => {
    const hrefs = everyLink("prj_2").map((link) => link.href);
    expect([...hrefs].sort()).toEqual(BAR_HREFS);
    expect(hrefs).toHaveLength(BAR_HREFS.length);
  });

  /** And the item stays lit on every page inside the area, list and one alike. */
  it("keeps every monitoring page under one navigation item", () => {
    expect(activeSectionIn("/projects/prj_1/monitoring")).toBe("monitoring");
    expect(activeSectionIn("/projects/prj_1/monitoring/transcripts")).toBe(
      "monitoring",
    );
    expect(
      activeSectionIn("/projects/prj_1/monitoring/transcripts/5c1e4b0f"),
    ).toBe("monitoring");
  });

  /**
   * `dashboard` is reserved and undecided: nothing ships there, and no link the
   * navigation offers claims it.
   */
  it("claims nothing at the reserved dashboard address", () => {
    for (const link of everyLink("prj_2")) {
      expect(link.href, link.id).not.toContain("dashboard");
    }
  });

  /**
   * **No row for something that does not ship.** Measures joins the Monitoring
   * group when the measures bridge lands and not one day before — a "soon" row
   * is a state that is not truthful, and a row with nowhere to go is worse.
   */
  it("offers no row that leads nowhere", () => {
    for (const link of everyLink("prj_2")) {
      expect(link.label.trim(), link.id).not.toBe("");
      expect(link.label, link.id).not.toMatch(/soon|coming/i);
      expect(link.href.startsWith("/projects/prj_2/"), link.id).toBe(true);
    }
  });

  /**
   * Both transcript pages are inside a project now, so switching project from
   * Monitoring lands on the other project's Monitoring rather than throwing
   * somebody out to Agents — which is what the old top-level addresses did.
   */
  it("carries the monitoring area across a change of project", () => {
    expect(
      inProject("/projects/prj_1/monitoring/transcripts", "prj_2"),
    ).toBe("/projects/prj_2/monitoring");
    expect(
      inProject("/projects/prj_1/monitoring/transcripts/5c1e4b0f", "prj_2"),
    ).toBe("/projects/prj_2/monitoring");
  });

  /**
   * Settings is administrative work rather than a project destination, so it is
   * in no group and its addresses light nothing.
   */
  it("keeps Settings in the account menu instead of the project navigation", () => {
    expect(EVERY_NAVIGATION_ITEM.map((item) => item.id)).not.toContain(
      "settings",
    );
    expect(activeSectionIn("/projects/prj_2/settings/people")).toBeNull();
  });

  /**
   * The section a grader screen is under, read out of the address like every
   * other. The running-copies screen is a second page inside the same section
   * rather than a section of its own, so the item stays lit while somebody is
   * on it — which is the whole reason the two are tabs.
   */
  it("keeps both grader screens under one navigation item", () => {
    expect(activeSectionIn("/projects/prj_1/graders")).toBe("graders");
    expect(activeSectionIn("/projects/prj_1/graders/running")).toBe("graders");
  });

  it("has no item for a simulation, which is evidence reached from its run", () => {
    const every = EVERY_NAVIGATION_ITEM.map((item) => item.id);
    expect(every).not.toContain("simulations");
    expect(activeSectionIn("/projects/prj_1/runs/run_9/simulations/sim_1")).toBe(
      "runs",
    );
  });

  it("carries the project in every link it offers", () => {
    for (const link of everyLink("prj_2")) {
      expect(link.href.startsWith("/projects/prj_2/"), link.id).toBe(true);
    }
    expect(everyLink("prj_2").map((link) => link.href)).toContain(
      "/projects/prj_2/agents",
    );
  });

  /**
   * **A group is presentation and never an address.** The item an address is
   * under is found by its own id, so the same path lights the same item it lit
   * when the bar was flat — and no group name is ever read out of a URL.
   */
  it("knows which item an address is under, and says nothing outside the product", () => {
    expect(activeSectionIn("/projects/prj_1/agents")).toBe("agents");
    expect(activeSectionIn("/projects/prj_1/personas/prs_3")).toBe("personas");
    expect(activeSectionIn("/projects/prj_1/global")).toBeNull();
    expect(activeSectionIn("/projects/prj_1/simulations")).toBeNull();
    // The two addresses the transcript pages used to answer at. They are inside
    // the project now, and nothing here is under them.
    expect(activeSectionIn("/traces")).toBeNull();
    expect(activeSectionIn("/traces/5c1e4b0f")).toBeNull();
    expect(activeSectionIn("/members")).toBeNull();
  });
});

describe("what a role is offered", () => {
  it("lets members and admins author, and never a viewer", () => {
    expect(canAuthor("admin")).toBe(true);
    expect(canAuthor("member")).toBe(true);
    expect(canAuthor("viewer")).toBe(false);
  });

  /**
   * A role nobody recognizes reads as the least of them. The server is the
   * boundary either way, so the worst a wrong guess can do here is offer too
   * little — and offering too much is the failure that would matter.
   */
  it("reads an unknown role as the least one", () => {
    expect(roleFrom("owner")).toBe("viewer");
    expect(roleFrom(undefined)).toBe("viewer");
    expect(roleOf({ ...ADA, organizations: [] })).toBe("viewer");
    expect(roleOf(ADA)).toBe("member");
  });
});

describe("the organization and project control", () => {
  it("has an organization to name, and the projects to choose between", () => {
    expect(organizationOf(ADA)?.name).toBe("Acme");
    expect(firstProjectOf(ADA)?.id).toBe("prj_1");
  });

  /**
   * One project is still a place somebody is working, so the control still has
   * something to say — and the list it opens is that one project rather than
   * nothing.
   */
  it("still has one project to show when there is only one", () => {
    const alone = { ...ADA, projects: ADA.projects.slice(0, 1) };
    expect(projectsMatching(alone.projects, "")).toHaveLength(1);
  });

  it("finds a project by its name or by the word in its address", () => {
    expect(projectsMatching(ADA.projects, "out").map((one) => one.id)).toEqual([
      "prj_2",
    ]);
    expect(projectsMatching(ADA.projects, "DEFAULT").map((one) => one.id)).toEqual([
      "prj_1",
    ]);
    expect(projectsMatching(ADA.projects, "  ")).toEqual(ADA.projects);
    expect(projectsMatching(ADA.projects, "zzz")).toEqual([]);
  });

  it("never reorders the list under the keyboard", () => {
    expect(projectsMatching(ADA.projects, "").map((one) => one.id)).toEqual([
      "prj_1",
      "prj_2",
    ]);
  });
});

describe("what an answer from the API means to a page", () => {
  it("is the thing itself when egma sent one", () => {
    expect(answerFor<{ items: [] }>(200, { items: [] })).toEqual({
      status: "ready",
      value: { items: [] },
    });
  });

  it("sends a lapsed session back to sign in rather than showing a refusal", () => {
    expect(answerFor(401, { error: "not_authenticated", message: "no" })).toEqual({
      status: "signed-out",
    });
  });

  /**
   * A project of somebody else's and a project that never existed arrive as
   * one answer, so a page cannot accidentally confirm which. The page shows an
   * absence, and the API's own sentence names the way out.
   */
  it("reads a project this organization does not hold as an absence", () => {
    const refusal = {
      error: PROJECT_OUTSIDE_ORGANIZATION,
      message: projectOutsideOrganization("prj_9"),
    };
    expect(answerFor(404, refusal)).toEqual({ status: "missing", refusal });
  });

  it("keeps a refusal's own sentence rather than writing a second one", () => {
    const refusal = { error: "not_permitted", message: "your viewer role cannot." };
    expect(answerFor(403, refusal)).toEqual({ status: "failed", refusal });
  });

  /**
   * An answer that did not come from egma at all — a proxy, a container running
   * a different build, a route that is not mounted — still gets a sentence. A
   * page that showed nothing would present a broken deployment as a product
   * working correctly.
   */
  it("still says something when the answer did not come from egma", () => {
    const answer = answerFor(502, "<html>gateway</html>");
    expect(answer.status).toBe("failed");
    expect(answer.status === "failed" && answer.refusal.message).toContain("502");
  });

  it("says so when the request never arrived anywhere", () => {
    expect(unreachable().status).toBe("failed");
  });

  /**
   * The code the page branches on is the API's own, read from the API's own
   * vocabulary rather than typed twice. A rename on one side and not the other
   * would turn a foreign project into a generic failure with no way back.
   */
  it("branches on a code this API actually answers with", () => {
    expect(Object.keys(CODES)).toContain(PROJECT_OUTSIDE_ORGANIZATION);
    expect(CODES[PROJECT_OUTSIDE_ORGANIZATION]).toBe(404);
  });
});
