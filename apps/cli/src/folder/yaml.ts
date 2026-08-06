/**
 * The small piece of YAML egma's own two files are written in, read and written
 * here and nowhere else.
 *
 * Two files need it: the folder's `config.yaml`, which is a mapping of mappings
 * two levels deep, and the frontmatter of a test file, which is a mapping of
 * scalars and one list. That is the whole language — no anchors, no multi-line
 * scalars, no lists of mappings — and this reads exactly that and refuses the
 * rest by name and line number.
 *
 * It is written rather than depended on for two reasons. The first is that
 * `npx egma` is the first thing a developer runs, so every dependency is
 * download time before anything happens. The second matters more: `pull`
 * immediately after `push` has to change zero bytes, and that is a promise about
 * output, not about a parse tree. Writing the bytes here is what lets it be
 * kept, because nothing between the value and the file is free to reformat.
 */

/** Everything a value in one of egma's files can be. */
export type YamlValue = string | readonly string[] | YamlMapping | null;

export type YamlMapping = { readonly [key: string]: YamlValue };

/** A file egma could not read, said with enough to go and fix it. */
export class YamlProblem extends Error {
  readonly where: string;
  readonly line: number;

  constructor(where: string, line: number, said: string) {
    super(`${where}, line ${line}: ${said}`);
    this.name = "YamlProblem";
    this.where = where;
    this.line = line;
  }
}

type Line = {
  /** How many spaces the line starts with. */
  readonly indent: number;
  readonly text: string;
  /** Counted from one, as an editor counts. */
  readonly number: number;
};

/**
 * The line with any comment taken off the end.
 *
 * A `#` only starts a comment when it opens the line or follows a space, which
 * is YAML's own rule and the one that keeps `name: shift#2` a name. Quoted text
 * is stepped over, so a `#` inside quotes stays where it was written.
 */
function withoutComment(raw: string): string {
  let quote: string | null = null;
  for (let at = 0; at < raw.length; at += 1) {
    const character = raw[at] as string;
    if (quote !== null) {
      if (character === quote) quote = null;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === "#" && (at === 0 || raw[at - 1] === " " || raw[at - 1] === "\t")) {
      return raw.slice(0, at);
    }
  }
  return raw;
}

function meaningfulLines(document: string): Line[] {
  const lines: Line[] = [];
  document.split("\n").forEach((raw, index) => {
    const withoutTail = withoutComment(raw).replace(/\s+$/u, "");
    if (withoutTail.trim() === "") return;
    lines.push({
      indent: withoutTail.length - withoutTail.trimStart().length,
      text: withoutTail.trimStart(),
      number: index + 1,
    });
  });
  return lines;
}

/** A quoted string, unquoted. */
function unquote(raw: string, where: string, line: number): string {
  const quote = raw[0] as string;
  if (raw.length < 2 || !raw.endsWith(quote)) {
    throw new YamlProblem(where, line, "a quoted value that never closes its quote");
  }
  const inside = raw.slice(1, -1);
  if (quote === "'") return inside.replaceAll("''", "'");
  try {
    return JSON.parse(`"${inside}"`) as string;
  } catch {
    throw new YamlProblem(where, line, "a quoted value egma could not read");
  }
}

function scalar(raw: string, where: string, line: number): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith('"') || trimmed.startsWith("'")) {
    return unquote(trimmed, where, line);
  }
  return trimmed;
}

/** `[a, b, c]`, which is the only kind of list these files hold. */
function flowList(raw: string, where: string, line: number): readonly string[] {
  const inside = raw.slice(1, -1).trim();
  if (inside === "") return [];

  const items: string[] = [];
  let start = 0;
  let quote: string | null = null;
  for (let at = 0; at <= inside.length; at += 1) {
    const character = inside[at];
    if (quote !== null) {
      if (character === quote) quote = null;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === undefined || character === ",") {
      items.push(scalar(inside.slice(start, at), where, line));
      start = at + 1;
    }
  }
  if (quote !== null) {
    throw new YamlProblem(where, line, "a list with a quote that never closes");
  }
  return items;
}

function valueOf(raw: string, where: string, line: number): YamlValue {
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  if (trimmed.startsWith("[")) {
    if (!trimmed.endsWith("]")) {
      throw new YamlProblem(where, line, "a list that never closes its bracket");
    }
    return flowList(trimmed, where, line);
  }
  if (trimmed === "null" || trimmed === "~") return null;
  return scalar(trimmed, where, line);
}

