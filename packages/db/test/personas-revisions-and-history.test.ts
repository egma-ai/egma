import { newId } from "@egma/ids";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  archivePersona,
  createPersona,
  editPersona,
  getPersona,
  getPersonaVersion,
  IdentityConflictError,
  listPersonaVersions,
  restorePersona,
  testsUsingPersona,
  VersionConflictError,
  type AuthContext,
  type PersonaTraits,
} from "@egma/db";

import {
  createConnectedDatabase,
  type MigratedDatabase,
} from "./support/database.ts";
import { seedOrganization, seedUser } from "./support/tenancy.ts";

/**
 * The two things a persona write can be told it was written against, and the
 * two reads a detail page is made of.
 *
 * **A revision and a version id answer different questions and are not
 * interchangeable.** The revision says *this persona has not moved* — a rename,
 * an Archive, a Restore. The version id says *this content has not moved* — a
 * trait write. An edit that touches both names both, and the two refusals are
 * separate because they are separately recoverable: a rename that lost a race
 * is retyped in a second, and traits somebody spent an afternoon on have to be
 * handed back rather than overwritten.
 *
 * Every assertion here goes through the factory functions. The one raw read is
 * not needed: what a revision *is* is deliberately nobody's business, so
 * nothing here reads its shape — only that it changes when the persona does,
 * and that handing back a stale one is refused.
 */

let database: MigratedDatabase;

const acme = { organization: newId("org"), project: newId("prj") };
const ada = newId("usr");

function acting(role: "admin" | "member" | "viewer" = "member"): AuthContext {
  return {
    userId: ada,
    organizationId: acme.organization,
    projectId: acme.project,
    role,
    via: "session",
  };
}

const TRAITS: PersonaTraits = {
  personality: "Calls about a bill, and wants it settled today.",
  language: "en-US",
  voice: { provider: "elevenlabs", voiceId: "EXAVITQu4vr4xnSDxMaL", speed: 1 },
};

beforeAll(async () => {
  database = await createConnectedDatabase("persona_revisions");
  await seedOrganization(database, acme.organization, [
    { id: acme.project, slug: "default" },
  ]);
  await seedUser(database, ada, "ada@acme.example");
});

afterAll(async () => {
  await database.drop();
});

async function seed(name: string) {
  return createPersona(acting(), { name, traits: TRAITS });
}

describe("the revision an identity write names", () => {
  it("changes on a rename, and the one it replaced no longer lands", async () => {
    const made = await seed("Renamed Rowan");

    const renamed = await editPersona(acting(), made.id, {
      name: "Rowan, renamed",
      expectedRevision: made.revision,
    });
    expect(renamed?.name).toBe("Rowan, renamed");
    expect(renamed?.revision).not.toBe(made.revision);

    // The second tab, still holding what it read before the rename.
    const refused = await editPersona(acting(), made.id, {
      name: "Rowan, renamed again",
      expectedRevision: made.revision,
    }).then(
      () => {
        throw new Error("the stale edit was expected to be refused");
      },
      (thrown: unknown) => thrown,
    );

    expect(refused).toBeInstanceOf(IdentityConflictError);
    const conflict = refused as IdentityConflictError;
    expect(conflict.resource).toBe("persona");
    expect(conflict.resourceId).toBe(made.id);
    expect(conflict.expected).toBe(made.revision);
    expect(conflict.current).toBe(renamed?.revision);

    // Refused means nothing written, not written and then complained about.
    expect((await getPersona(acting(), made.id))?.name).toBe("Rowan, renamed");
  });

  it("guards Archive and Restore on the same terms", async () => {
    const made = await seed("Guarded Gail");

    await expect(
      archivePersona(acting(), made.id, { expectedRevision: "not-the-one" }),
    ).rejects.toBeInstanceOf(IdentityConflictError);
    expect((await getPersona(acting(), made.id))?.archivedAt).toBeNull();

    const archived = await archivePersona(acting(), made.id, {
      expectedRevision: made.revision,
    });
    expect(archived?.archivedAt).toBeInstanceOf(Date);

    // The revision the Archive replaced is exactly what a page opened before
    // it is holding, and Restore refuses it for the same reason.
    await expect(
      restorePersona(acting(), made.id, { expectedRevision: made.revision }),
    ).rejects.toBeInstanceOf(IdentityConflictError);

    const restored = await restorePersona(acting(), made.id, {
      expectedRevision: archived?.revision,
    });
    expect(restored?.archivedAt).toBeNull();
  });

  it("is not asked for by a caller that names none", async () => {
    // The scripts and the seeding paths act on a row they read a line earlier
    // and have nobody to race. The browser's door is where naming one is
    // required; leaving it out here writes without a check, on purpose.
    const made = await seed("Unguarded Uma");
    const renamed = await editPersona(acting(), made.id, { name: "Uma" });
    expect(renamed?.name).toBe("Uma");
  });
});

