/**
 * Deterministic proof for the files that make a Python LiveKit worker use Egma.
 *
 * The coding agent may choose how to edit Python. This module owns the smaller
 * contract Egma must prove from disk: the same discovered worker still has the
 * requested and pre-existing hooks in their safe order, and the reported
 * Python dependency manifest still declares the `egma` distribution.
 */

import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";

export type WorkerIntegrationMode = "monitoring" | "testing" | "both";

type EgmaHooks = {
  readonly monitoring: boolean;
  readonly testing: boolean;
};

type EgmaHookCounts = {
  readonly monitoring: number;
  readonly testing: number;
};

type EgmaHookCallLimit = {
  readonly expected: number;
  readonly requested: boolean;
};

type EgmaHookCallLimits = {
  readonly monitoring: EgmaHookCallLimit;
  readonly testing: EgmaHookCallLimit;
};

type RepositoryFile = {
  readonly shown: string;
  readonly canonical: string;
  readonly source: string;
};

type DependencyCandidate = {
  readonly shown: string;
  readonly canonical: string;
  readonly source: string;
};

export type WorkerIntegrationSnapshot = {
  readonly file: string;
  readonly canonical: string;
  readonly existing: EgmaHooks;
  readonly existingCalls: EgmaHookCounts;
  readonly source: string;
  readonly dependencyCandidates: readonly DependencyCandidate[];
};

export type WorkerIntegrationContract = {
  readonly workerFile: string;
  readonly dependencyFile: string;
  readonly workerCanonical: string;
  readonly dependencyCanonical: string;
  readonly required: EgmaHooks;
  readonly existing: EgmaHooks;
  readonly allowedCalls: EgmaHookCallLimits;
  readonly workerDigest: string;
  readonly dependencyDigest: string;
};

export type WorkerIntegrationVerification =
  | {
      readonly kind: "verified";
      readonly file: string;
      readonly dependencyFile: string;
      readonly contract: WorkerIntegrationContract;
    }
  | { readonly kind: "unverified"; readonly reason: string };

export type WorkerIntegrationSnapshotResult =
  | { readonly kind: "snapshotted"; readonly snapshot: WorkerIntegrationSnapshot }
  | { readonly kind: "unverified"; readonly reason: string };

