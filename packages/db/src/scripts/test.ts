import { parseArgs } from "node:util";

import { newId } from "@egma/ids";
import { eq } from "drizzle-orm";

import { connect, disconnect, db } from "../client.ts";
import {
  createTest,
  deleteTest,
  editTest,
  getTest,
  getTestVersion,
  listTests,
} from "../access/tests.ts";
import { createTestSuite } from "../access/suites.ts";
import type { AuthContext } from "../access/context.ts";
import { projectsOf } from "../access/projects.ts";
import { reconcileGraderCatalog } from "../access/grader-library.ts";
import { seedPersonaLibrary } from "../persona-library/seed.ts";
import { provisionOrganization } from "../access/provisioning.ts";
import { runMigrations } from "../migrate.ts";
import { organization, user } from "../schema/index.ts";

/**
 * Development test CLI. Provisions or reuses the factory-dev organization
 * and acts as its admin. Run node packages/db/dist/scripts/test.js for usage.
 * Create requires a suite and usable persona IDs; create-suite and persona.js
 * provide them. On edit, omitted flags retain values; behavior and persona
 * flags replace their respective lists.
 */

const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://egma:egma@localhost:5433/egma";

const DEV_SLUG = "factory-dev";
const DEV_EMAIL = "factory@dev.local";

async function actAsDevelopmentTenant(): Promise<AuthContext> {
  await db()
    .insert(user)
    .values({ id: newId("usr"), email: DEV_EMAIL })
    .onConflictDoNothing({ target: user.email });
  const [developer] = await db()
    .select({ id: user.id })
    .from(user)
    .where(eq(user.email, DEV_EMAIL));
  if (developer === undefined) throw new Error("the development user vanished");

  const existing = await db()
    .select({ id: organization.id })
    .from(organization)
    .where(eq(organization.slug, DEV_SLUG));

  const provisioned =
    existing.length > 0
      ? undefined
      : await provisionOrganization({
          ownerUserId: developer.id,
          organizationName: "Factory dev",
          organizationSlug: DEV_SLUG,
          projectName: "Default",
          projectSlug: "default",
        });

  const organizationId = existing[0]?.id ?? provisioned?.organizationId;
  if (organizationId === undefined) throw new Error("no development organization");

  const [firstProject] = await projectsOf(organizationId);
  if (firstProject === undefined) throw new Error("no development project");

  return {
    userId: developer.id,
    organizationId,
    projectId: firstProject.id,
    role: "admin",
    via: "session",
  };
}

function usage(): never {
  console.error(
    [
      "usage:",
      "  test.js create --suite <ste_id> --name <name> --scenario <text>",
      "    --behavior <text> [--behavior <text> …]",
      "    [--description <text>] [--persona <prs_id> …]",
      "  test.js get <tst_id>",
      "  test.js edit <tst_id> [--name <name>] [--description <text>]",
      "    [--scenario <text>] [--behavior <text> …] [--persona <prs_id> …]",
      "  test.js get-version <tstv_id>",
      "  test.js list <ste_id> [--limit <n>] [--cursor <tst_id>]",
      "  test.js delete <tst_id> <tstv_id> <rev_id>",
      "  test.js create-suite --name <name>",
    ].join("\n"),
  );
  process.exit(1);
}

/** The one positional argument most commands take. */
function requiredId(rest: readonly string[]): string {
  const [id] = rest;
  if (id === undefined) usage();
  return id;
}

/** Print what the factory answered, or say the id reached nothing and exit. */
function printTest(id: string, found: unknown): void {
  if (found === undefined) {
    console.error(`no test ${id} in the development project`);
    process.exit(1);
  }
  console.log(JSON.stringify(found, null, 2));
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);

  await runMigrations(DATABASE_URL);
  connect({ databaseUrl: DATABASE_URL, maxConnections: 2 });
  // egma's own graders, on the shelf before a project can be created — every
  // project is born holding a copy of one, and the pointer is a foreign key.
  await reconcileGraderCatalog();
  await seedPersonaLibrary();

  const auth = await actAsDevelopmentTenant();

  if (command === "create") {
    const { values } = parseArgs({
      args: rest,
      options: {
        name: { type: "string" },
        suite: { type: "string" },
        description: { type: "string" },
        scenario: { type: "string" },
        // Repeatable, and the order they are given is the order they are kept.
        behavior: { type: "string", multiple: true },
        "persona": { type: "string", multiple: true },
      },
    });
    if (
      values.name === undefined ||
      values.scenario === undefined ||
      values.suite === undefined
    ) usage();

    const created = await createTest(auth, {
      suiteId: values.suite,
      name: values.name,
      description: values.description,
      scenario: values.scenario,
      expectedBehaviors: values.behavior ?? [],
      personaIds: values["persona"],
    });
    console.log(JSON.stringify(created, null, 2));
  } else if (command === "get") {
    const id = requiredId(rest);
    printTest(id, await getTest(auth, id));
  } else if (command === "edit") {
    const [id, ...flags] = rest;
    if (id === undefined) usage();
    const { values } = parseArgs({
      args: flags,
      options: {
        name: { type: "string" },
        description: { type: "string" },
        scenario: { type: "string" },
        behavior: { type: "string", multiple: true },
        "persona": { type: "string", multiple: true },
      },
    });

    // Only the flags that were given are handed on, so what the edit does not
    // mention is what the factory keeps.
    const edited = await editTest(auth, id, {
      ...(values.name === undefined ? {} : { name: values.name }),
      ...(values.description === undefined
        ? {}
        : { description: values.description }),
      ...(values.scenario === undefined ? {} : { scenario: values.scenario }),
      ...(values.behavior === undefined
        ? {}
        : { expectedBehaviors: values.behavior }),
      ...(values["persona"] === undefined
        ? {}
        : { personaIds: values["persona"] }),
    });
    printTest(id, edited);
  } else if (command === "get-version") {
    const versionId = requiredId(rest);
    const found = await getTestVersion(auth, versionId);
    if (found === undefined) {
      console.error(`no version ${versionId} in the development project`);
      process.exit(1);
    }
    console.log(JSON.stringify(found, null, 2));
  } else if (command === "list") {
    const [suiteId, ...flags] = rest;
    if (suiteId === undefined) usage();
    const { values } = parseArgs({
      args: flags,
      options: {
        limit: { type: "string" },
        cursor: { type: "string" },
      },
    });
    const page = await listTests(auth, suiteId, {
      limit: values.limit === undefined ? undefined : Number(values.limit),
      cursor: values.cursor,
    });
    console.log(JSON.stringify(page, null, 2));
  } else if (command === "delete") {
    const id = requiredId(rest);
    const expectedVersionId = requiredId(rest.slice(1));
    const expectedRevision = requiredId(rest.slice(2));
    console.log(
      JSON.stringify(
        { deleted: await deleteTest(auth, id, expectedVersionId, expectedRevision) },
        null,
        2,
      ),
    );
  } else if (command === "create-suite") {
    const { values } = parseArgs({
      args: rest,
      options: { name: { type: "string" } },
    });
    if (values.name === undefined) usage();
    console.log(JSON.stringify(await createTestSuite(auth, { name: values.name }), null, 2));
  } else {
    usage();
  }
}

try {
  await main();
} finally {
  await disconnect();
}
