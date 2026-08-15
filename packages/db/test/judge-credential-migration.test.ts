import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { newId } from "@egma/ids";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { readMigrations, runMigrations } from "../src/migrate.ts";
import {
  createEmptyDatabase,
  openSingleConnection,
  type EmptyDatabase,
  type SingleConnection,
} from "./support/database.ts";

/**
 * Judge keys moving from the project onto the organization (0026), applied over
 * rows the release before it wrote.
 *
 * **The claim: distinct secrets stay distinct.** Two projects of one
 * organization configured with two different keys come out of this migration
 * holding two credentials, not one — because merging them would silently start
 * billing one team's account for the other team's grading, and nothing in a
 * migration could tell that the two keys were meant to be the same. It is the
 * kind of thing that is invisible afterwards: the rows still read as configured
 * and grading still works, and a customer only finds out on an invoice.
 *
 * **And the order.** A credential exists before any project points at one, and
 * a project's own envelope is dropped in the same statement that writes its
 * reference — so there is no instant at which a configuration names neither its
 * key nor a credential holding it.
 *
 * The envelope is moved rather than re-sealed, so every existing configuration
 * keeps judging without anything opening a secret to upgrade. The ciphertexts
 * are compared byte for byte here for exactly that reason.
 */

describe("judge keys moving to the organization (0026)", () => {
  let database: EmptyDatabase;
  /** The migration files, up to 0026's predecessor, as that release shipped. */
  let asItWas: string;
  let client: SingleConnection;

  const acme = {
    organization: newId("org"),
    outbound: newId("prj"),
    support: newId("prj"),
  };
  const globex = { organization: newId("org"), project: newId("prj") };

  /**
   * Two keys sealed exactly as the release before wrote them. The values do not
   * have to open — nothing in the migration opens one, which is the property
   * being asserted — so they are recognisable strings rather than real
   * envelopes.
   */
  const OUTBOUND_ENVELOPE = "v1.outbound-iv.outbound-ciphertext.outbound-tag";
  const SUPPORT_ENVELOPE = "v1.support-iv.support-ciphertext.support-tag";
  const GLOBEX_ENVELOPE = "v1.globex-iv.globex-ciphertext.globex-tag";

  beforeAll(async () => {
    database = await createEmptyDatabase("judge_credential_upgrade");
    asItWas = await mkdtemp(path.join(os.tmpdir(), "egma-judge-upgrade-"));
  });

  afterAll(async () => {
    await client?.close();
    await database.drop();
    await rm(asItWas, { recursive: true, force: true });
  });

  it("gives every existing configuration its own credential, and merges no two keys", async () => {
    const migrations = await readMigrations();
    const subject = migrations.findIndex((migration) =>
      migration.name.startsWith("0026_"),
    );
    if (subject === -1) throw new Error("0026 is missing");
    const before = migrations.slice(0, subject);

    for (const migration of before) {
      await writeFile(path.join(asItWas, migration.name), migration.sql);
    }
    const applied = await runMigrations(database.url, asItWas);
    expect(applied.applied).toEqual(before.map((migration) => migration.name));

    client = await openSingleConnection(database.url);

    // A customer's work as the release before this one wrote it: two projects
    // in one organization, each with a judge key of its own, and a second
    // organization with a third.
    for (const [organization, name] of [
      [acme.organization, "Acme"],
      [globex.organization, "Globex"],
    ]) {
      await client.sql(
        "insert into organization (id, name, slug) values ($1, $2, $3)",
        [organization, name, String(name).toLowerCase()],
      );
    }
    for (const [id, organization, slug] of [
      [acme.outbound, acme.organization, "outbound"],
      [acme.support, acme.organization, "support"],
      [globex.project, globex.organization, "default"],
    ]) {
      await client.sql(
        "insert into project (id, organization_id, name, slug) values ($1, $2, $3, $4)",
        [id, organization, slug, slug],
      );
    }
    for (const [project, organization, envelope, hint] of [
      [acme.outbound, acme.organization, OUTBOUND_ENVELOPE, "AAAA"],
      [acme.support, acme.organization, SUPPORT_ENVELOPE, "BBBB"],
      [globex.project, globex.organization, GLOBEX_ENVELOPE, "CCCC"],
    ]) {
      await client.sql(
        `insert into judge_configuration
           (project_id, organization_id, provider, model, credentials, credentials_hint)
         values ($1, $2, 'openai', 'gpt-4o', $3, $4)`,
        [project, organization, envelope, hint],
      );
    }

    // Then the upgrade.
    const upgraded = await runMigrations(database.url);
    expect(upgraded.applied).toEqual([migrations[subject]?.name]);

    const { rows: credentials } = await client.sql<{
      id: string;
      organization_id: string;
      label: string;
      provider: string;
      credentials: string;
      credentials_hint: string;
      revision: string;
    }>("select * from judge_credential order by label");

    // Three configurations, three credentials. Never two projects sharing one.
    expect(credentials).toHaveLength(3);
    expect(credentials.map((row) => row.credentials).sort()).toEqual(
      [OUTBOUND_ENVELOPE, SUPPORT_ENVELOPE, GLOBEX_ENVELOPE].sort(),
    );
    // Labelled from the project each key was configured for, so an organization
    // holding several can tell which is which by more than four characters.
    expect(credentials.map((row) => row.label)).toEqual([
      "default judge key",
      "outbound judge key",
      "support judge key",
    ]);
    // And each stays inside the organization it was configured in.
    const globexCredential = credentials.find(
      (row) => row.credentials === GLOBEX_ENVELOPE,
    );
    expect(globexCredential?.organization_id).toBe(globex.organization);
    for (const row of credentials) {
      expect(row.provider).toBe("openai");
      expect(row.revision).toMatch(/^rev_[0-9A-HJKMNP-TV-Z]{26}$/);
      expect(row.id).toMatch(/^jcr_[0-9A-HJKMNP-TV-Z]{26}$/);
    }
  });

  it("points each project at its own credential and leaves it holding no secret", async () => {
    const { rows } = await client.sql<{
      project_id: string;
      source: string;
      credential_id: string | null;
      credentials: string | null;
      credentials_hint: string | null;
      envelope: string;
    }>(
      `select jc.project_id, jc.source, jc.credential_id, jc.credentials,
              jc.credentials_hint, c.credentials as envelope
         from judge_configuration jc
         join judge_credential c on c.id = jc.credential_id
        order by jc.project_id`,
    );

    expect(rows).toHaveLength(3);

    const byProject = new Map(rows.map((row) => [row.project_id, row]));
    expect(byProject.get(acme.outbound)?.envelope).toBe(OUTBOUND_ENVELOPE);
    expect(byProject.get(acme.support)?.envelope).toBe(SUPPORT_ENVELOPE);
    expect(byProject.get(globex.project)?.envelope).toBe(GLOBEX_ENVELOPE);

    // Two projects of one organization, two different credentials.
    expect(byProject.get(acme.outbound)?.credential_id).not.toBe(
      byProject.get(acme.support)?.credential_id,
    );

    for (const row of rows) {
      expect(row.source).toBe("credential");
      // The project holds a reference and no copy of the secret at all.
      expect(row.credentials).toBeNull();
      expect(row.credentials_hint).toBeNull();
    }
  });

  /**
   * The constraint that makes the arrangement hold afterwards, rather than
   * depending on whoever writes the next row: exactly one place a key can come
   * from. A `credential` setting that also carried an envelope would be two
   * secrets with no rule saying which is spent.
   */
  it("refuses a configuration that would hold both a credential and an envelope", async () => {
    await expect(
      client.sql(
        "update judge_configuration set credentials = $1 where project_id = $2",
        [OUTBOUND_ENVELOPE, acme.outbound],
      ),
    ).rejects.toThrow(/judge_configuration_has_one_key_source/);
  });

  it("refuses a platform configuration that names a credential", async () => {
    await expect(
      client.sql(
        "update judge_configuration set source = 'platform' where project_id = $1",
        [acme.outbound],
      ),
    ).rejects.toThrow(/judge_configuration_has_one_key_source/);
  });
});
