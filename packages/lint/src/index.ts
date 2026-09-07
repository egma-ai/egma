import { access, readdir, readFile } from "node:fs/promises";
import path from "node:path";

import ts from "typescript";

/**
 * Build-time rules that hold the data-access boundary in place.
 *
 * These are here rather than in a written guideline because a guideline is a
 * thing people remember, and the whole point of the boundary is that it survives
 * people not remembering. They run in `pnpm build`, so they fail on the change
 * that introduces the problem rather than on a test run somebody skipped.
 */

export type Violation = {
  /** Repository-relative, POSIX-separated. */
  readonly file: string;
  readonly line: number;
  readonly rule: RuleName;
  readonly detail: string;
};

export const RULE_NAMES = [
  "no-datastore-driver-outside-the-data-access-module",
  "no-reaching-into-the-data-access-module",
  "one-place-reads-a-membership",
  "every-exported-call-carries-an-auth-context",
  "only-the-seam-knows-the-auth-provider",
  "no-private-package-in-a-published-one",
  "only-a-fenced-home-holds-the-query-interface",
] as const;

export type RuleName = (typeof RULE_NAMES)[number];

/** The data-access module. The pool lives inside it and is never handed out. */
const DATA_ACCESS_MODULE = "packages/db/src/";

/** The package that contains it, whose entry point is the only way in. */
const DATA_ACCESS_PACKAGE = "packages/db/";

/** The single file allowed to read a membership row. */
const MEMBERSHIP_RESOLVER = "packages/db/src/access/memberships.ts";

/** Everything the module offers the rest of the codebase. */
const ACCESS_SURFACE = "packages/db/src/access/index.ts";

/**
 * The second fenced home of the data-access boundary: the commercially
 * licensed package.
 *
 * **It is a second home and not a hole in the first.** `ee/` holds the cloud
 * billing tables' reads and writes, because no shared code may read a `cloud_`
 * table and putting them in `packages/db/src/access/` would put them in every
 * self-hoster's build. So the same rules follow them here: nothing outside
 * `ee/src/access/` reaches the query interface, every exported call on the
 * surface below takes an `AuthContext` first apart from a named list narrower
 * than the shared module's, and no file in `ee/` may hold a datastore driver —
 * that rule already covers this package, because the driver rule names one
 * directory and this is not it.
 */
const EE_MODULE = "ee/src/";
const EE_ACCESS_MODULE = "ee/src/access/";
const EE_ACCESS_SURFACE = "ee/src/access/index.ts";

/**
 * The one export that hands the query interface out of `packages/db`, and the
 * only directories allowed to take it.
 *
 * The Postgres pool is private to `packages/db/src` and `db()` is not on the
 * package's entry point, so `ee/` — a separate package — could not otherwise
 * reach a database at all. `fencedDatabase` is that one door, named so a
 * reader of an import list can see it being opened, and this rule is what
 * keeps it from being opened anywhere else. Without the rule the export would
 * be exactly the loophole the boundary exists to prevent: any package could
 * take the pool and write its own untenanted query.
 */
const QUERY_INTERFACE_EXPORT = "fencedDatabase";
const FENCED_HOMES = [DATA_ACCESS_MODULE, EE_ACCESS_MODULE];

/** The type every exported call that touches a customer's data begins with. */
const AUTH_CONTEXT = "AuthContext";

/**
 * Exports that establish an AuthContext from an authenticated identity or secret.
 * They cannot require an existing context. Each must restrict access to the
 * identity or secret supplied; additions require review.
 */
const CONTEXT_ESTABLISHING = [
  "membershipsOf",
  "projectsOf",
  "provisionOrganization",
  "resolveApiKey",
  "resolveDeviceAuthorization",
  "readInvitation",
  "acceptInvitation",
];

/**
 * Unauthenticated deployment facts. Enforce zero arguments and the declared
 * return type so an exemption cannot become a customer-data read.
 */
const INSTANCE_SCOPED: ReadonlyMap<string, string> = new Map([
  ["instanceIsClaimed", "Promise<boolean>"],
]);

