/**
 * The marker lines a driven coding agent reports through.
 *
 * A coding agent writes prose, and prose is not a report. So every step that
 * egma dispatches asks for its answers on marker lines: one fact per line, at
 * the start of the line, beginning `egma:`. Those become status lines and the
 * step's result. Everything else the agent says is kept in the log and never
 * put on screen, because a wall of text is not visibility.
 *
 * Four markers, and they mean the same thing in every step:
 *
 *   egma:note   <text>          something the developer should see happening
 *   egma:found  <field> <value> one fact this step was sent to find
 *   egma:none   <reason>        the agent looked and there is nothing to report
 *   egma:abort  <reason>        the agent cannot go on
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
  | { readonly kind: "abort"; readonly reason: string };

/** What one line of the agent's output turned out to be. */
export type ParsedLine =
  | { readonly kind: "marker"; readonly marker: Marker }
  /** Not a marker: the log's, not the screen's. */
  | { readonly kind: "prose"; readonly text: string };

/** Leading decoration a model adds when it thinks it is formatting a list. */
const DECORATION = /^(?:[-*+>]\s+|\d+[.)]\s+)*/;

function undecorate(line: string): string {
  let text = line.trim().replace(DECORATION, "").trim();
  // A model that has been told "no code fence" often reaches for inline code.
  if (text.startsWith("`") && text.endsWith("`") && text.length > 1) {
    text = text.slice(1, -1).trim();
  }
  return text;
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
 * pressed straight against a word with no space is never how anyone writes a
 * sentence, so it is read as the line break that went missing. A marker with a
 * space in front of it is left alone: that is somebody talking about markers,
 * and talking about one does not make one.
 */
const WELDED_MARKER = /(?<=\S)(?=egma:)/gi;

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
    this.pending = (this.pending + chunk).replace(WELDED_MARKER, "\n");
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
