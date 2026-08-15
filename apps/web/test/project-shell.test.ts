import { describe, expect, it } from "vitest";

import { CODES } from "../../api/src/http/refusals.ts";
import { projectOutsideOrganization } from "../../api/src/http/refusals.ts";
import { answerFor, PROJECT_OUTSIDE_ORGANIZATION, unreachable } from "../lib/api.ts";
import {
  firstProjectOf,
  organizationOf,
  projectOf,
  projectsMatching,
  roleOf,
  type Me,
} from "../lib/me.ts";
import {
  activeSectionIn,
  navigationFor,
  PRIMARY_NAVIGATION,
  SECONDARY_NAVIGATION,
} from "../lib/navigation.ts";
import {
  inProject,
  projectIdIn,
  projectLanding,
  projectPath,
  sectionIn,
} from "../lib/project-context.ts";
import { canAdminister, canAuthor, roleFrom } from "../lib/roles.ts";

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
    expect(projectIdIn("/traces")).toBeNull();
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
    expect(inProject("/traces", "prj_2")).toBe("/projects/prj_2/agents");
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
  it("offers Agents, Tests, Graders and Runs, in that order and no others", () => {
    expect(PRIMARY_NAVIGATION.map((item) => item.label)).toEqual([
      "Agents",
      "Tests",
      "Graders",
      "Runs",
    ]);
  });

  /**
   * A persona is reusable and must never be reachable only from inside a test
   * form — but it is not one of the four things a team works on all day, so it
   * has a direct path of its own rather than a primary slot.
   */
  it("gives Personas a direct path outside the primary four", () => {
    expect(SECONDARY_NAVIGATION.map((item) => item.id)).toEqual(["personas"]);
    expect(navigationFor("prj_2").secondary[0]?.href).toBe(
      "/projects/prj_2/personas",
    );
  });

  it("has no item for a simulation, which is evidence reached from its run", () => {
    const every = [...PRIMARY_NAVIGATION, ...SECONDARY_NAVIGATION].map(
      (item) => item.id,
    );
    expect(every).not.toContain("simulations");
    expect(activeSectionIn("/projects/prj_1/runs/run_9/simulations/sim_1")).toBe(
      "runs",
    );
  });

  it("carries the project in every link it offers", () => {
    const { primary } = navigationFor("prj_2");
    for (const link of primary) {
      expect(link.href.startsWith("/projects/prj_2/")).toBe(true);
    }
    expect(primary.map((link) => link.href)).toContain("/projects/prj_2/agents");
  });

  it("knows which item an address is under, and says nothing outside the product", () => {
    expect(activeSectionIn("/projects/prj_1/agents")).toBe("agents");
    expect(activeSectionIn("/projects/prj_1/personas/prs_3")).toBe("personas");
    expect(activeSectionIn("/traces")).toBeNull();
    expect(activeSectionIn("/members")).toBeNull();
  });
});

describe("what a role is offered", () => {
  it("lets members and admins author, and never a viewer", () => {
    expect(canAuthor("admin")).toBe(true);
    expect(canAuthor("member")).toBe(true);
    expect(canAuthor("viewer")).toBe(false);
  });

  it("keeps organization administration to admins", () => {
    expect(canAdminister("admin")).toBe(true);
    expect(canAdminister("member")).toBe(false);
    expect(canAdminister("viewer")).toBe(false);
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
    expect(projectOf(ADA, "prj_2")?.name).toBe("Outbound");
    expect(projectOf(ADA, "prj_9")).toBeUndefined();
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
