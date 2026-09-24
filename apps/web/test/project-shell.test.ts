import { describe, expect, it } from "vitest";

import { answerFor } from "../lib/api.ts";
import { inProject, sectionIn } from "../lib/project-context.ts";
import { canAuthor } from "../lib/roles.ts";

/**
 * The decisions the product shell makes for itself: which project a tab is in,
 * where the navigation goes, what a role may be offered, and what an answer
 * from the API means to a page.
 *
 * Each is a function rather than a branch inside a component, because each is a
 * promise the product makes and a render branch is a promise nothing can
 * check.
 */

describe("which project a tab is looking at", () => {
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

  it("keeps a named settings page because the settings root does not exist", () => {
    expect(inProject("/projects/prj_1/settings/project", "prj_2")).toBe(
      "/projects/prj_2/settings/project",
    );
    expect(inProject("/projects/prj_1/settings", "prj_2")).toBe(
      "/projects/prj_2/settings/organization",
    );
  });
});

describe("what a role is offered", () => {
  it("lets members and admins author, and never a viewer", () => {
    expect(canAuthor("admin")).toBe(true);
    expect(canAuthor("member")).toBe(true);
    expect(canAuthor("viewer")).toBe(false);
  });
});

describe("what an answer from the API means to a page", () => {
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
});
