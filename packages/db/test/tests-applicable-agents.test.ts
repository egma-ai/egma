import { newId } from "@egma/ids";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  ApplicabilityConflictError,
  archiveAgent,
  archivePersona,
  archiveTest,
  cloneTest,
  createAgent,
  createTest,
  deleteGrader,
  editTest,
  getTest,
  IdentityConflictError,
  listTests,
  restoreTest,
  setTestAgents,
  TestAgentRefusedError,
  TestDependencyInactiveError,
  UnknownCapabilityError,
  type Test,
} from "@egma/db";

import { type MigratedDatabase } from "./support/database.ts";
import {
  acme,
  actingAsAcme,
  actingAsGlobex,
  globex,
  rescheduling,
  seedAgent,
  seedGrader,
  seedPersona,
  seedTestFactory,
} from "./support/test-factory.ts";

/**
 * Which agents a test applies to, and what that relation refuses.
 *
 * Every assertion goes through the factory functions. The relation is on the
 * identity row rather than on a version, and the three things that follow from
 * that are what this file is mostly about: a link edit mints no version, a link
 * edit does not move the identity revision, and the set can never be emptied.
 *
 * The sibling project is where the "a project with no active agent" cases live,
 * because they need a project this file can empty without taking every other
 * block's target away.
 */

let database: MigratedDatabase;
let rita: string;
let grace: string;
let frontDesk: string;
let globexDesk: string;

/** A project of Acme's this file can empty of agents. */
const bare = newId("prj");

function actingInBare() {
  return { ...actingAsAcme(), projectId: bare };
}

beforeAll(async () => {
  ({ database, rita, grace, frontDesk, globexDesk } = await seedTestFactory(
    "tests_applicable_agents",
  ));

  // Raw, because the fixture's own seeding is per organization and this file
  // needs one extra project inside an organization it already made. A project
  // carries a live revision of its own since 0027, so this writes one.
  await database.sql(
    `insert into project (id, organization_id, name, slug, revision)
     values ($1, $2, 'Bare', 'bare', $3)`,
    [bare, acme.organization, newId("rev")],
  );
});

afterAll(async () => {
  await database.drop();
});

/** A test of Acme's default project, applying to whatever is named. */
async function aTest(
  name: string,
  changes: Partial<Parameters<typeof createTest>[1]> = {},
): Promise<Test> {
  return createTest(actingAsAcme(), {
    ...rescheduling,
    name,
    personaIds: [rita],
    ...changes,
  });
}

describe("creating a test with the agents it applies to", () => {
  it("links the agents it names, and reads them back", async () => {
    const second = await seedAgent(actingAsAcme(), "Front desk, night shift");
    const created = await aTest("Named two agents", {
      agentIds: [frontDesk, second],
    });

    expect(created.agents.map((applies) => applies.id).sort()).toEqual(
      [frontDesk, second].sort(),
    );
    expect(created.agents.every((applies) => applies.archivedAt === null)).toBe(
      true,
    );
  });

  it("takes every active agent in the project when it names none", async () => {
    const created = await aTest("Named no agent");

    const active = await database.sql<{ id: string }>(
      "select id from agent where project_id = $1 and archived_at is null",
      [acme.project],
    );
    expect(created.agents.map((applies) => applies.id).sort()).toEqual(
      active.rows.map((row) => row.id).sort(),
    );
  });

  it("refuses an archived agent by name, and says it is not active", async () => {
    const retiring = await seedAgent(actingAsAcme(), "Retiring desk");
    await archiveAgent(actingAsAcme(), retiring);

    await expect(
      aTest("Names an archived agent", { agentIds: [retiring] }),
    ).rejects.toSatisfy(
      (error) =>
        error instanceof TestAgentRefusedError &&
        error.reason === "agent_not_available" &&
        error.message.includes(retiring),
    );
  });

  it("refuses another project's agent in the same words as one that never existed", async () => {
    await expect(
      aTest("Names a stranger's agent", { agentIds: [globexDesk] }),
    ).rejects.toSatisfy(
      (error) =>
        error instanceof TestAgentRefusedError &&
        error.reason === "agent_not_available",
    );

    // Nothing about somebody else's row is confirmed, and nothing is written.
    const { rows } = await database.sql<{ count: string }>(
      "select count(*) as count from test where name = 'Names a stranger''s agent'",
    );
    expect(Number(rows[0]?.count)).toBe(0);
  });

  it("refuses a create in a project with no active agent at all", async () => {
    const stranded = await seedPersona(actingInBare(), "Stranded Sam");

    await expect(
      createTest(actingInBare(), {
        ...rescheduling,
        name: "Nowhere to run",
        personaIds: [stranded],
      }),
    ).rejects.toSatisfy(
      (error) =>
        error instanceof TestAgentRefusedError &&
        error.reason === "test_needs_agent" &&
        error.message ===
          "Every test must apply to at least one active agent. Select an " +
            "active agent and save the test again.",
    );
  });
});

