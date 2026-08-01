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
 */
const CONTEXT_ESTABLISHING = [
  "membershipsOf",
  "projectsOf",
  "provisionOrganization",
  "resolveApiKey",
  "resolveDeviceAuthorization",
];

/**
 * The exports that answer a question about the deployment rather than about a
 * customer. `instanceIsClaimed` is asked by somebody looking at a signup form,
 * who has no credential to build a context from and never will until they have
 * signed up.
 *
 * This category is narrower than the one above and the rule enforces the reason
 * it is safe: a function here **takes no arguments at all**. With nothing to
 * name, there is no customer to name wrongly, and a boolean carries no row out.
 * A function here that grew a parameter would be an ordinary read wearing an
 * exemption, so the rule refuses it.
 */
const INSTANCE_SCOPED = ["instanceIsClaimed"];

/**
 * The auth provider, as the package names it import. The provider answers one
 * question — who is this person, and are they logged in — and the whole reason
 * a swap stays cheap is that the answer arrives through egma's own types rather
 * than the vendor's.
 */
const AUTH_PROVIDER_PACKAGES = ["better-auth", "@better-auth/core"];

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
 * A driver for a store egma keeps customer data in. ClickHouse is named before
 * it exists, because it arrives behind this same boundary and the rule should be
 * waiting for it rather than added after the first import.
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
  "packages/db/test/migrations.test.ts",
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
 * Every function the module exports either takes an `AuthContext` first, or is
 * one of the two named exceptions that produce one. Nothing exported takes a
 * predicate, so there is no call shape that lets a caller supply their own
 * tenancy filter — or none.
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
      const exempt =
        CONTEXT_ESTABLISHING.includes(name) || INSTANCE_SCOPED.includes(name);
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

      if (INSTANCE_SCOPED.includes(name) && declaration.parameters.length > 0) {
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

  for (const absolute of await collectSourceFiles(root)) {
    const file = relative(root, absolute);
    const source = await readFile(absolute, "utf8");
    const imports = importsOf(absolute, source);

    const insideModule = file.startsWith(DATA_ACCESS_MODULE);
    const insidePackage = file.startsWith(DATA_ACCESS_PACKAGE);
    const bypassesDeliberately = DELIBERATE_BYPASSES.includes(file);

    for (const record of imports) {
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
            `of the codebase sees that answer as egma's own type. Every ` +
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
