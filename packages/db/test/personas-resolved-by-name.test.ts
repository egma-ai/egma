import { newId } from "@egma/ids";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createPersona,
  archivePersona,
  PersonaNameAmbiguousError,
  resolvePersonaNames,
  type AuthContext,
  type Role,
} from "@egma/db";

import {
  createConnectedDatabase,
  type MigratedDatabase,
} from "./support/database.ts";
import { seedOrganization, seedUser } from "./support/tenancy.ts";

/**
 * Names off a reviewed file, turned into the identity a version names. Why the
 * wire carries names at all is `resolvePersonaNames`'s own story.
 *
 * What is checked here is only what this function decides: which persona a
 * written name means, and how it refuses when the answer is none, somebody
 * archived, more than one, or the same one twice. Whether an empty list becomes
 * the project's default is the test factory's rule and is tested there.
 */

let database: MigratedDatabase;

const acme = {
  organization: newId("org"),
  project: newId("prj"),
  /** A sibling project, so a name can exist in the customer and not here. */
  outbound: newId("prj"),
};
const globex = { organization: newId("org"), project: newId("prj") };
const ada = newId("usr");
const gene = newId("usr");

const neutralTraits = {
  personality: "Speaks plainly, stays patient, asks one question at a time.",
  language: "en-US",
  voice: { provider: "elevenlabs", voiceId: "EXAVITQu4vr4xnSDxMaL", speed: 1 },
} as const;

function actingIn(
  projectId: string | undefined,
  role: Role = "member",
): AuthContext {
  return {
    userId: ada,
    organizationId: acme.organization,
    projectId,
    role,
    via: "session",
  };
}

function actingAsGlobex(): AuthContext {
  return {
    userId: gene,
    organizationId: globex.organization,
    projectId: globex.project,
    role: "member",
    via: "session",
  };
}

async function seedPersona(auth: AuthContext, name: string): Promise<string> {
  const created = await createPersona(auth, { name, traits: neutralTraits });
  return created.id;
}

let rita: string;
let omar: string;

beforeAll(async () => {
  database = await createConnectedDatabase("personas_by_name");
  await seedOrganization(database, acme.organization, [
    { id: acme.project, slug: "default" },
    { id: acme.outbound, slug: "outbound" },
  ]);
  await seedOrganization(database, globex.organization, [
    { id: globex.project, slug: "default" },
  ]);
  await seedUser(database, ada, "ada@acme.example");
  await seedUser(database, gene, "gene@globex.example");

  rita = await seedPersona(actingIn(acme.project), "Impatient Rita");
  omar = await seedPersona(actingIn(acme.project), "Omar");
});

afterAll(async () => {
  await database.drop();
});

describe("resolving the personas a file names", () => {
  it("answers a name with the persona's identity", async () => {
    expect(
      await resolvePersonaNames(actingIn(acme.project), ["Impatient Rita"]),
    ).toEqual([rita]);
  });

  it("keeps the order they were named in, because that order is content", async () => {
    expect(
      await resolvePersonaNames(actingIn(acme.project), ["Omar", "Impatient Rita"]),
    ).toEqual([omar, rita]);
  });

  it("resolves an identifier too, so a caller holding one needs no name", async () => {
    expect(
      await resolvePersonaNames(actingIn(acme.project), [rita, "Omar"]),
    ).toEqual([rita, omar]);
  });

  it("answers nobody with nobody, leaving the default rule to the write", async () => {
    expect(await resolvePersonaNames(actingIn(acme.project), [])).toEqual([]);
  });

  it("reads a name with space around it as the name", async () => {
    expect(
      await resolvePersonaNames(actingIn(acme.project), ["  Omar  "]),
    ).toEqual([omar]);
  });
});

describe("a name this project cannot answer", () => {
  it("is refused, saying what to do instead", async () => {
    await expect(
      resolvePersonaNames(actingIn(acme.project), ["Nobody At All"]),
    ).rejects.toThrow(
      'egma has no persona called "Nobody At All" in this project. Name a persona this project already has, or name none and egma takes the project\'s default.',
    );
  });

  it("is refused in the factory's own words when it was an identifier", async () => {
    const missing = newId("prs");
    await expect(
      resolvePersonaNames(actingIn(acme.project), [missing]),
    ).rejects.toThrow(`there is no persona ${missing} in this project`);
  });

  it("is a name that belongs to a sibling project of the same customer", async () => {
    await seedPersona(actingIn(acme.outbound), "Outbound Only");

    await expect(
      resolvePersonaNames(actingIn(acme.project), ["Outbound Only"]),
    ).rejects.toThrow(/egma has no persona called "Outbound Only"/u);
  });

  it("is a name that belongs to another customer", async () => {
    await seedPersona(actingAsGlobex(), "Careful Grace");

    await expect(
      resolvePersonaNames(actingIn(acme.project), ["Careful Grace"]),
    ).rejects.toThrow(/egma has no persona called "Careful Grace"/u);
  });

});