describe("changing which agents a test applies to", () => {
  let subject: Test;
  let second: string;

  beforeAll(async () => {
    second = await seedAgent(actingAsAcme(), "Front desk, weekend");
    subject = await aTest("Applicability under edit", { agentIds: [frontDesk] });
  });

  it("adds a link without minting a version or moving the identity revision", async () => {
    const changed = await setTestAgents(actingAsAcme(), subject.id, {
      agentIds: [frontDesk, second],
    });

    expect(changed?.agents.map((applies) => applies.id).sort()).toEqual(
      [frontDesk, second].sort(),
    );
    // Target coverage is not test content, so no version is minted…
    expect(changed?.version).toBe(subject.version);
    expect(changed?.versionId).toBe(subject.versionId);
    // …and it is not the test's live identity either, so a rename being typed
    // in another tab stays saveable.
    expect(changed?.revision).toBe(subject.revision);
    // Only the token that names the set moves.
    expect(changed?.applicabilityRevision).not.toBe(
      subject.applicabilityRevision,
    );

    subject = changed as Test;
  });

  it("removes a link, on the same terms", async () => {
    const changed = await setTestAgents(actingAsAcme(), subject.id, {
      agentIds: [second],
    });

    expect(changed?.agents.map((applies) => applies.id)).toEqual([second]);
    expect(changed?.versionId).toBe(subject.versionId);
    expect(changed?.revision).toBe(subject.revision);

    subject = changed as Test;
  });

  it("refuses removing the last link, and names the agent going out", async () => {
    await expect(
      setTestAgents(actingAsAcme(), subject.id, { agentIds: [] }),
    ).rejects.toSatisfy(
      (error) =>
        error instanceof TestAgentRefusedError &&
        error.reason === "last_test_agent" &&
        error.message ===
          `Test ${subject.id} must apply to at least one agent. Link another ` +
            `active agent before you remove ${second}.`,
    );

    // Refused whole: the link it was about to remove is still there.
    const held = await getTest(actingAsAcme(), subject.id);
    expect(held?.agents.map((applies) => applies.id)).toEqual([second]);
    expect(held?.applicabilityRevision).toBe(subject.applicabilityRevision);
  });

  it("refuses a link edit written against an applicability revision it has moved past", async () => {
    const stale = subject.applicabilityRevision;
    const moved = await setTestAgents(actingAsAcme(), subject.id, {
      agentIds: [second, frontDesk],
      expectedApplicabilityRevision: stale,
    });
    expect(moved?.agents).toHaveLength(2);

    await expect(
      setTestAgents(actingAsAcme(), subject.id, {
        agentIds: [second],
        expectedApplicabilityRevision: stale,
      }),
    ).rejects.toSatisfy(
      (error) =>
        error instanceof ApplicabilityConflictError &&
        error.expected === stale &&
        error.current === moved?.applicabilityRevision,
    );

    // Nothing written: both links are still there.
    const held = await getTest(actingAsAcme(), subject.id);
    expect(held?.agents).toHaveLength(2);
    subject = held as Test;
  });

  it("writes nothing at all when the set is already exactly what was sent", async () => {
    const same = await setTestAgents(actingAsAcme(), subject.id, {
      agentIds: [frontDesk, second],
    });

    // A save that changed nothing must not make somebody else's open link
    // editor stale.
    expect(same?.applicabilityRevision).toBe(subject.applicabilityRevision);
  });

  it("keeps a link whose agent is archived, and says so on the read", async () => {
    const retiring = await seedAgent(actingAsAcme(), "Desk that retires");
    await setTestAgents(actingAsAcme(), subject.id, {
      agentIds: [frontDesk, retiring],
    });
    await archiveAgent(actingAsAcme(), retiring);

    const held = await getTest(actingAsAcme(), subject.id);
    const kept = held?.agents.find((applies) => applies.id === retiring);
    // Removing it would rewrite somebody's coverage as a side effect of tidying
    // up; hiding it would show a test with fewer targets than it has.
    expect(kept?.archivedAt).toBeInstanceOf(Date);
  });

  it("refuses a new link to that archived agent, which is the same rule seen from the other side", async () => {
    const retiring = await seedAgent(actingAsAcme(), "Desk that also retires");
    await archiveAgent(actingAsAcme(), retiring);

    await expect(
      setTestAgents(actingAsAcme(), subject.id, {
        agentIds: [frontDesk, retiring],
      }),
    ).rejects.toSatisfy(
      (error) =>
        error instanceof TestAgentRefusedError &&
        error.reason === "agent_not_available",
    );
  });

  it("is refused to a viewer", async () => {
    await expect(
      setTestAgents(actingAsAcme("viewer"), subject.id, {
        agentIds: [frontDesk],
      }),
    ).rejects.toThrow(/viewer/);
  });

  it("answers nothing for another customer's test", async () => {
    expect(
      await setTestAgents(actingAsGlobex(), subject.id, {
        agentIds: [globexDesk],
      }),
    ).toBeUndefined();
  });
});

