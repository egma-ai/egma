"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ComponentProps,
  type ReactNode,
} from "react";
import {
  createTest,
  deleteTest,
  listPersonas,
  updateTest,
} from "@egma/platform-api/client";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { cn } from "@/lib/utils";
import {
  platformAnswer,
  platformClient,
} from "../../../../lib/platform-client.ts";
import type { ListedTest } from "../../../../lib/tests.ts";
import { Dialog } from "../../../../ui/dialog.tsx";
import { DestructiveItem, MenuReason, RowMenu } from "../../../../ui/row-menu.tsx";
import { ConfirmDialog } from "./parts.tsx";

/**
 * The suite's tests, as a spreadsheet.
 *
 * **The grid has one grammar, and the founder wrote it on 2026-08-24: editing
 * saves itself cell by cell; creating asks once and cannot fire early.** An
 * existing test is four cells that each commit alone, so changing a scenario is
 * one click, one blur and one request carrying one field. A new test is an
 * entry row with a commit bar, because there is no honest way to save a quarter
 * of a test — a test with no persona, or no behavior, is not a test that can
 * run, and a row that saved itself a field at a time would have to invent the
 * rest.
 *
 * All four fields are mandatory: name, scenario, at least one expected
 * behavior, at least one persona. The platform holds the same four; this screen
 * says so before the request rather than after it, and repeats the platform's
 * own sentence when a request is refused anyway.
 *
 * **The save grammar, whole.** Every rule below exists because a version
 * guard makes two saves of one test contend, and because a request is awaited
 * while a person keeps typing. Four rules, and together they close the family:
 *
 * 1. **Different tests save in parallel; one test saves in order.** Separate
 *    rows carry separate guards, so they cannot contend. Two cells of one test
 *    would carry the same version, so they queue, and a queued save reads its
 *    version or revision when it is sent — from the answer the save in front
 *    of it received, never from the render that started it.
 * 2. **A wake seeds from the newest intent.** The stored row, with any
 *    unfinished save of it laid over the top, because the row still shows what
 *    that save is replacing.
 * 3. **An answer closes only its own session, and only over what it sent.**
 *    Leaving a cell and returning is a new session, so a late answer from the
 *    old one neither closes it nor speaks into it; and pressing Enter and
 *    carrying on typing never leaves the session, so the draft itself is what
 *    says the answer has been overtaken.
 * 4. **A commit is dropped only when it is an identical resubmit** — the blur
 *    that follows an Enter. Anything a person actually changed queues.
 *
 * What that buys is one sentence: a version conflict can only be a write this
 * client did not make, so the refusal in the cell means another person moved
 * the test, and it is never about something the person in front of it did.
 *
 * The look is `LNC-0`, `LUT-0` and boards 10–14 of Paper page 04B: a Pure Paper
 * panel inside one hairline, hairlines between every cell, a woken cell inside
 * a 2px ink edge, add-affordances only on the woken cell, and a ghost row at
 * the foot that opens the entry row.
 */

/** A persona as a cell needs it: an id to send and a name to show. */
type Named = { readonly id: string; readonly name: string };

/** What a cell is, which is also which field one save carries. */
type Field = "name" | "scenario" | "expectedBehaviors" | "personas";

/** One woken cell: which test's, and which of its four fields. */
type Woken = { readonly testId: string; readonly field: Field };

/**
 * One edit session: a cell, and *which time* it was woken.
 *
 * **The cell is not the identity a late answer needs.** Leaving a cell and
 * coming back to it is a new session over the same two coordinates, so a save
 * still in flight from the first one would match the second on `testId` and
 * `field` and clear a draft somebody is in the middle of typing. `at` is what
 * tells the two apart: a counter that moves on every wake, so a session is
 * only ever itself.
 */
type Session = Woken & { readonly at: number };

/** Content fields mint a version; the name is identity and mints a revision. */
function isContent(field: Field): boolean {
  return field !== "name";
}

/** The four columns, at the proportions `LNC-0` draws them. */
const COLUMNS: readonly {
  readonly field: Field;
  readonly header: string;
  readonly width: string;
}[] = [
  { field: "name", header: "Name", width: "16.3%" },
  { field: "scenario", header: "Scenario", width: "34.2%" },
  { field: "expectedBehaviors", header: "Expected behaviors", width: "34.2%" },
  { field: "personas", header: "Personas", width: "15.2%" },
];

const CELL = "border-r border-b border-border p-0 align-top last:border-r-0";
/*
 * **The row's own ⋮ lane, and it is not a fifth column.** The four columns are
 * the test's content; this is the house table's fixed `--table-action-width`
 * slot, which every row of every list in the product carries so the triggers
 * line up in one lane. The boards are silent on it, so the current screen's
 * verb stays: a test is deleted from its row.
 */
const ACTION = "w-(--table-action-width) border-b border-border p-0 text-center align-top";
const PAD = "px-2.5 py-2";
const TEXT = "text-sm leading-(--line-caption) text-foreground";
/*
 * A woken cell wears its 2px ink edge as an inset shadow rather than a border,
 * so waking one moves nothing: a border would take two pixels out of the cell
 * and shove every word in the row sideways. Only the shadow transitions, and
 * only over `--duration-hover`.
 */
const WOKEN =
  "shadow-[inset_0_0_0_2px_var(--border-strong)] transition-shadow duration-(--duration-hover) ease-out motion-reduce:transition-none";
const QUIET_INPUT =
  "w-full resize-none border-0 bg-transparent p-0 text-sm leading-(--line-caption) text-foreground outline-none placeholder:text-faint";

/** The ember affordance a woken cell grows, and nothing else on the screen. */
const ADD_LINE =
  "cursor-pointer bg-transparent p-0 text-left text-sm leading-(--line-caption) text-primary underline-offset-4 pointer-hover:underline";

type Draft = {
  readonly name: string;
  readonly scenario: string;
  readonly expectedBehaviors: readonly string[];
  readonly personas: readonly string[];
};

const EMPTY_DRAFT: Draft = {
  name: "",
  scenario: "",
  expectedBehaviors: [""],
  personas: [],
};

