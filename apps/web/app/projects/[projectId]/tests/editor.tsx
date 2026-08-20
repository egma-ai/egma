"use client";

import { useEffect, useId, useRef, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { agentsQuery } from "../../../../lib/agents.ts";
import { readJson } from "../../../../lib/api.ts";
import { personasQuery } from "../../../../lib/personas.ts";
import {
  type ExpectedBehavior,
  type Named,
  type TestVersionRow,
} from "../../../../lib/tests.ts";
import { Problem } from "../../../../ui/form.tsx";
import { Menu } from "../../../../ui/menu.tsx";
import { RelativeInstant } from "../../../../ui/relative-time.tsx";

/**
 * The parts a test is authored and read through.
 *
 * **A choice comes from the server.** Which agents a test may apply to and which
 * personas may call about it are lists the platform owns. A form holding its
 * own copy would offer something the platform refuses, and the refusal would
 * arrive after somebody had written a test around it.
 *
 * **History is read and never rewound.** An older version can be opened and
 * looked at; nothing here offers to make it current, because that is an edit
 * somebody makes deliberately by carrying what it says forward — and a control
 * that did it in one press would rewrite what a test checks from a page
 * somebody opened to look at the past.
 *
 * These live in this file rather than in `ui/controls.tsx` because they are the
 * Tests area's and nothing else uses them. The controls they are built from are
 * the shared ones.
 */

/**
 * The expected behaviors: one sentence each, and nothing beside them.
 *
 * **There is nothing to say per sentence, so there is no second column.** Every
 * expected behavior has to hold — that is what makes a test falsifiable — so
 * the question "what happens if this one fails" has one answer for the whole
 * list and does not belong on any row. How loudly a *grader* speaks is the
 * running copy's `required` flag, set where the copy is, once.
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
        className="m-0 flex list-none flex-col gap-3 p-0"
        aria-label="Expected behaviors"
      >
        {behaviors.map((one, index) => (
          // These statements have no public id. Their position is kept only so
          // the frozen version and its grader assertions remain stable.
          // eslint-disable-next-line react/no-array-index-key
          <li
            className={
              "grid grid-cols-[minmax(0,1fr)_auto] items-start gap-3 p-3 " +
              "rounded-card border border-border bg-surface " +
              "max-[640px]:grid-cols-1"
            }
            key={index}
          >
            {/*
              The row's own shape, said here rather than in a stylesheet
              reaching into the shared field. One line to start with, growing
              with what is typed: a behavior is a sentence, and a box four lines
              tall for a sentence is four lines of empty space per statement.
            */}
            <Textarea
              className="min-h-(--control-lg) py-2 [field-sizing:content]"
              id={`${field}-behavior-${String(index)}`}
              value={one}
              rows={1}
              aria-label={`Expected behavior ${String(index + 1)}`}
              placeholder="Verifies who it is speaking to before discussing the booking"
              disabled={disabled}
              onChange={(event) => at(index, event.target.value)}
            />
            <Button
              type="button"
              variant="secondary"
              disabled={disabled}
              onClick={() =>
                onChange(
                  behaviors.filter((_held, position) => position !== index),
                )
              }
            >
              Remove
            </Button>
          </li>
        ))}
      </ul>
      <div>
        <Button
          type="button"
          variant="secondary"
          disabled={disabled}
          onClick={() => onChange([...behaviors, ""])}
        >
          Add expected behavior
        </Button>
      </div>
    </div>
  );
}

type NamedPage = {
  readonly items: readonly Named[];
  readonly next_cursor: string | null;
};

type SelectorPage = {
  readonly items: readonly Named[];
  readonly nextCursor: string | null;
};

type NamedResource = "agents" | "personas";

function namedPagePath(
  resource: NamedResource,
  search: string,
  cursor?: string,
): string {
  const asking = {
    ...(search === "" ? {} : { search }),
    ...(cursor === undefined ? {} : { cursor }),
  };
  return resource === "agents"
    ? agentsQuery(asking)
    : personasQuery(asking);
}

/** The quiet supporting line inside the panel: a placeholder, a page, an absence. */
const SELECTOR_QUIET = "text-sm text-muted-foreground";

