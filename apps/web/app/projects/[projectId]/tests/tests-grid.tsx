"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ComponentProps,
  type ReactNode,
} from "react";
import { createTest, listPersonas, updateTest } from "@egma/platform-api/client";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  platformAnswer,
  platformClient,
} from "../../../../lib/platform-client.ts";
import type { ListedTest } from "../../../../lib/tests.ts";
import { Dialog } from "../../../../ui/dialog.tsx";

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
 * The look is `LNC-0`, `LUT-0` and boards 10–14 of Paper page 04B: a Pure Paper
 * panel inside one hairline, hairlines between every cell, a woken cell inside
 * a 2px ink edge, add-affordances only on the woken cell, and a ghost row at
 * the foot that opens the entry row.
 */

/** A persona as a cell needs it: an id to send and a name to show. */
type Named = { readonly id: string; readonly name: string };

/** What a cell is, which is also which field one save carries. */
type Field = "name" | "scenario" | "expectedBehaviors" | "personas";

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
const PAD = "px-2.5 py-2";
const TEXT = "text-sm leading-caption text-foreground";
/*
 * A woken cell wears its 2px ink edge as an inset shadow rather than a border,
 * so waking one moves nothing: a border would take two pixels out of the cell
 * and shove every word in the row sideways. Only the shadow transitions, and
 * only over `--duration-hover`.
 */
const WOKEN =
  "shadow-[inset_0_0_0_2px_var(--border-strong)] transition-shadow duration-(--duration-hover) ease-out motion-reduce:transition-none";
const QUIET_INPUT =
  "w-full resize-none border-0 bg-transparent p-0 text-sm leading-caption text-foreground outline-none placeholder:text-faint";