function draftOf(test: ListedTest): Draft {
  return {
    name: test.name,
    scenario: test.scenario,
    expectedBehaviors: [...test.expectedBehaviors],
    personas: test.personas.map((persona) => persona.id),
  };
}

function trimmedBehaviors(behaviors: readonly string[]): readonly string[] {
  return behaviors.map((one) => one.trim()).filter((one) => one !== "");
}

/** Whether two committed values say the same thing, of whichever shape. */
function sameSent(
  left: string | readonly string[],
  right: string | readonly string[],
): boolean {
  if (typeof left === "string" || typeof right === "string") return left === right;
  return sameList(left, right);
}

/** Whether a draft still says exactly what a finished save carried. */
function holdsWhatWasSent(
  held: Draft | null,
  field: Field,
  sent: string | readonly string[],
): boolean {
  if (held === null) return false;
  if (field === "name") return held.name.trim() === sent;
  if (field === "scenario") return held.scenario.trim() === sent;
  if (field === "expectedBehaviors") {
    return sameList(trimmedBehaviors(held.expectedBehaviors), sent as readonly string[]);
  }
  return sameList(held.personas, sent as readonly string[]);
}

function sameList(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((one, at) => one === right[at]);
}

/**
 * The one sentence a disabled Save carries, naming exactly what is missing.
 *
 * It is rebuilt on every keystroke, so it shortens as the row fills and
 * disappears when the row is whole. Two missing things read "A and B"; three or
 * more take the serial comma, which is what `LZY-0` draws.
 */
export function whatIsMissing(draft: Draft): string | null {
  const missing: string[] = [];
  if (draft.name.trim() === "") missing.push("a name");
  if (draft.scenario.trim() === "") missing.push("a scenario");
  if (trimmedBehaviors(draft.expectedBehaviors).length === 0) {
    missing.push("one expected behavior");
  }
  if (draft.personas.length === 0) missing.push("one persona");
  if (missing.length === 0) return null;
  if (missing.length === 1) return `Needs ${String(missing[0])}.`;
  if (missing.length === 2) {
    return `Needs ${String(missing[0])} and ${String(missing[1])}.`;
  }
  const last = missing[missing.length - 1] ?? "";
  return `Needs ${missing.slice(0, -1).join(", ")}, and ${last}.`;
}

/** Why one field's save is refused before it is sent. Mandatory means empty. */
function whyFieldRefuses(field: Field, draft: Draft): string | null {
  if (field === "name" && draft.name.trim() === "") {
    return "A test needs a name. The stored name stands.";
  }
  if (field === "scenario" && draft.scenario.trim() === "") {
    return "A test needs a scenario: the situation the agent is put in. The stored scenario stands.";
  }
  if (
    field === "expectedBehaviors" &&
    trimmedBehaviors(draft.expectedBehaviors).length === 0
  ) {
    return "A test needs at least one expected behavior, because a test that cannot fail is not a test. The stored behaviors stand.";
  }
  if (field === "personas" && draft.personas.length === 0) {
    return "A test needs at least one persona, because a test says who calls. The stored personas stand.";
  }
  return null;
}

/** A surface that arrives on mount, and simply exists under reduced motion. */
function Arriving({
  className,
  children,
  ...rest
}: ComponentProps<"div">) {
  const [here, setHere] = useState(false);
  useEffect(() => {
    const frame = window.requestAnimationFrame(() => setHere(true));
    return () => window.cancelAnimationFrame(frame);
  }, []);
  return (
    <div
      className={cn(
        "transition-[opacity,transform] duration-(--duration-popover-in) ease-out motion-reduce:transition-none",
        here ? "translate-y-0 scale-100 opacity-100" : "-translate-y-0.5 scale-[0.98] opacity-0",
        className,
      )}
      {...rest}
    >
      {children}
    </div>
  );
}

/**
 * The persona picker, and this is its only home.
 *
 * It opens inside the woken Personas cell — search, checkboxes, Done — because
 * the cell is where the answer is read. Personas arrive once per open and are
 * narrowed in the browser, which is what the list does everywhere else on this
 * screen.
 */
