/**
 * The small piece of YAML egma's own two files are written in, read and written
 * here and nowhere else.
 *
 * Two files need it: the folder's `config.yaml`, which is a mapping of mappings
 * two levels deep, and the frontmatter of a test file, which is a mapping of
 * scalars, one flow list, and one block sequence of small mappings — the
 * personas, which carry a stable identifier and the display name a reviewer
 * reads beside it. That is the whole language — no anchors, no multi-line
 * scalars, nothing nested inside a sequence item — and this reads exactly that
 * and refuses the rest by name and line number.
 *
 * It is written rather than depended on for two reasons. The first is that
 * `egma` is the first thing a developer runs, so every dependency is
 * download time before anything happens. The second matters more: `pull`
 * immediately after `push` has to change zero bytes, and that is a promise about
 * output, not about a parse tree. Writing the bytes here is what lets it be
 * kept, because nothing between the value and the file is free to reformat.
 */

/**
 * A list, however it was written: `[a, b]` gives text, and a block of `- `
 * lines gives text or a small mapping depending on what each item says.
 */
export type YamlScalar = string | number | boolean;
export type YamlSequence = readonly (YamlScalar | YamlMapping)[];

/** Everything a value in one of egma's files can be. */
export type YamlValue = YamlScalar | YamlSequence | YamlMapping | null;

export type YamlMapping = { readonly [key: string]: YamlValue };

/** A file egma could not read, said with enough to go and fix it. */
import { FolderProblem } from "./problem.ts";

export class YamlProblem extends FolderProblem {
  readonly line: number;

  constructor(where: string, line: number, said: string) {
    super(where, `${where}, line ${String(line)}: ${said}`);
    this.name = "YamlProblem";
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
      if (quote === '"' && character === "\\") {
        // Egma writes double-quoted YAML through JSON.stringify. The byte
        // after a backslash is part of that quoted scalar, even when it is a
        // quote. Skipping it keeps a later `#` inside the same scalar instead
        // of mistaking it for a comment.
        at += 1;
        continue;
      }
      if (quote === "'" && character === "'" && raw[at + 1] === "'") {
        // YAML escapes a quote inside a single-quoted scalar by doubling it.
        at += 1;
        continue;
      }
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
    throw new YamlProblem(where, line, "a quoted value Egma could not read");
  }
}

function scalar(raw: string, where: string, line: number): YamlScalar {
  const trimmed = raw.trim();
  if (trimmed.startsWith('"') || trimmed.startsWith("'")) {
    return unquote(trimmed, where, line);
  }
  if (/^(?:true|false)$/iu.test(trimmed)) return trimmed.toLowerCase() === "true";
  if (
    /^[+-]?(?:(?:0|[1-9]\d*)(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/iu.test(trimmed)
  ) {
    const number = Number(trimmed);
    if (Number.isFinite(number)) return number;
  }
  return trimmed;
}

/** `[a, b, c]`, which is the only kind of list these files hold. */
function flowList(raw: string, where: string, line: number): readonly YamlScalar[] {
  const inside = raw.slice(1, -1).trim();
  if (inside === "") return [];

  const items: YamlScalar[] = [];
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

/** Whether a line opens an item of a block sequence. */
function opensAnItem(text: string): boolean {
  return text === "-" || text.startsWith("- ");
}

/**
 * A block of `- ` items under a key that named nothing on its own line.
 *
 * Each item is either one scalar — `- impatient-caller`, which is what somebody
 * types by hand — or a small mapping written on the `- ` line and continued on
 * the lines indented under it:
 *
 * ```yaml
 * personas:
 *   - id: prs_01EXAMPLE
 *     name: Impatient customer
 * ```
 *
 * A mapping item may itself contain another mapping or sequence. The config
 * file uses that one extra level for an agent's connections. Scalar items stay
 * scalar, and every nested value is still read through the same small YAML
 * grammar as the rest of the folder.
 */
function blockSequenceAt(
  lines: readonly Line[],
  from: number,
  indent: number,
  where: string,
): { readonly sequence: YamlSequence; readonly next: number } {
  const sequence: (YamlScalar | YamlMapping)[] = [];
  let at = from;

  while (at < lines.length) {
    const line = lines[at] as Line;
    if (line.indent !== indent || !opensAnItem(line.text)) break;
    at += 1;

    const opening = line.text.slice(1).trim();
    // Everything indented past the dash belongs to this item, up to the next
    // item in this sequence. `mappingAt` below decides whether those lines are
    // a nested mapping or a nested sequence opened by one of its keys.
    const under: Line[] = [];
    while (at < lines.length) {
      const next = lines[at] as Line;
      if (next.indent <= indent) break;
      under.push(next);
      at += 1;
    }

    const separator = opening.indexOf(":");
    if (separator <= 0) {
      if (under.length > 0) {
        throw new YamlProblem(
          where,
          line.number,
          "Egma reads these files as plain name: value lines, and this line is not one",
        );
      }
      sequence.push(opening === "" ? "" : scalar(opening, where, line.number));
      continue;
    }

    // The dash line and whatever is under it are one mapping. It is read by
    // the same function every other mapping goes through, so a quoted value or
    // a comment on one of these lines means exactly what it means everywhere
    // else in the file.
    const first: Line = {
      indent: under[0]?.indent ?? indent + 2,
      text: opening,
      number: line.number,
    };
    sequence.push(mappingAt([first, ...under], 0, first.indent, where).mapping);
  }

  return { sequence, next: at };
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
        "this line is indented further than the line above it leads Egma to expect",
      );
    }

    const separator = line.text.indexOf(":");
    if (separator <= 0) {
      throw new YamlProblem(
        where,
        line.number,
        "Egma reads these files as plain name: value lines, and this line is not one",
      );
    }

    const key = line.text.slice(0, separator).trim();
    const rest = line.text.slice(separator + 1);
    if (Object.prototype.hasOwnProperty.call(mapping, key)) {
      throw new YamlProblem(where, line.number, `the key ${key} is written more than once`);
    }
    at += 1;

    const nested = lines[at];
    if (rest.trim() === "" && nested !== undefined && opensAnItem(nested.text)) {
      // A `- ` block may be written under the key or level with it — both are
      // YAML and both are what somebody types — so the sequence is recognised
      // by the dash rather than by how far it is indented.
      if (nested.indent >= indent) {
        const items = blockSequenceAt(lines, at, nested.indent, where);
        mapping[key] = items.sequence;
        at = items.next;
        continue;
      }
    }
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
  const read = mappingAt(lines, 0, first.indent, where);
  if (read.next !== lines.length) {
    const unconsumed = lines[read.next] as Line;
    throw new YamlProblem(
      where,
      unconsumed.number,
      "this line is outside the top-level mapping that begins the file",
    );
  }
  return read.mapping;
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

/**
 * A mapping's value as a list, however it was written, with each item left as
 * the text or the small mapping it is. A key naming nothing reads as empty.
 */
export function sequenceAt(mapping: YamlMapping, key: string): YamlSequence {
  const value = mapping[key];
  if (Array.isArray(value)) return value as YamlSequence;
  return typeof value === "string" && value.trim() !== "" ? [value] : [];
}

/** A mapping's value as a list of strings; anything else reads as empty. */
export function listAt(mapping: YamlMapping, key: string): readonly string[] {
  const value = mapping[key];
  if (Array.isArray(value)) {
    return (value as YamlSequence).filter(
      (item): item is string => typeof item === "string" && item.trim() !== "",
    );
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