/**
 * Deployment-wide work cannot use a customer-scoped AuthContext. These exports
 * may select Egma work by claim or simulation ID, but may not accept an
 * organizationId or projectId. Subsequent reads and writes must use the
 * AuthContext narrowed to the selected row. Review each exemption for these
 * constraints; the argument rule alone does not prove isolation.
 */
const WORK_DISPATCHING = [
  "claimGradingJobs",
  "claimSimulations",
  "recordSimulationHeartbeat",
  "resolveSimulationStanding",
  "sweepOrphanedSimulations",
  "watchGradingWork",
  // Retell Monitoring is claimed from Egma's own due-work table. The caller
  // cannot name a project or agent; the returned target carries the narrowed
  // `AuthContext` that every provider read and store write after the claim must
  // use.
  "claimDueMonitoringPull",
  // Which process, out of however many are running, drains the pending prefix.
  // Added on 2026-08-22 with the ingestion roles, deliberately and after the
  // rule stopped the build. It is the same shape as the claims above turned one
  // step further out: the prefix holds every project's evidence and the process
  // that walks it walks all of it, so there is no customer to name and no
  // narrower claim that would be honest. It takes nothing and answers a lock,
  // reaching no table at all.
  "openDrainOwnership",
  // Resolve the run and simulation IDs supplied by the agent platform, which
  // has no Egma credential. Return only the live-run association, pinned mock
  // tools, and narrowed AuthContext; accept no customer selector.
  "resolveMockToolCall",
  // Bound the wait for the agent's POV across completed simulations. Each
  // grading request uses that simulation's narrowed AuthContext. Inputs are
  // time limits, not customer selectors; outputs contain IDs, not content.
  "settleSimulationsPastTheAgentPovBound",
];

/**
 * Deployment startup reconciles predefined graders, required project policy,
 * and Egma-provided personas before a browser session exists. These exports
 * accept no customer selector or customer-authored content. New projects
 * receive their policy in the project-creation transaction.
 */
const DEPLOYMENT_CONFIGURING = [
  "reconcileGraderCatalog",
  "seedPersonaLibrary",
  // The cloud plan rows, written from the shipped file on boot exactly as the
  // rate card and the persona shelf are. It takes the parsed file and no
  // customer identifier, and it can write nothing but the two plan rows.
  "seedCloudPlans",
  // The Stripe product, prices and meters a plan is sold through, written onto
  // that plan's row by the setup that created them in Stripe. Added on
  // 2026-09-07 with the Stripe adapter, deliberately and after the rule
  // stopped the build. It is the plan seed's shape one step later in the same
  // lifecycle: a product, a price and a meter belong to the deployment's
  // Stripe account rather than to anybody on it, so there is no customer to
  // name and the rule below still refuses this name the day somebody gives it
  // one. It can write nothing but the six Stripe columns of one plan row.
  "recordStripePlanObjects",
];

/** Trusted billing hooks and collectors use organization IDs resolved by the product. */
const BILLING_PORTS = [
  "openBillingAccount",
  "readEntitlementFacts",
  "createBillingAccount",
  "activateBilling",
  "settleInference",
  "settleInferenceForOrganization",
];

/**
 * The exports of the **second** fenced home that act on what Stripe has already
 * proved, and the sweep that tells Stripe what an hour owes.
 *
 * **Neither has a person to carry, and neither can be given a customer.** A
 * webhook arrives from Stripe with no session and no key: the signature is the
 * whole credential, and the organization is found from Egma's own account row
 * through the unique index on the Stripe customer id — never from anything the
 * payload claimed. So `applyStripeEvent` is handed a delivery and finds whose
 * money it is; a caller cannot name one, and the rule below refuses this name
 * the day somebody adds a parameter that could. The hourly meter sweep is the
 * other side of the same coin: it walks every paying Pro organization on the
 * deployment, because that is what an hourly job is, and there is no honest
 * context for "all of them".
 *
 * What keeps it safe beyond the mechanism is written where the functions live:
 * `applyStripeEvent` writes the event row first and everything it causes in
 * the same transaction, so a delivery is applied once or not at all, and a
 * customer it cannot resolve is a fault rather than a shrug; `overageForHour`
 * only reads, and only the `cloud_` accounts and the seconds of their own
 * organizations' conversations.
 *
 * A third name here is a decision somebody has to make on purpose.
 */