describe("the version a trait write names", () => {
  it("refuses a write against a version the persona has moved past", async () => {
    const made = await seed("Versioned Vera");

    const second = await editPersona(acting(), made.id, {
      traits: { ...TRAITS, personality: "Vera, after a long wait." },
      expectedVersionId: made.versionId,
    });
    expect(second?.version).toBe(2);

    const refused = await editPersona(acting(), made.id, {
      traits: { ...TRAITS, personality: "Vera, in a hurry." },
      expectedVersionId: made.versionId,
    }).then(
      () => {
        throw new Error("the stale trait write was expected to be refused");
      },
      (thrown: unknown) => thrown,
    );

    expect(refused).toBeInstanceOf(VersionConflictError);
    const conflict = refused as VersionConflictError;
    expect(conflict.resource).toBe("persona");
    expect(conflict.expected).toBe(made.versionId);
    expect(conflict.current).toBe(second?.versionId);

    const now = await getPersona(acting(), made.id);
    expect(now?.version).toBe(2);
    expect(now?.traits.personality).toBe("Vera, after a long wait.");
  });

  it("refuses a stale expectation even when the traits sent are identical", async () => {
    const made = await seed("Nervous Nell");
    const second = await editPersona(acting(), made.id, {
      traits: { ...TRAITS, personality: "Nell, twice as brisk." },
      expectedVersionId: made.versionId,
    });

    // Nothing would have been minted — the traits below are what is already
    // stored — but the caller is working from a read taken two versions ago,
    // and letting that through would tell them their view is current.
    await expect(
      editPersona(acting(), made.id, {
        traits: second?.traits ?? TRAITS,
        expectedVersionId: made.versionId,
      }),
    ).rejects.toBeInstanceOf(VersionConflictError);
  });

  it("mints nothing for a byte-identical save that names the current version", async () => {
    const made = await seed("Steady Sam");

    const saved = await editPersona(acting(), made.id, {
      traits: { ...TRAITS, voice: { ...TRAITS.voice } },
      expectedVersionId: made.versionId,
    });

    expect(saved?.version).toBe(1);
    expect(saved?.versionId).toBe(made.versionId);
    expect(saved?.revision).toBe(made.revision);
    const history = await listPersonaVersions(acting(), made.id);
    expect(history.items).toHaveLength(1);
  });
});

describe("the described traits", () => {
  const described: PersonaTraits = {
    ...TRAITS,
    manner: "Warm, and talks over the end of a sentence.",
    patience: "Gives it about a minute before asking for somebody else.",
    accent: "Glaswegian.",
    backgroundNoise: "A busy kitchen.",
    underFriction: "Repeats the question louder, then asks to escalate.",
  };

  it("round-trip through a create and version on any one of them", async () => {
    const made = await createPersona(acting(), {
      name: "Described Dee",
      traits: described,
    });
    expect((await getPersona(acting(), made.id))?.traits).toEqual(described);

    let version = 1;
    for (const change of [
      { manner: "Brisk, and does not talk over anybody." },
      { patience: "Waits as long as it takes." },
      { accent: "Received pronunciation." },
      { backgroundNoise: "A quiet room." },
      { underFriction: "Goes silent and waits." },
    ]) {
      const edited = await editPersona(acting(), made.id, {
        traits: { ...described, ...change },
      });
      version += 1;
      expect(edited?.version, JSON.stringify(change)).toBe(version);
    }
  });

  it("treat cleared and never-written as the same fact, so neither mints a version", async () => {
    const made = await createPersona(acting(), {
      name: "Half-Described Hal",
      traits: { ...TRAITS, manner: "Formal." },
    });

    // Whitespace is not a statement about somebody, so clearing to blanks and
    // never having written the field are one state and save as a no-op.
    const cleared = await editPersona(acting(), made.id, {
      traits: { ...TRAITS, manner: "   ", accent: "" },
    });
    expect(cleared?.version).toBe(2);
    expect(cleared?.traits.manner).toBeUndefined();

    const again = await editPersona(acting(), made.id, {
      traits: { ...TRAITS },
    });
    expect(again?.version).toBe(2);
    expect(again?.versionId).toBe(cleared?.versionId);
  });
});

describe("what a detail page reads", () => {
  it("lists every version newest first, and each one stays readable on its own", async () => {
    const made = await seed("Historic Hana");
    const second = await editPersona(acting(), made.id, {
      traits: { ...TRAITS, language: "en-GB" },
    });
    const third = await editPersona(acting(), made.id, {
      traits: { ...TRAITS, language: "en-AU" },
    });

    const history = await listPersonaVersions(acting(), made.id);
    expect(history.items.map((one) => one.version)).toEqual([3, 2, 1]);
    expect(history.items.map((one) => one.id)).toEqual([
      third?.versionId,
      second?.versionId,
      made.versionId,
    ]);

    const older = await getPersonaVersion(acting(), made.versionId);
    expect(older?.traits).toEqual(TRAITS);
    expect(history.items[2]?.traits).toEqual(TRAITS);
  });

  it("keeps the history readable after the persona is archived", async () => {
    const made = await seed("Filed-Away Fay");
    await editPersona(acting(), made.id, {
      traits: { ...TRAITS, language: "en-IE" },
    });
    await archivePersona(acting(), made.id);

    const history = await listPersonaVersions(acting(), made.id);
    expect(history.items.map((one) => one.version)).toEqual([2, 1]);
  });

  it("answers nothing at all for a persona this caller cannot reach", async () => {
    expect(await listPersonaVersions(acting(), newId("prs"))).toEqual({
      items: [],
      nextCursor: undefined,
    });
    expect(await testsUsingPersona(acting(), newId("prs"))).toBeUndefined();
  });

  it("answers an empty usage list for a persona no test names", async () => {
    const made = await seed("Unused Ulla");
    expect(await testsUsingPersona(acting(), made.id)).toEqual([]);
  });

  it("is refused to nobody: a viewer reads history and usage like anybody else", async () => {
    const made = await seed("Readable Rae");
    expect((await listPersonaVersions(acting("viewer"), made.id)).items).toHaveLength(1);
    expect(await testsUsingPersona(acting("viewer"), made.id)).toEqual([]);
  });
});