describe("the two expectations an edit may carry", () => {
  it("refuses a rename written against a stale identity revision, and leaves the links alone", async () => {
    const subject = await aTest("Two tokens", { agentIds: [frontDesk] });
    const renamed = await editTest(actingAsAcme(), subject.id, {
      name: "Two tokens, renamed",
      expectedRevision: subject.revision,
    });
    expect(renamed?.name).toBe("Two tokens, renamed");

    await expect(
      editTest(actingAsAcme(), subject.id, {
        name: "Two tokens, renamed again",
        expectedRevision: subject.revision,
      }),
    ).rejects.toSatisfy(
      (error) =>
        error instanceof IdentityConflictError &&
        error.resource === "test" &&
        error.expected === subject.revision &&
        error.current === renamed?.revision,
    );

    const held = await getTest(actingAsAcme(), subject.id);
    expect(held?.name).toBe("Two tokens, renamed");
  });

  it("does not move the applicability revision when the name changes", async () => {
    const subject = await aTest("Rename leaves links alone", {
      agentIds: [frontDesk],
    });
    const renamed = await editTest(actingAsAcme(), subject.id, {
      name: "Renamed, links untouched",
    });

    expect(renamed?.applicabilityRevision).toBe(subject.applicabilityRevision);
  });
});

describe("required capabilities", () => {
  it("round-trips through the catalog, in the order they were written", async () => {
    const created = await aTest("Needs digits", {
      requiredCapabilities: ["dtmf", "raw_audio"],
    });

    expect(created.requiredCapabilities).toEqual(["dtmf", "raw_audio"]);
    const held = await getTest(actingAsAcme(), created.id);
    expect(held?.requiredCapabilities).toEqual(["dtmf", "raw_audio"]);
  });

  it("refuses a key the catalog does not have, and writes nothing", async () => {
    await expect(
      aTest("Needs something invented", {
        requiredCapabilities: ["dtmf", "telepathy"],
      }),
    ).rejects.toSatisfy(
      (error) =>
        error instanceof UnknownCapabilityError &&
        error.capability === "telepathy" &&
        error.message ===
          "Capability telepathy is not in this Egma capability catalog. " +
            "Choose a capability offered by the test editor and save the " +
            "test again.",
    );

    const { rows } = await database.sql<{ count: string }>(
      "select count(*) as count from test where name = 'Needs something invented'",
    );
    expect(Number(rows[0]?.count)).toBe(0);
  });

  it("mints a version when the set changes, and none when it does not", async () => {
    const created = await aTest("Capabilities under edit", {
      requiredCapabilities: ["dtmf"],
    });

    const changed = await editTest(actingAsAcme(), created.id, {
      requiredCapabilities: ["dtmf", "barge_in"],
    });
    expect(changed?.version).toBe(2);

    const again = await editTest(actingAsAcme(), created.id, {
      requiredCapabilities: ["dtmf", "barge_in"],
    });
    expect(again?.version).toBe(2);
    expect(again?.versionId).toBe(changed?.versionId);
  });

  it("carries them forward when an edit does not mention them", async () => {
    const created = await aTest("Capabilities kept", {
      requiredCapabilities: ["raw_audio"],
    });

    const changed = await editTest(actingAsAcme(), created.id, {
      scenario: "They call from a noisy platform at the station.",
    });
    expect(changed?.requiredCapabilities).toEqual(["raw_audio"]);
  });

  it("clears them when an edit sends an empty list", async () => {
    const created = await aTest("Capabilities cleared", {
      requiredCapabilities: ["raw_audio"],
    });

    const changed = await editTest(actingAsAcme(), created.id, {
      requiredCapabilities: [],
    });
    expect(changed?.requiredCapabilities).toEqual([]);
    expect(changed?.version).toBe(2);
  });
});