const ANY_MONITOR_CALL =
  /(?:^|[^A-Za-z0-9_.])(?:egma\s*\.\s*)?monitor_livekit\s*\(/u;
const ANY_MOCKABLE_CALL =
  /(?:^|[^A-Za-z0-9_.])(?:egma\s*\.\s*)?mockable\s*\(/u;
const AWAITED_SESSION_START =
  /\bawait\s+(?:[A-Za-z_]\w*\s*\.\s*)*session\s*\.\s*start\s*\(/u;
const AWAITED_ANY_START =
  /\bawait\s+[A-Za-z_]\w*\s*\.\s*start\s*\(/u;
const TRIPLE_QUOTES = ['"""', "'''"] as const;
const FOREIGN_COMMENT_LINE = /^\s*\/\//u;

/** Python source with comments and string bodies blanked, preserving offsets. */
function pythonCode(source: string): string {
  const out: string[] = new Array<string>(source.length);
  let closes: string | null = null;
  let inComment = false;
  let at = 0;

  const keep = (): void => {
    out[at] = source[at] as string;
    at += 1;
  };
  const blank = (howMany: number): void => {
    for (let taken = 0; taken < howMany && at < source.length; taken += 1) {
      out[at] = source[at] === "\n" ? "\n" : " ";
      at += 1;
    }
  };

  while (at < source.length) {
    const here = source[at] as string;
    if (inComment) {
      if (here === "\n") {
        inComment = false;
        keep();
      } else blank(1);
      continue;
    }
    if (closes !== null) {
      if (here === "\\") {
        blank(2);
        continue;
      }
      if (source.startsWith(closes, at)) {
        blank(closes.length);
        closes = null;
        continue;
      }
      if (here === "\n" && closes.length === 1) {
        closes = null;
        keep();
        continue;
      }
      blank(1);
      continue;
    }
    if (here === "#") {
      inComment = true;
      blank(1);
      continue;
    }
    const triple = TRIPLE_QUOTES.find((quotes) => source.startsWith(quotes, at));
    if (triple !== undefined) {
      closes = triple;
      blank(triple.length);
      continue;
    }
    if (here === '"' || here === "'") {
      closes = here;
      blank(1);
      continue;
    }
    keep();
  }

  return out
    .join("")
    .split("\n")
    .map((line) => (FOREIGN_COMMENT_LINE.test(line) ? "" : line))
    .join("\n");
}

type ContextEntrypoint = {
  readonly code: string;
  readonly offset: number;
  readonly parameters: string;
};

/** The body of the async job entrypoint that receives ctx. */
function contextEntrypoint(code: string): ContextEntrypoint | null {
  const lines = code.split("\n");
  const lineOffsets: number[] = [];
  let lineOffset = 0;
  for (const line of lines) {
    lineOffsets.push(lineOffset);
    lineOffset += line.length + 1;
  }
  let found: ContextEntrypoint | null = null;
  for (let at = 0; at < lines.length; at += 1) {
    const definition = /^(\s*)async\s+def\s+[A-Za-z_]\w*\s*\(/u.exec(
      lines[at] ?? "",
    );
    if (definition === null) continue;
    let definitionEnd = at;
    let signature = lines[at] ?? "";
    const opening = signature.indexOf("(", definition.index);
    let closing = closingParenthesis(signature, opening);
    while (
      (closing === null || !signature.slice(closing + 1).trimEnd().endsWith(":")) &&
      definitionEnd + 1 < lines.length
    ) {
      definitionEnd += 1;
      signature += `\n${lines[definitionEnd] ?? ""}`;
      closing = closingParenthesis(signature, opening);
    }
    if (
      closing === null ||
      !signature.slice(closing + 1).trimEnd().endsWith(":") ||
      !/\bctx\b/u.test(signature.slice(opening + 1, closing))
    ) {
      at = definitionEnd;
      continue;
    }
    const definitionIndent = (definition[1] ?? "").length;
    const body: string[] = [];
    let resumesAt = lines.length;
    for (let below = definitionEnd + 1; below < lines.length; below += 1) {
      const line = lines[below] ?? "";
      const indent = /^\s*/u.exec(line)?.[0].length ?? 0;
      if (line.trim() !== "" && indent <= definitionIndent) {
        resumesAt = below;
        break;
      }
      body.push(line);
    }
    if (found !== null) return null;
    found = {
      code: body.join("\n"),
      offset: lineOffsets[definitionEnd + 1] ?? code.length,
      parameters: signature.slice(opening + 1, closing),
    };
    at = resumesAt - 1;
  }
  return found;
}

async function repositoryFile(
  repository: string,
  claimed: string,
): Promise<RepositoryFile | null> {
  const shown = claimed.trim();
  if (shown === "") return null;

  const root = await realpath(repository);
  const candidate = path.resolve(repository, shown);
  const relative = path.relative(path.resolve(repository), candidate);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
    return null;
  }

  try {
    if (!(await stat(candidate)).isFile()) return null;
    const canonical = await realpath(candidate);
    const canonicalRelative = path.relative(root, canonical);
    if (
      canonicalRelative === "" ||
      canonicalRelative.startsWith("..") ||
      path.isAbsolute(canonicalRelative)
    ) {
      return null;
    }
    return { shown, canonical, source: await readFile(canonical, "utf8") };
  } catch {
    return null;
  }
}

function pathIsInsideRepository(repository: string, claimed: string): boolean {
  const relative = path.relative(
    path.resolve(repository),
    path.resolve(repository, claimed.trim()),
  );
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function requestedHooks(mode: WorkerIntegrationMode): EgmaHooks {
  return {
    monitoring: mode === "monitoring" || mode === "both",
    testing: mode === "testing" || mode === "both",
  };
}

function requiredHooks(existing: EgmaHooks, mode: WorkerIntegrationMode): EgmaHooks {
  const requested = requestedHooks(mode);
  return {
    monitoring: existing.monitoring || requested.monitoring,
    testing: existing.testing || requested.testing,
  };
}

type HookName = "monitor_livekit" | "mockable";

function hookBindings(code: string, name: HookName): readonly string[] {
  const bindings = new Set<string>();
  const imports = code.matchAll(
    /(?:^|\n)from[ \t]+egma[ \t]+import[ \t]+(?:\(([^)]*)\)|([^\n]+))/gu,
  );
  const direct = new RegExp(
    `(?:^|,)\\s*${name}(?:\\s+as\\s+([A-Za-z_]\\w*))?\\s*(?=,|$)`,
    "gu",
  );
  for (const found of imports) {
    for (const item of (found[1] ?? found[2] ?? "").matchAll(direct)) {
      bindings.add(item[1] ?? name);
    }
  }

  const qualified = code.matchAll(
    /(?:^|\n)import[ \t]+egma(?:[ \t]+as[ \t]+([A-Za-z_]\w*))?[ \t]*(?=\n|$)/gu,
  );
  for (const found of qualified) bindings.add(`${found[1] ?? "egma"}.${name}`);
  return [...bindings];
}

function hookBindingImportEnd(
  code: string,
  name: HookName,
  binding: string,
): number {
  let end = -1;
  const directImports = code.matchAll(
    /(?:^|\n)from[ \t]+egma[ \t]+import[ \t]+(?:\(([^)]*)\)|([^\n]+))/gu,
  );
  const direct = new RegExp(
    `(?:^|,)\\s*${name}(?:\\s+as\\s+([A-Za-z_]\\w*))?\\s*(?=,|$)`,
    "gu",
  );
  for (const found of directImports) {
    for (const item of (found[1] ?? found[2] ?? "").matchAll(direct)) {
      if ((item[1] ?? name) === binding) {
        end = Math.max(end, (found.index ?? -1) + found[0].length);
      }
    }
  }

  const qualifiedImports = code.matchAll(
    /(?:^|\n)import[ \t]+egma(?:[ \t]+as[ \t]+([A-Za-z_]\w*))?[ \t]*(?=\n|$)/gu,
  );
  for (const found of qualifiedImports) {
    if (`${found[1] ?? "egma"}.${name}` === binding) {
      end = Math.max(end, (found.index ?? -1) + found[0].length);
    }
  }
  return end;
}

function importedNames(line: string): readonly string[] {
  const fromImport = /^from\s+[^\s]+\s+import\s+(.+)$/u.exec(line);
  if (fromImport !== null) {
    return (fromImport[1] ?? "")
      .replace(/[()]/gu, "")
      .split(",")
      .map((item) => {
        const imported = /^\s*([A-Za-z_]\w*)(?:\s+as\s+([A-Za-z_]\w*))?/u.exec(
          item,
        );
        return imported?.[2] ?? imported?.[1] ?? "";
      })
      .filter((name) => name !== "");
  }
  const directImport = /^import\s+(.+)$/u.exec(line);
  if (directImport === null) return [];
  return (directImport[1] ?? "")
    .split(",")
    .map((item) => {
      const imported = /^\s*([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)(?:\s+as\s+([A-Za-z_]\w*))?/u.exec(
        item,
      );
      return imported?.[2] ?? imported?.[1]?.split(".")[0] ?? "";
    })
    .filter((name) => name !== "");
}

function bindingIsReboundAfterEgmaImport(
  code: string,
  name: HookName,
  binding: string,
): boolean {
  const importedAt = hookBindingImportEnd(code, name, binding);
  if (importedAt < 0) return false;
  const local = binding.split(".")[0] ?? binding;
  let offset = 0;
  for (const line of code.split("\n")) {
    const trimmed = line.trim();
    if (
      offset > importedAt &&
      trimmed !== "" &&
      line === line.trimStart() &&
      (importedNames(trimmed).includes(local) ||
        new RegExp(
          `^(?:async\\s+def|def|class)\\s+${local}\\b|^${local}(?:\\s*:[^=]+)?\\s*=(?!=)`,
          "u",
        ).test(trimmed))
    ) {
      return true;
    }
    offset += line.length + 1;
  }
  return false;
}

function bindingPattern(binding: string): string {
  return binding
    .split(".")
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"))
    .join("\\s*\\.\\s*");
}

function bindingIsShadowed(
  entrypoint: ContextEntrypoint,
  binding: string,
): boolean {
  const local = binding.split(".")[0] ?? binding;
  const escaped = local.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const shadowedByParameter = topLevelArguments(entrypoint.parameters).some(
    (parameter) => {
      const name = /^\s*\*{0,2}\s*([A-Za-z_]\w*)/u.exec(parameter)?.[1];
      return name === local;
    },
  );
  if (shadowedByParameter) return true;
  return [
    new RegExp(`(?:^|\\n)\\s*${escaped}\\s*(?::[^=\\n]+)?\\s*=(?!=)`, "u"),
    new RegExp(`(?:^|\\n)\\s*${escaped}\\s*:[^=\\n]+(?=\\n|$)`, "u"),
    new RegExp(`\\b${escaped}\\s*:=`, "u"),
    new RegExp(`\\bfor\\s+${escaped}\\s+in\\b`, "u"),
    new RegExp(`\\bas\\s+${escaped}\\b`, "u"),
    new RegExp(`(?:^|\\n)\\s*(?:async\\s+)?def\\s+${escaped}\\b`, "u"),
    new RegExp(`(?:^|\\n)\\s*class\\s+${escaped}\\b`, "u"),
  ].some((pattern) => pattern.test(entrypoint.code));
}

function usableBindings(
  entrypoint: ContextEntrypoint,
  bindings: readonly string[],
): readonly string[] {
  return bindings.filter((binding) => !bindingIsShadowed(entrypoint, binding));
}

function verifiedBindings(
  code: string,
  entrypoint: ContextEntrypoint,
  name: HookName,
  bindings: readonly string[],
): readonly string[] {
  return usableBindings(entrypoint, bindings).filter(
    (binding) => !bindingIsReboundAfterEgmaImport(code, name, binding),
  );
}

function exactHookPattern(binding: string, name: HookName): RegExp {
  const called = bindingPattern(binding);
  return new RegExp(
    name === "monitor_livekit"
      ? `^${called}\\s*\\(\\s*ctx\\s*,?\\s*\\)\\s*$`
      : `^await\\s+${called}\\s*\\(\\s*agent\\s*,\\s*ctx\\s*,\\s*session\\s*,?\\s*\\)\\s*$`,
    "u",
  );
}

function hookMention(
  entrypoint: ContextEntrypoint,
  bindings: readonly string[],
  _name: HookName,
): boolean {
  return bindings.some((binding) => {
    const called = bindingPattern(binding);
    return new RegExp(`(?:^|[^A-Za-z0-9_.])${called}\\s*\\(`, "u").test(
      entrypoint.code,
    );
  });
}

function hookCallCount(code: string, name: HookName): number {
  const bindings = new Set([
    ...hookBindings(code, name),
    name,
    `egma.${name}`,
  ]);
  const offsets = new Set<number>();
  for (const binding of bindings) {
    const called = bindingPattern(binding);
    const calls = code.matchAll(
      new RegExp(
        `(?:^|[^A-Za-z0-9_.])(?<binding>${called})\\s*\\(`,
        "gu",
      ),
    );
    for (const call of calls) {
      const matchedBinding = call.groups?.binding;
      if (matchedBinding === undefined) continue;
      const offset = (call.index ?? 0) + call[0].indexOf(matchedBinding);
      const prefix = code.slice(Math.max(0, offset - 32), offset);
      if (/(?:\bdef|\bclass)\s*$/u.test(prefix)) continue;
      offsets.add(offset);
    }
  }
  return offsets.size;
}

function hookCallCounts(code: string): EgmaHookCounts {
  return {
    monitoring: hookCallCount(code, "monitor_livekit"),
    testing: hookCallCount(code, "mockable"),
  };
}

function allowedHookCalls(
  existingCalls: EgmaHookCounts,
  existingHooks: EgmaHooks,
  mode: WorkerIntegrationMode,
): EgmaHookCallLimits {
  const requested = requestedHooks(mode);
  return {
    monitoring: {
      expected:
        requested.monitoring && !existingHooks.monitoring
          ? existingCalls.monitoring + 1
          : existingCalls.monitoring,
      requested: requested.monitoring,
    },
    testing: {
      expected:
        requested.testing && !existingHooks.testing
          ? existingCalls.testing + 1
          : existingCalls.testing,
      requested: requested.testing,
    },
  };
}

function exactHookExists(
  entrypoint: ContextEntrypoint,
  bindings: readonly string[],
  name: HookName,
): boolean {
  return bindings.some((binding) => {
    const called = bindingPattern(binding);
    return new RegExp(
      name === "monitor_livekit"
        ? `(?:^|[;\\n])\\s*${called}\\s*\\(\\s*ctx\\s*,?\\s*\\)`
        : `\\bawait\\s+${called}\\s*\\(\\s*agent\\s*,\\s*ctx\\s*,\\s*session\\s*,?\\s*\\)`,
      "u",
    ).test(entrypoint.code);
  });
}

type DirectStatement = {
  readonly text: string;
  readonly offset: number;
  readonly end: number;
};

function directStatements(entrypoint: ContextEntrypoint): readonly DirectStatement[] {
  const lines = entrypoint.code.split("\n");
  const nonempty = lines.filter((line) => line.trim() !== "");
  if (nonempty.length === 0) return [];
  const bodyIndent = Math.min(
    ...nonempty.map((line) => /^\s*/u.exec(line)?.[0].length ?? 0),
  );
  const statements: DirectStatement[] = [];
  let offset = 0;
  let coveredUntil = -1;
  for (const line of lines) {
    const indent = /^\s*/u.exec(line)?.[0].length ?? 0;
    const startsAt = offset + indent;
    if (
      line.trim() !== "" &&
      indent === bodyIndent &&
      startsAt >= coveredUntil
    ) {
      let round = 0;
      let square = 0;
      let curly = 0;
      let endsAt = entrypoint.code.length;
      for (let at = startsAt; at < entrypoint.code.length; at += 1) {
        const character = entrypoint.code[at];
        if (character === "(") round += 1;
        else if (character === ")") round -= 1;
        else if (character === "[") square += 1;
        else if (character === "]") square -= 1;
        else if (character === "{") curly += 1;
        else if (character === "}") curly -= 1;
        else if (
          character === "\n" &&
          round === 0 &&
          square === 0 &&
          curly === 0 &&
          entrypoint.code.slice(startsAt, at).trimEnd().at(-1) !== "\\"
        ) {
          endsAt = at;
          break;
        }
      }
      statements.push({
        text: entrypoint.code.slice(startsAt, endsAt).trim(),
        offset: startsAt,
        end: endsAt,
      });
      coveredUntil = endsAt;
    }
    offset += line.length + 1;
  }
  return statements;
}

function topLevelHookOffset(
  entrypoint: ContextEntrypoint,
  bindings: readonly string[],
  name: HookName,
): number {
  return (
    directStatements(entrypoint).find((statement) =>
      bindings.some((binding) => exactHookPattern(binding, name).test(statement.text)),
    )?.offset ?? -1
  );
}

function awaitedConnectOffset(entrypoint: ContextEntrypoint): number {
  return (
    directStatements(entrypoint).find((statement) =>
      /^await\s+ctx\s*\.\s*connect\s*\(/u.test(statement.text),
    )?.offset ?? -1
  );
}

function bindingIsBoundBefore(
  entrypoint: ContextEntrypoint,
  binding: "agent" | "session",
  before: number,
): boolean {
  const assignment = new RegExp(
    `^${binding}(?:\\s*:[^=]+)?\\s*=\\s*(?!${binding}\\s*$).+`,
    "u",
  );
  return directStatements(entrypoint).some(
    (statement) => statement.offset < before && assignment.test(statement.text),
  );
}

function bindingIsReboundBetween(
  entrypoint: ContextEntrypoint,
  binding: "agent" | "session",
  after: number,
  before: number,
): boolean {
  const source = entrypoint.code.slice(after, before);
  if (
    source
      .split("\n")
      .some((line) => importedNames(line.trim()).includes(binding))
  ) {
    return true;
  }
  const escaped = binding.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return [
    new RegExp(
      `(?:^|\\n)\\s*${escaped}(?:\\s*:[^=\\n]+)?\\s*(?:=(?!=)|[-+*/%@&|^<>]{1,2}=)`,
      "u",
    ),
    new RegExp(`\\b${escaped}\\s*:=`, "u"),
    new RegExp(`\\b(?:async\\s+)?for\\s+${escaped}\\s+in\\b`, "u"),
    new RegExp(`\\bas\\s+${escaped}\\b`, "u"),
    new RegExp(
      `(?:^|\\n)\\s*(?:async\\s+def|def|class)\\s+${escaped}\\b`,
      "u",
    ),
  ].some((pattern) => pattern.test(source));
}

function closingParenthesis(code: string, opening: number): number | null {
  let depth = 0;
  for (let at = opening; at < code.length; at += 1) {
    const character = code[at];
    if (character === "(") depth += 1;
    if (character === ")") {
      depth -= 1;
      if (depth === 0) return at;
    }
  }
  return null;
}

function topLevelArguments(source: string): readonly string[] {
  const argumentsFound: string[] = [];
  let depth = 0;
  let startsAt = 0;
  for (let at = 0; at < source.length; at += 1) {
    const character = source[at];
    if (character === "(" || character === "[" || character === "{") depth += 1;
    if (character === ")" || character === "]" || character === "}") depth -= 1;
    if (character === "," && depth === 0) {
      argumentsFound.push(source.slice(startsAt, at).trim());
      startsAt = at + 1;
    }
  }
  const last = source.slice(startsAt).trim();
  if (last !== "") argumentsFound.push(last);
  return argumentsFound;
}

function matchingSessionStart(
  entrypoint: ContextEntrypoint,
  after: number,
): number | null {
  for (const statement of directStatements(entrypoint)) {
    if (statement.offset <= after) continue;
    const start = /^await\s+session\s*\.\s*start\s*\(/u.exec(statement.text);
    if (start === null) continue;
    const opening = statement.offset + start[0].lastIndexOf("(");
    const closing = closingParenthesis(entrypoint.code, opening);
    if (closing === null) return null;
    const args = topLevelArguments(entrypoint.code.slice(opening + 1, closing));
    if (args.some((argument) => /^agent\s*=\s*agent$/u.test(argument))) {
      return statement.offset;
    }
  }
  return null;
}

function sessionStartsBefore(
  entrypoint: ContextEntrypoint,
  before: number,
): boolean {
  return directStatements(entrypoint).some(
    (statement) =>
      statement.offset < before &&
      /^await\s+session\s*\.\s*start\s*\(/u.test(statement.text),
  );
}

function firstStatementIsHook(
  entrypoint: ContextEntrypoint,
  bindings: readonly string[],
  name: HookName,
): boolean {
  const first = directStatements(entrypoint)[0];
  return (
    first !== undefined &&
    bindings.some((binding) => exactHookPattern(binding, name).test(first.text))
  );
}

function hooksIn(code: string, entrypoint: ContextEntrypoint): EgmaHooks {
  const monitoring = verifiedBindings(
    code,
    entrypoint,
    "monitor_livekit",
    hookBindings(code, "monitor_livekit"),
  );
  const testing = verifiedBindings(
    code,
    entrypoint,
    "mockable",
    hookBindings(code, "mockable"),
  );
  return {
    monitoring: exactHookExists(entrypoint, monitoring, "monitor_livekit"),
    testing: exactHookExists(entrypoint, testing, "mockable"),
  };
}

type SourceRange = {
  readonly start: number;
  readonly end: number;
};

function normalizedNonblankLines(source: string): string {
  return source
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.trim() !== "")
    .join("\n");
}

type EgmaImportSpecifier = {
  readonly imported: string;
  readonly rendered: string;
};

function egmaImportSpecifiers(source: string): readonly EgmaImportSpecifier[] {
  return source
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item !== "")
    .map((item) => {
      const parsed = /^([A-Za-z_]\w*)(?:\s+as\s+([A-Za-z_]\w*))?$/u.exec(item);
      if (parsed === null) return { imported: "", rendered: item };
      return {
        imported: parsed[1] ?? "",
        rendered: `${parsed[1] ?? ""}${parsed[2] === undefined ? "" : ` as ${parsed[2]}`}`,
      };
    });
}

function qualifiedEgmaImportBindings(code: string): ReadonlySet<string> {
  return new Set(
    [...code.matchAll(
      /(?:^|\n)import[ \t]+egma(?:[ \t]+as[ \t]+([A-Za-z_]\w*))?[ \t]*(?=\n|$)/gu,
    )].map((found) => found[1] ?? "egma"),
  );
}

function workerWithoutRequestedEgmaIntegration(
  source: string,
  requested: EgmaHooks,
  existingQualifiedImports: ReadonlySet<string>,
): string {
  const normalized = source.replace(/\r\n?/gu, "\n");
  const code = pythonCode(normalized);
  const replacements: (SourceRange & { readonly replacement: string })[] = [];
  const usedQualifiedBindings = new Set<string>();

  const imports = code.matchAll(
    /(?:^|\n)from[ \t]+egma[ \t]+import[ \t]+(?:\(([^)]*)\)|([^\n]+))/gu,
  );
  for (const imported of imports) {
    const start =
      (imported.index ?? 0) + (imported[0].startsWith("\n") ? 1 : 0);
    const kept = egmaImportSpecifiers(imported[1] ?? imported[2] ?? "").filter(
      (specifier) =>
        !(
          (requested.monitoring && specifier.imported === "monitor_livekit") ||
          (requested.testing && specifier.imported === "mockable")
        ),
    );
    replacements.push({
      start,
      end: (imported.index ?? 0) + imported[0].length,
      replacement:
        kept.length === 0
          ? ""
          : `from egma import ${kept.map((item) => item.rendered).join(", ")}`,
    });
  }

  const entrypoint = contextEntrypoint(code);
  if (entrypoint !== null) {
    const monitoring = requested.monitoring
      ? hookBindings(code, "monitor_livekit")
      : [];
    const testing = requested.testing ? hookBindings(code, "mockable") : [];
    for (const statement of directStatements(entrypoint)) {
      const usedMonitoring = monitoring.find((binding) =>
        exactHookPattern(binding, "monitor_livekit").test(statement.text),
      );
      const usedTesting = testing.find((binding) =>
        exactHookPattern(binding, "mockable").test(statement.text),
      );
      for (const binding of [usedMonitoring, usedTesting]) {
        if (binding?.includes(".")) {
          usedQualifiedBindings.add(binding.split(".")[0] ?? binding);
        }
      }
      if (usedMonitoring !== undefined || usedTesting !== undefined) {
        replacements.push({
          start: entrypoint.offset + statement.offset,
          end: entrypoint.offset + statement.end,
          replacement: "",
        });
      }
    }
  }

  const qualifiedImports = code.matchAll(
    /(?:^|\n)import[ \t]+egma(?:[ \t]+as[ \t]+([A-Za-z_]\w*))?[ \t]*(?=\n|$)/gu,
  );
  for (const imported of qualifiedImports) {
    const binding = imported[1] ?? "egma";
    if (
      existingQualifiedImports.has(binding) ||
      !usedQualifiedBindings.has(binding)
    ) {
      continue;
    }
    const start =
      (imported.index ?? 0) + (imported[0].startsWith("\n") ? 1 : 0);
    replacements.push({
      start,
      end: (imported.index ?? 0) + imported[0].length,
      replacement: "",
    });
  }

  return normalizedNonblankLines(replaceTextSpans(normalized, replacements));
}

function sourceDigest(source: string): string {
  return createHash("sha256").update(source).digest("hex");
}

function verifyWorkerSource(
  shown: string,
  source: string,
  required: EgmaHooks,
  existing: EgmaHooks,
  allowedCalls: EgmaHookCallLimits,
): string | null {
  const code = pythonCode(source);
  const entrypoint = contextEntrypoint(code);
  if (entrypoint === null) {
    return `Egma read ${shown}, but could not identify one async job entrypoint that receives ctx.`;
  }

  const allMonitoringBindings = hookBindings(code, "monitor_livekit");
  const allTestingBindings = hookBindings(code, "mockable");
  const monitoringBindings = verifiedBindings(
    code,
    entrypoint,
    "monitor_livekit",
    allMonitoringBindings,
  );
  const testingBindings = verifiedBindings(
    code,
    entrypoint,
    "mockable",
    allTestingBindings,
  );
  const monitoring = topLevelHookOffset(
    entrypoint,
    monitoringBindings,
    "monitor_livekit",
  );
  const testing = topLevelHookOffset(entrypoint, testingBindings, "mockable");
  const connects = awaitedConnectOffset(entrypoint);
  const sessionStarts = entrypoint.code.search(AWAITED_SESSION_START);
  const anyStarts = entrypoint.code.search(AWAITED_ANY_START);
  const calls = hookCallCounts(code);

  if (calls.monitoring !== allowedCalls.monitoring.expected) {
    if (allowedCalls.monitoring.requested) {
      const expected = allowedCalls.monitoring.expected;
      return `Egma read ${shown}, but expected exactly ${expected === 1 ? "one" : String(expected)} monitor_livekit() call${expected === 1 ? "" : "s"} after integration and found ${String(calls.monitoring)}.`;
    }
    return calls.monitoring > allowedCalls.monitoring.expected
      ? `Egma read ${shown}, but the testing-only integration added monitor_livekit() beyond the pre-existing calls.`
      : `Egma read ${shown}, but the testing-only integration removed a pre-existing monitor_livekit() call.`;
  }
  if (calls.testing !== allowedCalls.testing.expected) {
    if (allowedCalls.testing.requested) {
      const expected = allowedCalls.testing.expected;
      return `Egma read ${shown}, but expected exactly ${expected === 1 ? "one" : String(expected)} mockable() call${expected === 1 ? "" : "s"} after integration and found ${String(calls.testing)}.`;
    }
    return calls.testing > allowedCalls.testing.expected
      ? `Egma read ${shown}, but the monitoring-only integration added mockable() beyond the pre-existing calls.`
      : `Egma read ${shown}, but the monitoring-only integration removed a pre-existing mockable() call.`;
  }

  if (required.monitoring && monitoring < 0) {
    if (
      allMonitoringBindings.some((binding) =>
        bindingIsReboundAfterEgmaImport(code, "monitor_livekit", binding),
      )
    ) {
      return `Egma read ${shown}, but monitor_livekit is rebound after its egma import.`;
    }
    if (
      topLevelHookOffset(entrypoint, allMonitoringBindings, "monitor_livekit") >= 0 &&
      monitoringBindings.length < allMonitoringBindings.length
    ) {
      return `Egma read ${shown}, but monitor_livekit is shadowed inside the job entrypoint.`;
    }
    if (monitoringBindings.length === 0 && ANY_MONITOR_CALL.test(entrypoint.code)) {
      return `Egma read ${shown}, but monitor_livekit() is not imported from egma.`;
    }
    if (hookMention(entrypoint, monitoringBindings, "monitor_livekit")) {
      return `Egma read ${shown}, but monitor_livekit(ctx) is not a direct job-entrypoint statement.`;
    }
    return existing.monitoring
      ? `Egma read ${shown}, but the existing monitor_livekit() was removed.`
      : `Egma read ${shown} and found no monitor_livekit() in it.`;
  }
  if (required.monitoring) {
    if (!firstStatementIsHook(entrypoint, monitoringBindings, "monitor_livekit")) {
      return `Egma read ${shown}, but monitor_livekit() is not the first executable statement of its job entrypoint.`;
    }
  }
  if (required.testing && testing < 0) {
    if (
      allTestingBindings.some((binding) =>
        bindingIsReboundAfterEgmaImport(code, "mockable", binding),
      )
    ) {
      return `Egma read ${shown}, but mockable is rebound after its egma import.`;
    }
    if (
      topLevelHookOffset(entrypoint, allTestingBindings, "mockable") >= 0 &&
      testingBindings.length < allTestingBindings.length
    ) {
      return `Egma read ${shown}, but mockable is shadowed inside the job entrypoint.`;
    }
    if (testingBindings.length === 0 && ANY_MOCKABLE_CALL.test(entrypoint.code)) {
      return `Egma read ${shown}, but mockable() is not imported from egma.`;
    }
    if (hookMention(entrypoint, testingBindings, "mockable")) {
      return `Egma read ${shown}, but await mockable(agent, ctx, session) is not a direct job-entrypoint statement.`;
    }
    return existing.testing
      ? `Egma read ${shown}, but the existing mockable() was removed.`
      : `Egma read ${shown} and found no awaited mockable() in it.`;
  }
  if (testing >= 0 && !bindingIsBoundBefore(entrypoint, "agent", testing)) {
    return `Egma read ${shown}, but agent is not bound before mockable(). Extract the agent instance before the Egma call.`;
  }
  if (testing >= 0 && !bindingIsBoundBefore(entrypoint, "session", testing)) {
    return `Egma read ${shown}, but session is not bound before mockable(). Create AgentSession before the Egma call.`;
  }
  if (testing >= 0 && sessionStartsBefore(entrypoint, testing)) {
    return `Egma read ${shown}, but session already starts before mockable(). Egma isolation must run before the mocked session starts.`;
  }
  const matchingStart = testing < 0 ? null : matchingSessionStart(entrypoint, testing);
  if (testing >= 0 && matchingStart === null) {
    return anyStarts < 0
      ? `Egma read ${shown}, but found no awaited AgentSession.start() after mockable().`
      : `Egma read ${shown}, but AgentSession.start() does not use the same session and agent bindings passed to mockable().`;
  }
  if (testing >= 0 && matchingStart !== null) {
    const reassigned = (["agent", "session"] as const).find((binding) =>
      bindingIsReboundBetween(entrypoint, binding, testing, matchingStart),
    );
    if (reassigned !== undefined) {
      return `Egma read ${shown}, but ${reassigned} is rebound between mockable() and AgentSession.start().`;
    }
  }
  if (monitoring >= 0 && connects >= 0 && monitoring > connects) {
    return `Egma read ${shown}, but monitor_livekit() does not run before ctx.connect().`;
  }
  if (monitoring >= 0 && sessionStarts >= 0 && monitoring > sessionStarts) {
    return `Egma read ${shown}, but monitor_livekit() does not run before AgentSession.start().`;
  }
  if (testing >= 0 && matchingStart !== null && testing > matchingStart) {
    return `Egma read ${shown}, but mockable() does not run before AgentSession.start().`;
  }
  if (testing >= 0 && connects >= 0 && testing < connects) {
    return `Egma read ${shown}, but its explicit ctx.connect() runs after mockable().`;
  }
  return null;
}

/** Remove TOML comments without damaging quoted dependency strings. */
function tomlWithoutComments(source: string): string {
  return source
    .split("\n")
    .map((line) => {
      let quote: '"' | "'" | null = null;
      let escaped = false;
      for (let at = 0; at < line.length; at += 1) {
        const character = line[at] as string;
        if (escaped) {
          escaped = false;
          continue;
        }
        if (quote !== null && character === "\\" && quote === '"') {
          escaped = true;
          continue;
        }
        if (character === '"' || character === "'") {
          quote = quote === null ? character : quote === character ? null : quote;
          continue;
        }
        if (character === "#" && quote === null) return line.slice(0, at);
      }
      return line;
    })
    .join("\n");
}

function tomlSections(source: string): ReadonlyMap<string, string> {
  const sections = new Map<string, string[]>();
  let current = "";
  sections.set(current, []);
  for (const line of tomlWithoutComments(source).split("\n")) {
    const heading = /^\s*\[([^\]]+)\]\s*$/u.exec(line);
    if (heading !== null) {
      current = (heading[1] ?? "").trim().toLowerCase();
      if (!sections.has(current)) sections.set(current, []);
      continue;
    }
    sections.get(current)?.push(line);
  }
  return new Map([...sections].map(([name, lines]) => [name, lines.join("\n")]));
}

function assignedArray(section: string, key: string): string | null {
  const assignment = new RegExp(`(?:^|\\n)\\s*${key}\\s*=\\s*\\[`, "iu").exec(section);
  if (assignment === null) return null;
  const start = assignment.index + assignment[0].length;
  let depth = 1;
  let quote: '"' | "'" | null = null;
  let escaped = false;
  for (let at = start; at < section.length; at += 1) {
    const character = section[at] as string;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (quote !== null && character === "\\" && quote === '"') {
      escaped = true;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = quote === null ? character : quote === character ? null : quote;
      continue;
    }
    if (quote !== null) continue;
    if (character === "[") depth += 1;
    if (character === "]") depth -= 1;
    if (depth === 0) return section.slice(start, at);
  }
  return null;
}

type TextSpan = {
  readonly start: number;
  readonly end: number;
  readonly text: string;
};

function tomlSection(source: string, wanted: string): TextSpan | null {
  const headings = [...source.matchAll(/(?:^|\n)\s*\[([^\]]+)\]\s*(?=\n|$)/gu)];
  const found = headings.find(
    (heading) => (heading[1] ?? "").trim().toLowerCase() === wanted,
  );
  if (found === undefined) return null;
  const start = (found.index ?? 0) + found[0].length;
  const next = headings.find((heading) => (heading.index ?? 0) > (found.index ?? 0));
  const end = next?.index ?? source.length;
  return { start, end, text: source.slice(start, end) };
}

function assignedArraySpan(section: TextSpan, key: string): TextSpan | null {
  const assignment = new RegExp(`(?:^|\\n)\\s*${key}\\s*=\\s*\\[`, "iu").exec(
    section.text,
  );
  if (assignment === null) return null;
  const opening = section.start + assignment.index + assignment[0].lastIndexOf("[");
  let depth = 0;
  let quote: '"' | "'" | null = null;
  let escaped = false;
  for (let at = opening; at < section.end; at += 1) {
    const character = section.text[at - section.start] as string;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (quote !== null && character === "\\" && quote === '"') {
      escaped = true;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = quote === null ? character : quote === character ? null : quote;
      continue;
    }
    if (quote !== null) continue;
    if (character === "[") depth += 1;
    if (character === "]") depth -= 1;
    if (depth === 0) {
      return {
        start: opening,
        end: at + 1,
        text: section.text.slice(opening - section.start + 1, at - section.start),
      };
    }
  }
  return null;
}

function quotedRequirements(source: string): readonly string[] {
  return [...source.matchAll(/(["'])(.*?)\1/gu)].map((match) => match[2] ?? "");
}

function pyprojectEgmaDeclarations(source: string): readonly string[] {
  const declarations: string[] = [];
  const project = tomlSection(source, "project");
  const dependencies = project === null ? null : assignedArraySpan(project, "dependencies");
  if (dependencies !== null) {
    declarations.push(
      ...quotedRequirements(dependencies.text).filter((requirement) =>
        namesEgma(requirement),
      ),
    );
  }
  const poetry = tomlSection(source, "tool.poetry.dependencies");
  if (poetry !== null) {
    for (const match of poetry.text.matchAll(
      /(?:^|\n)\s*(?:egma|"egma"|'egma')\s*=\s*([^\n]+)/giu,
    )) {
      const raw = (match[1] ?? "").trim();
      const quoted = /^(["'])(.*?)\1\s*$/u.exec(raw)?.[2];
      declarations.push(`egma${quoted ?? raw}`);
    }
  }
  return declarations;
}

function requirementsEgmaDeclarations(source: string): readonly string[] {
  return source
    .split("\n")
    .map((line) => line.trim().replace(/\s+#.*$/u, ""))
    .filter((line) => namesEgma(line));
}

/**
 * Whether one declaration pins the SDK at or above the floor Egma needs.
 *
 * The floor is `0.2.0` because that is the first release in which `mockable`
 * and `monitor_livekit` decide from the job's room name. A `livekit_room`
 * connection can put a worker in an Egma room by four dispatch paths, and a
 * release below the floor reads dispatch metadata instead, which reaches the
 * worker on one of those four. Below the floor, therefore, mock tools are
 * inert on the other three and a simulation's spans leave through the
 * production door. Neither failure says anything from inside the worker: the
 * run completes, the real tools answer a synthetic caller, and the coverage
 * stamp is three empty lists. That silence is why the pin is proved from the
 * manifest here rather than left for the import to complain about.
 *
 * A direct reference — a URL, a path, a VCS checkout, anything carrying `@` —
 * names no version to compare against the floor, so it is refused rather than
 * guessed at.
 */
function registryEgmaAtLeastMinimum(requirement: string): boolean {
  if (requirement.includes("@")) return false;
  const match = /^\s*egma(?:\s*\[[^\]]+\])?\s*(>=|>|==|~=|\^)\s*(\d+)(?:\.(\d+))?(?:\.(\d+))?/iu.exec(
    requirement,
  );
  if (match === null) return false;
  const version = [Number(match[2]), Number(match[3] ?? 0), Number(match[4] ?? 0)];
  const minimum = [0, 2, 0];
  for (let at = 0; at < minimum.length; at += 1) {
    if ((version[at] ?? 0) === (minimum[at] ?? 0)) continue;
    return (version[at] ?? 0) > (minimum[at] ?? 0);
  }
  return match[1] !== ">";
}

function replaceTextSpans(
  source: string,
  replacements: readonly (SourceRange & { readonly replacement: string })[],
): string {
  return [...replacements]
    .sort((left, right) => right.start - left.start)
    .reduce(
      (held, replacement) =>
        `${held.slice(0, replacement.start)}${replacement.replacement}${held.slice(replacement.end)}`,
      source,
    );
}

function pyprojectWithoutEgma(source: string): string {
  const normalized = source.replace(/\r\n?/gu, "\n");
  const replacements: (TextSpan & { readonly replacement: string })[] = [];
  const project = tomlSection(normalized, "project");
  const dependencies = project === null ? null : assignedArraySpan(project, "dependencies");
  if (dependencies !== null) {
    const kept = quotedRequirements(dependencies.text).filter(
      (requirement) => !namesEgma(requirement),
    );
    replacements.push({
      ...dependencies,
      replacement: JSON.stringify(kept),
    });
  }
  const poetry = tomlSection(normalized, "tool.poetry.dependencies");
  if (poetry !== null) {
    for (const match of poetry.text.matchAll(
      /(?:^|\n)\s*(?:egma|"egma"|'egma')\s*=\s*[^\n]+/giu,
    )) {
      const start =
        poetry.start +
        (match.index ?? 0) +
        (match[0].startsWith("\n") ? 1 : 0);
      replacements.push({
        start,
        end: poetry.start + (match.index ?? 0) + match[0].length,
        text: match[0],
        replacement: "",
      });
    }
  }
  return normalizedNonblankLines(replaceTextSpans(normalized, replacements));
}

function manifestWithoutEgma(file: RepositoryFile | DependencyCandidate): string {
  if (manifestKind(file.shown) === "pyproject") {
    return pyprojectWithoutEgma(file.source);
  }
  return normalizedNonblankLines(
    file.source
      .replace(/\r\n?/gu, "\n")
      .split("\n")
      .filter((line) => {
        const active = line.trim().replace(/\s+#.*$/u, "");
        return !namesEgma(active);
      })
      .join("\n"),
  );
}

function manifestPreservationReason(
  before: DependencyCandidate,
  after: RepositoryFile,
): string | null {
  const declarations =
    manifestKind(after.shown) === "pyproject"
      ? pyprojectEgmaDeclarations(after.source)
      : requirementsEgmaDeclarations(after.source);
  if (
    declarations.length !== 1 ||
    !registryEgmaAtLeastMinimum(declarations[0] ?? "")
  ) {
    return `Egma read ${after.shown}, but expected one registry egma>=0.2.0 dependency.`;
  }
  return manifestWithoutEgma(before) === manifestWithoutEgma(after)
    ? null
    : `Egma read ${after.shown}, but the integration changed the runtime manifest beyond one registry egma dependency.`;
}

function namesEgma(requirement: string): boolean {
  return /^\s*egma(?:\s*\[[^\]]+\])?(?:\s*$|\s*@|\s*[<>=!~;])/iu.test(requirement);
}

function pyprojectDeclaresEgma(source: string): boolean {
  const sections = tomlSections(source);
  const projectDependencies = assignedArray(sections.get("project") ?? "", "dependencies");
  if (projectDependencies !== null) {
    const strings = projectDependencies.matchAll(/(["'])(.*?)\1/gu);
    for (const match of strings) {
      if (namesEgma(match[2] ?? "")) return true;
    }
  }

  const poetry = sections.get("tool.poetry.dependencies") ?? "";
  return /(?:^|\n)\s*(?:egma|"egma"|'egma')\s*=/iu.test(poetry);
}

function requirementsDeclaresEgma(source: string): boolean {
  return source.split("\n").some((line) => {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) return false;
    const withoutComment = trimmed.replace(/\s+#.*$/u, "");
    return namesEgma(withoutComment);
  });
}

function manifestKind(file: string): "pyproject" | "requirements" | null {
  const basename = path.basename(file).toLowerCase();
  if (basename === "pyproject.toml") return "pyproject";
  if (basename === "requirements.txt") return "requirements";
  return null;
}

async function existingDependencyCandidates(
  repository: string,
  workerCanonical: string,
): Promise<readonly DependencyCandidate[]> {
  const root = await realpath(repository);
  const directories: string[] = [];
  for (
    let directory = path.dirname(workerCanonical);
    ;
    directory = path.dirname(directory)
  ) {
    const relative = path.relative(root, directory);
    if (relative.startsWith("..") || path.isAbsolute(relative)) break;
    directories.push(directory);
    if (directory === root) break;
  }

  const existingFile = async (
    file: string,
  ): Promise<RepositoryFile | null> => {
    const shown = path.relative(root, file);
    return repositoryFile(root, shown);
  };
  const pathExists = async (file: string): Promise<boolean> => {
    try {
      return (await stat(file)).isFile();
    } catch {
      return false;
    }
  };

  // `lk agent dev` stops at the first ancestor that contains a recognized
  // Python project marker. Check every directory once, in nearest-first order,
  // so a nested requirements project cannot be displaced by a parent
  // pyproject.
  for (const directory of directories) {
    const pyproject = await existingFile(path.join(directory, "pyproject.toml"));
    const hasUvLock = await pathExists(path.join(directory, "uv.lock"));
    if (hasUvLock) {
      return pyproject === null
        ? []
        : [
            {
              shown: pyproject.shown,
              canonical: pyproject.canonical,
              source: pyproject.source,
            },
          ];
    }
    const requirements = await existingFile(path.join(directory, "requirements.txt"));
    if (requirements !== null) {
      return [
        {
          shown: requirements.shown,
          canonical: requirements.canonical,
          source: requirements.source,
        },
      ];
    }
    if (pyproject !== null) {
      return [
        {
          shown: pyproject.shown,
          canonical: pyproject.canonical,
          source: pyproject.source,
        },
      ];
    }
  }
  return [];
}

function dependencyReason(file: RepositoryFile): string | null {
  const kind = manifestKind(file.shown);
  if (kind === null) {
    return `Egma cannot verify Python dependencies in ${file.shown}. Report pyproject.toml or a requirements-style manifest.`;
  }
  const declares =
    kind === "pyproject"
      ? pyprojectDeclaresEgma(file.source)
      : requirementsDeclaresEgma(file.source);
  return declares
    ? null
    : `Egma read ${file.shown}, but it does not declare the Python egma distribution.`;
}

/** Capture the real Egma hooks in the discovered worker before any edit. */
export async function snapshotWorkerIntegration(
  repository: string,
  discovered: string,
): Promise<WorkerIntegrationSnapshotResult> {
  const shown = discovered.trim();
  if (shown === "") {
    return {
      kind: "unverified",
      reason: "Egma could not snapshot the LiveKit worker before integration because discovery named no entrypoint.",
    };
  }
  const worker = await repositoryFile(repository, shown);
  if (worker === null) {
    return {
      kind: "unverified",
      reason: `Egma could not snapshot ${shown} inside this repository before integration.`,
    };
  }
  const code = pythonCode(worker.source);
  const entrypoint = contextEntrypoint(code);
  if (entrypoint === null) {
    return {
      kind: "unverified",
      reason: `Egma read ${shown} before integration, but could not identify one async job entrypoint that receives ctx.`,
    };
  }
  const dependencyCandidates = await existingDependencyCandidates(
    repository,
    worker.canonical,
  );
  if (dependencyCandidates.length === 0) {
    return {
      kind: "unverified",
      reason: `Egma found no existing Python dependency manifest on the ancestor path for ${shown}. Add the worker's runtime manifest before integration.`,
    };
  }
  return {
    kind: "snapshotted",
    snapshot: {
      file: worker.shown,
      canonical: worker.canonical,
      existing: hooksIn(code, entrypoint),
      existingCalls: hookCallCounts(code),
      source: worker.source,
      dependencyCandidates,
    },
  };
}

/** Verify the coding agent's two reported files and create the final contract. */
export async function verifyWorkerIntegrationClaim(
  repository: string,
  snapshot: WorkerIntegrationSnapshot,
  claimedWorker: string,
  claimedDependency: string,
  mode: WorkerIntegrationMode,
): Promise<WorkerIntegrationVerification> {
  const shownWorker = claimedWorker.trim();
  if (shownWorker === "") {
    return { kind: "unverified", reason: "No LiveKit worker file was named for Egma." };
  }
  if (!pathIsInsideRepository(repository, shownWorker)) {
    return {
      kind: "unverified",
      reason: `${shownWorker} is outside this repository, so Egma did not read it.`,
    };
  }
  const worker = await repositoryFile(repository, shownWorker);
  if (worker === null) {
    return {
      kind: "unverified",
      reason: `${shownWorker} is not a readable file inside this repository, so Egma did not verify it.`,
    };
  }
  if (worker.canonical !== snapshot.canonical) {
    return {
      kind: "unverified",
      reason: `The coding agent reported ${shownWorker}, but discovery found ${snapshot.file}. Egma cannot prove that existing worker behavior was preserved.`,
    };
  }

  const required = requiredHooks(snapshot.existing, mode);
  const allowedCalls = allowedHookCalls(
    snapshot.existingCalls,
    snapshot.existing,
    mode,
  );
  const workerReason = verifyWorkerSource(
    worker.shown,
    worker.source,
    required,
    snapshot.existing,
    allowedCalls,
  );
  if (workerReason !== null) return { kind: "unverified", reason: workerReason };
  const requested = requestedHooks(mode);
  const existingQualifiedImports = qualifiedEgmaImportBindings(
    pythonCode(snapshot.source),
  );
  if (
    workerWithoutRequestedEgmaIntegration(
      snapshot.source,
      requested,
      existingQualifiedImports,
    ) !==
    workerWithoutRequestedEgmaIntegration(
      worker.source,
      requested,
      existingQualifiedImports,
    )
  ) {
    return {
      kind: "unverified",
      reason: `Egma read ${worker.shown}, but the integration changed worker code outside the exact Egma imports and entry hooks.`,
    };
  }

  const shownDependency = claimedDependency.trim();
  if (shownDependency === "") {
    return {
      kind: "unverified",
      reason: "The coding agent did not report the Python dependency manifest that declares egma.",
    };
  }
  if (!pathIsInsideRepository(repository, shownDependency)) {
    return {
      kind: "unverified",
      reason: `${shownDependency} is outside this repository, so Egma did not read it.`,
    };
  }
  const dependency = await repositoryFile(repository, shownDependency);
  if (dependency === null) {
    return {
      kind: "unverified",
      reason: `${shownDependency} is not a readable dependency manifest inside this repository.`,
    };
  }
  if (
    !snapshot.dependencyCandidates.some(
      (candidate) => candidate.canonical === dependency.canonical,
    )
  ) {
    return {
      kind: "unverified",
      reason: `${shownDependency} was not the existing runtime dependency manifest for the worker before integration.`,
    };
  }
  const dependencyBefore = snapshot.dependencyCandidates.find(
    (candidate) => candidate.canonical === dependency.canonical,
  );
  if (dependencyBefore === undefined) {
    return {
      kind: "unverified",
      reason: `${shownDependency} was not the existing runtime dependency manifest for the worker before integration.`,
    };
  }
  const manifestReason = dependencyReason(dependency);
  if (manifestReason !== null) return { kind: "unverified", reason: manifestReason };
  const preservationReason = manifestPreservationReason(
    dependencyBefore,
    dependency,
  );
  if (preservationReason !== null) {
    return { kind: "unverified", reason: preservationReason };
  }

  const contract: WorkerIntegrationContract = {
    workerFile: worker.shown,
    dependencyFile: dependency.shown,
    workerCanonical: worker.canonical,
    dependencyCanonical: dependency.canonical,
    required,
    existing: snapshot.existing,
    allowedCalls,
    workerDigest: sourceDigest(worker.source),
    dependencyDigest: sourceDigest(dependency.source),
  };
  return {
    kind: "verified",
    file: worker.shown,
    dependencyFile: dependency.shown,
    contract,
  };
}

/** Re-read both files before any local worker or hosted run can start. */
export async function verifyWorkerIntegration(
  repository: string,
  contract: WorkerIntegrationContract,
): Promise<WorkerIntegrationVerification> {
  const worker = await repositoryFile(repository, contract.workerFile);
  if (worker === null || worker.canonical !== contract.workerCanonical) {
    return {
      kind: "unverified",
      reason: `Egma could no longer verify ${contract.workerFile} inside this repository.`,
    };
  }
  if (sourceDigest(worker.source) !== contract.workerDigest) {
    return {
      kind: "unverified",
      reason: `Egma read ${contract.workerFile}, but the worker changed after integration approval.`,
    };
  }
  const workerReason = verifyWorkerSource(
    worker.shown,
    worker.source,
    contract.required,
    contract.existing,
    contract.allowedCalls,
  );
  if (workerReason !== null) return { kind: "unverified", reason: workerReason };

  const dependency = await repositoryFile(repository, contract.dependencyFile);
  if (dependency === null || dependency.canonical !== contract.dependencyCanonical) {
    return {
      kind: "unverified",
      reason: `Egma could no longer verify ${contract.dependencyFile} inside this repository.`,
    };
  }
  if (sourceDigest(dependency.source) !== contract.dependencyDigest) {
    return {
      kind: "unverified",
      reason: `Egma read ${contract.dependencyFile}, but the runtime dependency manifest changed after integration approval.`,
    };
  }
  const manifestReason = dependencyReason(dependency);
  if (manifestReason !== null) return { kind: "unverified", reason: manifestReason };

  return {
    kind: "verified",
    file: worker.shown,
    dependencyFile: dependency.shown,
    contract,
  };
}