const STRIPE_FACTS = [
  "applyStripeEvent",
  "overageOwedThrough",
  "markOverageReported",
];

/**
 * What a work-dispatching or deployment-configuring export may not be handed,
 * in any position: an argument named for a customer, or an object argument
 * carrying one. Matched on
 * the text of the parameter and its type, which is how these are written —
 * inline object types with named properties.
 */
const NAMES_A_CUSTOMER = /\b(organizationId|projectId)\b/;

/**
 * The auth provider, as the package names it import. The provider answers one
 * question — who is this person, and are they logged in — and the whole reason
 * a swap stays cheap is that the answer arrives through egma's own types rather
 * than the vendor's.
 */
const AUTH_PROVIDER_PACKAGES = ["better-auth", "@better-auth/core"];

/**
 * Published source must not import private workspace packages unless they are
 * bundled in the installed package. Local project references can make a build
 * pass while leaving such imports unresolvable after installation.
 */
const PUBLISHED_PACKAGES = ["apps/cli/src/", "sdks/livekit-js/src/"];

/**
 * Private workspace packages deliberately carried inside a published package.
 *
 * A bundled dependency resolves from the installed tarball's own
 * `node_modules`, so it does not have to exist as a separate npm package. The
 * release workflow packs and installs that tarball in a clean folder before it
 * can publish, which is the runtime proof this exception needs.
 */
async function bundledWorkspacePackagesIn(root: string): Promise<Set<string>> {
  const held = new Set<string>();
  for (const manifestPath of ["apps/cli/package.json"]) {
    try {
      const manifest = JSON.parse(
        await readFile(path.join(root, manifestPath), "utf8"),
      ) as { bundledDependencies?: unknown };
      if (Array.isArray(manifest.bundledDependencies)) {
        for (const name of manifest.bundledDependencies) {
          if (typeof name === "string") held.add(name);
        }
      }
    } catch {
      // A missing published manifest means there is nothing to exempt.
    }
  }
  return held;
}

/**
 * Only the identity-store binding and auth-provider implementation may import
 * the provider. All other modules use the provider interface.
 */
const AUTH_PROVIDER_SEAM = [
  "packages/db/src/identity-store.ts",
  "apps/api/src/auth/better-auth.ts",
];

/**
 * A driver for a store egma keeps customer data in. ClickHouse was named here
 * before it existed, so the rule was already waiting when the trace store
 * arrived rather than being added after the first import.
 */
const DATASTORE_DRIVERS = [
  "pg",
  "pg-native",
  "pg-pool",
  "postgres",
  "drizzle-orm/node-postgres",
  "drizzle-orm/postgres-js",
  "drizzle-orm/pg-proxy",
  "@clickhouse/client",
  "@clickhouse/client-web",
];

/**
 * The only files outside the module permitted to hold a driver. Each is there
 * because it exists *to* bypass the module: those tests write raw SQL on purpose,
 * to cover the migration scripts, bulk imports and manual fixes that never pass
 * through the application at all.
 *
 * Adding a line here is the deliberate act it should be.
 */
const DELIBERATE_BYPASSES = [
  "packages/db/test/support/database.ts",
  "packages/db/test/support/clickhouse.ts",
  // Drops the test databases a timed-out run stranded, before a suite starts.
  // It exists to speak to the two stores as an operator rather than as egma:
  // there is no tenancy in `drop database`, and the thing it drops is not a
  // customer's row but a whole database this repository's own tests made.
  "packages/db/test/support/sweep-stale-databases.ts",
];

const SOURCE_EXTENSIONS = [
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
];

