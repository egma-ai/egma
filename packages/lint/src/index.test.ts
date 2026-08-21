import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { check, type RuleName } from "./index.ts";

/**
 * The rules are the enforcement mechanism, so these tests prove they fire.
 * A rule that has never been seen to fail is a comment.
 *
 * Each case builds a small tree on disk that looks like the repository and
 * checks it, rather than committing a fixture that imports a driver — which
 * would be a violation sitting in the repository, which is the thing being
 * forbidden.
 */

const REPOSITORY_ROOT = fileURLToPath(new URL("../../..", import.meta.url));

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "egma-lint-"));
  await writeFile(path.join(root, "pnpm-workspace.yaml"), "packages:\n  - '*'\n");
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function write(file: string, contents: string): Promise<void> {
  const full = path.join(root, file);
  await mkdir(path.dirname(full), { recursive: true });
  await writeFile(full, contents);
}

function rules(violations: readonly { rule: RuleName }[]): RuleName[] {
  return violations.map((violation) => violation.rule);
}

describe("a file outside the data-access module that imports the Postgres driver", () => {
  it("fails the build", async () => {
    await write("apps/web/app/page.tsx", 'import pg from "pg";\nexport default pg;\n');

    const violations = await check(root);

    expect(rules(violations)).toEqual([
      "no-datastore-driver-outside-the-data-access-module",
    ]);
    expect(violations[0]?.file).toBe("apps/web/app/page.tsx");
    expect(violations[0]?.line).toBe(1);
  });

  it("fails whichever way the driver is named", async () => {
    await write("apps/api/src/a.ts", 'import { Pool } from "pg";\nexport { Pool };\n');
    await write("apps/api/src/b.ts", 'const pg = require("pg");\n');
    await write("apps/api/src/c.ts", 'export { Pool } from "pg";\n');
    await write("apps/api/src/d.ts", 'await import("pg");\n');
    await write("apps/api/src/e.ts", 'import { drizzle } from "drizzle-orm/node-postgres";\nexport { drizzle };\n');
    await write("apps/api/src/f.ts", 'import postgres from "postgres";\nexport default postgres;\n');
    await write("apps/api/src/g.ts", 'import type pg from "pg";\nexport type X = typeof pg;\n');

    const violations = await check(root);

    expect(violations).toHaveLength(7);
    expect(new Set(rules(violations))).toEqual(
      new Set(["no-datastore-driver-outside-the-data-access-module"]),
    );
  });

  it("fails for the ClickHouse driver too, before ClickHouse exists", async () => {
    await write(
      "apps/web/app/results/page.tsx",
      'import { createClient } from "@clickhouse/client";\nexport default createClient;\n',
    );

    expect(rules(await check(root))).toEqual([
      "no-datastore-driver-outside-the-data-access-module",
    ]);
  });

  it("does not fire on a mention of the driver that is not an import", async () => {
    await write(
      "apps/api/src/a.ts",
      '// never import pg here\nexport const note = \'import pg from "pg"\';\n',
    );

    expect(await check(root)).toEqual([]);
  });

  it("does not fire inside a directory holding its own repository", async () => {
    await write("vendored/thing/src/a.ts", 'import pg from "pg";\nexport default pg;\n');
    await write("vendored/thing/.git/HEAD", "ref: refs/heads/main\n");

    expect(await check(root)).toEqual([]);
  });

  it("does not fire on the schema DSL, which is not a driver", async () => {
    await write(
      "apps/api/src/a.ts",
      'import { pgTable } from "drizzle-orm/pg-core";\nexport { pgTable };\n',
    );

    expect(await check(root)).toEqual([]);
  });
});

describe("the data-access module itself", () => {
  it("may hold the driver, because that is the whole point of it", async () => {
    await write("packages/db/src/client.ts", 'import pg from "pg";\nexport default pg;\n');

    expect(await check(root)).toEqual([]);
  });

  it("lets a named test bypass it, because seam three exists to bypass it", async () => {
    await write(
      "packages/db/test/support/database.ts",
      'import pg from "pg";\nexport default pg;\n',
    );

    expect(await check(root)).toEqual([]);
  });

  it("does not let an unnamed test bypass it", async () => {
    await write(
      "packages/db/test/convenient.test.ts",
      'import pg from "pg";\nexport default pg;\n',
    );

    expect(rules(await check(root))).toEqual([
      "no-datastore-driver-outside-the-data-access-module",
    ]);
  });
});

