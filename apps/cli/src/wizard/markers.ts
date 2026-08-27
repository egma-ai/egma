/**
 * The marker lines a driven coding agent reports through.
 *
 * A coding agent writes prose, and prose is not a report. So every step that
 * egma dispatches asks for its answers on marker lines: one fact per line, at
 * the start of the line, beginning `egma:`. Those become status lines and the
 * step's result. Everything else the agent says remains ordinary prose for the
 * live coding-agent activity and the task log. Marker lines are withheld from
 * that prose view because the step already renders their structured meaning.
 *
 * Four markers, and they mean the same thing in every step:
 *
 *   egma:note   <text>          something the developer should see happening
 *   egma:found  <field> <value> one fact this step was sent to find
 *   egma:none   <reason>        the agent looked and there is nothing to report
 *   egma:abort  <reason>        the agent cannot go on
 *
 * Three more belong to a step that writes files rather than reads them. They
 * are the same grammar and they are read by the same parser, because a step
 * that had a marker syntax of its own would be a second thing to learn:
 *
 *   egma:plan    <name>, <name> every test it means to write, said once, first
 *   egma:writing <name>         it has started on this one
 *   egma:wrote   <name>         this one is on disk
 *
 * `abort` is enforced here rather than trusted to the agent: egma reads the
 * line, ends the task itself, and does not wait for the agent to agree that it
 * has finished.
 *
 * The parser is forgiving about the shapes a model reaches for when it is
 * trying to be helpful — a bullet in front, backticks around, a stray capital —
 * and forgiving about nothing else. A line that is not a marker is not a fact.
 */

/** What every marker line starts with. */
export const MARKER_PREFIX = "egma:";

export type Marker =
  | { readonly kind: "note"; readonly text: string }
  | { readonly kind: "found"; readonly field: string; readonly value: string }
  | { readonly kind: "none"; readonly reason: string }
  | { readonly kind: "abort"; readonly reason: string }
  /** Everything the agent means to write, named before it writes any of it. */
  | { readonly kind: "plan"; readonly names: readonly string[] }
  | { readonly kind: "writing"; readonly name: string }
  | { readonly kind: "wrote"; readonly name: string };

/** What one line of the agent's output turned out to be. */
export type ParsedLine =
  | { readonly kind: "marker"; readonly marker: Marker }
  /** Not a marker: the log's, not the screen's. */
  | { readonly kind: "prose"; readonly text: string };

/** Leading decoration a model adds when it thinks it is formatting a list. */
const DECORATION = /^(?:[-*+>]\s+|\d+[.)]\s+)*/;

/** The whole line in bold: `**egma:found framework retell-sdk**`. */
const WHOLE_BOLD = /^(\*\*|__)([\s\S]+)\1$/;

/** Only the marker's own name in bold: `**egma:found** framework retell-sdk`. */
const LEADING_BOLD = /^(\*\*|__)([\s\S]+?)\1/;

function undecorate(line: string): string {
  let text = line.trim().replace(DECORATION, "").trim();

  // Bold is what a model reaches for when it is told to write a bare line and
  // cannot help itself. The whole line is tried first, so a value holding an
  // asterisk — `src/**/*.ts` is a good value — is not cut short by its own
  // glob.
  const bold = WHOLE_BOLD.exec(text) ?? LEADING_BOLD.exec(text);
  if (bold !== null) text = `${bold[2] as string}${text.slice(bold[0].length)}`.trim();

  // A model that has been told "no code fence" often reaches for inline code.
  if (text.startsWith("`") && text.endsWith("`") && text.length > 1) {
    text = text.slice(1, -1).trim();
  }
  return text;
}

/**
 * The test a `writing` or `wrote` line is about.
 *
 * The marker asks for a name and an agent that has just written a file often
 * gives the file instead, sometimes with a word of explanation after it. Both
 * say the same thing, so both are read: the first word is taken, a path is
 * reduced to its own last part, and `.md` comes off the end. A name egma
 * cannot make sense of is no marker at all.
 */
