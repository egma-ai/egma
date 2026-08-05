import { parseArgs } from "node:util";

import { newId } from "@egma/ids";
import { eq } from "drizzle-orm";

import { connect, disconnect, db } from "../client.ts";
import {
  cloneTest,
  createTest,
  deleteTest,
  editTest,
  getTest,
  getTestVersion,
  listTests,
} from "../access/tests.ts";
import type { AuthContext } from "../access/context.ts";
import { projectsOf } from "../access/projects.ts";
import { provisionOrganization } from "../access/provisioning.ts";
import { runMigrations } from "../migrate.ts";
import { organization, user } from "../schema/index.ts";

/**
 * Drives the test factory from a terminal, until the real front door (the API)
 * exists. Signup does not reach a terminal yet either, so the script keeps one
 * development organization of its own — provisioned through the same front
 * door signup will use — and acts in it as its admin.
 *
 *   node packages/db/dist/scripts/test.js create \
 *     --name "Reschedules a booked appointment" \
 *     --scenario "Their cleaning is booked for Thursday and has to move…" \
 *     --behavior "verifies who it is speaking to first" \
 *     --behavior "confirms the new time back before finishing" \
 *     [--persona prs_…]
 *
 *   node packages/db/dist/scripts/test.js get tst_…
 *   node packages/db/dist/scripts/test.js edit tst_… --scenario "…"
 *   node packages/db/dist/scripts/test.js get-version tstv_…
 *   node packages/db/dist/scripts/test.js list [--limit 50] [--cursor tst_…]
 *   node packages/db/dist/scripts/test.js clone tst_…
 *   node packages/db/dist/scripts/test.js delete tst_…
 *
 * Naming no persona takes the project's default, which provisioning
 * seeds when it creates the development organization — so a create can leave
 * the flag out from the very first one.
 *
 * On an edit, a flag left out keeps what the test already says, so editing the
 * scenario alone is one flag. A `--behavior` or a `--persona` given at
 * all replaces the whole list, because the order is content.
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
      "  test.js create --name <name> --scenario <text>",
      "    --behavior <text> [--behavior <text> …]",
      "    [--description <text>] [--persona <prs_id> …]",
      "  test.js get <tst_id>",
      "  test.js edit <tst_id> [--name <name>] [--description <text>]",
      "    [--scenario <text>] [--behavior <text> …] [--persona <prs_id> …]",
      "  test.js get-version <tstv_id>",
      "  test.js list [--limit <n>] [--cursor <tst_id>]",
      "  test.js clone <tst_id>",
      "  test.js delete <tst_id>",
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

  const auth = await actAsDevelopmentTenant();

  if (command === "create") {
    const { values } = parseArgs({
      args: rest,
      options: {
        name: { type: "string" },
        description: { type: "string" },
        scenario: { type: "string" },
        // Repeatable, and the order they are given is the order they are kept.
        behavior: { type: "string", multiple: true },
        "persona": { type: "string", multiple: true },
      },
    });
    if (values.name === undefined || values.scenario === undefined) usage();

    const created = await createTest(auth, {
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
    const { values } = parseArgs({
      args: rest,
      options: {
        limit: { type: "string" },
        cursor: { type: "string" },
      },
    });
    const page = await listTests(auth, {
      limit: values.limit === undefined ? undefined : Number(values.limit),
      cursor: values.cursor,
    });
    console.log(JSON.stringify(page, null, 2));
  } else if (command === "clone") {
    const id = requiredId(rest);
    printTest(id, await cloneTest(auth, id));
  } else if (command === "delete") {
    const id = requiredId(rest);
    printTest(id, await deleteTest(auth, id));
  } else {
    usage();
  }
}

try {
  await main();
} finally {
  await disconnect();
}