describe("a file outside the module reaching past its entry point", () => {
  it("fails on a deep import of the package", async () => {
    await write(
      "apps/api/src/server.ts",
      'import { db } from "@egma/db/dist/client.js";\nexport { db };\n',
    );

    expect(rules(await check(root))).toEqual([
      "no-reaching-into-the-data-access-module",
    ]);
  });

  it("fails on a relative path into the module", async () => {
    await write(
      "apps/api/src/server.ts",
      'import { db } from "../../../packages/db/src/client.ts";\nexport { db };\n',
    );

    expect(rules(await check(root))).toEqual([
      "no-reaching-into-the-data-access-module",
    ]);
  });

  it("allows the entry point", async () => {
    await write(
      "apps/api/src/server.ts",
      'import { ping } from "@egma/db";\nexport { ping };\n',
    );

    expect(await check(root)).toEqual([]);
  });
});

describe("a second place reading a membership row", () => {
  it("fails the build, because the resolver is the reversibility condition", async () => {
    await write(
      "packages/db/src/access/somewhere-else.ts",
      'import { membership } from "../schema/tenancy.ts";\nexport { membership };\n',
    );

    expect(rules(await check(root))).toEqual(["one-place-reads-a-membership"]);
  });

  it("fails when it is reached through a namespace import", async () => {
    await write(
      "packages/db/src/access/somewhere-else.ts",
      'import * as schema from "../schema/index.ts";\nexport const t = schema.membership;\n',
    );

    expect(rules(await check(root))).toEqual(["one-place-reads-a-membership"]);
  });

  it("does not fire on the resolver", async () => {
    await write(
      "packages/db/src/access/memberships.ts",
      'import { membership } from "../schema/tenancy.ts";\nexport { membership };\n',
    );

    expect(await check(root)).toEqual([]);
  });

  it("does not fire on another table", async () => {
    await write(
      "packages/db/src/access/projects.ts",
      'import { project } from "../schema/tenancy.ts";\nexport { project };\n',
    );

    expect(await check(root)).toEqual([]);
  });
});

