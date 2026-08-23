"use client";

import { ChevronDownIcon, XIcon } from "lucide-react";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { listAgents, listPersonas } from "@egma/platform-api/client";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { platformAnswer, platformClient } from "../../../../lib/platform-client.ts";
import {
  type ExpectedBehavior,
  type Named,
  type TestMockTool,
} from "../../../../lib/tests.ts";
import { Problem } from "../../../../ui/form.tsx";
import { Menu } from "../../../../ui/menu.tsx";

/**
 * The parts a test is authored and read through.
 *
 * **The sheet and the page draw the same test.** `ATG-0` writes a test in a
 * side sheet and `B9M-0` reads one on a page, and the four blocks between the
 * name and the footer — the scenario, the expected behaviors, the personas and
 * the overrides — are drawn identically on both boards. So they are one
 * component, `TestChecks`, and neither surface owns a second drawing of them.
 *
 * **A choice comes from the server.** Which personas may call about a test is a
 * list the platform owns. A form holding its own copy would offer something the
 * platform refuses, and the refusal would arrive after somebody had written a
 * test around it.
 *
 * **Version history left this file with the boards.** `B9M-0` has no history
 * aside, and versioning is hidden from the interface for launch, so the
 * component that read an old version and the request behind it are gone. The
 * versions themselves are untouched: every run still pins the version it ran.
 *
 * These live in this file rather than in the shared set because they are the
 * Tests area's and nothing else uses them. The controls they are built from are
 * the shared ones.
 */

/** What a test checks, as one editable value both surfaces hold. */
export type TestContentDraft = {
  readonly scenario: string;
  readonly behaviors: readonly ExpectedBehavior[];
  readonly personas: readonly string[];
};

/**
 * The label over a block, uppercase by rule rather than by spelling.
 *
 * The boards head each block of a test with a letter-spaced capital label —
 * SCENARIO, EXPECTED BEHAVIORS — and where that block has one control the label
 * *is* that control's label. So the word in the document stays "Scenario",
 * which is what a screen reader reads and what a test looks for, and the
 * capitals are `text-transform`. Spelling it in capitals would change the
 * accessible name to match a styling decision.
 *
 * It is the 14px step: `DESIGN.md` keeps the 12px micro label for the two
 * labels the sidebar carries and nothing else.
 */
const EYEBROW = "text-xs font-normal tracking-(--tracking-label) text-faint uppercase";

/** The sentence under an eyebrow that says what belongs in the block. */
function BlockLead({ id, children }: { readonly id?: string; readonly children: ReactNode }) {
  return (
    <p className="m-0 text-sm text-muted-foreground" id={id}>
      {children}
    </p>
  );
}

/**
 * One block of the test: a capital label, a sentence, and the fields.
 *
 * `htmlFor` makes the label a real label. A block with more than one control —
 * the behaviors, the personas — has nothing single to point at, so it heads
 * itself with a paragraph and each control carries its own name.
 */
function Block({
  eyebrow,
  htmlFor,
  lead,
  leadId,
  children,
}: {
  readonly eyebrow: string;
  readonly htmlFor?: string;
  readonly lead?: ReactNode;
  readonly leadId?: string;
  readonly children: ReactNode;
}) {
  return (
    <section className="flex min-w-0 flex-col gap-3">
      {htmlFor === undefined ? (
        <p className={cn("m-0", EYEBROW)}>{eyebrow}</p>
      ) : (
        <Label className={EYEBROW} htmlFor={htmlFor}>
          {eyebrow}
        </Label>
      )}
      {lead === undefined ? null : <BlockLead id={leadId}>{lead}</BlockLead>}
      {children}
    </section>
  );
}

/**
 * The head of a group on the test page: the capital label and the sentence that
 * says what the group is for. `B9M-0` heads both of its groups this way.
 */
export function GroupHead({
  id,
  eyebrow,
  lead,
}: {
  readonly id?: string;
  readonly eyebrow: string;
  readonly lead: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2">
      <p className={cn("m-0", EYEBROW)} id={id}>
        {eyebrow}
      </p>
      <BlockLead>{lead}</BlockLead>
    </div>
  );
}