describe("a name only an archived persona answers to", () => {
  /**
   * A different problem from a name nothing answers to, and it gets different
   * words. The name was right when somebody wrote it, so reporting it as never
   * having existed would send them looking for a typo that is not there.
   */
  it("is refused in the factory's own words, by name and by identifier alike", async () => {
    const leaving = await seedPersona(actingIn(acme.project), "Leaving Soon");
    await archivePersona(actingIn(acme.project), leaving);

    const gone = `persona ${leaving} is archived, and a test cannot name an archived persona`;
    await expect(
      resolvePersonaNames(actingIn(acme.project), ["Leaving Soon"]),
    ).rejects.toThrow(gone);
    await expect(
      resolvePersonaNames(actingIn(acme.project), [leaving]),
    ).rejects.toThrow(gone);
  });

  it("is still a persona nobody has, once another customer asks by that name", async () => {
    const leaving = await seedPersona(actingIn(acme.project), "Also Leaving");
    await archivePersona(actingIn(acme.project), leaving);

    await expect(
      resolvePersonaNames(actingAsGlobex(), ["Also Leaving"]),
    ).rejects.toThrow(/egma has no persona called "Also Leaving"/u);
  });

  it("does not shadow a living persona of the same name", async () => {
    const gone = await seedPersona(actingIn(acme.project), "Two Of Them");
    await archivePersona(actingIn(acme.project), gone);
    const living = await seedPersona(actingIn(acme.project), "Two Of Them");

    expect(
      await resolvePersonaNames(actingIn(acme.project), ["Two Of Them"]),
    ).toEqual([living]);
  });
});

describe("a name that is not one persona", () => {
  /**
   * Its own class, and the sentence that says where the identifier goes.
   *
   * The usual reader is a repository file rather than a form: a version-1 test
   * file carries persona *names* and nothing else, and the fix is to put the
   * stable identifier in the file — an instruction no browser would be given.
   * Nothing picks one of the two, ever: there is no uniqueness rule on a
   * persona's name, so choosing by list order would put somebody in a test that
   * nobody chose and the run would be about a caller the author never named.
   */
  it("is refused when two personas answer to it, rather than one being picked", async () => {
    const first = await seedPersona(actingIn(acme.project), "Twice Over");
    const second = await seedPersona(actingIn(acme.project), "Twice Over");

    const refused = await resolvePersonaNames(actingIn(acme.project), [
      "Twice Over",
    ]).then(
      (resolved) => ({ resolved }),
      (thrown: unknown) => ({ thrown }),
    );

    expect(refused, `resolved to ${JSON.stringify(refused)}`).not.toHaveProperty(
      "resolved",
    );
    const thrown = (refused as { thrown: unknown }).thrown;
    expect(thrown).toBeInstanceOf(PersonaNameAmbiguousError);
    expect((thrown as PersonaNameAmbiguousError).personaName).toBe("Twice Over");
    expect((thrown as Error).message).toBe(
      "Persona name Twice Over matches more than one active persona in this " +
        "project. Put the intended persona's stable ID in the file and try " +
        "again; for a pinned file, egma pull can write the IDs after the file " +
        "is safe to migrate.",
    );

    // Either identifier still resolves, which is what the sentence tells the
    // writer to reach for.
    for (const id of [first, second]) {
      expect(await resolvePersonaNames(actingIn(acme.project), [id])).toEqual([id]);
    }
  });

  it("is refused when one persona is named twice, however they were spelled", async () => {
    await expect(
      resolvePersonaNames(actingIn(acme.project), ["Omar", "Omar"]),
    ).rejects.toThrow(
      'persona "Omar" is named twice on one test; name each persona once',
    );

    await expect(
      resolvePersonaNames(actingIn(acme.project), [omar, "Omar"]),
    ).rejects.toThrow(
      'persona "Omar" is named twice on one test; name each persona once',
    );
  });
});

describe("who may ask", () => {
  it("includes a viewer, because reading is what every role may do", async () => {
    expect(
      await resolvePersonaNames(actingIn(acme.project, "viewer"), ["Omar"]),
    ).toEqual([omar]);
  });

  it("refuses a credential acting in no project, which has none to look in", async () => {
    await expect(
      resolvePersonaNames(actingIn(undefined), ["Omar"]),
    ).rejects.toThrow(/acting in none/u);
  });

  it("does not answer another customer an identifier of ours", async () => {
    await expect(
      resolvePersonaNames(actingAsGlobex(), [omar]),
    ).rejects.toThrow(`there is no persona ${omar} in this project`);
  });
});
