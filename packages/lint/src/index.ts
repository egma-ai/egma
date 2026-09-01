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

/** The type every exported call that touches a customer's data begins with. */
const AUTH_CONTEXT = "AuthContext";

/**
 * The exports that cannot take an `AuthContext`, because between them they are
 * what produces one: which organization a person is in, which projects are in
 * it, bringing a new organization into existence, and turning a credential into
 * the context a request carrying it acts in. None of them can reach a row
 * belonging to anybody else — each takes the thing the credential already names
 * and can return nothing outside it. Another name in this list is a decision
 * somebody has to make on purpose.
 *
 * `resolveApiKey` and `resolveDeviceAuthorization` were added on 2026-08-01
 * with the device flow, deliberately and after the rule stopped the build.
 * Each takes a high-entropy secret that egma issued to exactly one holder and
 * answers what it resolves to — a whole `AuthContext` for the first, an
 * organization and a project for the second. Neither can be asked about
 * somebody else's, because there is no argument other than the secret itself.
 *
 * `readInvitation` and `acceptInvitation` were added on 2026-08-01 with
 * invitations, on the same terms and after the rule stopped the build again.
 * The person following an invitation link has no account at the moment they
 * read it and no membership at the moment they accept it, so there is no context
 * for either to take; the token's hash is the only argument, and an invitation
 * nobody was given cannot be named. `acceptInvitation` takes a second argument
 * naming the person accepting, which is the same shape as `membershipsOf` —
 * whoever calls it has already resolved that identity from a credential.
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
 * The exports that answer a question about the deployment rather than about a
 * customer. `instanceIsClaimed` is asked by somebody looking at a signup form,
 * who has no credential to build a context from and never will until they have
 * signed up.
 *
 * This category is narrower than the one above and the rule enforces both parts
 * of each named exception: no function here takes an argument, and each returns
 * only the platform fact written beside it. `instanceIsClaimed` returns a
 * boolean. A parameter or a wider return would make it an ordinary read
 * wearing an exemption, so the rule refuses both changes.
 */
const INSTANCE_SCOPED: ReadonlyMap<string, string> = new Map([
  ["instanceIsClaimed", "Promise<boolean>"],
]);

/**
 * The exports that dispatch egma's own work across the whole deployment, and
 * the ones that keep a dispatch honest afterwards.
 *
 * The grader and the simulator each stand behind every organization at once
 * and hold no credential, because there is no honest one to give them: an API
 * key minted inside one customer would either see too little to do the job or
 * be shared between customers to do it. So each is handed work instead of
 * asked for a credential — the claims hand it out, and the simulator's
 * heartbeat, orphan sweep and standing resolver stand on the same ground for
 * the same reason: a beat arrives bearing the service token, which resolves
 * to nobody, silence is noticed by nobody in particular, and a report about
 * a held row arrives from the same nobody the row must answer for.
 *
 * `claimSimulations` was added on 2026-08-08 with the simulator's claim door,
 * deliberately and after the rule stopped the build: the tenancy-scoped claim
 * it replaced had no production caller, and the real one reaches every
 * customer's queue on the grading claim's exact terms.
 * `recordSimulationHeartbeat` and `sweepOrphanedSimulations` followed the
 * same day on the same replaced-function terms: a heartbeat can only stamp a
 * row already claimed under the caller's own name and answers one boolean
 * egma itself wrote, and the sweep moves only rows the claim machinery
 * stamped, filing each orphan's grading work under the tenancy the row
 * itself carries.
 *
 * `resolveSimulationStanding` was added the same day with the report door, on
 * the same terms one step later in the same lifecycle: a simulator calling
 * back about a row it already holds still has no credential, so the row is
 * looked up by the id the claim itself handed out, and the answer carries the
 * lifecycle stamps and the same narrowed context the claim built — which is
 * what every write about the row then goes through. The ingest door's
 * service path asks it the same way for arriving telemetry, added the same
 * day: the answer's pins are what a simulation's spans are filed under, read
 * off egma's own row rather than off anything the payload claimed.
 *
 * This category is narrower than it looks, and the rule enforces the property
 * that makes it safe: **nothing here may take an argument by which a caller
 * could name a customer.** A claimant's name, a capacity, a simulation id, a
 * staleness window — each says which piece of egma's own bookkeeping is
 * meant; none says whose data to bring back. A function here that grew an
 * `organizationId` or a `projectId` would be an ordinary cross-tenant read
 * wearing an exemption, and the rule refuses it.
 *
 * The rest of what makes it safe is not mechanical and is written out where
 * the functions live: the only rows any of them reaches are egma's own queues
 * — grading jobs, and the simulations egma itself wrote and claimed — a claim
 * carries identifiers and tenancy rather than anything a customer wrote, and
 * every claim arrives with the `AuthContext` narrowed to that row's own
 * organization and project — which is what the work itself goes through.
 *
 * A tenth name here is a decision somebody has to make on purpose.
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
  // The mock endpoint's own resolver, added on 2026-08-28 with that endpoint
  // and after the rule stopped the build. It is the standing resolver's shape
  // turned one step further out again: the caller is the **customer's agent
  // platform**, which holds no credential of egma's at all and could not be
  // given one — the tool calls arrive from Retell's infrastructure. So the row
  // is looked up by the two unguessable identifiers egma itself wrote into the
  // tool URL, and the answer carries the same narrowed `AuthContext` a claim
  // builds, which is what the record write then goes through.
  //
  // It names no customer and cannot be made to: a run id and a simulation id
  // say which piece of egma's own bookkeeping is meant, and the rule below
  // still refuses this name the day somebody gives it an organization or a
  // project. What it may answer is bounded on purpose — whether that run is
  // live, whether the simulation is its, and the answers that simulation was
  // already frozen with.
  "resolveMockToolCall",
];

/**
 * The exports through which the deployment configures *itself*, before it has
 * served a request and while there is no session anything could be done under.
 *
 * `reconcileGraderCatalog` writes predefined grader definitions from the
 * product catalog and adds the fixed Expected behaviors project policy where
 * an older project is missing it. It takes no customer identifier. New project
 * creation writes that policy inside its own transaction.
 *
 * `seedPersonaLibrary` does the same for the fixed Egma-provided persona
 * catalog. It can create only the catalog's null-tenancy identities and
 * immutable versions; it accepts no customer identifier or authored value.
 *
 * The rule enforces the second half of that the same way it does for work
 * dispatch: nothing here may be handed an `organizationId` or a `projectId`. A
 * function here that grew one would be an ordinary cross-tenant *write* wearing
 * an exemption, which is worse than the read work dispatch guards against.
 *
 * Another name here is a decision somebody has to make on purpose.
 */