describe("an exported call that could reach the database without a customer", () => {
  async function withSurface(
    exports: string,
    declarations: string,
  ): Promise<void> {
    await write("packages/db/src/access/index.ts", exports);
    await write("packages/db/src/access/things.ts", declarations);
  }

  it("fails the build when it takes no auth context", async () => {
    await withSurface(
      'export { listThings } from "./things.ts";\n',
      "export async function listThings(\n  organizationId: string,\n): Promise<string[]> {\n  return [organizationId];\n}\n",
    );

    expect(rules(await check(root))).toEqual([
      "every-exported-call-carries-an-auth-context",
    ]);
  });

  it("fails the build when it takes the auth context second", async () => {
    await withSurface(
      'export { listThings } from "./things.ts";\n',
      "import type { AuthContext } from './context.ts';\nexport async function listThings(\n  projectId: string,\n  auth: AuthContext,\n): Promise<string[]> {\n  return [projectId, auth.userId];\n}\n",
    );

    expect(rules(await check(root))).toEqual([
      "every-exported-call-carries-an-auth-context",
    ]);
  });

  it("fails the build when it lets the caller supply a predicate", async () => {
    await withSurface(
      'export { listThings } from "./things.ts";\n',
      "import type { SQL } from 'drizzle-orm';\nimport type { AuthContext } from './context.ts';\nexport async function listThings(\n  auth: AuthContext,\n  where: SQL,\n): Promise<string[]> {\n  return [auth.userId, String(where)];\n}\n",
    );

    expect(rules(await check(root))).toEqual([
      "every-exported-call-carries-an-auth-context",
    ]);
  });

  it("passes when it takes the auth context first and nothing else it could widen", async () => {
    await withSurface(
      'export { listThings } from "./things.ts";\n',
      "import type { AuthContext } from './context.ts';\nexport async function listThings(\n  auth: AuthContext,\n): Promise<string[]> {\n  return [auth.userId];\n}\n",
    );

    expect(await check(root)).toEqual([]);
  });

  /**
   * The list is closed, and the counter-example is a name that could never
   * belong on it: reading *any* organization is the one thing the whole
   * boundary exists to make unreachable. `resolveApiKey` stood here until the
   * device flow needed it, at which point the rule did its job — it stopped the
   * build, somebody decided, and the name moved into the list on purpose.
   */
  it("allows exactly the exports that produce a context, and no other", async () => {
    await withSurface(
      'export { membershipsOf, projectsOf, provisionOrganization, resolveApiKey, resolveDeviceAuthorization, readAnyOrganization } from "./things.ts";\n',
      "export async function membershipsOf(userId: string): Promise<string[]> {\n  return [userId];\n}\nexport async function projectsOf(organizationId: string): Promise<string[]> {\n  return [organizationId];\n}\nexport async function provisionOrganization(name: string): Promise<string> {\n  return name;\n}\nexport async function resolveApiKey(hash: string): Promise<string> {\n  return hash;\n}\nexport async function resolveDeviceAuthorization(deviceCode: string): Promise<string> {\n  return deviceCode;\n}\nexport async function readAnyOrganization(organizationId: string): Promise<string> {\n  return organizationId;\n}\n",
    );

    const violations = await check(root);
    expect(rules(violations)).toEqual([
      "every-exported-call-carries-an-auth-context",
    ]);
    expect(violations[0]?.detail).toContain("readAnyOrganization");
  });

  it("allows a question about the deployment, which has no customer to name", async () => {
    await withSurface(
      'export { instanceIsClaimed } from "./things.ts";\n',
      "export async function instanceIsClaimed(): Promise<boolean> {\n  return true;\n}\n",
    );

    expect(await check(root)).toEqual([]);
  });

  it("refuses that exemption the moment it grows an argument", async () => {
    await withSurface(
      'export { instanceIsClaimed } from "./things.ts";\n',
      "export async function instanceIsClaimed(organizationId: string): Promise<boolean> {\n  return organizationId !== '';\n}\n",
    );

    const violations = await check(root);
    expect(rules(violations)).toEqual([
      "every-exported-call-carries-an-auth-context",
    ]);
    expect(violations[0]?.detail).toContain("wearing an exemption");
  });

  it("refuses the instance exception when its result grows wider", async () => {
    await withSurface(
      'export { instanceIsClaimed } from "./things.ts";\n',
      "export async function instanceIsClaimed(): Promise<string> {\n  return 'all organizations';\n}\n",
    );

    const violations = await check(root);
    expect(rules(violations)).toEqual([
      "every-exported-call-carries-an-auth-context",
    ]);
    expect(violations[0]?.detail).toContain("instanceIsClaimed");
  });

  /**
   * The widening that a pin on the *name* would have missed, which is the whole
   * reason the pin carries the alias's body.
   *
   * `platformFacts` answers what this deployment was configured with, at the
   * one door that asks for no credential, and what keeps that safe is the shape
   * behind the name: non-secret values, with every secret reduced to null. A
   * rule comparing `Promise<PlatformFacts>` as text would stay green while
   * somebody put a key's hint — or a key — inside it, so the alias declared
   * beside the function is pinned with it.
   */
  it("refuses an instance exception whose answer is widened behind its own name", async () => {
    // Only the *value* is widened, and the keys beside it are left exactly as
    // they were. That is the leak this pin exists to catch, isolated: the
    // secret a caller may be handed lives in the value, and it is written
    // inside the pinned alias's own body.
    const widened =
      "export type PlatformSettingName = 'persona_model';\n" +
      "export type PlatformFacts = Readonly<Partial<Record<PlatformSettingName, { value: string | null; hint: string }>>>;\n" +
      "export async function platformFacts(): Promise<PlatformFacts> {\n  return {};\n}\n";
    await withSurface(
      'export { platformFacts } from "./things.ts";\n',
      widened,
    );

    const violations = await check(root);
    expect(rules(violations)).toEqual([
      "every-exported-call-carries-an-auth-context",
    ]);
    expect(violations[0]?.detail).toContain("PlatformFacts");
    expect(violations[0]?.detail).toContain("wearing an exemption");
  });

  it("passes the same exception while its answer is the shape that was pinned", async () => {
    const pinned =
      "export type PlatformSettingName = 'persona_model';\n" +
      "export type PlatformFacts = Readonly<Partial<Record<PlatformSettingName, string | null>>>;\n" +
      "export async function platformFacts(): Promise<PlatformFacts> {\n  return {};\n}\n";
    await withSurface('export { platformFacts } from "./things.ts";\n', pinned);

    // **One level, and `PlatformSettingName` is deliberately not one of them.**
    // The walk collects the aliases named in the *signature* — here
    // `PlatformFacts` — and appends their declarations; it does not recurse
    // into what those declarations then name. That is the point rather than a
    // gap: the settings this platform holds are meant to grow, one per ticket
    // of this effort, and a pin that followed their names would stop the build
    // on every setting added. What may never grow is the *value* beside them,
    // and that is written inside the body this pin does carry — the test above
    // widens exactly that and is refused.
    expect(await check(root)).toEqual([]);
  });

  /**
   * The engine's own work, which is the one thing on this surface that
   * legitimately spans customers: the grader service holds no credential
   * because there is nobody for it to be, so it is handed work instead. What
   * keeps that from being a hole is that nothing in it can be *asked* about a
   * customer, and that is the half of the reasoning a rule can hold.
   */
  it("allows the two calls that dispatch egma's own work across the deployment", async () => {
    await withSurface(
      'export { claimGradingJobs, watchGradingWork } from "./things.ts";\n',
      "export type GradingClaimRequest = { readonly claimant: string; readonly capacity: number };\nexport async function claimGradingJobs(request: GradingClaimRequest): Promise<string[]> {\n  return [request.claimant];\n}\nexport async function watchGradingWork(onWork: () => void): Promise<void> {\n  onWork();\n}\n",
    );

    expect(await check(root)).toEqual([]);
  });

  it("allows the hosted deployment to reconcile its own carrier route", async () => {
    await withSurface(
      'export { reconcileDeploymentCarrierSettings } from "./things.ts";\n',
      "export type PlatformSettingValues = Readonly<Record<string, string>>;\nexport async function reconcileDeploymentCarrierSettings(values: PlatformSettingValues): Promise<readonly string[]> {\n  return Object.keys(values);\n}\n",
    );

    expect(await check(root)).toEqual([]);
  });

  it("refuses the carrier reconciliation exemption if it can name a customer", async () => {
    await withSurface(
      'export { reconcileDeploymentCarrierSettings } from "./things.ts";\n',
      "export async function reconcileDeploymentCarrierSettings(organizationId: string): Promise<readonly string[]> {\n  return [organizationId];\n}\n",
    );

    const violations = await check(root);
    expect(rules(violations)).toEqual([
      "every-exported-call-carries-an-auth-context",
    ]);
    expect(violations[0]?.detail).toContain("wearing an exemption");
  });

  it("refuses one of them the moment a caller can name a customer to it", async () => {
    await withSurface(
      'export { claimGradingJobs } from "./things.ts";\n',
      "export async function claimGradingJobs(claimant: string, organizationId: string): Promise<string[]> {\n  return [claimant, organizationId];\n}\n",
    );

    const violations = await check(root);
    expect(rules(violations)).toEqual([
      "every-exported-call-carries-an-auth-context",
    ]);
    expect(violations[0]?.detail).toContain("wearing an exemption");
  });

  it("sees a customer named inside the shape a parameter points at", async () => {
    await withSurface(
      'export { claimGradingJobs } from "./things.ts";\n',
      "export type GradingClaimRequest = { readonly claimant: string; readonly projectId: string };\nexport async function claimGradingJobs(request: GradingClaimRequest): Promise<string[]> {\n  return [request.claimant];\n}\n",
    );

    const violations = await check(root);
    expect(rules(violations)).toEqual([
      "every-exported-call-carries-an-auth-context",
    ]);
  });

  it("says nothing about what the module keeps to itself", async () => {
    await write("packages/db/src/access/index.ts", "export {} from './things.ts';\n");
    await write(
      "packages/db/src/access/things.ts",
      "export function insertThing(on: unknown): unknown {\n  return on;\n}\n",
    );

    expect(await check(root)).toEqual([]);
  });
});