function testNameIn(rest: string): string | null {
  const first = rest.split(/\s/)[0] ?? "";
  const bare = first.replaceAll(/^[("'`]+|[)"'`,;:]+$/gu, "");
  const last = (bare.split(/[/\\]/).pop() ?? "").replace(/\.md$/iu, "");
  return last === "" ? null : last;
}

/** The marker on this line, or `null` when the line is not one. */
export function markerIn(line: string): Marker | null {
  const text = undecorate(line);
  if (!text.toLowerCase().startsWith(MARKER_PREFIX)) return null;

  const body = text.slice(MARKER_PREFIX.length).trim();
  const space = body.search(/\s/);
  const name = (space === -1 ? body : body.slice(0, space)).toLowerCase();
  const rest = space === -1 ? "" : body.slice(space).trim();

  switch (name) {
    case "note":
      return rest === "" ? null : { kind: "note", text: rest };
    case "none":
      return { kind: "none", reason: rest };
    case "abort":
      return { kind: "abort", reason: rest };
    case "found": {
      const gap = rest.search(/\s/);
      if (gap === -1) return null;
      const field = rest.slice(0, gap).replace(/:$/, "").toLowerCase();
      const value = rest.slice(gap).trim();
      if (field === "" || value === "") return null;
      return { kind: "found", field, value };
    }
    case "plan": {
      const names = rest
        .split(/[,;]/u)
        .map((entry) => testNameIn(entry.trim()))
        .filter((name): name is string => name !== null);
      return names.length === 0 ? null : { kind: "plan", names };
    }
    case "writing": {
      const name = testNameIn(rest);
      return name === null ? null : { kind: "writing", name };
    }
    case "wrote": {
      const name = testNameIn(rest);
      return name === null ? null : { kind: "wrote", name };
    }
    default:
      return null;
  }
}

/**
 * A marker welded onto the end of the line before it.
 *
 * An agent's words arrive in pieces, and the piece before a marker sometimes
 * ends without the line ending that was meant to follow it — so a line of prose
 * and the marker after it become one line, and the marker is lost. A marker
 * pressed straight against the end of a sentence is never how anyone writes
 * one, so it is read as the line break that went missing.
 *
 * The split fires only where a lost line ending is the plausible explanation:
 * after a word character, a full stop or a comma. It never fires after a
 * backtick, a bracket, a quote or an asterisk, because those are how a person
 * writes *about* a marker — `` `egma:found framework retell-sdk` `` in a
 * sentence is somebody explaining the format, and splitting there turns the
 * rest of their sentence into a fact egma never found. A marker with a space
 * in front of it is left alone for the same reason.
 *
 * What may sit between the two is the decoration the next line would have
 * carried anyway: a model that writes `**egma:found** …` writes it that way
 * whether or not the line ending survived.
 */
const WELDED_MARKER = /(?<=[\w.,])(?=(?:\*\*|__|`)?egma:)/gi;

/**
 * Two inline-code marker lines whose ACP boundary lost its line ending.
 *
 * Claude commonly wraps each required marker in one backtick pair. When ACP
 * joins two chunks without the newline between them, the closing backtick of
 * the first marker touches the opening backtick of the next:
 *
 *   `egma:writing one``egma:wrote one`
 *
 * Split that exact shape only when the logical line itself starts as an
 * inline-code marker. A sentence that merely quotes the same words stays
 * prose, so this cannot turn an explanation into a reported fact.
 */
function splitAdjacentInlineMarkers(text: string): string {
  return text
    .split("\n")
    .map((line) => {
      const start = line.trim().replace(DECORATION, "").trimStart();
      if (!start.toLowerCase().startsWith("`egma:")) return line;
      return line.replace(
        /`(?=`egma:(?:note|found|none|abort|plan|writing|wrote)\b)/giu,
        "`\n",
      );
    })
    .join("\n");
}

/**
 * The agent's words as they arrive, split into markers and everything else.
 *
 * Text arrives in pieces that do not respect line endings, so a line is only
 * read once it is whole. Whatever is left over when the turn ends is read by
 * `flush` — an agent's last line often arrives without one.
 */
export class MarkerStream {
  private pending = "";

  /** Everything that has become whole since the last call. */
  push(chunk: string): ParsedLine[] {
    this.pending = splitAdjacentInlineMarkers(this.pending + chunk).replace(
      WELDED_MARKER,
      "\n",
    );
    const parts = this.pending.split("\n");
    this.pending = parts.pop() ?? "";
    return parts.map(read);
  }

  /** The last line, if the agent stopped without ending it. */
  flush(): ParsedLine[] {
    if (this.pending.trim() === "") {
      this.pending = "";
      return [];
    }
    const last = read(this.pending);
    this.pending = "";
    return [last];
  }
}

function read(line: string): ParsedLine {
  const marker = markerIn(line);
  return marker === null ? { kind: "prose", text: line } : { kind: "marker", marker };
}