const DEPLOYMENT_CONFIGURING = [
  "reconcileGraderCatalog",
  "seedPersonaLibrary",
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
 * The packages this repository publishes, by the source they ship.
 *
 * **A published package's `src` may not import a workspace package that is
 * never published.** `apps/cli` ships `dist/` unbundled, so an import written
 * in `src` is still an import in the file `egma` runs — and a
 * `private: true` workspace package is not on npm for it to resolve. The
 * command installs, starts, and then fails at the first line that needs it, on
 * somebody else's machine.
 *
 * This shipped once, as `import { newId } from "@egma/ids"` in the CLI's run
 * client. TypeScript caught it, but only by luck: nothing built that package
 * first, so the module was missing at build time too. **The natural repair for
 * that build error is to add a project reference — which makes the build pass
 * and ships the crash.** That is what this rule is for.
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
 * The only files that may name the auth provider.
 *
 * One binds it to the five identity tables, because the pool is private and
 * something has to hand it a way in. One implements the seam — resolve an
 * identity, the two device-flow calls, revoke a session — and everything else
 * in the codebase talks to that. A third file here is porting cost: it is the
 * vendor spreading past the seam, which is the failure this whole arrangement
 * exists to prevent.
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
 * Every workspace package marked `private`, read from the manifests rather than
 * listed here. A list would be one more thing to keep, and what it would be
 * forgotten about is whether a package is safe to ship.
 */
/**
 * The directories the workspace keeps its packages in, read from
 * `pnpm-workspace.yaml`.
 *
 * Read rather than listed, for the same reason the manifests are. The first
 * version of this rule named `packages` and `apps` and missed `fixtures` and
 * `sdks` — where two private packages live — so a rule written against a list
 * was already wrong on the day it was written. The workspace file is the one
 * place that decides, so it is the one place to ask.
 *
 * Only the leading directory of each entry is taken: `apps/*` and any deeper
 * glob both mean "look under `apps`", and a manifest is either directly in
 * there or it is not a workspace package this rule can judge.
 */
async function workspaceRootsIn(root: string): Promise<string[]> {
  let file: string;
  try {
    file = await readFile(path.join(root, "pnpm-workspace.yaml"), "utf8");
  } catch {
    return [];
  }
  const roots = new Set<string>();
  let inPackages = false;
  for (const line of file.split("\n")) {
    if (/^packages:/.test(line)) {
      inPackages = true;
      continue;
    }
    if (inPackages && /^\S/.test(line)) break;
    const entry = /^\s+-\s*['"]?([^'"\s]+)/.exec(line);
    if (inPackages && entry?.[1] !== undefined) {
      const first = entry[1].split("/")[0];
      if (first !== undefined && first !== "" && first !== ".") roots.add(first);
    }
  }
  return [...roots];
}

async function privateWorkspacePackagesIn(root: string): Promise<Set<string>> {
  const held = new Set<string>();
  for (const where of await workspaceRootsIn(root)) {
    let entries: string[];
    try {
      entries = await readdir(path.join(root, where));
    } catch {
      continue;
    }
    for (const entry of entries) {
      try {
        const manifest = JSON.parse(
          await readFile(path.join(root, where, entry, "package.json"), "utf8"),
        ) as { name?: unknown; private?: unknown };
        if (manifest.private === true && typeof manifest.name === "string") {
          held.add(manifest.name);
        }
      } catch {
        // A directory with no readable manifest is not a workspace package.
      }
    }
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
  if (!specifier.startsWith(".")) return false;
  const target = path.posix.normalize(
    path.posix.join(path.posix.dirname(file), specifier),
  );
  return target.startsWith(DATA_ACCESS_MODULE);
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
async function checkExportedCallShapes(root: string): Promise<Violation[]> {
  const surface = path.join(root, ACCESS_SURFACE);
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
        DEPLOYMENT_CONFIGURING.includes(name);
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
        DEPLOYMENT_CONFIGURING.includes(name)
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
  const violations: Violation[] = await checkExportedCallShapes(root);
  const privateWorkspacePackages = await privateWorkspacePackagesIn(root);
  const bundledWorkspacePackages = await bundledWorkspacePackagesIn(root);

  for (const absolute of await collectSourceFiles(root)) {
    const file = relative(root, absolute);
    const source = await readFile(absolute, "utf8");
    const imports = importsOf(absolute, source);

    const insideModule = file.startsWith(DATA_ACCESS_MODULE);
    const insidePackage = file.startsWith(DATA_ACCESS_PACKAGE);
    const bypassesDeliberately = DELIBERATE_BYPASSES.includes(file);

    for (const record of imports) {
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