function PersonaPicker({
  projectId,
  chosen,
  known,
  onChange,
  onDone,
}: {
  readonly projectId: string;
  readonly chosen: readonly string[];
  readonly known: ReadonlyMap<string, Named>;
  readonly onChange: (ids: readonly string[], named: ReadonlyMap<string, Named>) => void;
  readonly onDone: () => void;
}) {
  const [search, setSearch] = useState("");
  const [people, setPeople] = useState<readonly Named[] | null>(null);
  const [refused, setRefused] = useState<string | null>(null);
  /** Whether egma holds more than this picker read. Said out loud if so. */
  const [truncated, setTruncated] = useState(false);
  /** The newest way out, so the listener below never closes over a stale one. */
  const done = useRef(onDone);
  useEffect(() => {
    done.current = onDone;
  });

  /*
   * **A click anywhere else closes this picker, and it closes it the way Done
   * does** — the choices ticked so far are kept, because ticking a checkbox has
   * already changed the draft. A picker that stayed open under a click that
   * plainly meant "elsewhere" left the only way out a button somebody had to
   * find, which is the defect the founder named on 2026-08-25.
   *
   * `mousedown` rather than `click`, so the close happens before focus moves —
   * the same instant Done would have. The lane marked `data-persona-picker` is
   * this surface *and* the "+ Add a persona" trigger, so pressing the trigger
   * to shut the picker is not read as an outside click and then re-opened.
   */
  useEffect(() => {
    function elsewhere(event: MouseEvent): void {
      const target = event.target;
      if (
        target instanceof Element &&
        target.closest("[data-persona-picker]") !== null
      ) {
        return;
      }
      done.current();
    }
    document.addEventListener("mousedown", elsewhere);
    return () => document.removeEventListener("mousedown", elsewhere);
  }, []);

  /*
   * **Every persona the project holds, not the first page of them.**
   * `listPersonas` answers a page at a time, and the search below runs in the
   * browser — so reading one page would hide every later persona from a picker
   * whose whole job is finding one. The pages are followed to the end, bounded,
   * and if the bound is ever reached the picker says so rather than presenting
   * a short list as the whole list.
   */
  useEffect(() => {
    let live = true;
    const PAGES_AT_MOST = 20;

    async function readEveryone(): Promise<void> {
      const held: Named[] = [];
      let pageToken: string | undefined;
      for (let page = 0; page < PAGES_AT_MOST; page += 1) {
        const answer = await platformAnswer(
          listPersonas(
            { projectId, ...(pageToken === undefined ? {} : { pageToken }) },
            { client: platformClient },
          ),
        );
        if (!live) return;
        if (answer.status === "signed-out") {
          window.location.replace("/sign-in");
          return;
        }
        if (answer.status !== "ready") {
          setRefused(answer.refusal.message);
          return;
        }
        held.push(
          ...answer.value.personas.map((one) => ({ id: one.id, name: one.name })),
        );
        const next = answer.value.nextPageToken;
        if (next === null) {
          setPeople(held);
          return;
        }
        pageToken = next;
        // Show what has arrived while the rest is still coming, so a long list
        // is usable before it is complete.
        setPeople([...held]);
      }
      if (!live) return;
      setPeople(held);
      setTruncated(true);
    }

    void readEveryone();
  }, [projectId]);

  const wanted = search.trim().toLocaleLowerCase();
  const listed = (people ?? []).filter(
    (one) => wanted === "" || one.name.toLocaleLowerCase().includes(wanted),
  );

  function toggle(one: Named): void {
    const next = chosen.includes(one.id)
      ? chosen.filter((id) => id !== one.id)
      : [...chosen, one.id];
    const named = new Map(known);
    named.set(one.id, one);
    onChange(next, named);
  }

  return (
    <Arriving
      className="absolute top-full left-0 z-20 mt-1 w-[300px] origin-top border border-border bg-surface shadow-popover"
      role="dialog"
      aria-label="Choose personas"
      data-persona-picker=""
    >
      <div className="border-b border-border">
        <input
          className={cn(QUIET_INPUT, "h-9 px-2.5")}
          aria-label="Search personas"
          placeholder="Search personas"
          value={search}
          autoComplete="off"
          onChange={(event) => setSearch(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.stopPropagation();
              onDone();
            }
          }}
        />
      </div>
      <div className="max-h-[240px] overflow-y-auto">
        {refused !== null ? (
          <p className="m-0 px-2.5 py-2 text-sm text-failure">{refused}</p>
        ) : people === null ? (
          <p className="m-0 px-2.5 py-2 text-sm text-muted-foreground">
            Loading personas…
          </p>
        ) : listed.length === 0 ? (
          <p className="m-0 px-2.5 py-2 text-sm text-muted-foreground">
            {wanted === ""
              ? "This project has no personas yet."
              : `No personas match “${search.trim()}”.`}
          </p>
        ) : (
          listed.map((one) => (
            <label
              className="flex min-h-9 cursor-pointer items-center gap-2.5 px-2.5 text-sm text-foreground pointer-hover:bg-surface-soft"
              key={one.id}
            >
              <Checkbox
                checked={chosen.includes(one.id)}
                onChange={() => toggle(one)}
              />
              <span className="min-w-0 truncate">{one.name}</span>
            </label>
          ))
        )}
      </div>
      {truncated ? (
        // The search below runs in the browser, so it reaches what was read
        // and nothing beyond it. The sentence says that rather than promising
        // a search that would quietly come back empty.
        <p className="m-0 border-t border-border px-2.5 py-1.5 text-sm text-muted-foreground">
          Egma holds more personas than this list read.
        </p>
      ) : null}
      <div className="flex justify-end border-t border-border px-2.5 py-1.5">
        <button className={cn(ADD_LINE, "underline")} type="button" onClick={onDone}>
          Done
        </button>
      </div>
    </Arriving>
  );
}

/**
 * The lines a cell keeps once nobody is typing into them.
 *
 * A numbered line with nothing on it is scaffolding, not a behavior, so it
 * never survives a commit: the platform is sent the trimmed list either way,
 * and the cell must not go on drawing a line 3 that says nothing.
 */
function withoutTrailingBlanks(behaviors: readonly string[]): readonly string[] {
  let end = behaviors.length;
  while (end > 1 && (behaviors[end - 1] ?? "").trim() === "") end -= 1;
  return behaviors.slice(0, end);
}

/** The behaviors of one cell, as numbered lines with one caret at a time. */
function BehaviorLines({
  behaviors,
  onChange,
  onCommit,
  onCancel,
}: {
  readonly behaviors: readonly string[];
  readonly onChange: (next: readonly string[]) => void;
  readonly onCommit: () => void;
  readonly onCancel: () => void;
}) {
  const lines = useRef<(HTMLInputElement | null)[]>([]);
  /**
   * Which line the caret is owed, and it is always a line that just moved.
   *
   * Adding a line and deleting one are the same problem seen twice: the caret
   * has to land on a line the render after this one draws. Holding the index
   * rather than a ref to "the last one" is what lets Backspace put the caret
   * at the end of the line *above* the one it removed.
   */
  const [caretAt, setCaretAt] = useState<number | null>(null);

  useEffect(() => {
    if (caretAt === null) return;
    const line = lines.current[caretAt];
    setCaretAt(null);
    if (line === null || line === undefined) return;
    line.focus();
    const end = line.value.length;
    line.setSelectionRange(end, end);
  }, [caretAt, behaviors]);

  return (
    <div className="flex flex-col gap-0.5">
      {behaviors.map((behavior, at) => (
        <div className="flex items-baseline gap-1.5" key={`behavior-${String(at)}`}>
          <span className="flex-none text-sm tabular-nums text-faint">
            {at + 1}
          </span>
          <input
            className={QUIET_INPUT}
            aria-label={`Expected behavior ${String(at + 1)}`}
            value={behavior}
            autoComplete="off"
            ref={(node) => {
              lines.current[at] = node;
            }}
            onChange={(event) => {
              const next = [...behaviors];
              next[at] = event.target.value;
              onChange(next);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                if (behavior.trim() === "") {
                  // Enter on a blank line means "I am done", so the blank
                  // lines under it go with it rather than lingering.
                  const kept = withoutTrailingBlanks(behaviors);
                  if (kept.length !== behaviors.length) onChange(kept);
                  onCommit();
                  return;
                }
                setCaretAt(at + 1);
                onChange([...behaviors.slice(0, at + 1), "", ...behaviors.slice(at + 1)]);
                return;
              }
              /*
               * **Backspace on an empty line removes it.** A line added by
               * mistake had no way out: it holds nothing, so there is nothing
               * to delete character by character, and it sat there numbered.
               * The caret goes to the end of the line above, which is where
               * Backspace means it to go. The last line standing is the cell's
               * only writing surface, so it stays.
               */
              if (event.key === "Backspace" && behavior === "" && behaviors.length > 1) {
                event.preventDefault();
                setCaretAt(at === 0 ? 0 : at - 1);
                onChange(behaviors.filter((_, index) => index !== at));
                return;
              }
              if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                onCancel();
              }
            }}
          />
        </div>
      ))}
      <button
        className={ADD_LINE}
        type="button"
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => {
          setCaretAt(behaviors.length);
          onChange([...behaviors, ""]);
        }}
      >
        + Add a behavior
      </button>
    </div>
  );
}

