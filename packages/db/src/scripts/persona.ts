import { parseArgs } from "node:util";

import { newId } from "@egma/ids";
import { eq } from "drizzle-orm";

import { connect, disconnect, db } from "../client.ts";
import {
  archivePersona,
  createPersona,
  editPersona,
  forkPersona,
  getPersona,
  getPersonaVersion,
  listPersonas,
  restorePersona,
} from "../access/personas.ts";
import { seedPersonaLibrary } from "../persona-library/seed.ts";
import type { AuthContext } from "../access/context.ts";
import { projectsOf } from "../access/projects.ts";
import { seedGraderLibrary } from "../access/grader-library.ts";
import { provisionOrganization } from "../access/provisioning.ts";
import { runMigrations } from "../migrate.ts";
import { organization, user } from "../schema/index.ts";

/**
 * Drives the persona factory from a terminal, until the real front door
 * (the API) exists. Signup does not reach a terminal yet either, so the script
 * keeps one development organization of its own — provisioned through the same
 * front door signup will use — and acts in it as its admin.
 *
 *   node packages/db/dist/scripts/persona.js create \
 *     --name "Impatient Rita" \
 *     --personality "70, hard of hearing, gets louder when mishears."
 *
 *   node packages/db/dist/scripts/persona.js get prs_…
 *   node packages/db/dist/scripts/persona.js list [--limit 50] [--cursor prs_…]
 *   node packages/db/dist/scripts/persona.js fork prs_…
 *   node packages/db/dist/scripts/persona.js archive prs_… [--replacement prs_…]
 *   node packages/db/dist/scripts/persona.js restore prs_…
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
      "  persona.js create --name <name> --personality <text> --language <tag>",
      "    [--description <text>]",
      "  persona.js get <prs_id>",
      "  persona.js edit <prs_id> [--name <name>] [--description <text>]",
      "    [--personality <text>] [--language <tag>]",
      "  persona.js get-version <prsv_id>",
      "  persona.js list [--limit <n>] [--cursor <prs_id>]",
      "  persona.js fork <prs_id>",
      "  persona.js archive <prs_id> [--replacement <prs_id>]",
      "  persona.js restore <prs_id>",
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
function printPersona(id: string, found: unknown): void {
  if (found === undefined) {
    console.error(`no persona ${id} in the development project`);
    process.exit(1);
  }
  console.log(JSON.stringify(found, null, 2));
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);

  await runMigrations(DATABASE_URL);
  connect({ databaseUrl: DATABASE_URL, maxConnections: 2 });
  await seedPersonaLibrary();
  // egma's own graders, on the shelf before a project can be created — every
  // project is born holding a copy of one, and the pointer is a foreign key.
  await seedGraderLibrary();

  const auth = await actAsDevelopmentTenant();

  if (command === "create") {
    const { values } = parseArgs({
      args: rest,
      options: {
        name: { type: "string" },
        description: { type: "string" },
        personality: { type: "string" },
        language: { type: "string" },
      },
    });
    if (
      values.name === undefined ||
      values.personality === undefined ||
      values.language === undefined
    ) {
      usage();
    }

    const created = await createPersona(auth, {
      name: values.name,
      description: values.description,
      traits: {
        personality: values.personality,
        language: values.language,
      },
    });
    console.log(JSON.stringify(created, null, 2));
  } else if (command === "get") {
    const id = requiredId(rest);
    printPersona(id, await getPersona(auth, id));
  } else if (command === "edit") {
    const [id, ...flags] = rest;
    if (id === undefined) usage();
    const { values } = parseArgs({
      args: flags,
      options: {
        name: { type: "string" },
        description: { type: "string" },
        personality: { type: "string" },
        language: { type: "string" },
      },
    });

    const current = await getPersona(auth, id);
    if (current === undefined) {
      printPersona(id, current);
      return;
    }
    const traitsChanged =
      values.personality !== undefined || values.language !== undefined;

    const edited = await editPersona(auth, id, {
      ...(values.name === undefined ? {} : { name: values.name }),
      ...(values.description === undefined
        ? {}
        : { description: values.description }),
      ...(traitsChanged
        ? {
            traits: {
              ...current.traits,
              ...(values.personality === undefined
                ? {}
                : { personality: values.personality }),
              ...(values.language === undefined
                ? {}
                : { language: values.language }),
            },
          }
        : {}),
    });
    printPersona(id, edited);
  } else if (command === "get-version") {
    const versionId = requiredId(rest);
    const found = await getPersonaVersion(auth, versionId);
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
    const page = await listPersonas(auth, {
      limit: values.limit === undefined ? undefined : Number(values.limit),
      cursor: values.cursor,
    });
    console.log(JSON.stringify(page, null, 2));
  } else if (command === "fork" || command === "clone") {
    const id = requiredId(rest);
    printPersona(id, await forkPersona(auth, id));
  } else if (command === "archive") {
    const [id, ...flags] = rest;
    if (id === undefined) usage();
    const { values } = parseArgs({
      args: flags,
      options: { replacement: { type: "string" } },
    });
    printPersona(
      id,
      await archivePersona(auth, id, {
        ...(values.replacement === undefined
          ? {}
          : { replacementPersonaId: values.replacement }),
      }),
    );
  } else if (command === "restore") {
    const id = requiredId(rest);
    printPersona(id, await restorePersona(auth, id));
  } else {
    usage();
  }
}

try {
  await main();
} finally {
  await disconnect();
}