describe("a file naming the auth provider", () => {
  it("fails the build, because a swap must not have to reach past the seam", async () => {
    await write(
      "apps/api/src/routes/things.ts",
      'import { betterAuth } from "better-auth";\nexport { betterAuth };\n',
    );

    const violations = await check(root);
    expect(rules(violations)).toEqual(["only-the-seam-knows-the-auth-provider"]);
    expect(violations[0]?.detail).toContain("better-auth");
  });

  it("fails on a deep import of it, and on its core package", async () => {
    await write(
      "apps/web/app/page.tsx",
      'import { APIError } from "better-auth/api";\nexport { APIError };\n',
    );
    await write(
      "apps/api/src/auth/session.ts",
      'import type { Session } from "@better-auth/core";\nexport type S = Session;\n',
    );

    expect(rules(await check(root))).toEqual([
      "only-the-seam-knows-the-auth-provider",
      "only-the-seam-knows-the-auth-provider",
    ]);
  });

  it("allows the file that implements the seam, and the one that binds the tables", async () => {
    await write(
      "apps/api/src/auth/better-auth.ts",
      'import { betterAuth } from "better-auth";\nexport { betterAuth };\n',
    );
    await write(
      "packages/db/src/identity-store.ts",
      'import { drizzleAdapter } from "better-auth/adapters/drizzle";\nexport { drizzleAdapter };\n',
    );

    expect(await check(root)).toEqual([]);
  });
});