/** The names a Personas cell shows, in the order they were authored. */
function personaNames(
  ids: readonly string[],
  known: ReadonlyMap<string, Named>,
): string {
  return ids.map((id) => known.get(id)?.name ?? id).join(", ");
}

/**
 * One cell's contents, woken or at rest.
 *
 * At rest it is the stored value and nothing else — the grid is quiet until
 * somebody puts a caret in it.
 */
function CellBody({
  field,
  woken,
  draft,
  known,
  projectId,
  picking,
  onPick,
  onChange,
  onKnown,
  onCommit,
  onCancel,
}: {
  readonly field: Field;
  readonly woken: boolean;
  readonly draft: Draft;
  readonly known: ReadonlyMap<string, Named>;
  readonly projectId: string;
  readonly picking: boolean;
  readonly onPick: (open: boolean) => void;
  readonly onChange: (next: Draft) => void;
  readonly onKnown: (named: ReadonlyMap<string, Named>) => void;
  readonly onCommit: () => void;
  readonly onCancel: () => void;
}) {
  const first = useRef<HTMLInputElement & HTMLTextAreaElement>(null);
  useEffect(() => {
    if (woken && (field === "name" || field === "scenario")) first.current?.focus();
  }, [woken, field]);

  if (field === "name") {
    return woken ? (
      <input
        className={QUIET_INPUT}
        aria-label="Name"
        value={draft.name}
        autoComplete="off"
        spellCheck={false}
        ref={first}
        onChange={(event) => onChange({ ...draft, name: event.target.value })}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            onCommit();
          }
          if (event.key === "Escape") {
            event.preventDefault();
            // Escape in a cell reverts that cell and stops there. Without this
            // it also reached the wrapper, where an open entry row reads it as
            // "discard everything I typed".
            event.stopPropagation();
            onCancel();
          }
        }}
      />
    ) : (
      <span className={TEXT}>{draft.name}</span>
    );
  }

  if (field === "scenario") {
    return woken ? (
      <textarea
        className={cn(QUIET_INPUT, "field-sizing-content min-h-5")}
        aria-label="Scenario"
        value={draft.scenario}
        rows={2}
        ref={first}
        onChange={(event) => onChange({ ...draft, scenario: event.target.value })}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            onCommit();
          }
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            onCancel();
          }
        }}
      />
    ) : (
      <span className={TEXT}>{draft.scenario}</span>
    );
  }

  if (field === "expectedBehaviors") {
    return woken ? (
      <BehaviorLines
        behaviors={draft.expectedBehaviors}
        onChange={(next) => onChange({ ...draft, expectedBehaviors: next })}
        onCommit={onCommit}
        onCancel={onCancel}
      />
    ) : (
      <div className="flex flex-col gap-0.5">
        {draft.expectedBehaviors.map((behavior, at) => (
          <span className={TEXT} key={`behavior-${String(at)}`}>
            <span className="tabular-nums text-faint">{at + 1}</span> {behavior}
          </span>
        ))}
      </div>
    );
  }

  return (
    <div
      className="relative flex flex-col gap-0.5"
      onKeyDown={(event) => {
        if (!woken || event.key !== "Escape") return;
        event.preventDefault();
        event.stopPropagation();
        onCancel();
      }}
    >
      <span className={TEXT}>{personaNames(draft.personas, known)}</span>
      {woken ? (
        <button
          className={ADD_LINE}
          type="button"
          data-persona-picker=""
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => onPick(!picking)}
        >
          + Add a persona
        </button>
      ) : null}
      {woken && picking ? (
        <PersonaPicker
          projectId={projectId}
          chosen={draft.personas}
          known={known}
          onChange={(ids, named) => {
            // The named map travels with the ids so a just-chosen persona has a
            // name to show before any list is read again.
            onChange({ ...draft, personas: ids });
            onKnown(named);
          }}
          onDone={() => {
            onPick(false);
            onCommit();
          }}
        />
      ) : null}
    </div>
  );
}

export type GridProps = {
  readonly projectId: string;
  readonly suiteId: string;
  readonly tests: readonly ListedTest[];
  readonly mayAuthor: boolean;
  readonly why?: string;
  /** The entry row opens because the address said to write a test. */
  readonly writing: boolean;
  readonly onWriting: (open: boolean) => void;
  readonly onSaved: (test: ListedTest) => void;
  readonly onCreated: (test: ListedTest) => void;
  readonly onDeleted: (test: ListedTest) => void;
  readonly more?: ReactNode;
};