const SKIPPED_DIRECTORIES = new Set([
  "node_modules",
  "dist",
  "coverage",
  ".git",
  ".next",
  ".turbo",
]);

/** A directory holding its own repository is somebody else's source, not ours. */
async function isNestedRepository(directory: string): Promise<boolean> {
  try {
    await access(path.join(directory, ".git"));
    return true;
  } catch {
    return false;
  }
}

type ImportRecord = {
  readonly specifier: string;
  readonly line: number;
  /** Bindings introduced by name, e.g. `import { membership } from …`. */
  readonly named: readonly string[];
  /** The binding introduced by `import * as x from …`, if any. */
  readonly namespace: string | null;
};

export async function collectSourceFiles(root: string): Promise<string[]> {
  const found: string[] = [];

  async function walk(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (SKIPPED_DIRECTORIES.has(entry.name)) continue;
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (await isNestedRepository(full)) continue;
        await walk(full);
      } else if (SOURCE_EXTENSIONS.includes(path.extname(entry.name))) {
        found.push(full);
      }
    }
  }

  await walk(root);
  return found.sort();
}

function relative(root: string, file: string): string {
  return path.relative(root, file).split(path.sep).join("/");
}

function importsOf(fileName: string, source: string): ImportRecord[] {
  const tree = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
    fileName.endsWith(".tsx") || fileName.endsWith(".jsx")
      ? ts.ScriptKind.TSX
      : ts.ScriptKind.TS,
  );

  const records: ImportRecord[] = [];

  const record = (
    node: ts.Node,
    specifier: string,
    named: readonly string[] = [],
    namespace: string | null = null,
  ): void => {
    records.push({
      specifier,
      line: tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1,
      named,
      namespace,
    });
  };

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const bindings = node.importClause?.namedBindings;
      const named =
        bindings !== undefined && ts.isNamedImports(bindings)
          ? bindings.elements.map((element) =>
              (element.propertyName ?? element.name).text,
            )
          : [];
      const namespace =
        bindings !== undefined && ts.isNamespaceImport(bindings)
          ? bindings.name.text
          : null;
      record(node, node.moduleSpecifier.text, named, namespace);
    } else if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      const named =
        node.exportClause !== undefined && ts.isNamedExports(node.exportClause)
          ? node.exportClause.elements.map((element) =>
              (element.propertyName ?? element.name).text,
            )
          : [];
      record(node, node.moduleSpecifier.text, named);
    } else if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const brings =
        callee.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(callee) && callee.text === "require");
      const argument = node.arguments[0];
      if (brings && argument !== undefined && ts.isStringLiteral(argument)) {
        record(node, argument.text);
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(tree);
  return records;
}