/** The ember affordance a woken cell grows, and nothing else on the screen. */
const ADD_LINE =
  "cursor-pointer bg-transparent p-0 text-left text-sm leading-caption text-primary underline-offset-4 pointer-hover:underline";

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

  useEffect(() => {
    let live = true;
    void platformAnswer(
      listPersonas({ projectId }, { client: platformClient }),
    ).then((answer) => {
      if (!live) return;
      if (answer.status === "signed-out") {
        window.location.replace("/sign-in");
        return;
      }
      if (answer.status !== "ready") {
        setRefused(answer.refusal.message);
        return;
      }
      setPeople(
        answer.value.personas.map((one) => ({ id: one.id, name: one.name })),
      );
    });
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
    <Arriving
      className="absolute top-full left-0 z-20 mt-1 w-[300px] origin-top border border-border bg-surface shadow-popover"
      role="dialog"
      aria-label="Choose personas"
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
              className="flex h-9 cursor-pointer items-center gap-2.5 px-2.5 text-sm text-foreground pointer-hover:bg-surface-soft"
              key={one.id}
            >
              <input
                className="size-4 flex-none accent-[var(--action)]"
                type="checkbox"
                checked={chosen.includes(one.id)}
                onChange={() => toggle(one)}
              />
              <span className="min-w-0 truncate">{one.name}</span>
            </label>
          ))
        )}
      </div>
      <div className="flex justify-end border-t border-border px-2.5 py-1.5">
        <button className={cn(ADD_LINE, "underline")} type="button" onClick={onDone}>
          Done
        </button>
      </div>
    </Arriving>
  );
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
  const last = useRef<HTMLInputElement | null>(null);
  const [adding, setAdding] = useState(false);

  useEffect(() => {
    if (adding) last.current?.focus();
  }, [adding, behaviors.length]);

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
            ref={at === behaviors.length - 1 ? last : undefined}
            onChange={(event) => {
              const next = [...behaviors];
              next[at] = event.target.value;
              onChange(next);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                if (behavior.trim() === "") {
                  onCommit();
                  return;
                }
                setAdding(true);
                onChange([...behaviors.slice(0, at + 1), "", ...behaviors.slice(at + 1)]);
                return;
              }
              if (event.key === "Escape") {
                event.preventDefault();
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
          setAdding(true);
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
    <div className="relative flex flex-col gap-0.5">
      <span className={TEXT}>{personaNames(draft.personas, known)}</span>
      {woken ? (
        <button
          className={ADD_LINE}
          type="button"
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
    more,
  } = props;

  const [active, setActive] = useState<{ testId: string; field: Field } | null>(null);
  const [cellDraft, setCellDraft] = useState<Draft | null>(null);
  const [cellRefused, setCellRefused] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [picking, setPicking] = useState(false);
  const [known, setKnown] = useState<ReadonlyMap<string, Named>>(new Map());
  const [entry, setEntry] = useState<Draft | null>(null);
  const [entryRefused, setEntryRefused] = useState<string | null>(null);
  const [entrySaving, setEntrySaving] = useState(false);
  const [discarding, setDiscarding] = useState(false);
  const entryName = useRef<HTMLInputElement>(null);

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
    onWriting(true);
    window.requestAnimationFrame(() => entryName.current?.focus());
  }, [onWriting]);

  useEffect(() => {
    if (writing && entry === null) setEntry(EMPTY_DRAFT);
  }, [writing, entry]);

  function wake(test: ListedTest, field: Field): void {
    if (!mayAuthor) return;
    setActive({ testId: test.id, field });
    setCellDraft(draftOf(test));
    setCellRefused(null);
    setPicking(false);
  }

  function rest(): void {
    setActive(null);
    setCellDraft(null);
    setCellRefused(null);
    setPicking(false);
  }

  async function commit(test: ListedTest, field: Field): Promise<void> {
    if (cellDraft === null || saving) return;
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
    if (unchanged) {
      rest();
      return;
    }
    setSaving(true);
    setCellRefused(null);
    /*
     * One field, and the guard the platform asks that field for. A content
     * edit carries the version it was read at, so a save cannot land on top of
     * somebody else's; a name is identity and carries the revision instead.
     */
    const answer = await platformAnswer(
      updateTest(
        {
          testId: test.id,
          projectId,
          [field]: value,
          ...(isContent(field)
            ? { expectedVersionId: test.versionId }
            : { expectedRevision: test.revision }),
        } as Parameters<typeof updateTest>[0],
        { client: platformClient },
      ),
    );
    setSaving(false);
    if (answer.status === "signed-out") {
      window.location.replace("/sign-in");
      return;
    }
    if (answer.status !== "ready") {
      setCellRefused(answer.refusal.message);
      return;
    }
    onSaved(answer.value);
    rest();
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
            picking={woken && picking}
            onPick={setPicking}
            onChange={setCellDraft}
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

  function entryCell(field: Field): ReactNode {
    if (entry === null) return null;
    return (
      <td className={cn(CELL, WOKEN)} key={field}>
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
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => setPicking(!picking)}
              >
                + Add a persona
              </button>
              {picking ? (
                <PersonaPicker
                  projectId={projectId}
                  chosen={entry.personas}
                  known={known}
                  onChange={(ids, named) => {
                    setEntry({ ...entry, personas: ids });
                    setKnown(named);
                  }}
                  onDone={() => setPicking(false)}
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
            </tr>
          ) : null}
          {tests.map((test) => (
            <tr key={test.id}>
              {COLUMNS.map((column) => cell(test, column.field))}
            </tr>
          ))}
          {entry === null ? null : (
            <tr>{COLUMNS.map((column) => entryCell(column.field))}</tr>
          )}
          {mayAuthor && entry === null ? (
            <tr>
              <td className={cn(CELL, "border-b-0")} colSpan={COLUMNS.length}>
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
        <Arriving className="mt-3 flex flex-wrap items-center gap-3">
          <Button
            type="button"
            size="lg"
            disabled={!mayAuthor || missing !== null || entrySaving}
            busy={entrySaving}
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
          <p className="m-0 text-sm text-muted-foreground" role="status">
            {missing ?? "Not saved yet."}
          </p>
        </Arriving>
      )}

      {entryRefused === null ? null : (
        <p className="mt-2 text-sm text-failure" role="alert">
          {entryRefused}
        </p>
      )}

      {discarding ? (
        <Dialog title="Discard this test?" onClose={() => setDiscarding(false)}>
          {(dismiss) => (
            <div className="flex flex-col gap-5">
              <p className="m-0 text-sm text-muted-foreground">
                What you typed is not saved. Egma keeps nothing from this row.
              </p>
              <div className="flex flex-wrap items-center gap-3 pt-1">
                <Button
                  type="button"
                  variant="destructive"
                  size="lg"
                  onClick={() => {
                    setDiscarding(false);
                    setEntry(null);
                    setPicking(false);
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