export function TestsGrid(props: GridProps) {
  const {
    projectId,
    suiteId,
    tests,
    mayAuthor,
    why,
    writing,
    onWriting,
    onSaved,
    onCreated,
    onDeleted,
    more,
  } = props;

  const [active, setActive] = useState<Woken | null>(null);
  /**
   * The woken cell as it is *now*, not as it was when a commit was created.
   *
   * **The state alone cannot answer this question.** A commit is awaited, and
   * the function that resumes after the await still closes over the `active`
   * of the render that started it — which, for a late answer, is the cell that
   * has since been left. Comparing against that closure would let A's answer
   * decide it is still A and clear the cell somebody is typing into, which is
   * the exact bug the guard exists to stop. The ref is written in the same
   * breath as the state, so it is true at every instant rather than at every
   * render.
   */
  const wokenNow = useRef<Session | null>(null);
  /** Moves on every wake, so no two edit sessions can be mistaken for one. */
  const wakes = useRef(0);
  /**
   * The draft as it is *now*, for the same reason `wokenNow` exists.
   *
   * A commit that succeeds closes its cell — but only if the cell still holds
   * what was sent. Somebody who pressed Enter and kept typing is still in the
   * same session, so `at` cannot tell that apart; what tells it apart is that
   * the draft has moved past the value the answer is about. Closing then would
   * throw the newer words away.
   */
  const draftNow = useRef<Draft | null>(null);
  /**
   * What each cell's unfinished save is trying to make true.
   *
   * **A wake seeds from the newest intent, not from the row.** The row still
   * shows the value a save is in the middle of replacing, so a cell woken while
   * its own save is in flight used to start from the value the person had just
   * typed over. Blurring it without touching anything then committed that older
   * value back — against the version their own save had just minted, so it
   * landed, and their edit was undone by a click that changed nothing.
   *
   * Seeded from here instead, that blur commits a value equal to what is
   * stored, and the unchanged path absorbs it without a request.
   */
  const intent = useRef<Map<string, string | readonly string[]>>(new Map());
  /**
   * The tail of each test's queue, so one test's saves happen in order.
   *
   * **Two cells of the same test cannot go at once, and the reason is the
   * version guard.** A content edit carries the version it was read at, so two
   * content cells committed together would carry the *same* one: the first
   * mints a new version and the second is refused for holding the version it
   * has just replaced. That refusal would be about nothing a person did, and if
   * the caret had already moved it would have nowhere to be shown — an edit
   * gone with no request left standing and no sentence, which is the one thing
   * this grid promises never to do.
   *
   * Different tests keep no queue between them: their guards are separate rows,
   * so they are independent by construction and run side by side.
   */
  const queued = useRef<Map<string, Promise<void>>>(new Map());
  /**
   * The newest version and revision egma has answered with, per test.
   *
   * A queued save reads its guard from here at the moment it is sent rather
   * than from the render that started it, so the save in front of it hands the
   * one behind it the version it just minted. `onSaved` writes the same answer
   * into the screen's state; this is the copy that is true immediately, because
   * a queued continuation cannot wait for a render.
   */
  const latest = useRef<Map<string, { versionId: string; revision: string }>>(
    new Map(),
  );
  const [cellDraft, setCellDraft] = useState<Draft | null>(null);
  const [cellRefused, setCellRefused] = useState<string | null>(null);
  /**
   * Which cell's persona picker is open, and there can only be one.
   *
   * **Openness belongs to the cell that owns it**, not to a shared flag: a
   * boolean served every woken Personas cell and the entry row at once, so two
   * pickers could stand open together and waking any cell slammed the entry
   * row's shut. `"entry"` is the entry row's own; a woken cell's is its test id.
   */
  const [picking, setPicking] = useState<string | null>(null);
  const [known, setKnown] = useState<ReadonlyMap<string, Named>>(new Map());
  const [entry, setEntry] = useState<Draft | null>(null);
  /**
   * Which entry cell the caret is in, and it is the only one that may wake.
   *
   * **The whole entry row used to wear the 2px ink edge at once** — four heavy
   * boxes shouting together the moment somebody asked to write a test. The
   * wake means "this is the cell you are in", so it follows the caret, and a
   * row nobody has touched yet rests on the grid's own hairlines like every
   * other row (founder, 2026-08-25).
   */
  const [entryFocus, setEntryFocus] = useState<Field | null>(null);
  const [entryRefused, setEntryRefused] = useState<string | null>(null);
  const [entrySaving, setEntrySaving] = useState(false);
  const [discarding, setDiscarding] = useState(false);
  const [deleting, setDeleting] = useState<ListedTest | null>(null);
  const [deleteInFlight, setDeleteInFlight] = useState(false);
  const [deleteRefused, setDeleteRefused] = useState<string | null>(null);
  const entryName = useRef<HTMLInputElement>(null);

  /*
   * A different suite is a different set of rows, so nothing a previous one
   * learned about versions or had in flight may follow it here.
   */
  useEffect(() => {
    queued.current = new Map();
    latest.current = new Map();
    intent.current = new Map();
  }, [projectId, suiteId]);

  /* Every persona a row already names has a name, so a cell can show it. */
  useEffect(() => {
    setKnown((held) => {
      const named = new Map(held);
      for (const test of tests) {
        for (const persona of test.personas) named.set(persona.id, persona);
      }
      return named;
    });
  }, [tests]);

  const openEntry = useCallback(() => {
    setEntry((held) => held ?? EMPTY_DRAFT);
    setEntryRefused(null);
    // A fresh row is at rest until the caret lands, which it does below.
    setEntryFocus(null);
    onWriting(true);
    window.requestAnimationFrame(() => entryName.current?.focus());
  }, [onWriting]);

  /*
   * The address that means "write a test" opens the entry row the same way the
   * ghost row does, caret and all — `/tests/new?suite=` is the old write
   * address, and landing on it must put somebody in the same place pressing
   * the button does.
   */
  const arrivedWriting = useRef(false);
  useEffect(() => {
    if (!writing || arrivedWriting.current) return;
    arrivedWriting.current = true;
    openEntry();
  }, [writing, openEntry]);

  /** Wake one cell, in state and in the refs that answer "which one now?". */
  function woken(next: Woken | null): void {
    wakes.current += 1;
    wokenNow.current = next === null ? null : { ...next, at: wakes.current };
    setActive(next);
  }

  /** The draft, in state and in the ref that is true before the next render. */
  function holdDraft(next: Draft | null): void {
    draftNow.current = next;
    setCellDraft(next);
  }

  /** The stored row, with any unfinished save of it laid over the top. */
  function newestIntent(test: ListedTest): Draft {
    const held = draftOf(test);
    const pending = (of: Field): string | readonly string[] | undefined =>
      intent.current.get(`${test.id}:${of}`);
    const name = pending("name");
    const scenario = pending("scenario");
    const behaviors = pending("expectedBehaviors");
    const personas = pending("personas");
    return {
      name: typeof name === "string" ? name : held.name,
      scenario: typeof scenario === "string" ? scenario : held.scenario,
      expectedBehaviors: Array.isArray(behaviors)
        ? [...(behaviors as readonly string[])]
        : held.expectedBehaviors,
      personas: Array.isArray(personas)
        ? [...(personas as readonly string[])]
        : held.personas,
    };
  }

  function wake(test: ListedTest, field: Field): void {
    if (!mayAuthor) return;
    woken({ testId: test.id, field });
    holdDraft(newestIntent(test));
    setCellRefused(null);
    // Waking a cell closes a picker of its own from a previous wake, and
    // leaves the entry row's alone.
    setPicking((held) => (held === "entry" ? held : null));
  }

  /**
   * Put the grid back to rest, but only if the cell that asked is still the
   * woken one.
   *
   * **A save that lands late must not reach into a cell somebody has since
   * clicked into.** A commit is awaited, and in that time the caret can be two
   * cells away with a sentence half typed into it; un-waking that cell would
   * throw away what was typed with no refusal and no record — the one thing
   * this grid promises never to do.
   */
  function rest(mine?: Session): void {
    if (mine !== undefined && wokenNow.current?.at !== mine.at) return;
    woken(null);
    holdDraft(null);
    setCellRefused(null);
    setPicking(null);
  }

  async function commit(test: ListedTest, field: Field): Promise<void> {
    /*
     * Which edit session this commit belongs to, held across the await so the
     * answer can only ever land back on the session that asked. Not the cell:
     * leaving a cell and coming back is a new session over the same two
     * coordinates, and an answer from the old one must neither close it nor
     * speak into it.
     */
    const held = wokenNow.current;
    const mine: Session =
      held !== null && held.testId === test.id && held.field === field
        ? held
        : { testId: test.id, field, at: wakes.current };
    const key = `${mine.testId}:${mine.field}`;
    if (cellDraft === null) return;
    const stored = draftOf(test);
    const problem = whyFieldRefuses(field, cellDraft);
    if (problem !== null) {
      setCellRefused(problem);
      return;
    }
    const value =
      field === "name"
        ? cellDraft.name.trim()
        : field === "scenario"
          ? cellDraft.scenario.trim()
          : field === "expectedBehaviors"
            ? trimmedBehaviors(cellDraft.expectedBehaviors)
            : cellDraft.personas;
    const unchanged =
      field === "name"
        ? value === stored.name
        : field === "scenario"
          ? value === stored.scenario
          : sameList(value as readonly string[], field === "expectedBehaviors"
              ? stored.expectedBehaviors
              : stored.personas);
    /*
     * **A cell drops only an identical resubmit.** The guard exists for one
     * thing: Enter commits, and the blur it causes commits the same value a
     * moment later. Blanket-blocking every commit while a save was in flight
     * threw away a real edit instead — words typed after Enter were neither
     * sent nor queued, and waking the next cell replaced the draft that held
     * them. A changed value queues behind the save in front of it like any
     * other, and goes with the version that save mints.
     */
    const flying = intent.current.get(key);
    if (flying !== undefined && sameSent(flying, value)) return;
    if (unchanged) {
      rest(mine);
      return;
    }
    // What this cell is now trying to make true, from here until it answers.
    intent.current.set(key, value);
    setCellRefused(null);

    /*
     * One field, and the guard the platform asks that field for. A content edit
     * carries the version it was read at, so a save cannot land on top of
     * somebody else's; a name is identity and carries the revision instead.
     *
     * Both are read here rather than closed over, because this runs when the
     * queue reaches it: the save in front may have minted a version since, and
     * carrying the older one would be refused for no reason a person could act
     * on. A genuine refusal now means what it says — somebody else moved this
     * test — which is exactly what the sentence in the cell is for.
     */
    const send = async (): Promise<void> => {
      const guard = latest.current.get(test.id) ?? {
        versionId: test.versionId,
        revision: test.revision,
      };
      const answer = await platformAnswer(
        updateTest(
          {
            testId: test.id,
            projectId,
            [field]: value,
            ...(isContent(field)
              ? { expectedVersionId: guard.versionId }
              : { expectedRevision: guard.revision }),
          } as Parameters<typeof updateTest>[0],
          { client: platformClient },
        ),
      );
      // Clear the intent only if it is still this save's. A newer commit on
      // the same cell has already replaced it and is waiting its turn.
      const standing = intent.current.get(key);
      if (standing !== undefined && sameSent(standing, value)) {
        intent.current.delete(key);
      }
      if (answer.status === "signed-out") {
        window.location.replace("/sign-in");
        return;
      }
      // The session that asked, and whether it is still the one on screen.
      const stillMine = wokenNow.current?.at === mine.at;
      if (answer.status !== "ready") {
        // A refusal belongs beside the session it is about. If that session has
        // ended — the caret moved, or the cell was left and re-entered — the
        // sentence has nowhere truthful to sit, and the save simply did not
        // happen: the stored value stands either way.
        if (stillMine) setCellRefused(answer.refusal.message);
        return;
      }
      // What the next save on this test must carry, true from this instant.
      latest.current.set(test.id, {
        versionId: answer.value.versionId,
        revision: answer.value.revision,
      });
      onSaved(answer.value);
      /*
       * Close the cell only if it still holds exactly what was sent. Pressing
       * Enter and carrying on typing stays one session, so `at` cannot tell
       * that apart — but the draft has moved past what this answer is about,
       * and closing would take the newer words with it. Left open, the next
       * commit saves them.
       */
      if (holdsWhatWasSent(draftNow.current, field, value)) rest(mine);
    };

    // Behind whatever this test is already saving, and nothing else.
    const ahead = queued.current.get(test.id) ?? Promise.resolve();
    const run = ahead.then(send, send);
    queued.current.set(
      test.id,
      run.catch(() => undefined),
    );
    await run;
  }

  async function write(): Promise<void> {
    if (entry === null || entrySaving) return;
    if (whatIsMissing(entry) !== null) return;
    setEntrySaving(true);
    setEntryRefused(null);
    const answer = await platformAnswer(
      createTest(
        {
          projectId,
          suiteId,
          name: entry.name.trim(),
          scenario: entry.scenario.trim(),
          expectedBehaviors: [...trimmedBehaviors(entry.expectedBehaviors)],
          personas: [...entry.personas],
        },
        { client: platformClient },
      ),
    );
    setEntrySaving(false);
    if (answer.status === "signed-out") {
      window.location.replace("/sign-in");
      return;
    }
    if (answer.status !== "ready") {
      setEntryRefused(answer.refusal.message);
      return;
    }
    onCreated(answer.value);
    setEntry(null);
    onWriting(false);
  }

  async function remove(test: ListedTest): Promise<void> {
    setDeleteInFlight(true);
    setDeleteRefused(null);
    const answer = await platformAnswer(
      deleteTest({ testId: test.id, projectId }, { client: platformClient }),
    );
    setDeleteInFlight(false);
    if (answer.status === "signed-out") {
      window.location.replace("/sign-in");
      return;
    }
    if (answer.status !== "ready") {
      setDeleteRefused(answer.refusal.message);
      return;
    }
    setDeleting(null);
    if (active?.testId === test.id) rest();
    onDeleted(test);
  }

  function askToDiscard(): void {
    if (entry === null) return;
    const typed =
      entry.name.trim() !== "" ||
      entry.scenario.trim() !== "" ||
      trimmedBehaviors(entry.expectedBehaviors).length > 0 ||
      entry.personas.length > 0;
    if (!typed) {
      setEntry(null);
      onWriting(false);
      return;
    }
    setDiscarding(true);
  }

  function cell(test: ListedTest, field: Field): ReactNode {
    const woken = active?.testId === test.id && active.field === field;
    const draft = woken && cellDraft !== null ? cellDraft : draftOf(test);
    return (
      <td
        className={cn(CELL, woken && WOKEN)}
        key={field}
        onClick={woken ? undefined : () => wake(test, field)}
        onBlur={
          woken
            ? (event) => {
                if (
                  event.currentTarget.contains(event.relatedTarget as Node | null)
                ) {
                  return;
                }
                void commit(test, field);
              }
            : undefined
        }
      >
        <div className={cn(PAD, !woken && mayAuthor && "cursor-text")}>
          <CellBody
            field={field}
            woken={woken}
            draft={draft}
            known={known}
            projectId={projectId}
            picking={woken && picking === test.id}
            onPick={(open) => setPicking(open ? test.id : null)}
            onChange={holdDraft}
            onKnown={setKnown}
            onCommit={() => void commit(test, field)}
            onCancel={rest}
          />
          {woken && cellRefused !== null ? (
            <p className="m-0 pt-1 text-sm text-failure" role="alert">
              {cellRefused}
            </p>
          ) : null}
        </div>
      </td>
    );
  }

  /**
   * The row's own ⋮, holding the one thing a row can do to itself.
   *
   * It is here rather than in a column because it is the house table's
   * trailing slot: `ui/row-menu.tsx` draws the control, and the lane is 48px
   * wide on every row so the triggers line up. Only a written test has one —
   * the entry row has nothing to delete yet, and the ghost row is not a test.
   */
  function rowMenu(test: ListedTest): ReactNode {
    return (
      <td className={ACTION} key="menu">
        <RowMenu label={`Open the menu for ${test.name}`}>
          {(close) => (
            <>
              <DestructiveItem
                disabled={!mayAuthor}
                onClick={() => {
                  close();
                  setDeleteRefused(null);
                  setDeleting(test);
                }}
              >
                Delete test
              </DestructiveItem>
              {why === undefined ? null : <MenuReason>{why}</MenuReason>}
            </>
          )}
        </RowMenu>
      </td>
    );
  }

  function entryCell(field: Field): ReactNode {
    if (entry === null) return null;
    return (
      <td
        className={cn(CELL, entryFocus === field && WOKEN)}
        key={field}
        onFocus={() => setEntryFocus(field)}
        onBlur={(event) => {
          if (event.currentTarget.contains(event.relatedTarget as Node | null)) {
            return;
          }
          setEntryFocus((held) => (held === field ? null : held));
        }}
      >
        <div className={PAD}>
          {field === "name" ? (
            <input
              className={QUIET_INPUT}
              aria-label="Name"
              placeholder="One situation to put the agent in…"
              value={entry.name}
              autoComplete="off"
              spellCheck={false}
              ref={entryName}
              onChange={(event) => setEntry({ ...entry, name: event.target.value })}
            />
          ) : field === "scenario" ? (
            <textarea
              className={cn(QUIET_INPUT, "field-sizing-content min-h-5")}
              aria-label="Scenario"
              placeholder="…what the caller wants…"
              value={entry.scenario}
              rows={2}
              onChange={(event) =>
                setEntry({ ...entry, scenario: event.target.value })
              }
            />
          ) : field === "expectedBehaviors" ? (
            <BehaviorLines
              behaviors={entry.expectedBehaviors}
              onChange={(next) => setEntry({ ...entry, expectedBehaviors: next })}
              onCommit={() => undefined}
              onCancel={askToDiscard}
            />
          ) : (
            <div className="relative flex flex-col gap-0.5">
              <span className={TEXT}>{personaNames(entry.personas, known)}</span>
              <button
                className={ADD_LINE}
                type="button"
                data-persona-picker=""
                onMouseDown={(event) => event.preventDefault()}
                onClick={() =>
                  setPicking(picking === "entry" ? null : "entry")
                }
              >
                + Add a persona
              </button>
              {picking === "entry" ? (
                <PersonaPicker
                  projectId={projectId}
                  chosen={entry.personas}
                  known={known}
                  onChange={(ids, named) => {
                    setEntry({ ...entry, personas: ids });
                    setKnown(named);
                  }}
                  onDone={() => setPicking(null)}
                />
              ) : null}
            </div>
          )}
        </div>
      </td>
    );
  }

  const missing = entry === null ? null : whatIsMissing(entry);

  return (
    <div
      onKeyDown={(event) => {
        if (event.key !== "Escape" || entry === null) return;
        /*
         * Only the entry row's own Escape discards it. A woken cell handles
         * and stops its own; this guard is the second half of the same rule,
         * so Escape pressed anywhere else on the grid never throws away a row
         * somebody is still writing.
         */
        const inEntry =
          event.target instanceof Element &&
          event.target.closest("[data-entry-row]") !== null;
        if (!inEntry) return;
        event.preventDefault();
        askToDiscard();
      }}
    >
      <table className="w-full table-fixed border-collapse border border-border bg-surface text-sm">
        <caption className="sr-only">Tests in this suite</caption>
        <colgroup>
          {COLUMNS.map((column) => (
            <col key={column.field} style={{ width: column.width }} />
          ))}
          <col style={{ width: "var(--table-action-width)" }} />
        </colgroup>
        <thead>
          <tr className="bg-surface-soft">
            {COLUMNS.map((column) => (
              <th
                className="border-r border-b border-border px-2.5 py-2 text-left text-sm font-normal text-faint last:border-r-0"
                key={column.field}
                scope="col"
              >
                {column.header}
              </th>
            ))}
            {/*
              The trailing lane is named out loud. It was a blank cell with the
              words hidden for screen readers only, so on screen the ⋮ column
              was the one column of the grid with no header over it. "Actions"
              is what it holds, and every reader gets the same word now.
            */}
            <th
              className="w-(--table-action-width) border-b border-border px-2.5 py-2 text-center text-sm font-normal text-faint"
              scope="col"
            >
              Actions
            </th>
          </tr>
        </thead>
        <tbody>
          {tests.length === 0 && entry === null ? (
            <tr>
              <td className={cn(CELL, PAD, TEXT, "text-faint")}>
                One situation to put the agent in…
              </td>
              <td className={cn(CELL, PAD, TEXT, "text-faint")}>
                …what should happen…
              </td>
              <td className={cn(CELL, PAD, TEXT, "text-faint")}>…and who calls.</td>
              <td className={cn(CELL, PAD)} />
              <td className={ACTION} />
            </tr>
          ) : null}
          {tests.map((test) => (
            <tr key={test.id}>
              {COLUMNS.map((column) => cell(test, column.field))}
              {rowMenu(test)}
            </tr>
          ))}
          {entry === null ? null : (
            <tr data-entry-row="">
              {COLUMNS.map((column) => entryCell(column.field))}
              {/*
                Nothing to delete yet, so this cell holds the lane open and
                says nothing: no wake, no edge, nothing to click. A row that is
                not written has no action to offer, and dressing the lane like
                an editable cell promised one.
              */}
              <td className={ACTION} />
            </tr>
          )}
          {mayAuthor && entry === null ? (
            <tr>
              <td
                className={cn(CELL, "border-b-0")}
                colSpan={COLUMNS.length + 1}
              >
                <button
                  className={cn(ADD_LINE, PAD, "w-full")}
                  type="button"
                  onClick={openEntry}
                >
                  + Write a test
                </button>
              </td>
            </tr>
          ) : null}
        </tbody>
      </table>

      {more}

      {entry === null ? null : (
        <Arriving
          className="mt-3 flex flex-wrap items-center gap-3"
          data-entry-row=""
        >
          <Button
            type="button"
            size="lg"
            disabled={!mayAuthor || missing !== null || entrySaving}
            busy={entrySaving}
            // The sentence beside it is the reason it cannot fire, so the
            // button names it rather than leaving a screen reader to find it.
            aria-describedby="entry-row-state"
            {...(why === undefined ? {} : { why })}
            onClick={() => void write()}
          >
            {entrySaving ? "Saving…" : "Save test"}
          </Button>
          <Button
            type="button"
            variant="secondary"
            size="lg"
            disabled={entrySaving}
            onClick={askToDiscard}
          >
            Cancel
          </Button>
          <p
            className="m-0 text-sm text-muted-foreground"
            id="entry-row-state"
            role="status"
          >
            {missing ?? "Not saved yet."}
          </p>
        </Arriving>
      )}

      {entryRefused === null ? null : (
        <p className="mt-2 text-sm text-failure" role="alert">
          {entryRefused}
        </p>
      )}

      {deleting === null ? null : (
        <ConfirmDialog
          title="Delete this test?"
          lines={[
            `“${deleting.name}” leaves this suite. Nobody can author or run it after this.`,
            "Runs that already ran it keep their results and transcripts.",
          ]}
          confirmLabel="Delete test"
          busy={deleteInFlight}
          refusal={deleteRefused}
          onConfirm={() => void remove(deleting)}
          onClose={() => setDeleting(null)}
        />
      )}

      {discarding ? (
        <Dialog title="Discard this test?" onClose={() => setDiscarding(false)}>
          {(dismiss) => (
            <div className="flex flex-col gap-5">
              <p className="m-0 text-sm text-muted-foreground">
                What you typed is not saved.
              </p>
              <div className="flex flex-wrap items-center gap-3 pt-1">
                <Button
                  type="button"
                  variant="destructive"
                  size="lg"
                  onClick={() => {
                    setDiscarding(false);
                    setEntry(null);
                    setPicking(null);
                    onWriting(false);
                  }}
                >
                  Discard
                </Button>
                <Button type="button" variant="ghost" size="lg" onClick={dismiss}>
                  Keep writing
                </Button>
              </div>
            </div>
          )}
        </Dialog>
      ) : null}
    </div>
  );
}