describe("a test's hidden mock-tool overrides", () => {
  it("survive an edit that does not mention them", async () => {
    const created = await aTest("Overrides survive", {
      mockOverrides: [
        {
          toolName: "check_availability",
          answer: { answer: { slots: [] } },
        },
      ],
    });
    expect(created.mockOverrides).toHaveLength(1);

    // The browser's form never shows these, so every browser write leaves the
    // field out — and leaving it out has to mean keep.
    const changed = await editTest(actingAsAcme(), created.id, {
      name: "Overrides survive, renamed",
      scenario: "They call twice about the same booking.",
    });

    expect(changed?.mockOverrides).toEqual(created.mockOverrides);
  });

  it("are copied by a clone, so a copy runs in the same world", async () => {
    const created = await aTest("Overrides cloned", {
      mockOverrides: [
        {
          toolName: "check_availability",
          answer: { error: "the calendar is unreachable" },
        },
      ],
    });

    const clone = await cloneTest(actingAsAcme(), created.id);
    expect(clone?.mockOverrides).toEqual(created.mockOverrides);
  });
});

describe("cloning a test", () => {
  it("copies the source's active links and none of its archived ones", async () => {
    const retiring = await seedAgent(actingAsAcme(), "Desk to be archived");
    const source = await aTest("Cloned coverage", {
      agentIds: [frontDesk, retiring],
    });
    await archiveAgent(actingAsAcme(), retiring);

    const clone = await cloneTest(actingAsAcme(), source.id);

    // A clone is a create, and a create may not link an archived agent — so
    // copying the archived link would make clone the one door past that rule.
    expect(clone?.agents.map((applies) => applies.id)).toEqual([frontDesk]);
    expect(clone?.version).toBe(1);
    expect(clone?.id).not.toBe(source.id);
  });

  it("copies the required capabilities", async () => {
    const source = await aTest("Cloned capabilities", {
      requiredCapabilities: ["barge_in"],
    });
    const clone = await cloneTest(actingAsAcme(), source.id);
    expect(clone?.requiredCapabilities).toEqual(["barge_in"]);
  });
});

