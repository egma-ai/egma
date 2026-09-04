"use client";

import {
  Fragment,
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
 * a 2px ink edge, add-affordances on the woken cell, and a ghost row at the
 * foot that opens the entry row.
 *
 * The two JSON cells are the exception to "only when woken", and the founder
 * made it on 2026-09-04: they are not cells anybody types in, so they never
 * wake, and an empty one that showed nothing was a control with no sign it was
 * one. They carry the same add-affordance at rest.
 */

/** A persona as a cell needs it: an id to send and a name to show. */
type Named = { readonly id: string; readonly name: string };

/** What a cell is, which is also which field one save carries. */
type Field =
  | "name"
  | "scenario"
  | "expectedBehaviors"
  | "personas"
  | "mockTools"
  | "env";

/**
 * The two fields written as raw JSON, in a dialog rather than in the cell.
 *
 * **They are cells that open something, not cells you type in.** A mock tool's
 * answer is arbitrary JSON and an env is two nested objects, and neither fits
 * on a table row that has to stay scannable beside a scenario. So the cell
 * carries one short summary — or, while it holds nothing, the line that offers
 * to write the first one — and the writing happens in the smallest dialog that
 * holds a monospace editor, a reason when there is one, and Save and Cancel.
 */
type JsonField = "mockTools" | "env";

function isJsonField(field: Field): field is JsonField {
  return field === "mockTools" || field === "env";
}

/**
 * What each JSON dialog is called, what its empty cell offers, and what its
 * empty editor shows.
 *
 * **The example is written by the same call the editor is.** A stored value
 * opens as `JSON.stringify(value, null, 2)`, so a one-line example taught the
 * shape in a grammar this field never writes back: somebody copied it, saved,
 * reopened, and read a document that looked nothing like the one they had
 * pasted. Running a real value through the same call is what keeps the empty
 * editor and the full one the same shape — it cannot drift, because there is
 * no second copy of the formatting to drift from (founder, 2026-09-04).
 *
 * `add` is the empty cell's own line, and it is a verb rather than the column
 * heading again: the cell says what pressing it does.
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

/**
 * The columns, at the proportions `LNC-0` draws them, rebalanced for two more.
 *
 * **Every column holds its own heading on one line at the grid's floor**, and
 * that is what set these numbers rather than taste. At the 900px floor the
 * headings want, inside `--row-padding-x` either side, about 100px for
 * `Mock tools` and about 90px for `Personas`; `Expected behaviors` is the
 * widest word in the row and wants about 150.
 *
 * **The two JSON lanes are 15% each, and the sentences in them are why**
 * (founder, 2026-09-04). Their cells no longer hold a bare count and a list of
 * key names: an empty one offers `+ Add mock tools` or `+ Add env variables`,
 * and a full Env says `View env variables`. That is about 130px of words in a
 * lane that was 8%, which is 72px at the floor — so Env was the one column in
 * the grid whose content could not be drawn inside it at any width. Scenario
 * and Expected behaviors gave up the five and four points, because they are
 * the two lanes with room to give and their own headings still fit.
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
  { field: "personas", header: "Personas", width: "12%", required: true },
  { field: "mockTools", header: "Mock tools", width: "15%", required: false },
  { field: "env", header: "Env", width: "15%", required: false },
];

/**
 * The star over a column a test cannot be saved without.
 *
 * **It is the product's own label grammar, moved up to the heading.** The grid
 * has no field labels — a cell is the value and the column heading is its only
 * name — so the four mandatory fields had no way of saying so until the Save
 * button refused. `DESIGN.md` already sets the grammar: a mandatory field's
 * label ends in `*`.
 *
 * **The star wears the heading's own colour, not Ember** (founder,
 * 2026-09-04). A form draws its star in the brand colour, where it is one mark
 * on a quiet column of labels. A heading row is six labels side by side, and
 * four orange marks across it read as a state the table is in rather than a
 * fact about four fields. `ui/form.tsx` keeps the Ember star for forms.
 *
 * **And it is never only a picture**, which is the other half of the same
 * rule. A `<th>` takes no `aria-required`, so the heading says the word
 * instead, and it says it through the cell's own name rather than a hidden
 * span beside the star: the name a `<th>` computes from its contents runs the
 * text nodes together, so a hidden `(required)` was announced as
 * `Name(required)`. `columnHeading` below is the one place that name is built.
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
 * **The row's own ⋮ lane, and it is not a fifth column.** The four columns are
 * the test's content; this is the house table's trailing slot, which every row
 * of every list in the product carries so the triggers line up in one lane.
 * The boards are silent on it, so the current screen's verb stays: a test is
 * deleted from its row.
 *
 * **It is the labelled width, because this grid says Actions over it.** The
 * unlabelled `--table-action-width` is sized for a ⋮ and nothing else, so the
 * word ran out through the table's own right hairline. Header and body cells
 * read the one token — and so does the `<col>` this table's fixed layout
 * actually measures — so the lane stays one straight edge from the heading to
 * the last row.
 */
const ACTION =
  "w-(--table-action-labelled-width) border-b border-border p-0 text-center align-top";
/**
 * The lane's padding, and it is the house table's rather than this grid's own.
 *
 * This is the one table in the product that is not drawn from
 * `components/ui/table.tsx`, and it had been reading from 10px where every
 * other list reads from `--row-padding-x`. Six pixels is enough to see: a
 * person who walks Agents, Runs, Personas and then a suite watches the first
 * column step left, and 10px is not on `DESIGN.md`'s spacing scale to begin
 * with. Header and cells both read this, so the column keeps one edge from the
 * heading to the last row — which is the same promise the shared table makes.
 *
 * The edge itself is imported rather than copied: this grid is the one table
 * that inherits nothing from `components/ui/table.tsx`, and two files naming
 * the same edge separately is how it drifted off it the first time.
 */
const PAD = `${LANE_X} py-(--row-padding-y)`;
const TEXT = "text-sm leading-(--line-caption) text-foreground";
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
 * The persona picker, and this is its only home.
 *
 * It opens from the woken Personas cell — search, tick boxes, Done — because
 * the cell is where the answer is read.
 *
 * **It is the kit's popover now, and that is what deleted the grid's worst
 * trade.** The panel used to be an absolutely positioned box inside the cell,
 * which any scroll container clips, so the grid switched its own sideways
 * scrolling off for as long as a picker was open — and on a phone that switch
 * threw away the reader's place in the table. `PopoverContent` is drawn in a
 * portal, so nothing clips it and the grid scrolls at all times.
 *
 * **The click-outside rule is Radix's, and it is the same rule spelled once.**
 * The hand-written listener had to measure "elsewhere" against an owner id,
 * because a marker with no owner made *another* row's trigger count as inside
 * this panel: the picking moved to that row, Done never ran, and the personas
 * ticked here went with no save and no word said. A popover only knows itself,
 * so pressing another row's trigger dismisses this one first — which closes it
 * the way Done does, keeping the ticks — and the press then opens that row's.
 * The owner id is gone from this component because Radix is what holds the
 * rule now, and `tests-grid` keeps its own `picking` only to know which cell to
 * commit.
 *
 * The reading lives in `PersonaChoices`, inside the panel, because Radix mounts
 * the panel's children when it opens. A row that is never opened must not send
 * the project's whole persona list over the wire, and there is one of these per
 * row.
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
          type="button"
          /* The cell owns its own caret; opening must not move it first. */
          onMouseDown={(event) => event.preventDefault()}
        >
          + Add a persona
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        /* Never wider than the screen it has to fit on, as `ui/menu.tsx` is. */
        className="w-[min(300px,calc(100vw-var(--space-8)))] p-0"
        aria-label="Choose personas"
        /*
         * **Focus leaving does not shut this panel; a press elsewhere does.**
         * A popover closes on both by default, and the first one is wrong here:
         * the cell this hangs off keeps a caret of its own — the entry row puts
         * one in Name as soon as it wakes — so focus lands back outside the
         * panel a tick after it opens and Radix reads that as an exit. The
         * panel shut itself before anybody could tick a name.
         *
         * A press outside still closes it, which is the rule that matters: that
         * is the save, and it is what carries the ticks to the platform. Escape
         * still closes it too.
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
    /*
     * **`label` names the search field, not the list, and that is `cmdk`'s
     * doing rather than a choice made here.** It renders the prop into a hidden
     * element and points the field's `aria-labelledby` at it — always, even
     * with no label given, which is why an `aria-label` on the field is
     * overridden and silently does nothing. So the words that describe the
     * typing have to arrive through this prop. The panel around it is a dialog
     * and carries "Choose personas" of its own, so nothing is left unnamed.
     */
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
          <span className="flex-none text-sm tabular-nums text-foreground">
            {at + 1}.
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
            <span className="tabular-nums text-foreground">{at + 1}.</span> {behavior}
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
 * What a JSON cell shows at rest: the summary, or the way to write the first one.
 *
 * Muted text rather than a chip (founder, 2026-09-03): a chip in a table lane
 * this narrow is decoration, and what a reader needs is one short fact they can
 * scan past.
 *
 * **An empty cell says how to fill it** (founder, 2026-09-04). It used to be
 * blank, so the only thing that said a mock tool or an env could be written
 * here was the pointer changing shape over it — which a person has to already
 * suspect the cell is a control to find.
 *
 * **But it says it only to the row being reached for** (founder, 2026-09-04,
 * on seeing it built). Two brand lines on every row of a full suite is a column
 * of orange down a table whose job is to be scanned: `ADD_LINE` is an
 * invitation, and an invitation repeated on forty rows stops being one. So a
 * written row rests on `None` — the truthful empty state, in the same faint ink
 * the summary beside it uses — and offers the line when a pointer is over the
 * cell or the keyboard is in it. The entry row keeps the line at all times,
 * because that row *is* the act of authoring.
 *
 * **The swap is CSS, not state.** Two spans and the button's own `group`, so a
 * pointer crossing a suite re-renders nothing; a `useState` per cell would run
 * React on every mouse move across the grid. The pointer half is gated to fine
 * pointers, which is `DESIGN.md`'s rule and the reason `pointer-hover` exists —
 * on a touch screen `:hover` sticks after a tap and would leave the line up on
 * the row somebody just pressed. The focus half is not gated, because a
 * keyboard is a keyboard on every device.
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
 * The smallest dialog that fits one JSON field.
 *
 * The editor, the reason when there is one, Save and Cancel — and nothing
 * else. Centred, focus trapped, Escape closes, the opener restored: all of that
 * is `ui/dialog.tsx`'s, which is why none of it is written here.
 *
 * **The text is this component's, not the grid's.** A keystroke in here would
 * otherwise re-render every row of the table, and the value only matters when
 * Save is pressed. The reason and the busy state come from above, because the
 * platform is what says them.
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

  /**
   * A press anywhere else is leaving the cell, and leaving a cell commits it.
   *
   * **Blur alone does not close a cell, because most of a page takes no
   * focus.** The canvas beside the table, the table's own headings, the page
   * title: pressing any of them moves focus nowhere, so no blur fires and the
   * woken cell sat there wearing its ink edge over words nobody had saved
   * (founder, 2026-09-04). A press is what a person means by "I am done with
   * that cell", whether or not the browser had anywhere to put the caret.
   *
   * **It runs the same `commit` a blur runs**, so every rule that governs a
   * save governs this one: the identical-resubmit guard that makes a press
   * followed by a blur one request rather than two, the per-test queue, the
   * version the queue hands it, and the refusal shown in place. Escape is
   * untouched and still reverts.
   *
   * The handler is rebuilt every render and reached through a ref, because it
   * has to run *this* render's `commit` over *this* render's draft — a
   * listener captured once would save whatever was in the cell when it was
   * woken.
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
   * One JSON field of one written test, saved against the version it was read
   * at.
   *
   * **It queues behind whatever else that test is saving**, for the reason the
   * cell commits do: two content edits carrying the same version would have the
   * second refused for holding a version the first had just replaced. The guard
   * is read when the queue reaches this, so the save in front hands this one
   * the version it minted.
   *
   * A refusal stays in the dialog. Nothing is written and nothing is closed, so
   * the JSON somebody wrote is still on screen to fix.
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
   * A JSON cell: the summary, and the way into the dialog that writes it.
   *
   * It is a button rather than a woken cell because there is nothing to type
   * here — the value is JSON and it is written in the dialog. A row a reader
   * cannot author draws the same summary with nothing to press.
   *
   * Focus is the product's own two-pixel indicator, drawn on every button by
   * the unlayered rule in `globals.css`. The cell adds none of its own.
   */
  function jsonCell(test: ListedTest, field: JsonField): ReactNode {
    const said = jsonSaid(field, test);
    return (
      <td className={CELL} key={field}>
        {mayAuthor ? (
          <button
            className={cn(
              PAD,
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
          <div className={PAD}>
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
                 * **A cell whose own picker is open has not been left.** The
                 * panel is drawn in a portal now, so it is not a descendant of
                 * this cell and the test above reads focus moving into it as
                 * focus going away — which committed the cell and tore the
                 * panel down under the person about to tick a name. Asking
                 * whether this cell is the one picking is the same question
                 * without depending on where focus landed, which a browser may
                 * not say: `relatedTarget` is null on plenty of real blurs.
                 *
                 * Shutting the picker is what commits, and it commits there.
                 */
                if (picking === test.id) return;
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
            <div className="relative flex flex-col gap-0.5">
              <span className={TEXT}>{personaNames(entry.personas, known)}</span>
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
        The grid scrolls sideways rather than squeezing, the way every other
        table's `TablePanel` already does. Six percentage columns and a fixed
        lane share whatever width there is, and this grid has no narrow layout
        to fall back to, so under `--tests-grid-min-width` the columns stop
        holding their own headings on one line. Mock tools and Env raised that
        floor past a tablet, and the token says why.

        **It scrolls at all times now, and it used not to.** The persona picker
        was an absolutely positioned panel inside the cell it belongs to, and a
        scroll container clips exactly that — so this wrapper switched between
        `overflow-x: auto` and `overflow-visible` to keep an open picker whole,
        and on a phone the switch threw away the reader's place in the table.
        The picker is the kit's popover now and is drawn in a portal, the way
        the shared table's ⋮ always was, so nothing here has to move out of its
        way.
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
            An empty suite draws no teaching row. The faint "One situation to
            put the agent in…" row looked like a row to type in, so the first
            thing a person did on an empty suite was click it and get nothing:
            it was a picture of a test, and the way in was the line under it.
            The way in is now the only thing there (developer decision,
            2026-08-26).

            The run-flow refinement answered the same complaint the other way,
            by making that faint first cell open the entry row. The row is
            gone instead, so there is nothing left to make clickable: a picture
            of a test that opens a real one is still a picture of a test.
          */}
          {tests.map((test) => (
            <Fragment key={test.id}>
              <tr>
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