/** Whether `<namespace>.membership` is read anywhere in the file. */
function readsMembershipThroughNamespace(
  fileName: string,
  source: string,
  namespaces: readonly string[],
): number | null {
  if (namespaces.length === 0) return null;

  const tree = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );

  let line: number | null = null;
  const visit = (node: ts.Node): void => {
    if (
      line === null &&
      ts.isPropertyAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      namespaces.includes(node.expression.text) &&
      node.name.text === "membership"
    ) {
      line = tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1;
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
  return line;
}

function isDatastoreDriver(specifier: string): boolean {
  return DATASTORE_DRIVERS.some(
    (driver) => specifier === driver || specifier.startsWith(`${driver}/`),
  );
}

/**
 * The workspace package an import names, or nothing when it names none.
 *
 * `@egma/ids` and `@egma/ids/mint.ts` both belong to `@egma/ids`; a relative
 * path and an ordinary npm package belong to nobody.
 */
function workspaceNameOf(specifier: string): string | undefined {
  if (!specifier.startsWith("@egma/")) return undefined;
  const [scope, name] = specifier.split("/");
  return name === undefined ? undefined : `${scope}/${name}`;
}

/**
 * Read workspace packages from pnpm-workspace.yaml. A glob names a directory
 * of packages; a plain entry such as ee names one package.
 */
type WorkspaceEntry = {
  readonly where: string;
  /** Whether the entry names a directory of packages rather than one package. */
  readonly holdsMany: boolean;
};

async function workspaceEntriesIn(root: string): Promise<WorkspaceEntry[]> {
  let file: string;
  try {
    file = await readFile(path.join(root, "pnpm-workspace.yaml"), "utf8");
  } catch {
    return [];
  }
  const entries = new Map<string, WorkspaceEntry>();
  let inPackages = false;
  for (const line of file.split("\n")) {
    if (/^packages:/.test(line)) {
      inPackages = true;
      continue;
    }
    if (inPackages && /^\S/.test(line)) break;
    const entry = /^\s+-\s*['"]?([^'"\s]+)/.exec(line);
    if (inPackages && entry?.[1] !== undefined) {
      const written = entry[1];
      const first = written.split("/")[0];
      if (first === undefined || first === "" || first === ".") continue;
      const holdsMany = written.includes("*");
      const held = entries.get(first);
      // A repository listing both `ee` and `ee/*` means both, so a directory
      // named once as a package and once as a container is read both ways.
      entries.set(first, {
        where: first,
        holdsMany: holdsMany || held?.holdsMany === true,
      });
      if (!holdsMany && held?.holdsMany === true) {
        entries.set(first, { where: first, holdsMany: true });
      }
    }
  }
  return [...entries.values()];
}

async function privateWorkspacePackagesIn(root: string): Promise<Set<string>> {
  const held = new Set<string>();
  const take = async (directory: string): Promise<void> => {
    try {
      const manifest = JSON.parse(
        await readFile(path.join(directory, "package.json"), "utf8"),
      ) as { name?: unknown; private?: unknown };
      if (manifest.private === true && typeof manifest.name === "string") {
        held.add(manifest.name);
      }
    } catch {
      // A directory with no readable manifest is not a workspace package.
    }
  };

  for (const { where, holdsMany } of await workspaceEntriesIn(root)) {
    if (!holdsMany) {
      await take(path.join(root, where));
      continue;
    }
    let entries: string[];
    try {
      entries = await readdir(path.join(root, where));
    } catch {
      continue;
    }
    for (const entry of entries) await take(path.join(root, where, entry));
  }
  return held;
}

function isAuthProvider(specifier: string): boolean {
  return AUTH_PROVIDER_PACKAGES.some(
    (name) => specifier === name || specifier.startsWith(`${name}/`),
  );
}

function resolvedInsideModule(file: string, specifier: string): boolean {
  if (specifier.startsWith("@egma/db/")) return true;
  return resolvedInside(file, specifier, DATA_ACCESS_MODULE);
}

/** Where a relative import lands, repository-relative, or nothing. */
function resolvedTarget(file: string, specifier: string): string | undefined {
  if (!specifier.startsWith(".")) return undefined;
  return path.posix.normalize(
    path.posix.join(path.posix.dirname(file), specifier),
  );
}

function resolvedInside(
  file: string,
  specifier: string,
  where: string,
): boolean {
  return resolvedTarget(file, specifier)?.startsWith(where) === true;
}

function isSchemaModule(file: string, specifier: string): boolean {
  if (!specifier.startsWith(".")) return false;
  const target = path.posix.normalize(
    path.posix.join(path.posix.dirname(file), specifier),
  );
  return target.startsWith(`${DATA_ACCESS_MODULE}schema/`);
}

function parse(fileName: string, source: string): ts.SourceFile {
  return ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
}

function exportedFunction(
  tree: ts.SourceFile,
  name: string,
): ts.FunctionDeclaration | null {
  for (const statement of tree.statements) {
    if (
      ts.isFunctionDeclaration(statement) &&
      statement.name?.text === name &&
      statement.modifiers?.some(
        (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
      ) === true
    ) {
      return statement;
    }
  }
  return null;
}

/**
 * One parameter as a reader of the call sees it: what is written at the call
 * site, plus the body of a type alias declared in the same file, so a parameter
 * cannot hide a field behind a name. One level of alias, which is how these are
 * written — a second would be a shape nobody could read either.
 */
function asWritten(tree: ts.SourceFile, parameter: ts.ParameterDeclaration): string {
  const written = parameter.getText(tree);
  const type = parameter.type;
  if (type === undefined || !ts.isTypeReferenceNode(type)) return written;
  const referenced = type.typeName.getText(tree);

  for (const statement of tree.statements) {
    if (ts.isTypeAliasDeclaration(statement) && statement.name.text === referenced) {
      return `${written} ${statement.getText(tree)}`;
    }
  }
  return written;
}

/** The return type exactly as the exported function declares it. */
function answerAsWritten(
  tree: ts.SourceFile,
  declaration: ts.FunctionDeclaration,
): string {
  const type = declaration.type;
  if (type === undefined) return "no declared return type";
  return type.getText(tree);
}

/**
 * Every function the module exports either takes an `AuthContext` first, or is
 * one of the named exceptions: the seven that produce a context, the one that
 * asks about the deployment, and the five that dispatch egma's own work and
 * keep those dispatches honest. Nothing exported takes a predicate, so there
 * is no call shape that lets a caller supply their own tenancy filter — or
 * none.
 */
async function checkExportedCallShapes(
  root: string,
  which: string = ACCESS_SURFACE,
): Promise<Violation[]> {
  const surface = path.join(root, which);
  // The second fenced home's own narrower exemption list, and it is the only
  // surface that may use it.
  const billingPorts =
    which === EE_ACCESS_SURFACE ? [...BILLING_PORTS, ...STRIPE_FACTS] : [];
  let source: string;
  try {
    source = await readFile(surface, "utf8");
  } catch {
    return [];
  }

  const violations: Violation[] = [];
  const tree = parse(surface, source);

  for (const statement of tree.statements) {
    if (
      !ts.isExportDeclaration(statement) ||
      statement.isTypeOnly ||
      statement.moduleSpecifier === undefined ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      statement.exportClause === undefined ||
      !ts.isNamedExports(statement.exportClause)
    ) {
      continue;
    }

    const from = path.join(
      path.dirname(surface),
      statement.moduleSpecifier.text,
    );
    let declaring: ts.SourceFile;
    try {
      declaring = parse(from, await readFile(from, "utf8"));
    } catch {
      continue;
    }

    for (const element of statement.exportClause.elements) {
      if (element.isTypeOnly) continue;
      const name = (element.propertyName ?? element.name).text;
      const declaration = exportedFunction(declaring, name);
      if (declaration === null) continue;

      const line = (node: ts.Node): number =>
        declaring.getLineAndCharacterOfPosition(node.getStart(declaring)).line +
        1;
      const file = relative(root, from);

      const first = declaration.parameters[0];
      const firstType = first?.type?.getText(declaring);
      const instanceScopedReturn = INSTANCE_SCOPED.get(name);
      const exempt =
        CONTEXT_ESTABLISHING.includes(name) ||
        instanceScopedReturn !== undefined ||
        WORK_DISPATCHING.includes(name) ||
        DEPLOYMENT_CONFIGURING.includes(name) ||
        billingPorts.includes(name);
      if (!exempt && firstType !== AUTH_CONTEXT) {
        violations.push({
          file,
          line: line(declaration),
          rule: "every-exported-call-carries-an-auth-context",
          detail:
            `${name} is exported but does not take an ${AUTH_CONTEXT} first. ` +
            `A caller cannot be allowed to forget the tenancy filter, so a ` +
            `caller cannot be allowed to call without the context.`,
        });
      }

      if (instanceScopedReturn !== undefined && declaration.parameters.length > 0) {
        violations.push({
          file,
          line: line(declaration),
          rule: "every-exported-call-carries-an-auth-context",
          detail:
            `${name} skips the ${AUTH_CONTEXT} because it asks about the ` +
            `deployment rather than about a customer, and that only holds ` +
            `while it takes nothing. A parameter would give it a customer to ` +
            `name, and it would be an ordinary read wearing an exemption.`,
        });
      }

      if (instanceScopedReturn !== undefined) {
        const declared = answerAsWritten(declaring, declaration);
        if (declared !== instanceScopedReturn) {
          violations.push({
            file,
            line: line(declaration),
            rule: "every-exported-call-carries-an-auth-context",
            detail:
              `${name} skips the ${AUTH_CONTEXT} only because its public ` +
              `instance fact is ${instanceScopedReturn}. It declares ${declared}; ` +
              `a wider return would make this an ordinary read wearing an exemption.`,
          });
        }
      }

      if (
        WORK_DISPATCHING.includes(name) ||
        DEPLOYMENT_CONFIGURING.includes(name) ||
        (which === EE_ACCESS_SURFACE && STRIPE_FACTS.includes(name))
      ) {
        for (const parameter of declaration.parameters) {
          const written = asWritten(declaring, parameter);
          if (!NAMES_A_CUSTOMER.test(written)) continue;
          violations.push({
            file,
            line: line(parameter),
            rule: "every-exported-call-carries-an-auth-context",
            detail:
              `${name} skips the ${AUTH_CONTEXT} because it dispatches Egma's ` +
              `own work across the deployment, and that only holds while no ` +
              `caller can name a customer to it. This parameter names one, ` +
              `which makes it a cross-tenant read wearing an exemption.`,
          });
        }
      }

      for (const parameter of declaration.parameters) {
        const type = parameter.type?.getText(declaring) ?? "";
        if (/\bSQL\b/.test(type)) {
          violations.push({
            file,
            line: line(parameter),
            rule: "every-exported-call-carries-an-auth-context",
            detail:
              `${name} takes a predicate. An exported call may narrow what it ` +
              `returns through named arguments, never by being handed a filter.`,
          });
        }
      }
    }
  }

  return violations;
}

/** Every violation in the tree rooted at `root`, in file order. */
export async function check(root: string): Promise<Violation[]> {
  const violations: Violation[] = [
    ...(await checkExportedCallShapes(root)),
    ...(await checkExportedCallShapes(root, EE_ACCESS_SURFACE)),
  ];
  const privateWorkspacePackages = await privateWorkspacePackagesIn(root);
  const bundledWorkspacePackages = await bundledWorkspacePackagesIn(root);

  for (const absolute of await collectSourceFiles(root)) {
    const file = relative(root, absolute);
    const source = await readFile(absolute, "utf8");
    const imports = importsOf(absolute, source);

    const insideModule = file.startsWith(DATA_ACCESS_MODULE);
    const insidePackage = file.startsWith(DATA_ACCESS_PACKAGE);
    const bypassesDeliberately = DELIBERATE_BYPASSES.includes(file);
    const insideAFencedHome = FENCED_HOMES.some((home) => file.startsWith(home));

    for (const record of imports) {
      if (
        record.named.includes(QUERY_INTERFACE_EXPORT) &&
        !insideAFencedHome
      ) {
        violations.push({
          file,
          line: record.line,
          rule: "only-a-fenced-home-holds-the-query-interface",
          detail:
            `imports ${QUERY_INTERFACE_EXPORT}, which hands out the query ` +
            `interface the pool sits behind. Only ${FENCED_HOMES.join(" and ")} ` +
            `may hold one: every read and write goes through a function there ` +
            `that takes an AuthContext and injects the tenancy predicates ` +
            `itself. Import "@egma/db" and use what it exports.`,
        });
      }

      // The second fenced home has one way in, exactly as the first does.
      // Inside `ee/src/access/` a file reaches its neighbours freely; outside
      // it, `ee/` sees the surface and nothing else.
      if (
        file.startsWith(EE_MODULE) &&
        !file.startsWith(EE_ACCESS_MODULE) &&
        resolvedInside(file, record.specifier, EE_ACCESS_MODULE) &&
        resolvedTarget(file, record.specifier) !== EE_ACCESS_SURFACE
      ) {
        violations.push({
          file,
          line: record.line,
          rule: "no-reaching-into-the-data-access-module",
          detail:
            `reaches inside the cloud data-access module with ` +
            `"${record.specifier}". Import "./access/index.ts" and use what ` +
            `it exports: the surface is where every export is held to taking ` +
            `an AuthContext, and a file that goes around it is a read nobody ` +
            `checked.`,
        });
      }
      if (
        PUBLISHED_PACKAGES.some((where) => file.startsWith(where)) &&
        privateWorkspacePackages.has(workspaceNameOf(record.specifier) ?? "") &&
        !bundledWorkspacePackages.has(workspaceNameOf(record.specifier) ?? "")
      ) {
        violations.push({
          file,
          line: record.line,
          rule: "no-private-package-in-a-published-one",
          detail:
            `imports "${record.specifier}", which this repository never ` +
            `publishes. This package ships its source compiled rather than ` +
            `bundled, so the import survives into what somebody installs and ` +
            `cannot be resolved there. Use the standard library, or what the ` +
            `platform already sends.`,
        });
      }

      if (
        isDatastoreDriver(record.specifier) &&
        !insideModule &&
        !bypassesDeliberately
      ) {
        violations.push({
          file,
          line: record.line,
          rule: "no-datastore-driver-outside-the-data-access-module",
          detail:
            `imports the datastore driver "${record.specifier}". ` +
            `Only ${DATA_ACCESS_MODULE} may hold one: every read and write ` +
            `goes through a function there that takes an AuthContext and ` +
            `injects the tenancy predicates itself.`,
        });
      }

      if (
        isAuthProvider(record.specifier) &&
        !AUTH_PROVIDER_SEAM.includes(file)
      ) {
        violations.push({
          file,
          line: record.line,
          rule: "only-the-seam-knows-the-auth-provider",
          detail:
            `imports the auth provider "${record.specifier}". Only ` +
            `${AUTH_PROVIDER_SEAM.join(" and ")} may: the provider answers ` +
            `who this person is and whether they are logged in, and the rest ` +
            `of the codebase sees that answer as Egma's own type. Every ` +
            `import past the seam is what a provider swap would have to undo.`,
        });
      }

      if (!insidePackage && resolvedInsideModule(file, record.specifier)) {
        violations.push({
          file,
          line: record.line,
          rule: "no-reaching-into-the-data-access-module",
          detail:
            `reaches inside the data-access module with "${record.specifier}". ` +
            `Import "@egma/db" and use what it exports.`,
        });
      }

      if (
        insideModule &&
        file !== MEMBERSHIP_RESOLVER &&
        record.named.includes("membership") &&
        isSchemaModule(file, record.specifier)
      ) {
        violations.push({
          file,
          line: record.line,
          rule: "one-place-reads-a-membership",
          detail:
            `reads the membership table. Only ${MEMBERSHIP_RESOLVER} may: ` +
            `which organization a person is in is answered in one place, ` +
            `which is what keeps one-organization-per-person reversible.`,
        });
      }
    }

    if (insideModule && file !== MEMBERSHIP_RESOLVER) {
      const namespaces = imports
        .filter((record) => isSchemaModule(file, record.specifier))
        .map((record) => record.namespace)
        .filter((name): name is string => name !== null);
      const line = readsMembershipThroughNamespace(absolute, source, namespaces);
      if (line !== null) {
        violations.push({
          file,
          line,
          rule: "one-place-reads-a-membership",
          detail:
            `reads the membership table through a namespace import. Only ` +
            `${MEMBERSHIP_RESOLVER} may.`,
        });
      }
    }
  }

  return violations.sort(
    (left, right) =>
      left.file.localeCompare(right.file) || left.line - right.line,
  );
}

export function format(violations: readonly Violation[]): string {
  return violations
    .map(
      (violation) =>
        `${violation.file}:${violation.line}  ${violation.rule}\n    ${violation.detail}`,
    )
    .join("\n\n");
}