describe("archiving and restoring a test", () => {
  it("refuses Restore while the current version names an archived persona", async () => {
    const leaving = await seedPersona(actingAsAcme(), "Persona who leaves");
    const subject = await aTest("Names somebody who leaves", {
      personaIds: [leaving],
      agentIds: [frontDesk],
    });

    await archiveTest(actingAsAcme(), subject.id);
    // Only allowed once the test is archived: an active test naming them is
    // exactly what the persona's own Archive refuses.
    await archivePersona(actingAsAcme(), leaving);

    await expect(
      restoreTest(actingAsAcme(), subject.id),
    ).rejects.toSatisfy(
      (error) =>
        error instanceof TestDependencyInactiveError &&
        error.resources.some(
          (one) => one.kind === "persona" && one.id === leaving,
        ),
    );

    const held = await getTest(actingAsAcme(), subject.id);
    expect(held?.archivedAt).toBeInstanceOf(Date);
  });

  it("refuses Restore while the current version names an archived scenario grader", async () => {
    const judging = await seedGrader(actingAsAcme(), "Grader that leaves");
    const subject = await aTest("Names a grader that leaves", {
      graderIds: [judging],
      agentIds: [frontDesk],
    });

    await archiveTest(actingAsAcme(), subject.id);
    await deleteGrader(actingAsAcme(), judging);

    await expect(restoreTest(actingAsAcme(), subject.id)).rejects.toSatisfy(
      (error) =>
        error instanceof TestDependencyInactiveError &&
        error.resources.some(
          (one) => one.kind === "grader" && one.id === judging,
        ),
    );
  });

  it("restores a test whose linked agents are all archived, leaving it unavailable rather than unrestorable", async () => {
    const only = await seedAgent(actingAsAcme(), "The only desk");
    const subject = await aTest("Every target archived", { agentIds: [only] });

    await archiveTest(actingAsAcme(), subject.id);
    await archiveAgent(actingAsAcme(), only);

    const restored = await restoreTest(actingAsAcme(), subject.id);
    expect(restored?.archivedAt).toBeNull();
    // Active and unavailable is an honest state: the links are somebody's
    // coverage decision, and the fix is to restore an agent.
    expect(restored?.agents.every((applies) => applies.archivedAt !== null)).toBe(
      true,
    );
  });

  it("refuses Restore of a linkless test until an active agent is named in the same write", async () => {
    const subject = await aTest("Linkless after an upgrade", {
      agentIds: [frontDesk],
    });
    await archiveTest(actingAsAcme(), subject.id);

    // Only an upgrade can produce this: nothing in the product empties the set.
    await database.sql("delete from test_agent where test_id = $1", [subject.id]);

    await expect(restoreTest(actingAsAcme(), subject.id)).rejects.toSatisfy(
      (error) =>
        error instanceof TestAgentRefusedError &&
        error.reason === "test_needs_agent",
    );

    const restored = await restoreTest(actingAsAcme(), subject.id, {
      agentIds: [frontDesk],
    });
    expect(restored?.archivedAt).toBeNull();
    expect(restored?.agents.map((applies) => applies.id)).toEqual([frontDesk]);
    expect(restored?.archiveReason).toBeNull();
  });
});

describe("listing tests", () => {
  it("narrows to the tests that apply to one agent, once each", async () => {
    const only = await seedAgent(actingAsAcme(), "Filter desk");
    const applies = await aTest("Applies to the filter desk", {
      agentIds: [frontDesk, only],
    });
    await aTest("Applies elsewhere", { agentIds: [frontDesk] });

    const page = await listTests(actingAsAcme(), { agentId: only });
    // Once, not once per link: a join would multiply the page by the link count
    // and make the cursor lie.
    expect(page.items.map((item) => item.id)).toEqual([applies.id]);
  });

  it("narrows by name, ignoring case, and treats a wildcard as a character", async () => {
    await aTest("Refunds a 100% deposit");

    const found = await listTests(actingAsAcme(), { name: "refunds a 100%" });
    expect(found.items.map((item) => item.name)).toEqual([
      "Refunds a 100% deposit",
    ]);

    // The per cent is a character somebody typed, not a wildcard: it matches
    // the one test whose name really holds one, rather than every test in the
    // project.
    const wild = await listTests(actingAsAcme(), { name: "%" });
    expect(wild.items.map((item) => item.name)).toEqual([
      "Refunds a 100% deposit",
    ]);
  });

  it("shows archived tests only under the archive filter", async () => {
    const subject = await aTest("Archived for the list");
    await archiveTest(actingAsAcme(), subject.id);

    const active = await listTests(actingAsAcme(), { name: "Archived for the list" });
    expect(active.items).toHaveLength(0);

    const archived = await listTests(actingAsAcme(), {
      archived: true,
      name: "Archived for the list",
    });
    expect(archived.items.map((item) => item.id)).toEqual([subject.id]);
  });

  it("never shows another customer's test, however it is filtered", async () => {
    const theirs = await createTest(actingAsGlobex(), {
      ...rescheduling,
      name: "Globex's own",
      personaIds: [grace],
    });

    const page = await listTests(actingAsAcme(), { name: "Globex's own" });
    expect(page.items.map((item) => item.id)).not.toContain(theirs.id);

    // And naming their agent narrows to nothing rather than reaching across.
    const byAgent = await listTests(actingAsAcme(), { agentId: globexDesk });
    expect(byAgent.items).toHaveLength(0);
  });
});