/**
 * A searchable, paged selector for server-owned agents and personas.
 *
 * The panel stays open while items are checked. This makes a long multi-select
 * one short task instead of a cycle of open, search, choose, and reopen. An
 * archived item that is already selected stays visible and can only be removed.
 */
export function NamedSelector({
  label,
  resource,
  project,
  chosen,
  selectedItems = [],
  emptyMessage,
  disabled = false,
  onChange,
}: {
  readonly label: string;
  readonly resource: NamedResource;
  readonly project: string;
  readonly chosen: readonly string[];
  readonly selectedItems?: readonly Named[];
  readonly emptyMessage?: string;
  readonly disabled?: boolean;
  readonly onChange: (chosen: readonly string[]) => void;
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

    void readJson<NamedPage>(namedPagePath(resource, search), {
      project,
      signal: controller.signal,
    }).then((answer) => {
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
      for (const item of answer.value.items) named.current.set(item.id, item);
      setPages([
        {
          items: answer.value.items,
          nextCursor: answer.value.next_cursor,
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
  const summary =
    names.length === 0
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
    const answer = await readJson<NamedPage>(
      namedPagePath(resource, search, current.nextCursor),
      { project },
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
    for (const item of answer.value.items) named.current.set(item.id, item);
    setPages((held) => [
      ...held,
      {
        items: answer.value.items,
        nextCursor: answer.value.next_cursor,
      },
    ]);
    setPage(page + 1);
  }

  return (
    <Menu
      label={`Choose ${label.toLocaleLowerCase()}`}
      panelRole="dialog"
      triggerClassName={
        "grid w-full min-h-(--control-lg) grid-cols-[minmax(0,1fr)_auto] " +
        "items-center gap-3 px-4 " +
        "rounded-input border border-border bg-surface " +
        "cursor-pointer text-left text-sm text-foreground " +
        "pointer-hover:border-border-strong"
      }
      /* Open is a state of the control, so it wears the open, attentive surface. */
      openClassName="border-brand bg-selected"
      panelClassName="w-[min(480px,calc(100vw-var(--space-8)))] max-w-[min(480px,calc(100vw-var(--space-8)))]"
      trigger={
        <>
          <span className={names.length === 0 ? SELECTOR_QUIET : ""}>
            {summary}
          </span>
          <span className="text-base text-muted-foreground" aria-hidden="true">
            ⌄
          </span>
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
                    const unavailable = (one.archived_at ?? null) !== null;
                    return (
                      <button
                        className={
                          "grid w-full min-h-(--tap-target) items-center gap-3 " +
                          "grid-cols-[var(--space-5)_minmax(0,1fr)_auto] " +
                          "rounded-button border-0 bg-transparent px-3 py-2 " +
                          "cursor-pointer text-left text-sm text-foreground " +
                          "aria-checked:bg-selected " +
                          "disabled:cursor-not-allowed disabled:opacity-60 " +
                          "pointer-hover:not-disabled:bg-surface-soft"
                        }
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
                          )
                        }
                      >
                        <span
                          className={
                            "grid size-(--space-5) place-items-center " +
                            "rounded-button border border-border-strong text-brand"
                          }
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
                    disabled={disabled || busy || page === 0}
                    onClick={() => setPage(page - 1)}
                  >
                    Previous
                  </Button>
                  <Button
                    type="button"
                    variant="secondary"
                    disabled={
                      disabled || busy || (current?.nextCursor ?? null) === null
                    }
                    onClick={() => void showNext()}
                  >
                    Next
                  </Button>
                  <Button type="button" variant="secondary" onClick={close}>
                    Done
                  </Button>
                </div>
              </div>
            </>
          ) : (
            <div>
              <Problem>{problem}</Problem>
              <Button
                type="button"
                variant="secondary"
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

/** One edit boundary, its truthful state, and the write that owns it. */
export function SaveAction({
  label,
  changed,
  state,
  disabled,
  why,
  onSave,
}: {
  readonly label: string;
  readonly changed: boolean;
  readonly state: "unchanged" | "saving" | "saved" | "failed";
  readonly disabled: boolean;
  readonly why?: string;
  readonly onSave: () => void;
}) {
  const busy = state === "saving";
  const copy =
    state === "saving"
      ? "Saving…"
      : state === "failed"
        ? "Save failed"
        : changed
          ? "Unsaved changes"
          : state === "saved"
            ? "Saved"
            : "Unchanged";
  const mark =
    state === "saving"
      ? "·"
      : state === "failed"
        ? "×"
        : changed
          ? "○"
          : "✓";

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-4">
      {/*
        The state carries a mark as well as a colour, because "saved", "unsaved"
        and "failed" are three different facts and colour alone is not one of
        the ways this product is allowed to say which.
      */}
      <p
        className={`m-0 flex items-center gap-2 text-sm ${
          state === "failed"
            ? "text-failure"
            : changed
              ? "text-warning"
              : "text-success"
        }`}
        role="status"
      >
        <span aria-hidden="true">{mark}</span>
        {copy}
      </p>
      <Button
        type="button"
        busy={busy}
        disabled={disabled || !changed}
        {...(why === undefined ? {} : { why })}
        onClick={onSave}
      >
        {busy ? "Saving…" : label}
      </Button>
    </div>
  );
}

/**
 * The immutable history, and one version read out of it.
 *
 * Every version stays exactly as it was written, so what this shows is what a
 * run that pinned it executed. The current one is marked, because "which of
 * these is the test now" is the first question anybody asks of a history.
 */
export function VersionHistory({
  versions,
  reading,
  now,
  onRead,
}: {
  readonly versions: readonly TestVersionRow[];
  /** The version currently opened, or nothing. */
  readonly reading: TestVersionRow | null;
  readonly now: number;
  readonly onRead: (version: TestVersionRow | null) => void;
}) {
  return (
    <div>
      <ul
        className={
          "m-0 flex list-none flex-col overflow-hidden p-0 " +
          "rounded-card border border-border bg-surface"
        }
        aria-label="Version history"
      >
        {versions.map((version) => (
          <li
            className={
              "flex min-h-(--tap-target) flex-wrap items-baseline gap-3 px-4 py-3 " +
              "border-t border-border first:border-t-0 " +
              /*
               * The current version's mark: a 3px edge, carried over from the
               * stylesheet this replaces rather than chosen, so it is written
               * as a measurement instead of as a scale step that does not
               * exist.
               */
              "border-s-[3px] " +
              (version.current
                ? "border-s-brand bg-selected"
                : "border-s-transparent")
            }
            key={version.id}
          >
            <span className="font-mono text-sm text-foreground">
              v{version.version}
            </span>
            <span className="text-sm text-muted-foreground">
              <RelativeInstant instant={version.created_at} now={now} />
            </span>
            {version.current ? (
              <Badge variant="success">Current</Badge>
            ) : null}
            <span className="flex-1" />
            <Button
              type="button"
              variant="secondary"
              onClick={() =>
                onRead(reading?.id === version.id ? null : version)
              }
            >
              {reading?.id === version.id ? "Close" : "Read"}
            </Button>
          </li>
        ))}
      </ul>

      {reading === null ? null : (
        <article
          className="mt-4 flex flex-col gap-4 rounded-card border border-border bg-surface p-5"
          aria-label={`Version ${reading.version}`}
        >
          <h3 className="m-0 text-base font-medium text-foreground">
            Version {reading.version}, as it was written
          </h3>
          <p className="m-0 whitespace-pre-wrap text-sm text-foreground">
            {reading.scenario}
          </p>
          <ul className="m-0 flex flex-col gap-1 pl-6 text-sm text-foreground">
            {reading.expected_behaviors.map((one, at) => (
              // No identity of their own, and this list is read-only.
              // eslint-disable-next-line react/no-array-index-key
              <li key={at}>{one}</li>
            ))}
          </ul>
          <p className="m-0 whitespace-pre-wrap text-sm text-foreground">
            Personas: {reading.personas.map((one) => one.name).join(", ") || "none"}
            {"."}
          </p>
          <p className="text-sm text-muted-foreground">
            Reading an older version changes nothing. To go back to what it says,
            copy it into the current version and save.
          </p>
        </article>
      )}
    </div>
  );
}