describe("this repository", () => {
  it("has no violations, so the rules are live rather than aspirational", async () => {
    expect(await check(REPOSITORY_ROOT)).toEqual([]);
  });

  it("runs the rules as part of the build, not only as part of the tests", async () => {
    const manifest: { scripts?: Record<string, string> } = JSON.parse(
      await readFile(path.join(REPOSITORY_ROOT, "package.json"), "utf8"),
    );

    expect(manifest.scripts?.lint).toBeDefined();
    expect(manifest.scripts?.build).toContain("lint");
  });
});

/**
 * A package this repository publishes may not import one it never publishes.
 *
 * `apps/cli` ships its source compiled rather than bundled, so an import
 * written in `src` is still an import in the file `npx @egma/cli` runs. A
 * `private: true` workspace package is not on npm for it to resolve, so the
 * command installs, starts, and fails at the first line that needs it.
 *
 * This shipped once and the build caught it — but only because nothing had
 * built that package first, so the module was missing at build time too. The
 * natural repair for *that* error is to add a project reference, which makes
 * the build pass and ships the crash. Hence a rule rather than a memory.
 */
describe("a published package importing one that is never published", () => {
  async function workspace(): Promise<void> {
    // The roots this repository actually declares. The rule reads them from
    // here rather than holding a list of its own, which is the whole point:
    // the first version named `packages` and `apps` and missed `fixtures` and
    // `sdks`, where two private packages live.
    await write(
      "pnpm-workspace.yaml",
      "packages:\n  - 'apps/*'\n  - 'fixtures/*'\n  - 'packages/*'\n  - 'sdks/*'\n",
    );
    await write(
      "packages/ids/package.json",
      JSON.stringify({ name: "@egma/ids", private: true }),
    );
    await write(
      "packages/wire/package.json",
      JSON.stringify({ name: "@egma/wire", version: "1.2.3" }),
    );
    await write(
      "fixtures/dumb-agent/package.json",
      JSON.stringify({ name: "@egma/dumb-agent", private: true }),
    );
  }

  it("fails the build, and says what the reader would otherwise find out from a user", async () => {
    await workspace();
    await write(
      "apps/cli/src/platform/runs.ts",
      'import { newId } from "@egma/ids";\nexport const key = newId("run");\n',
    );

    const violations = await check(root);

    expect(rules(violations)).toEqual(["no-private-package-in-a-published-one"]);
    expect(violations[0]?.file).toBe("apps/cli/src/platform/runs.ts");
    expect(violations[0]?.detail).toContain("never publishes");
  });

  it("catches a deep import of the same package", async () => {
    await workspace();
    await write(
      "apps/cli/src/a.ts",
      'import { newId } from "@egma/ids/mint.ts";\nexport { newId };\n',
    );

    expect(rules(await check(root))).toEqual([
      "no-private-package-in-a-published-one",
    ]);
  });

  it("finds a private package under a root the first version of this rule missed", async () => {
    await workspace();
    await write(
      "apps/cli/src/a.ts",
      'import { serve } from "@egma/dumb-agent";\nexport { serve };\n',
    );

    expect(rules(await check(root))).toEqual([
      "no-private-package-in-a-published-one",
    ]);
  });

  it("allows a workspace package that is published", async () => {
    await workspace();
    await write(
      "apps/cli/src/a.ts",
      'import { ask } from "@egma/wire";\nexport { ask };\n',
    );

    expect(rules(await check(root))).toEqual([]);
  });

  it("allows a private workspace package bundled into the published tarball", async () => {
    await workspace();
    await write(
      "apps/cli/package.json",
      JSON.stringify({ bundledDependencies: ["@egma/ids"] }),
    );
    await write(
      "apps/cli/src/a.ts",
      'import { newId } from "@egma/ids";\nexport { newId };\n',
    );

    expect(rules(await check(root))).toEqual([]);
  });

  it("leaves the private package alone everywhere this repository runs its own code", async () => {
    await workspace();
    // The API and the tests are this repository's own, installed from this
    // repository. Only what is published has to stand on its own.
    await write("apps/api/src/a.ts", 'import { newId } from "@egma/ids";\nexport { newId };\n');
    await write(
      "apps/cli/test/a.test.ts",
      'import { newId } from "@egma/ids";\nexport { newId };\n',
    );

    expect(rules(await check(root))).toEqual([]);
  });
});
