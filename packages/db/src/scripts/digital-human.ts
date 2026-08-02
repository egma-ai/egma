import { parseArgs } from "node:util";

import { newId } from "@egma/ids";
import { eq } from "drizzle-orm";

import { connect, disconnect, db } from "../client.ts";
import {
  createDigitalHuman,
  getDigitalHuman,
  VOICE_PROVIDERS,
  type VoiceProvider,
} from "../access/digital-humans.ts";
import type { AuthContext } from "../access/context.ts";
import { projectsOf } from "../access/projects.ts";
import { provisionOrganization } from "../access/provisioning.ts";
import { runMigrations } from "../migrate.ts";
import { organization, user } from "../schema/index.ts";

/**
 * Drives the digital-human factory from a terminal, until the real front door
 * (the API) exists. Signup does not reach a terminal yet either, so the script
 * keeps one development organization of its own — provisioned through the same
 * front door signup will use — and acts in it as its admin.
 *
 *   node packages/db/dist/scripts/digital-human.js create \
 *     --name "Impatient Rita" \
 *     --personality "70, hard of hearing, gets louder when mishears." \
 *     --voice-id EXAVITQu4vr4xnSDxMaL
 *
 *   node packages/db/dist/scripts/digital-human.js get dh_…
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
      "  digital-human.js create --name <name> --personality <text>",
      "    [--description <text>] [--language en-US]",
      `    [--voice-provider ${VOICE_PROVIDERS.join("|")}] [--voice-id <id>] [--speed 1.0]`,
      "  digital-human.js get <dh_id>",
    ].join("\n"),
  );
  process.exit(1);
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
        personality: { type: "string" },
        language: { type: "string", default: "en-US" },
        "voice-provider": { type: "string", default: "elevenlabs" },
        "voice-id": { type: "string", default: "EXAVITQu4vr4xnSDxMaL" },
        speed: { type: "string", default: "1.0" },
      },
    });
    if (values.name === undefined || values.personality === undefined) usage();

    const created = await createDigitalHuman(auth, {
      name: values.name,
      description: values.description,
      traits: {
        personality: values.personality,
        language: values.language,
        voice: {
          provider: values["voice-provider"] as VoiceProvider,
          voiceId: values["voice-id"],
          speed: Number(values.speed),
        },
      },
    });
    console.log(JSON.stringify(created, null, 2));
  } else if (command === "get") {
    const [id] = rest;
    if (id === undefined) usage();
    const found = await getDigitalHuman(auth, id);
    if (found === undefined) {
      console.error(`no digital human ${id} in the development project`);
      process.exit(1);
    }
    console.log(JSON.stringify(found, null, 2));
  } else {
    usage();
  }
}

try {
  await main();
} finally {
  await disconnect();
}
