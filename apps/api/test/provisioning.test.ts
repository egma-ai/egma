import { newId } from "@egma/ids";
import { afterEach, describe, expect, it } from "vitest";

import {
  admitIdentity,
  AlreadyInAnOrganizationError,
  onIdentityCreated,
} from "../src/auth/provisioning.ts";
import { SignupClosedError } from "../src/auth/seam.ts";
import { createApi, type TestApi } from "./support/api.ts";

/**
 * The hooks, driven directly.
 *
 * They are registered with the provider rather than called by Egma, which is
 * what keeps signup from being a provider method. Reaching them without the
 * provider in the way is how the branches that a signup form cannot produce get
 * covered: an identity created some other way, and an identity that already
 * belongs somewhere.
 */

let api: TestApi;

afterEach(async () => {
  await api?.close();
});

async function anIdentity(email: string): Promise<string> {
  const userId = newId("usr");
  await api.database.sql('insert into "user" (id, email) values ($1, $2)', [
    userId,
    email,
  ]);
  return userId;
}

describe("an identity created without Egma's signup page", () => {
  it("still lands in an organization, named from its email domain", async () => {
    api = await createApi("hook_defaults");
    const userId = await anIdentity("ada@acme.example");

    await onIdentityCreated()(
      { externalIdentityId: userId, email: "ada@acme.example" },
      undefined,
    );

    const { rows } = await api.database.sql<{ name: string; slug: string }>(
      "select name, slug from organization",
    );
    expect(rows).toEqual([{ name: "Acme", slug: "acme" }]);

    const { rows: projects } = await api.database.sql<{ name: string }>(
      "select name from project",
    );
    expect(projects).toEqual([{ name: "Default" }]);
  });

  it("uses the names it was given when it was given some", async () => {
    api = await createApi("hook_intent");
    const userId = await anIdentity("ada@acme.example");

    await onIdentityCreated()(
      { externalIdentityId: userId, email: "ada@acme.example" },
      {
        kind: "new_organization",
        organizationName: "Acme Robotics",
        projectName: "Outbound",
      },
    );

    const { rows } = await api.database.sql<{ name: string; slug: string }>(
      "select name, slug from organization",
    );
    expect(rows).toEqual([{ name: "Acme Robotics", slug: "acme-robotics" }]);
  });
});

describe("an identity that already belongs somewhere", () => {
  it("is refused rather than given a second organization", async () => {
    api = await createApi("hook_second");
    const userId = await anIdentity("ada@acme.example");
    const identity = { externalIdentityId: userId, email: "ada@acme.example" };

    await onIdentityCreated()(identity, undefined);

    // One organization per person in v1. The membership is the last write in
    // the transaction, so the refusal takes the organization and the project
    // with it, and this is told apart from a name collision by which
    // constraint broke — otherwise it would retry five names and report the
    // wrong thing.
    await expect(onIdentityCreated()(identity, undefined)).rejects.toBeInstanceOf(
      AlreadyInAnOrganizationError,
    );

    for (const table of ["organization", "project", "membership"]) {
      const { rows } = await api.database.sql<{ count: string }>(
        `select count(*) as count from ${table}`,
      );
      expect(rows[0]?.count, table).toBe("1");
    }
  });
});

describe("who may sign up", () => {
  it("is anybody, on a deployment that holds many customers", async () => {
    api = await createApi("hook_open");
    const userId = await anIdentity("ada@acme.example");
    await onIdentityCreated()(
      { externalIdentityId: userId, email: "ada@acme.example" },
      undefined,
    );

    await expect(
      admitIdentity(false)("grace@globex.example", undefined),
    ).resolves.toBeUndefined();
  });

  it("is the first person only, on a deployment that holds one", async () => {
    api = await createApi("hook_claimed");

    await expect(
      admitIdentity(true)("ada@acme.example", undefined),
    ).resolves.toBeUndefined();

    const userId = await anIdentity("ada@acme.example");
    await onIdentityCreated()(
      { externalIdentityId: userId, email: "ada@acme.example" },
      undefined,
    );

    await expect(
      admitIdentity(true)("grace@globex.example", undefined),
    ).rejects.toBeInstanceOf(SignupClosedError);
  });
});