/**
 * One block of `key: value` lines at one indentation, and whatever is indented
 * under a key that names nothing on its own line.
 */
function mappingAt(
  lines: readonly Line[],
  from: number,
  indent: number,
  where: string,
): { readonly mapping: YamlMapping; readonly next: number } {
  const mapping: Record<string, YamlValue> = {};
  let at = from;

  while (at < lines.length) {
    const line = lines[at] as Line;
    if (line.indent < indent) break;
    if (line.indent > indent) {
      throw new YamlProblem(
        where,
        line.number,
        "this line is indented further than the line above it leads egma to expect",
      );
    }

    const separator = line.text.indexOf(":");
    if (separator <= 0) {
      throw new YamlProblem(
        where,
        line.number,
        "egma reads these files as plain name: value lines, and this line is not one",
      );
    }

    const key = line.text.slice(0, separator).trim();
    const rest = line.text.slice(separator + 1);
    at += 1;

    const nested = lines[at];
    if (rest.trim() === "" && nested !== undefined && nested.indent > indent) {
      const under = mappingAt(lines, at, nested.indent, where);
      mapping[key] = under.mapping;
      at = under.next;
      continue;
    }

    mapping[key] = valueOf(rest, where, line.number);
  }

  return { mapping, next: at };
}

/**
 * Read one of egma's files. `where` names the file in anything this refuses,
 * because the developer who has to fix it is looking at a folder of them.
 */
export function readYaml(document: string, where: string): YamlMapping {
  const lines = meaningfulLines(document);
  if (lines.length === 0) return {};
  const first = lines[0] as Line;
  return mappingAt(lines, 0, first.indent, where).mapping;
}

/** The values that mean something other than themselves when written bare. */
const RESERVED = new Set(["true", "false", "null", "yes", "no", "on", "off", "~", "-"]);

/**
 * The one extra thing a value may not hold when it is written inside `[…]`.
 *
 * A list is read by splitting on commas and stepping over quotes, so an item
 * carrying either of those comes back as two items, or as a quote that never
 * closes. A persona called `impatient, rushed` is one persona and has to read
 * back as one.
 */
const READS_AS_LIST_PUNCTUATION = /[,[\]{}'"]/u;

/**
 * A string as a value in one of these files: bare where bare is unambiguous,
 * and double-quoted where it is not.
 *
 * The rule errs towards quoting. A value that reads back as itself is the whole
 * job, and a quoted string always does; a bare one only does when nothing in it
 * is YAML punctuation.
 */
export function yamlScalar(value: string): string {
  const needsQuotes =
    value === "" ||
    value !== value.trim() ||
    RESERVED.has(value.toLowerCase()) ||
    /^[-?:,[\]{}#&*!|>'"%@`]/u.test(value) ||
    /:\s|\s#|[\n\r\t]/u.test(value) ||
    value.endsWith(":") ||
    /^[+-]?(\d|\.\d)/u.test(value);
  return needsQuotes ? JSON.stringify(value) : value;
}

/** `[a, b, c]`, written the way this module reads it back. */
export function yamlFlowList(values: readonly string[]): string {
  const written = values.map((value) =>
    READS_AS_LIST_PUNCTUATION.test(value) ? JSON.stringify(value) : yamlScalar(value),
  );
  return `[${written.join(", ")}]`;
}

/**
 * A mapping's value as a string, or `null` when it is anything else.
 *
 * The value comes back exactly as it was written. A bare one had its
 * surrounding spaces taken off when it was read, which is YAML's own rule for a
 * bare value; a quoted one asked for the spaces it has and keeps them, so a
 * name egma wrote quoted is the name egma reads back.
 */
export function textAt(mapping: YamlMapping, key: string): string | null {
  const value = mapping[key];
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

/** A mapping's value as a list of strings; anything else reads as empty. */
export function listAt(mapping: YamlMapping, key: string): readonly string[] {
  const value = mapping[key];
  if (Array.isArray(value)) {
    return (value as readonly string[]).filter((item) => item.trim() !== "");
  }
  // One name written bare is what a person types when there is only one, and
  // reading it as that one name is kinder than refusing the file.
  return typeof value === "string" && value.trim() !== "" ? [value] : [];
}

/** A mapping's value as a mapping, or `null` when the key names nothing. */
export function mappingAtKey(mapping: YamlMapping, key: string): YamlMapping | null {
  const value = mapping[key];
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as YamlMapping)
    : null;
}