/**
 * The quiet way to add one more row.
 *
 * Text in the action colour with no box around it, which is what the boards
 * draw under the behaviors and the overrides (`+ Add a behavior`). It is a
 * `Button` in kind rather than in dress: `DESIGN.md`'s quiet action is text
 * only, and a bordered control here would compete with the footer's answer.
 */
function AddRow({
  disabled = false,
  onClick,
  children,
}: {
  readonly disabled?: boolean;
  readonly onClick: () => void;
  readonly children: ReactNode;
}) {
  return (
    <button
      className={cn(
        "inline-flex w-fit min-h-(--control-md) items-center gap-1 px-0",
        "cursor-pointer rounded-button border-0 bg-transparent",
        /*
         * `text-primary` is the Ember-ink key: the theme maps
         * `--color-primary` onto `--action`, and there is no `--color-action`
         * for a `text-action` to read. A class that reads nothing draws the
         * inherited colour, which is how this arrived as ordinary body text.
         */
        "text-sm text-primary",
        "transition-[color] duration-(--duration-hover) ease-out",
        "pointer-coarse:min-h-(--tap-target)",
        "pointer-hover:not-disabled:text-primary-hover",
        "disabled:cursor-not-allowed disabled:opacity-55",
        "motion-reduce:transition-none",
      )}
      type="button"
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

/** The ✕ that takes one row out of an ordered list. */
function RemoveRow({
  label,
  disabled = false,
  onClick,
}: {
  readonly label: string;
  readonly disabled?: boolean;
  readonly onClick: () => void;
}) {
  return (
    <button
      className={cn(
        "inline-flex size-(--control-md) flex-none cursor-pointer items-center justify-center",
        "rounded-button border border-transparent bg-transparent text-faint",
        "transition-[color,background-color] duration-(--duration-hover) ease-out",
        "pointer-coarse:size-(--tap-target)",
        "pointer-hover:not-disabled:bg-surface-soft pointer-hover:not-disabled:text-foreground",
        "disabled:cursor-not-allowed disabled:opacity-55",
        "motion-reduce:transition-none",
      )}
      type="button"
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
    >
      <XIcon className="size-3.5" strokeWidth={1.5} aria-hidden="true" />
    </button>
  );
}

/** The number down the left of an ordered list, in the identifier face. */
function RowIndex({ index }: { readonly index: number }) {
  return (
    <span
      className="mt-3 w-4 flex-none font-mono text-sm text-faint tabular-nums"
      aria-hidden="true"
    >
      {index + 1}
    </span>
  );
}

/**
 * The expected behaviors: one sentence each, numbered, and nothing beside them.
 *
 * **There is nothing to say per sentence, so there is no second column.** Every
 * expected behavior has to hold — that is what makes a test falsifiable — so
 * the question "what happens if this one fails" has one answer for the whole
 * list and does not belong on any row. How loudly a *grader* speaks is the
 * running copy's `required` flag, set where the copy is, once.
 *
 * The box grows with what is typed rather than starting four lines tall: a
 * behavior is a sentence, and four empty lines per statement is what turned a
 * list of five into a screenful.
 */
export function Behaviors({
  behaviors,
  disabled = false,
  onChange,
}: {
  readonly behaviors: readonly ExpectedBehavior[];
  readonly disabled?: boolean;
  readonly onChange: (behaviors: readonly ExpectedBehavior[]) => void;
}) {
  const field = useId();

  const at = (index: number, behavior: ExpectedBehavior) =>
    onChange(
      behaviors.map((one, position) => (position === index ? behavior : one)),
    );

  return (
    <div className="flex flex-col gap-3">
      <ul
        className="m-0 flex list-none flex-col gap-2.5 p-0"
        aria-label="Expected behaviors"
      >
        {behaviors.map((one, index) => (
          // These statements have no public id. Their position is kept only so
          // the frozen version and its grader assertions remain stable.
          // eslint-disable-next-line react/no-array-index-key
          <li className="flex min-w-0 items-start gap-2.5" key={index}>
            <RowIndex index={index} />
            <Textarea
              className="min-h-(--control-lg) flex-1 px-3 py-3 text-sm [field-sizing:content]"
              id={`${field}-behavior-${String(index)}`}
              value={one}
              rows={1}
              aria-label={`Expected behavior ${String(index + 1)}`}
              placeholder="Verifies who it is speaking to before discussing the booking"
              disabled={disabled}
              onChange={(event) => at(index, event.target.value)}
            />
            <span className="mt-1 flex-none">
              <RemoveRow
                label={`Remove expected behavior ${String(index + 1)}`}
                disabled={disabled}
                onClick={() =>
                  onChange(
                    behaviors.filter((_held, position) => position !== index),
                  )
                }
              />
            </span>
          </li>
        ))}
      </ul>
      <AddRow disabled={disabled} onClick={() => onChange([...behaviors, ""])}>
        + Add a behavior
      </AddRow>
    </div>
  );
}

type SelectorPage = {
  readonly items: readonly Named[];
  readonly nextCursor: string | null;
};

type NamedResource = "agents" | "personas";

/** The quiet supporting line inside the panel: a placeholder, a page, an absence. */
const SELECTOR_QUIET = "text-sm text-faint";

/**
 * A searchable, paged selector for server-owned agents and personas.
 *
 * The panel stays open while items are checked. This makes a long multi-select
 * one short task instead of a cycle of open, search, choose, and reopen. An
 * archived item that is already selected stays visible and can only be removed.
 *
 * **It reports the names it has learned along with the ids it returns.** The
 * boards draw the chosen personas as ordered rows *outside* this control, and a
 * row that only had an id would have nothing to write in it. The map is what
 * this control already keeps to draw its own summary; handing it back means the
 * page beside it never asks the platform for a name twice.
 */
export function NamedSelector({
  label,
  resource,
  project,
  chosen,
  selectedItems = [],
  emptyMessage,
  placeholder,
  disabled = false,
  onChange,
}: {
  readonly label: string;
  readonly resource: NamedResource;
  readonly project: string;
  readonly chosen: readonly string[];
  readonly selectedItems?: readonly Named[];
  readonly emptyMessage?: string;
  /**
   * What the closed control says when nothing is chosen. The boards make this
   * row the "Add a persona" line under the personas already on the test, so the
   * trigger names the next step rather than restating the field.
   */
  readonly placeholder?: string;
  readonly disabled?: boolean;
  readonly onChange: (
    chosen: readonly string[],
    named: ReadonlyMap<string, Named>,
  ) => void;
}) {
  const searchId = useId();
  const [typedSearch, setTypedSearch] = useState("");
  const [search, setSearch] = useState("");
  const [pages, setPages] = useState<readonly SelectorPage[]>([]);
  const [page, setPage] = useState(0);
  const [loading, setLoading] = useState(true);
  const [problem, setProblem] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const generation = useRef(0);
  const named = useRef(new Map<string, Named>());

  useEffect(() => {
    const timer = window.setTimeout(() => setSearch(typedSearch.trim()), 200);
    return () => window.clearTimeout(timer);
  }, [typedSearch]);

  useEffect(() => {
    named.current.clear();
  }, [project, resource]);

  useEffect(() => {
    for (const item of selectedItems) named.current.set(item.id, item);
  }, [selectedItems]);

  useEffect(() => {
    const controller = new AbortController();
    const heldGeneration = generation.current + 1;
    generation.current = heldGeneration;
    setPages([]);
    setPage(0);
    setLoading(true);
    setProblem(null);

    const request =
      resource === "agents"
        ? platformAnswer(
            listAgents(
              { projectId: project, ...(search === "" ? {} : { search }) },
              { client: platformClient },
            ),
          )
        : platformAnswer(
            listPersonas(
              { projectId: project, ...(search === "" ? {} : { search }) },
              { client: platformClient },
            ),
          );
    void request.then((answer) => {
      if (
        controller.signal.aborted ||
        generation.current !== heldGeneration
      ) {
        return;
      }
      setLoading(false);
      if (answer.status === "signed-out") {
        window.location.replace("/sign-in");
        return;
      }
      if (answer.status !== "ready") {
        setProblem(answer.refusal.message);
        return;
      }
      const items =
        "agents" in answer.value ? answer.value.agents : answer.value.personas;
      for (const item of items) named.current.set(item.id, item);
      setPages([
        {
          items,
          nextCursor: answer.value.nextPageToken,
        },
      ]);
    });

    return () => {
      controller.abort();
      if (generation.current === heldGeneration) generation.current += 1;
    };
  }, [project, resource, retry, search]);

  const current = pages[page];
  const pendingSearch = typedSearch.trim() !== search;
  const busy = loading || pendingSearch;
  const pageItems = busy ? [] : (current?.items ?? []);
  const pinned = chosen
    .map(
      (id) =>
        pageItems.find((item) => item.id === id) ??
        selectedItems.find((item) => item.id === id) ??
        named.current.get(id),
    )
    .filter((item): item is Named => item !== undefined)
    .filter((item) => !pageItems.some((one) => one.id === item.id));
  const shown = [...pinned, ...pageItems];
  const names = chosen
    .map(
      (id) =>
        selectedItems.find((one) => one.id === id)?.name ??
        named.current.get(id)?.name,
    )
    .filter((one): one is string => one !== undefined);
  /*
   * What the closed control says.
   *
   * A `placeholder` wins over the names, and that is the point of it: the
   * boards draw the chosen personas as numbered rows *above* this control, so
   * a trigger that also listed them would say the same thing twice and the row
   * would stop reading as "add another one".
   */
  const summary =
    placeholder !== undefined
      ? placeholder
      : names.length === 0
        ? `Select ${label.toLocaleLowerCase()}`
        : names.length <= 2
          ? names.join(", ")
          : `${String(names.length)} selected`;

  async function showNext(): Promise<void> {
    if (current === undefined || current.nextCursor === null || loading) return;
    const cached = pages[page + 1];
    if (cached !== undefined) {
      setPage(page + 1);
      return;
    }

    const heldGeneration = generation.current;
    setLoading(true);
    setProblem(null);
    const answer =
      resource === "agents"
        ? await platformAnswer(
            listAgents(
              {
                projectId: project,
                pageToken: current.nextCursor,
                ...(search === "" ? {} : { search }),
              },
              { client: platformClient },
            ),
          )
        : await platformAnswer(
            listPersonas(
              {
                projectId: project,
                pageToken: current.nextCursor,
                ...(search === "" ? {} : { search }),
              },
              { client: platformClient },
            ),
          );
    if (generation.current !== heldGeneration) return;
    setLoading(false);
    if (answer.status === "signed-out") {
      window.location.replace("/sign-in");
      return;
    }
    if (answer.status !== "ready") {
      setProblem(answer.refusal.message);
      return;
    }
    const items =
      "agents" in answer.value ? answer.value.agents : answer.value.personas;
    for (const item of items) named.current.set(item.id, item);
    setPages((held) => [
      ...held,
      {
        items,
        nextCursor: answer.value.nextPageToken,
      },
    ]);
    setPage(page + 1);
  }

  return (
    <Menu
      label={`Choose ${label.toLocaleLowerCase()}`}
      panelRole="dialog"
      triggerClassName={cn(
        "grid w-full min-h-(--control-lg) grid-cols-[minmax(0,1fr)_auto]",
        "items-center gap-3 px-3",
        "rounded-input border border-border bg-surface",
        "cursor-pointer text-left text-sm text-foreground",
        "pointer-hover:border-border-strong",
      )}
      /* Open is a state of the control, so it wears the open, attentive surface. */
      openClassName="border-border-strong bg-selected"
      panelClassName="w-[min(480px,calc(100vw-var(--space-8)))] max-w-[min(480px,calc(100vw-var(--space-8)))]"
      trigger={
        <>
          <span
            className={cn(
              "overflow-hidden text-ellipsis whitespace-nowrap",
              names.length === 0 || placeholder !== undefined
                ? SELECTOR_QUIET
                : "",
            )}
          >
            {summary}
          </span>
          <ChevronDownIcon
            className="size-3.5 flex-none text-foreground"
            strokeWidth={1.5}
            aria-hidden="true"
          />
        </>
      }
    >
      {(close) => (
        <div className="flex flex-col gap-3">
          <Input
            id={searchId}
            aria-label={`Search ${label.toLocaleLowerCase()}`}
            placeholder={`Search ${label.toLocaleLowerCase()}`}
            value={typedSearch}
            disabled={disabled}
            autoComplete="off"
            spellCheck={false}
            data-menu-focus-first=""
            onChange={(event) => setTypedSearch(event.target.value)}
          />
          {problem === null ? (
            <>
              <div className="flex max-h-[min(420px,55vh)] flex-col gap-1 overflow-y-auto">
                {shown.length === 0 ? (
                  <p className={`m-0 p-3 ${SELECTOR_QUIET}`}>
                    {busy
                      ? `Searching ${label.toLocaleLowerCase()}…`
                      : search === "" && emptyMessage !== undefined
                        ? emptyMessage
                        : `No ${label.toLocaleLowerCase()} match that search.`}
                  </p>
                ) : (
                  shown.map((one) => {
                    const selected = chosen.includes(one.id);
                    const unavailable = one.archivedAt !== null;
                    return (
                      <button
                        className={cn(
                          "grid w-full min-h-(--tap-target) items-center gap-3",
                          "grid-cols-[var(--space-5)_minmax(0,1fr)_auto]",
                          "rounded-button border-0 bg-transparent px-3 py-2",
                          "cursor-pointer text-left text-sm text-foreground",
                          "aria-checked:bg-selected",
                          "disabled:cursor-not-allowed disabled:opacity-60",
                          "pointer-hover:not-disabled:bg-surface-soft",
                        )}
                        type="button"
                        role="checkbox"
                        aria-checked={selected}
                        aria-label={`${one.name}${unavailable ? ", archived" : ""}`}
                        data-menu-item=""
                        disabled={disabled || (unavailable && !selected)}
                        key={one.id}
                        onClick={() =>
                          onChange(
                            selected
                              ? chosen.filter((held) => held !== one.id)
                              : [...chosen, one.id],
                            named.current,
                          )
                        }
                      >
                        <span
                          className={cn(
                            "grid size-(--space-5) place-items-center",
                            "rounded-button border border-border-strong text-brand",
                          )}
                          aria-hidden="true"
                        >
                          {selected ? "✓" : ""}
                        </span>
                        <span
                          className={
                            unavailable ? "text-faint line-through" : ""
                          }
                        >
                          {one.name}
                        </span>
                        {unavailable ? (
                          <Badge variant="warning">Archived</Badge>
                        ) : null}
                      </button>
                    );
                  })
                )}
              </div>
              <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-3">
                <span className={SELECTOR_QUIET}>
                  {busy ? "Loading…" : `Page ${String(page + 1)}`}
                </span>
                <div className="flex gap-2">
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    disabled={disabled || busy || page === 0}
                    onClick={() => setPage(page - 1)}
                  >
                    Previous
                  </Button>
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    disabled={
                      disabled || busy || (current?.nextCursor ?? null) === null
                    }
                    onClick={() => void showNext()}
                  >
                    Next
                  </Button>
                  <Button type="button" variant="secondary" size="sm" onClick={close}>
                    Done
                  </Button>
                </div>
              </div>
            </>
          ) : (
            <div className="flex flex-col items-start gap-3">
              <Problem>{problem}</Problem>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={() => setRetry((held) => held + 1)}
              >
                Try again
              </Button>
            </div>
          )}
        </div>
      )}
    </Menu>
  );
}

/**
 * Who calls about this test, in the order they call.
 *
 * The rows are the chosen personas, drawn the way the boards draw them —
 * numbered, named, each with a way out — and the selector below them is the
 * "Add a persona" line. The order is the order they were chosen, which is the
 * order the platform keeps and the order the run walks.
 */
function Personas({
  projectId,
  chosen,
  known,
  selectedItems,
  disabled,
  onChange,
}: {
  readonly projectId: string;
  readonly chosen: readonly string[];
  readonly known: ReadonlyMap<string, Named>;
  readonly selectedItems: readonly Named[];
  readonly disabled: boolean;
  readonly onChange: (
    chosen: readonly string[],
    named: ReadonlyMap<string, Named>,
  ) => void;
}) {
  function nameOf(id: string): string {
    return (
      selectedItems.find((one) => one.id === id)?.name ??
      known.get(id)?.name ??
      id
    );
  }

  return (
    <div className="flex flex-col gap-2.5">
      {chosen.length === 0 ? null : (
        <ul className="m-0 flex list-none flex-col gap-2.5 p-0" aria-label="Personas on this test">
          {chosen.map((id, index) => (
            <li className="flex min-w-0 items-start gap-2.5" key={id}>
              <RowIndex index={index} />
              <span
                className={cn(
                  "flex min-h-(--control-lg) flex-1 items-center gap-3 px-3",
                  "rounded-input border border-border bg-surface",
                  "text-sm text-foreground",
                )}
              >
                <span className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap">
                  {nameOf(id)}
                </span>
              </span>
              <span className="mt-1 flex-none">
                <RemoveRow
                  label={`Remove ${nameOf(id)}`}
                  disabled={disabled}
                  onClick={() =>
                    onChange(
                      chosen.filter((held) => held !== id),
                      known,
                    )
                  }
                />
              </span>
            </li>
          ))}
        </ul>
      )}
      {/* The selector sits where the next row would be, and is that row. */}
      <div className="flex min-w-0 items-start gap-2.5">
        <span className="w-4 flex-none" aria-hidden="true" />
        <span className="min-w-0 flex-1">
          <NamedSelector
            label="Personas"
            resource="personas"
            project={projectId}
            chosen={chosen}
            selectedItems={selectedItems}
            placeholder="Add a persona"
            disabled={disabled}
            onChange={onChange}
          />
        </span>
        <span className="size-(--control-md) flex-none" aria-hidden="true" />
      </div>
    </div>
  );
}

/**
 * The tools this test answers for itself, read and never written here.
 *
 * **There is no way to author one on this screen, and that is the standing
 * rule.** Overrides arrive with the repository change set that owns them, and
 * the browser walk holds every product screen to offering no way to author a
 * mock tool. What a test page owes somebody is the fact that this test forces a
 * branch — so the entries are drawn exactly as the boards draw them, and
 * nothing beside them presses.
 */
function MockOverrides({ tools }: { readonly tools: readonly TestMockTool[] }) {
  return (
    <ul className="m-0 flex list-none flex-col gap-2.5 p-0">
      {tools.map((tool, index) => (
        <li
          className="flex flex-col gap-2 border border-border bg-background p-3.5"
          // Overrides carry no id of their own on a test, and the list is read
          // only, so position is a stable enough key.
          // eslint-disable-next-line react/no-array-index-key
          key={`${tool.tool}-${String(index)}`}
        >
          <span className="flex flex-wrap items-baseline justify-between gap-3">
            <span className="font-mono text-sm text-foreground">{tool.tool}</span>
            <span className="text-sm text-faint tabular-nums">
              delay {tool.delayMs} ms
            </span>
          </span>
          <span className="block overflow-x-auto border border-border bg-surface px-3 py-2.5">
            <code className="font-mono text-sm whitespace-pre text-muted-foreground">
              {"error" in tool && tool.error !== undefined
                ? tool.error
                : JSON.stringify(tool.answer, null, 2)}
            </code>
          </span>
        </li>
      ))}
    </ul>
  );
}

/**
 * The four blocks a run is judged by, drawn once for the sheet and the page.
 *
 * `ATG-0` and `B9M-0` draw them identically, so they are one component. The
 * only difference between the two surfaces is that a test being written has no
 * overrides yet, because nothing authors one here.
 */
export function TestChecks({
  projectId,
  draft,
  known,
  selectedPersonas = [],
  mockTools = [],
  disabled = false,
  problem,
  onChange,
}: {
  readonly projectId: string;
  readonly draft: TestContentDraft;
  /** Persona names the selector has learned, so a row can name what it holds. */
  readonly known: ReadonlyMap<string, Named>;
  readonly selectedPersonas?: readonly Named[];
  readonly mockTools?: readonly TestMockTool[];
  readonly disabled?: boolean;
  readonly problem?: string | null;
  readonly onChange: (
    draft: TestContentDraft,
    named?: ReadonlyMap<string, Named>,
  ) => void;
}) {
  const scenarioLead = useId();

  return (
    <>
      <Block
        eyebrow="Scenario"
        htmlFor="test-scenario"
        lead="What the persona wants, and the circumstances."
        leadId={scenarioLead}
      >
        <Textarea
          className="min-h-24 px-3 py-2.5 text-sm"
          id="test-scenario"
          aria-describedby={scenarioLead}
          value={draft.scenario}
          rows={4}
          placeholder="Their cleaning is booked for Thursday morning and has to move to any afternoon next week."
          disabled={disabled}
          onChange={(event) => onChange({ ...draft, scenario: event.target.value })}
        />
      </Block>

      <Block
        eyebrow="Expected behaviors"
        lead="One plain sentence each. Every one must hold for the test to pass. At least one."
      >
        <Behaviors
          behaviors={draft.behaviors}
          disabled={disabled}
          onChange={(behaviors) => onChange({ ...draft, behaviors })}
        />
        {problem === null || problem === undefined ? null : (
          <Problem>{problem}</Problem>
        )}
      </Block>

      <Block
        eyebrow="Personas"
        lead="Who calls about this scenario, in this order. Each persona is one simulation per run."
      >
        <Personas
          projectId={projectId}
          chosen={draft.personas}
          known={known}
          selectedItems={selectedPersonas}
          disabled={disabled}
          onChange={(personas, named) => onChange({ ...draft, personas }, named)}
        />
      </Block>

      {mockTools.length === 0 ? null : (
        <Block
          eyebrow="Mock overrides"
          lead="Tools this test answers for itself, instead of the project's mock tool. They are authored with the repository, not here."
        >
          <MockOverrides tools={mockTools} />
        </Block>
      )}
    </>
  );
}

export type SaveState =
  | "unchanged"
  | "saving"
  | "saved"
  | "failed"
  /** The record moved on under the draft. Saving is refused until it is re-read. */
  | "conflict";

/**
 * One edit boundary, its truthful state, and the write that owns it.
 *
 * **The state carries a mark and a word as well as a colour**, because saved,
 * unsaved, failed and cannot-save are four different facts and colour alone is
 * not one of the ways this product is allowed to say which. The marks and the
 * three colours are the boards': `✓ Saved` in the success colour, `▲ Unsaved
 * changes` in the warning colour, `■ Cannot save …` in the failure colour.
 */
export function SaveAction({
  label,
  changed,
  state,
  disabled,
  why,
  divided = true,
  secondary,
  onSave,
}: {
  readonly label: string;
  readonly changed: boolean;
  readonly state: SaveState;
  readonly disabled: boolean;
  readonly why?: string;
  /** A hairline over the row. The block that ends a panel has one; a group inside it does not. */
  readonly divided?: boolean;
  /** The way back out of a draft, beside the save. */
  readonly secondary?: ReactNode;
  readonly onSave: () => void;
}) {
  const busy = state === "saving";
  const copy =
    state === "conflict"
      ? "Cannot save · the test changed since you opened it"
      : state === "saving"
        ? "Saving…"
        : state === "failed"
          ? "Save failed"
          : changed
            ? "Unsaved changes"
            : state === "saved"
              ? "Saved"
              : "Unchanged";
  const mark =
    state === "conflict"
      ? "■"
      : state === "saving"
        ? "·"
        : state === "failed"
          ? "×"
          : changed
            ? "▲"
            : "✓";
  const bad = state === "failed" || state === "conflict";

  return (
    <div
      className={cn(
        "flex flex-wrap items-center justify-between gap-3",
        divided && "border-t border-border pt-2",
      )}
    >
      <p
        className={cn(
          "m-0 flex items-center gap-2 text-sm",
          bad ? "text-failure" : changed ? "text-warning" : "text-success",
        )}
        role="status"
      >
        <span aria-hidden="true">{mark}</span>
        {copy}
      </p>
      <span className="flex flex-wrap items-center gap-3">
        {secondary}
        <Button
          type="button"
          busy={busy}
          disabled={disabled || !changed}
          /*
           * The unchanged look is the boards': a neutral bordered control on
           * the raised surface with quiet text, rather than a faded wash. There
           * is nothing to save, and a washed-out primary reads as an action
           * that failed.
           */
          className={
            disabled || !changed
              ? "border-border bg-surface text-faint disabled:opacity-100 pointer-hover:bg-surface pointer-hover:text-faint"
              : undefined
          }
          {...(why === undefined ? {} : { why })}
          onClick={onSave}
        >
          {busy ? "Saving…" : label}
        </Button>
      </span>
    </div>
  );
}
