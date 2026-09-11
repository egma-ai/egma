"use client";

import { XIcon } from "lucide-react";
import {
  Fragment,
  useCallback,
  useEffect,
  useId,
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

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Command,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { LANE_X } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import {
  platformAnswer,
  platformClient,
} from "../../../../lib/platform-client.ts";
import {
  envSummary,
  mockToolsSummary,
  readEnv,
  readMockTools,
  type ListedTest,
  type TestEnv,
  type TestMockTool,
} from "../../../../lib/tests.ts";
import { Dialog } from "../../../../ui/dialog.tsx";
import { Problem } from "../../../../ui/form.tsx";
import { MenuDivider, MenuItem } from "../../../../ui/menu.tsx";
import { DestructiveItem, MenuReason, RowMenu } from "../../../../ui/row-menu.tsx";
import { ConfirmDialog } from "./parts.tsx";

/**
 * Existing tests save individual fields; new tests require an explicit complete
 * entry-row submit. Name, scenario, expected behaviors, and personas are required.
 *
 * Serialize saves per test and read the latest version/revision when sending.
 * Different tests may save concurrently. Reopened cells start from pending
 * intent, and late answers may affect only their original edit session and
 * unchanged submitted draft. Drop identical Enter/blur resubmits.
 * Mock tools and env open JSON dialogs instead of inline text editors.
 */

/**
 * A persona as a cell needs it: an id to send and a name to show.
 *
 * `archivedAt` travels with the personas a test names, so the picker can say
 * that one of them is gone. A persona read from the project's own list is
 * available by definition and carries nothing here.
 */
type Named = {
  readonly id: string;
  readonly name: string;
  readonly archivedAt?: string | null;
};

/** What a cell is, which is also which field one save carries. */
type Field =
  | "name"
  | "scenario"
  | "expectedBehaviors"
  | "personas"
  | "mockTools"
  | "env";

/**
 * Edit mock tools and env as JSON in dialogs; cells show a summary or an
 * action to add a value.
 */
type JsonField = "mockTools" | "env";

function isJsonField(field: Field): field is JsonField {
  return field === "mockTools" || field === "env";
}

/**
 * Format examples with the same JSON.stringify indentation as stored values.
 * Empty-cell labels describe the action that opens the editor.
 */
const JSON_FIELD: Readonly<
  Record<
    JsonField,
    {
      readonly title: string;
      readonly add: string;
      readonly example: string;
    }
  >
> = {
  mockTools: {
    title: "Mock tools",
    add: "Add mock tools",
    example: JSON.stringify(
      [
        { tool: "get_availability", answer: { slots: [] } },
        { tool: "book", error: "calendar down" },
      ],
      null,
      2,
    ),
  },
  env: {
    title: "Env",
    add: "Add env variables",
    example: JSON.stringify(
      {
        retell_dynamic_variables: { caller_name: "Margaret" },
        job_dispatch_metadata: { tenant: "acme" },
      },
      null,
      2,
    ),
  },
};

/** One woken cell: which test's, and which of its four fields. */
type Woken = { readonly testId: string; readonly field: Field };

/**
 * Identify each cell edit session with a new counter value. Reopening the
 * same cell must not let a previous save clear the new draft.
 */
type Session = Woken & { readonly at: number };

/** Content fields mint a version; the name is identity and mints a revision. */
function isContent(field: Field): boolean {
  return field !== "name";
}

/**
 * Allocate enough width for headings and JSON-cell actions at the grid's
 * minimum width. Keep the mock tools and env columns wide enough for their labels.
 */
const COLUMNS: readonly {
  readonly field: Field;
  readonly header: string;
  readonly width: string;
  /** Whether a test cannot be saved without this column, which four cannot. */
  readonly required: boolean;
}[] = [
  { field: "name", header: "Name", width: "12%", required: true },
  { field: "scenario", header: "Scenario", width: "22%", required: true },
  {
    field: "expectedBehaviors",
    header: "Expected behaviors",
    width: "24%",
    required: true,
  },
  /*
   * Wide enough for a persona's name to stand on one chip: at 12% every
   * chip truncated to its first word. The two JSON columns lent the width;
   * they mostly read `None`.
   */
  { field: "personas", header: "Personas", width: "18%", required: true },
  { field: "mockTools", header: "Mock tools", width: "12%", required: false },
  { field: "env", header: "Env", width: "12%", required: false },
];

/**
 * Mark required columns with a heading-colored star and include required in
 * the accessible column name. A th does not support aria-required.
 */
function RequiredMark() {
  return (
    <span className="pl-1" aria-hidden="true" data-required-mark="">
      *
    </span>
  );
}

/** What a screen reader hears for one column, star and all. */
function columnHeading(header: string, required: boolean): string | undefined {
  return required ? `${header}, required` : undefined;
}

const CELL = "border-r border-b border-border p-0 align-top last:border-r-0";
/*
 * Use the labeled action-width token for the Actions header, cells, and col.
 * The narrower icon-only action token would clip the heading.
 */
const ACTION =
  "w-(--table-action-labelled-width) border-b border-border p-0 text-center align-middle";
/**
 * Reuse shared table padding and edge tokens because this grid does not
 * render through the standard table component.
 */
const PAD = `${LANE_X} py-(--row-padding-y)`;
const TEXT = "text-sm leading-(--line-caption) text-foreground";
/** Stored rows reserve two caption lines, then clamp their display to that space. */
const VIEW_ROW = "flex min-h-(--topbar-height) min-w-0 items-center overflow-hidden";
const VIEW_TEXT = "block min-w-0 line-clamp-2";
/** The same quiet line a summary is drawn in, which `None` is one of. */
const CELL_QUIET = "text-sm leading-(--line-caption) text-faint";
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

/**
 * The one ember affordance on this screen, and every way in wears it.
 *
 * A woken Expected behaviors or Personas cell grows it, an empty Mock tools or
 * Env cell rests as it, and the ghost row at the foot of the table is it. One
 * class rather than four is what keeps them a single grammar: a person learns
 * "the orange line adds the thing beside it" once, on whichever cell they meet
 * first.
 */
const ADD_LINE =
  "cursor-pointer bg-transparent p-0 text-left text-sm leading-(--line-caption) text-primary underline-offset-4 pointer-hover:underline";

/**
 * Where a press is *not* leaving the woken cell.
 *
 * The cell itself, obviously. The persona picker, because it is the cell's own
 * panel and shutting it is what commits — the blur handler makes the same
 * exception for the same reason. And a dialog, scrim included, because a save
 * still in flight can leave a cell woken while one is opened over it, and a
 * press meant for Save is not a press meant for the table.
 */
const KEEPS_THE_CELL = [
  "[data-woken-cell]",
  '[data-slot="popover-content"]',
  '[data-slot="dialog-content"]',
  '[data-slot="dialog-overlay"]',
].join(",");

type Draft = {
  readonly name: string;
  readonly scenario: string;
  readonly expectedBehaviors: readonly string[];
  readonly personas: readonly string[];
  /**
   * The two JSON fields, carried on the draft so the entry row can hold them.
   *
   * An existing row never edits them through a draft — its dialog writes to the
   * platform directly, against the version guard, the way every other cell
   * does. They are here for the row that is not written yet: the entry row, and
   * the entry row prefilled by Duplicate.
   */
  readonly mockTools: readonly TestMockTool[];
  readonly env: TestEnv | null;
};

const EMPTY_DRAFT: Draft = {
  name: "",
  scenario: "",
  expectedBehaviors: [""],
  personas: [],
  mockTools: [],
  env: null,
};

function draftOf(test: ListedTest): Draft {
  return {
    name: test.name,
    scenario: test.scenario,
    expectedBehaviors: [...test.expectedBehaviors],
    personas: test.personas.map((persona) => persona.id),
    mockTools: [...test.mockTools],
    env: test.env,
  };
}

/**
 * One test as a new one: the same content under a name that says it is a copy.
 *
 * Everything the platform stores as content travels — the scenario, the
 * behaviors, the personas, the mock tools and the env — because a duplicate
 * that dropped half of them would be a new test wearing an old name. Nothing
 * is written here: this only fills the entry row in.
 */
function copyOf(test: ListedTest): Draft {
  return { ...draftOf(test), name: `${test.name} (copy)` };
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
 * Portal the persona picker so the grid can keep horizontal scrolling.
 * Dismissal commits the selected personas. Mount PersonaChoices only while
 * open to avoid fetching the persona list for every unopened row.
 */
function PersonaPicker({
  projectId,
  chosen,
  known,
  onChange,
  open,
  onOpenChange,
}: {
  readonly projectId: string;
  readonly chosen: readonly string[];
  readonly known: ReadonlyMap<string, Named>;
  readonly onChange: (ids: readonly string[], named: ReadonlyMap<string, Named>) => void;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <button
          className={ADD_LINE}
          /*
           * Marked, because the chips above take the caret back here when a
           * removal leaves no cross to hold it. The grid's own markers are
           * plain data attributes; `data-slot` belongs to the primitive.
           */
          data-persona-add=""
          type="button"
          /* The cell owns its own caret; opening must not move it first. */
          onMouseDown={(event) => event.preventDefault()}
        >
          {/*
           * The panel adds, and the chips above remove, so the trigger says
           * the one thing it does — on a cell that names nobody and on a cell
           * that already names three.
           */}
          + Add a persona
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        /* Never wider than the screen it has to fit on, as `ui/menu.tsx` is. */
        className="w-[min(300px,calc(100vw-var(--space-8)))] p-0"
        aria-label="Choose personas"
        /*
         * Prevent focus-out dismissal because the entry row may restore its own
         * caret after opening. Pointer dismissal and Escape still close the picker.
         */
        onFocusOutside={(event) => event.preventDefault()}
      >
        <PersonaChoices
          projectId={projectId}
          chosen={chosen}
          known={known}
          onChange={onChange}
          onDone={() => onOpenChange(false)}
        />
      </PopoverContent>
    </Popover>
  );
}

/**
 * What the open picker holds: the search, the people, and the way out.
 *
 * It is its own component so that the read below runs when a panel opens
 * rather than when the grid draws, which is the difference between one request
 * and one per row.
 */
function PersonaChoices({
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
    return () => {
      live = false;
    };
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
    <>
      {/*
       * **`label` names the search field, not the list, and that is `cmdk`'s
       * doing rather than a choice made here.** It renders the prop into a
       * hidden element and points the field's `aria-labelledby` at it — always,
       * even with no label given, which is why an `aria-label` on the field is
       * overridden and silently does nothing. So the words that describe the
       * typing have to arrive through this prop. The panel around it is a
       * dialog and carries "Choose personas" of its own, so nothing is left
       * unnamed.
       */}
      <Command label="Search personas">
        <CommandInput
          /*
           * The caret starts here, and that is load-bearing rather than a
           * courtesy. Radix puts focus on the panel itself when it opens, and the
           * panel's own children then re-render as the persona pages arrive —
           * which drops focus to the body, reads to Radix as focus leaving the
           * panel, and shuts it. Landing the caret on the field holds it on
           * something that outlives the list, and it is where somebody opening a
           * search panel expects to be typing.
           */
          autoFocus
          /* A placeholder is not a name: it leaves with the first keystroke. */
          placeholder="Search personas"
          value={search}
          onValueChange={setSearch}
        />
        <CommandList>
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
            <CommandGroup>
              {listed.map((one) => (
                <CommandItem
                  key={one.id}
                  value={one.id}
                  /*
                   * The row is the control, so the row says whether it is ticked.
                   * `cmdk` has already spent `aria-selected` on the arrow keys'
                   * highlight, and the box below is a picture of this state
                   * rather than a second control announcing it again.
                   */
                  aria-checked={chosen.includes(one.id)}
                  onSelect={() => toggle(one)}
                >
                  <Checkbox
                    checked={chosen.includes(one.id)}
                    readOnly
                    tabIndex={-1}
                    aria-hidden="true"
                  />
                  <span className="min-w-0 truncate">{one.name}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          )}
        </CommandList>
        {truncated ? (
          // The search above runs in the browser, so it reaches what was read
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
      </Command>
    </>
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
  const lines = useRef<(HTMLTextAreaElement | null)[]>([]);
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
          <span className="flex-none text-sm tabular-nums text-foreground">
            {at + 1}.
          </span>
          <textarea
            className={cn(QUIET_INPUT, "field-sizing-content min-h-5")}
            aria-label={`Expected behavior ${String(at + 1)}`}
            value={behavior}
            rows={1}
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

/**
 * The personas a cell names, as chips in the order the test names them.
 *
 * A woken cell grows a cross on each chip, and pressing one is the whole of
 * taking that persona off: removal was a hunt through the picker before, which
 * is a long way round for the commonest edit a Personas cell has.
 */
function PersonaChips({
  ids,
  known,
  stored,
  removable,
  onRemove,
}: {
  readonly ids: readonly string[];
  readonly known: ReadonlyMap<string, Named>;
  /** The personas the row already holds, so only a new chip arrives. */
  readonly stored: readonly string[];
  /** Whether each chip carries a cross, which is what takes it off. */
  readonly removable: boolean;
  readonly onRemove: (id: string) => void;
}) {
  const crosses = useRef<(HTMLButtonElement | null)[]>([]);
  /** The cell around the chips, held while the list stands. */
  const around = useRef<HTMLElement | null>(null);
  /**
   * Which cross the caret is owed, and it is always one that just moved.
   *
   * The cross that was pressed is about to leave. Holding the index rather
   * than an element is what lets the caret land on the chip that took its
   * place, or on the one above when the last chip went.
   */
  const [caretAt, setCaretAt] = useState<number | null>(null);

  useEffect(() => {
    if (caretAt === null) return;
    const cross = crosses.current[caretAt];
    setCaretAt(null);
    if (cross !== null && cross !== undefined) {
      cross.focus();
      return;
    }
    /*
     * Nothing left to hold the caret: the last persona on a stored test keeps
     * no cross, and an emptied entry row has no chip at all. The add line is
     * the cell's other way in, and the caret has to stay inside the cell —
     * dropped to the body it blurs the cell, and a blur is a commit.
     */
    around.current?.querySelector<HTMLButtonElement>("[data-persona-add]")?.focus();
  }, [caretAt, ids]);

  if (ids.length === 0) return null;

  return (
    <ul
      aria-label="Personas"
      className="m-0 flex list-none flex-wrap gap-1 p-0"
      ref={(node) => {
        if (node !== null) around.current = node.parentElement;
      }}
    >
      {ids.map((id, at) => {
        const one = known.get(id);
        const name = one?.name ?? id;
        return (
          <Badge
            asChild
            className={cn(
              /* A persona's name is the record's name, not a state word. */
              "max-w-full text-foreground",
              /*
               * On a coarse pointer the cross grows to the tap target, so the
               * chip grows with it and lets the name wrap rather than truncate.
               */
              removable && "gap-1 pointer-coarse:h-auto pointer-coarse:min-h-(--tap-target)",
            )}
            key={id}
            shape="count"
            variant="neutral"
          >
            <li
              data-slot="persona-chip"
              /* A chip the row already holds is simply there; a just-chosen
                 one arrives, which is what the theme's rule animates. */
              {...(stored.includes(id) ? {} : { "data-arrived": "" })}
            >
              <span
                className={cn(
                  "min-w-0 truncate",
                  removable && "pointer-coarse:whitespace-normal",
                )}
              >
                {name}
                {typeof one?.archivedAt === "string" ? (
                  // The test still names somebody the project has deleted.
                  // Saying so is what makes the cross beside it make sense.
                  <span className="text-faint"> (deleted)</span>
                ) : null}
              </span>
              {removable ? (
                <button
                  aria-label={`Remove ${name}`}
                  className={cn(
                    "inline-flex size-4 shrink-0 cursor-pointer items-center justify-center",
                    "border-0 bg-transparent p-0 text-muted-foreground",
                    /* Half of the chip's own side padding, so the cross sits
                       inside the edge rather than a word's width from it. */
                    "-mr-1",
                    "transition-[color] duration-(--duration-hover) ease-out",
                    /* Ember under a pointer, as a cell link and the add line are. */
                    "pointer-hover:text-primary motion-reduce:transition-none",
                    /* The tap target's height, as the Button keeps it; the
                       width stays modest so the name keeps its room. */
                    "pointer-coarse:h-(--tap-target) pointer-coarse:w-8",
                  )}
                  data-slot="persona-chip-remove"
                  /* The cell owns its own caret; a press here must not move it. */
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => {
                    /*
                     * The chip leaves on the press and nothing fades it out:
                     * a removal is a many-times-a-day edit, and a ghost chip
                     * would still have to be answered for if the draft it
                     * belongs to is reverted or refused.
                     */
                    setCaretAt(at === ids.length - 1 ? Math.max(at - 1, 0) : at);
                    onRemove(id);
                  }}
                  ref={(node) => {
                    crosses.current[at] = node;
                  }}
                  type="button"
                >
                  <XIcon aria-hidden="true" className="size-3" />
                </button>
              ) : null}
            </li>
          </Badge>
        );
      })}
    </ul>
  );
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
  stored,
  projectId,
  owner,
  picking,
  onPick,
  onChange,
  onKnown,
  onCommit,
  onCancel,
}: {
  /** Never a JSON field: those are cells that open a dialog, not cells to type in. */
  readonly field: Exclude<Field, JsonField>;
  readonly woken: boolean;
  readonly draft: Draft;
  readonly known: ReadonlyMap<string, Named>;
  /** The personas the stored row names, which the draft may have moved past. */
  readonly stored: readonly string[];
  readonly projectId: string;
  /** This row's test id, which is what its picking is held under. */
  readonly owner: string;
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
      <span className={cn(TEXT, VIEW_TEXT)}>{draft.name}</span>
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
      <span className={cn(TEXT, VIEW_TEXT)}>{draft.scenario}</span>
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
      <span className={cn(TEXT, VIEW_TEXT)}>
        {draft.expectedBehaviors
          .map((behavior, at) => `${String(at + 1)}. ${behavior}`)
          .join(" · ")}
      </span>
    );
  }

  return (
    <div
      className="relative flex min-w-0 flex-col gap-0.5"
      onKeyDown={(event) => {
        if (!woken || event.key !== "Escape") return;
        event.preventDefault();
        event.stopPropagation();
        onCancel();
      }}
    >
      {/*
       * The same list in both states, in the same place, so waking the cell
       * grows the crosses on the chips that are already there rather than
       * drawing the chips again.
       */}
      <PersonaChips
        ids={draft.personas}
        known={known}
        stored={stored}
        /*
         * A test says who calls, so the one persona it has left keeps no
         * cross. Unticking that persona in the picker is what says why.
         */
        removable={woken && draft.personas.length > 1}
        onRemove={(id) =>
          onChange({
            ...draft,
            personas: draft.personas.filter((one) => one !== id),
          })
        }
      />
      {woken ? (
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
          open={picking}
          onOpenChange={(open) => {
            onPick(open);
            // Shutting is the commit, however it was shut — Done, Escape, or a
            // press anywhere else. That is the rule the hand-written listener
            // was written to keep, and closing is the only path to it.
            if (!open) onCommit();
          }}
        />
      ) : null}
    </div>
  );
}

/** What one JSON field of a row says at rest, or `""` when it holds nothing. */
function jsonSaid(
  field: JsonField,
  held: Pick<Draft, "mockTools" | "env">,
): string {
  return field === "mockTools"
    ? mockToolsSummary(held.mockTools)
    : envSummary(held.env);
}

/**
 * What an empty JSON cell offers, which is a different thing in three places.
 */
type Offer =
  /** A written row: `None` at rest, and the add line under a pointer or focus. */
  | "reached"
  /** The entry row, which is being authored right now: the add line, always. */
  | "always"
  /** A reader who cannot author: `None`, because there is nothing to offer. */
  | "never";

/**
 * Show empty saved cells as None, with an add action on fine-pointer hover
 * or keyboard focus. The entry row always shows the action. Use CSS for the
 * swap so pointer movement does not update React state.
 */
function JsonSummary({
  field,
  test,
  offer,
}: {
  readonly field: JsonField;
  readonly test: Pick<Draft, "mockTools" | "env">;
  readonly offer: Offer;
}) {
  const said = jsonSaid(field, test);
  if (said !== "") return <span className={CELL_QUIET}>{said}</span>;
  const add = `+ ${JSON_FIELD[field].add}`;
  if (offer === "always") return <span className={ADD_LINE}>{add}</span>;
  if (offer === "never") return <span className={CELL_QUIET}>None</span>;
  return (
    <>
      <span
        className={cn(
          CELL_QUIET,
          "group-pointer-hover/json:hidden group-focus-visible/json:hidden",
        )}
      >
        None
      </span>
      <span
        className={cn(
          ADD_LINE,
          "hidden group-pointer-hover/json:inline group-focus-visible/json:inline",
        )}
      >
        {add}
      </span>
    </>
  );
}

/**
 * Keep editor text local so typing does not re-render the grid. Shared dialog
 * primitives own focus and dismissal; the grid supplies save status and refusals.
 */
function JsonDialog({
  field,
  initial,
  refused,
  saving,
  onSave,
  onClose,
}: {
  readonly field: JsonField;
  readonly initial: string;
  readonly refused: string | null;
  readonly saving: boolean;
  readonly onSave: (text: string) => void;
  readonly onClose: () => void;
}) {
  const [text, setText] = useState(initial);
  const editor = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    editor.current?.focus();
  }, []);

  return (
    <Dialog title={JSON_FIELD[field].title} onClose={onClose}>
      {(dismiss) => (
        <div className="flex flex-col gap-4">
          <Textarea
            aria-label={JSON_FIELD[field].title}
            className="resize-y font-mono text-sm"
            placeholder={JSON_FIELD[field].example}
            ref={editor}
            /*
             * Fourteen, because the examples are pretty-printed now: the mock
             * tools one is twelve lines, and a box that ends exactly where its
             * own placeholder does gives a reader no way to tell a whole
             * example from a clipped one.
             */
            rows={14}
            spellCheck={false}
            value={text}
            onChange={(event) => setText(event.target.value)}
          />
          {refused === null ? null : <Problem>{refused}</Problem>}
          <div className="flex flex-wrap items-center gap-3">
            <Button
              type="button"
              size="lg"
              busy={saving}
              disabled={saving}
              onClick={() => onSave(text)}
            >
              {saving ? "Saving…" : "Save"}
            </Button>
            <Button
              type="button"
              variant="secondary"
              size="lg"
              disabled={saving}
              onClick={dismiss}
            >
              Cancel
            </Button>
          </div>
        </div>
      )}
    </Dialog>
  );
}

/** What one JSON field of a row, or of the entry row, holds right now. */
type JsonEdit = {
  /** The test being edited, or `null` for the entry row's own draft. */
  readonly test: ListedTest | null;
  readonly field: JsonField;
};

/** What the editor opens with: the stored value, pretty, or nothing at all. */
function jsonText(field: JsonField, held: Pick<Draft, "mockTools" | "env">): string {
  if (field === "mockTools") {
    return held.mockTools.length === 0
      ? ""
      : JSON.stringify(held.mockTools, null, 2);
  }
  return held.env === null ? "" : JSON.stringify(held.env, null, 2);
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
  const entryRequirement = useId();

  const [active, setActive] = useState<Woken | null>(null);
  /**
   * Read the current edit session from a ref after awaits. A render closure
   * may still refer to a cell the user has already left.
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
   * Seed reopened cells from pending save intent, not the older stored row.
   * Otherwise an unchanged blur could write the previous value back.
   */
  const intent = useRef<Map<string, string | readonly string[]>>(new Map());
  /**
   * Queue saves per test so each receives the version/revision produced by
   * the previous save. Different tests keep independent queues.
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
  /**
   * Which row the entry row follows, or `null` for the foot of the table.
   *
   * Duplicate puts the copy where the eye already is — directly under the row
   * it came from — because a prefilled row that appeared at the bottom of a
   * long suite would look like nothing happened. "+ Write a test" keeps the
   * foot, which is where it opens the row from.
   */
  const [entryAnchor, setEntryAnchor] = useState<string | null>(null);
  const [entryRefused, setEntryRefused] = useState<string | null>(null);
  const [entrySaving, setEntrySaving] = useState(false);
  const [discarding, setDiscarding] = useState(false);
  const [deleting, setDeleting] = useState<ListedTest | null>(null);
  const [deleteInFlight, setDeleteInFlight] = useState(false);
  const [deleteRefused, setDeleteRefused] = useState<string | null>(null);
  /** Which JSON field is open in its dialog, and whose. */
  const [editing, setEditing] = useState<JsonEdit | null>(null);
  const [editingRefused, setEditingRefused] = useState<string | null>(null);
  const [editingSaving, setEditingSaving] = useState(false);
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

  const openEntry = useCallback(
    (seed?: Draft, below?: string) => {
      setEntry((held) => seed ?? held ?? EMPTY_DRAFT);
      setEntryAnchor(below ?? null);
      setEntryRefused(null);
      // A fresh row is at rest until the caret lands, which it does below.
      setEntryFocus(null);
      onWriting(true);
      window.requestAnimationFrame(() => entryName.current?.focus());
    },
    [onWriting],
  );

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
      // The two JSON fields keep no unfinished intent of their own: their
      // dialog stays open until the platform answers, so there is never a
      // half-saved value for a woken cell to seed from.
      mockTools: held.mockTools,
      env: held.env,
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
   * Close only the edit session that requested the save; preserve any newer active cell.
   */
  function rest(mine?: Session): void {
    if (mine !== undefined && wokenNow.current?.at !== mine.at) return;
    /*
     * Whose picking this may put away: its own, and nothing else. A commit is
     * awaited, and by the time it answers the picking can belong to another
     * row or to the entry row — the same rule that gives `picking` an owner
     * rather than a boolean. Closing it here shut a picker somebody had just
     * opened, over a save they had already stopped watching.
     */
    const owner = mine?.testId ?? wokenNow.current?.testId ?? null;
    woken(null);
    holdDraft(null);
    setCellRefused(null);
    setPicking((held) => (owner !== null && held === owner ? null : held));
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
     * Read guards when the queued save starts. Content uses expectedVersionId;
     * name edits use expectedRevision. Earlier saves may have advanced either guard.
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

  /**
   * Outside pointer presses commit even when focus does not change. Use the
   * same commit path as blur, including duplicate suppression; Escape reverts.
   * Read the latest handler through a ref so it submits the current draft.
   */
  const outsidePress = useRef<((event: Event) => void) | null>(null);
  useEffect(() => {
    outsidePress.current = (event: Event): void => {
      if (active === null) return;
      // Its own picker being open is the blur handler's exception too: Radix
      // shuts the panel on this same press, and shutting it is the commit.
      if (picking === active.testId) return;
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (target.closest(KEEPS_THE_CELL) !== null) return;
      const test = tests.find((one) => one.id === active.testId);
      if (test === undefined) return;
      void commit(test, active.field);
    };
  });

  useEffect(() => {
    if (active === null) return undefined;
    const press = (event: Event): void => outsidePress.current?.(event);
    /*
     * Capture, so the cell is committed on the way down to whatever was
     * pressed rather than after it has had its turn — a press that opens a
     * dialog or navigates away must carry the save with it.
     */
    document.addEventListener("pointerdown", press, true);
    return () => document.removeEventListener("pointerdown", press, true);
  }, [active]);

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
          // Sent only when the row carries them, so a plain new test asks for
          // exactly what it always asked for.
          ...(entry.mockTools.length === 0
            ? {}
            : { mockTools: [...entry.mockTools] }),
          ...(entry.env === null ? {} : { env: entry.env }),
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
    setEntryAnchor(null);
    onWriting(false);
  }

  /**
   * Queue JSON saves with other edits to the same test and read the latest
   * version when sending. Keep refused drafts open in the dialog.
   */
  async function saveJson(
    test: ListedTest,
    field: JsonField,
    value: readonly TestMockTool[] | TestEnv | null,
  ): Promise<void> {
    setEditingSaving(true);
    setEditingRefused(null);
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
            expectedVersionId: guard.versionId,
          } as Parameters<typeof updateTest>[0],
          { client: platformClient },
        ),
      );
      if (answer.status === "signed-out") {
        window.location.replace("/sign-in");
        return;
      }
      if (answer.status !== "ready") {
        setEditingRefused(answer.refusal.message);
        return;
      }
      latest.current.set(test.id, {
        versionId: answer.value.versionId,
        revision: answer.value.revision,
      });
      onSaved(answer.value);
      setEditing(null);
    };
    const ahead = queued.current.get(test.id) ?? Promise.resolve();
    const run = ahead.then(send, send);
    queued.current.set(
      test.id,
      run.catch(() => undefined),
    );
    await run;
    setEditingSaving(false);
  }

  /**
   * What Save does, wherever the dialog was opened from.
   *
   * The reading is the platform's own, run here first so a person sees why
   * without a round trip; the sentence they see is the one the platform would
   * have sent back. From the entry row nothing is written at all — the draft
   * takes the value and the first Save of the row creates the test with it.
   */
  function commitJson(open: JsonEdit, text: string): void {
    if (open.field === "mockTools") {
      const held = readMockTools(text);
      if (!held.ok) {
        setEditingRefused(held.why);
        return;
      }
      if (open.test === null) {
        setEntry((draft) =>
          draft === null ? draft : { ...draft, mockTools: held.value },
        );
        setEditing(null);
        return;
      }
      void saveJson(open.test, "mockTools", held.value);
      return;
    }
    const held = readEnv(text);
    if (!held.ok) {
      setEditingRefused(held.why);
      return;
    }
    if (open.test === null) {
      setEntry((draft) =>
        draft === null ? draft : { ...draft, env: held.value },
      );
      setEditing(null);
      return;
    }
    void saveJson(open.test, "env", held.value);
  }

  /** Open one JSON field's dialog, with nothing said about it yet. */
  function openJson(test: ListedTest | null, field: JsonField): void {
    if (!mayAuthor) return;
    setEditingRefused(null);
    setEditingSaving(false);
    setEditing({ test, field });
  }

  async function remove(test: ListedTest): Promise<void> {
    setDeleteInFlight(true);
    setDeleteRefused(null);
    // A delete is another write on this Test. Let an already-submitted save
    // finish first, then carry the version and identity revision that save
    // returned rather than the row snapshot that opened this dialog.
    await (queued.current.get(test.id) ?? Promise.resolve());
    const guard = latest.current.get(test.id) ?? {
      versionId: test.versionId,
      revision: test.revision,
    };
    const answer = await platformAnswer(
      deleteTest(
        {
          testId: test.id,
          projectId,
          expectedVersionId: guard.versionId,
          expectedRevision: guard.revision,
        },
        { client: platformClient },
      ),
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
      entry.personas.length > 0 ||
      entry.mockTools.length > 0 ||
      entry.env !== null;
    if (!typed) {
      setEntry(null);
      setEntryAnchor(null);
      onWriting(false);
      return;
    }
    setDiscarding(true);
  }

  /**
   * Editable JSON cells open a dialog with a real button. Read-only rows show
   * the same summary without an interactive control.
   */
  function jsonCell(test: ListedTest, field: JsonField): ReactNode {
    const said = jsonSaid(field, test);
    return (
      <td className={CELL} key={field}>
        {mayAuthor ? (
          <button
            className={cn(
              PAD,
              VIEW_ROW,
              /*
               * Named, the way every other group in the product is: an
               * unnamed one is claimed by whatever group wraps this cell next,
               * and a table row is exactly the place that happens.
               */
              "group/json block w-full cursor-pointer bg-transparent text-left",
            )}
            type="button"
            /*
             * **The name says what pressing does, whichever word is showing.**
             * At rest the cell reads `None`, which is the value rather than
             * the control: a button announced as "None" tells a screen reader
             * nothing about what it is for. So the name stays the verb, and
             * the moment focus reaches the cell the written line becomes the
             * same words.
             */
            aria-label={
              said === ""
                ? `${JSON_FIELD[field].add} for ${test.name}`
                : `${JSON_FIELD[field].title} for ${test.name}`
            }
            onClick={() => openJson(test, field)}
          >
            <JsonSummary field={field} test={test} offer="reached" />
          </button>
        ) : (
          <div className={cn(PAD, VIEW_ROW)}>
            <JsonSummary field={field} test={test} offer="never" />
          </div>
        )}
      </td>
    );
  }

  function cell(test: ListedTest, field: Field): ReactNode {
    if (isJsonField(field)) return jsonCell(test, field);
    const woken = active?.testId === test.id && active.field === field;
    const draft = woken && cellDraft !== null ? cellDraft : draftOf(test);
    return (
      <td
        className={cn(CELL, woken && WOKEN)}
        key={field}
        {...(woken ? { "data-woken-cell": "" } : {})}
        onClick={woken ? undefined : () => wake(test, field)}
        onBlur={
          woken
            ? (event) => {
                if (
                  event.currentTarget.contains(event.relatedTarget as Node | null)
                ) {
                  return;
                }
                /*
                 * An open portaled persona picker still belongs to this cell. Do not commit
                 * on blur into it; picker dismissal owns that commit.
                 */
                if (picking === test.id) return;
                void commit(test, field);
              }
            : undefined
        }
      >
        <div
          className={cn(
            PAD,
            !woken && VIEW_ROW,
            !woken && mayAuthor && "cursor-text",
          )}
        >
          <CellBody
            field={field}
            woken={woken}
            draft={draft}
            known={known}
            stored={test.personas.map((persona) => persona.id)}
            projectId={projectId}
            owner={test.id}
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
              {/*
                Duplicate writes nothing. It opens the entry row under this one
                with this test's content in it, and the row's own Save is what
                creates the copy — so somebody can change the name, or the
                scenario, or think better of it, before any test exists.
              */}
              <MenuItem
                disabled={!mayAuthor}
                onClick={() => {
                  close();
                  openEntry(copyOf(test), test.id);
                }}
              >
                Duplicate
              </MenuItem>
              <MenuDivider />
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
    if (isJsonField(field)) {
      // From the entry row the dialog edits the draft, because there is no
      // test to save against yet. The row's own Save carries what it holds.
      const said = jsonSaid(field, entry);
      return (
        <td className={CELL} key={field}>
          <button
            className={cn(
              PAD,
              "block w-full cursor-pointer bg-transparent text-left",
            )}
            type="button"
            aria-label={
              said === ""
                ? `${JSON_FIELD[field].add} for the new test`
                : `${JSON_FIELD[field].title} for the new test`
            }
            onClick={() => openJson(null, field)}
          >
            <JsonSummary field={field} test={entry} offer="always" />
          </button>
        </td>
      );
    }
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
            <div className="relative flex min-w-0 flex-col gap-0.5">
              <PersonaChips
                ids={entry.personas}
                known={known}
                /* Nothing here is written yet: every chip is one just chosen. */
                stored={[]}
                /*
                 * Every chip here can go. The row is not a test yet, and its
                 * own Save is what says it needs one persona.
                 */
                removable
                onRemove={(id) =>
                  setEntry({
                    ...entry,
                    personas: entry.personas.filter((one) => one !== id),
                  })
                }
              />
              <PersonaPicker
                projectId={projectId}
                chosen={entry.personas}
                known={known}
                onChange={(ids, named) => {
                  setEntry({ ...entry, personas: ids });
                  setKnown(named);
                }}
                open={picking === "entry"}
                onOpenChange={(open) => setPicking(open ? "entry" : null)}
              />
            </div>
          )}
        </div>
      </td>
    );
  }

  /** The row being written, wherever it stands. */
  function entryRow(): ReactNode {
    return (
      <tr data-entry-row="">
        {COLUMNS.map((column) => entryCell(column.field))}
        {/*
          Nothing to delete yet, so this cell holds the lane open and says
          nothing: no wake, no edge, nothing to click. A row that is not
          written has no action to offer, and dressing the lane like an
          editable cell promised one.
        */}
        <td className={ACTION} />
      </tr>
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
      {/*
       * Keep horizontal scrolling below the grid minimum width. Portaled pickers
       * do not require changing overflow or losing the current scroll position.
       */}
      <div className="overflow-x-auto">
      <table className="w-full min-w-(--tests-grid-min-width) table-fixed border-collapse border border-border bg-surface text-sm">
        <caption className="sr-only">Tests in this suite</caption>
        <colgroup>
          {COLUMNS.map((column) => (
            <col key={column.field} style={{ width: column.width }} />
          ))}
          <col style={{ width: "var(--table-action-labelled-width)" }} />
        </colgroup>
        <thead>
          <tr className="bg-surface-soft">
            {COLUMNS.map((column) => (
              <th
                className={cn(
                  PAD,
                  "border-r border-b border-border text-left text-sm font-normal text-faint last:border-r-0",
                )}
                key={column.field}
                scope="col"
                aria-label={columnHeading(column.header, column.required)}
              >
                {column.header}
                {column.required ? <RequiredMark /> : null}
              </th>
            ))}
            {/*
              The trailing lane is named out loud. It was a blank cell with the
              words hidden for screen readers only, so on screen the ⋮ column
              was the one column of the grid with no header over it. "Actions"
              is what it holds, and every reader gets the same word now.
            */}
            <th
              className={cn(
                PAD,
                "w-(--table-action-labelled-width) border-b border-border text-center text-sm font-normal whitespace-nowrap text-faint",
              )}
              scope="col"
            >
              Actions
            </th>
          </tr>
        </thead>
        <tbody>
          {/*
           * An empty suite shows only the actionable entry row, without a sample row
           * that could be mistaken for an editor.
           */}
          {tests.map((test) => (
            <Fragment key={test.id}>
              <tr data-test-row={test.id}>
                {COLUMNS.map((column) => cell(test, column.field))}
                {rowMenu(test)}
              </tr>
              {/*
                A duplicate stands under the row it came from, so the copy
                appears where the eye already is rather than at the foot of a
                suite somebody would have to scroll to find.
              */}
              {entry !== null && entryAnchor === test.id ? entryRow() : null}
            </Fragment>
          ))}
          {entry === null || entryAnchor !== null ? null : entryRow()}
          {mayAuthor && entry === null ? (
            <tr>
              <td
                className={cn(CELL, "border-b-0")}
                colSpan={COLUMNS.length + 1}
              >
                <button
                  className={cn(ADD_LINE, PAD, "w-full")}
                  type="button"
                  onClick={() => openEntry()}
                >
                  + Write a test
                </button>
              </td>
            </tr>
          ) : null}
          {/*
            A reader who cannot write gets the line the author's way in would
            have stood on. Without it an empty suite is column headings over
            nothing, which is the one state that says neither what is here nor
            why nothing is.
          */}
          {tests.length === 0 && entry === null && !mayAuthor ? (
            <tr>
              <td
                className={cn(CELL, PAD, TEXT, "border-b-0 text-faint")}
                colSpan={COLUMNS.length + 1}
              >
                {why ?? "No tests in this suite yet."}
              </td>
            </tr>
          ) : null}
        </tbody>
      </table>
      </div>

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
            {...(why === undefined ? {} : { why })}
            aria-describedby={
              why === undefined && missing !== null ? entryRequirement : undefined
            }
            onClick={() => void write()}
          >
            {entrySaving ? "Saving…" : "Save test"}
          </Button>
          {why === undefined && missing !== null ? (
            <span className="sr-only" id={entryRequirement}>
              {missing}
            </span>
          ) : null}
          <Button
            type="button"
            variant="secondary"
            size="lg"
            disabled={entrySaving}
            onClick={askToDiscard}
          >
            Cancel
          </Button>
        </Arriving>
      )}

      {entryRefused === null ? null : (
        <p className="mt-2 text-sm text-failure" role="alert">
          {entryRefused}
        </p>
      )}

      {editing === null ? null : (
        <JsonDialog
          field={editing.field}
          /*
           * Keyed so a second cell opened after the first starts from its own
           * value: the editor holds the text itself, and a component that was
           * only re-rendered would keep the words from the cell before it.
           */
          key={`${editing.test?.id ?? "entry"}:${editing.field}`}
          initial={jsonText(
            editing.field,
            editing.test === null
              ? (entry ?? EMPTY_DRAFT)
              : draftOf(editing.test),
          )}
          refused={editingRefused}
          saving={editingSaving}
          onSave={(text) => commitJson(editing, text)}
          onClose={() => setEditing(null)}
        />
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
                    setEntryAnchor(null);
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
