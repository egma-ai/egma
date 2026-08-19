"use client";

import { useEffect, useId, useRef, useState } from "react";

import { agentsQuery } from "../../../../lib/agents.ts";
import { readJson } from "../../../../lib/api.ts";
import { personasQuery } from "../../../../lib/personas.ts";
import {
  type ExpectedBehavior,
  type Named,
  type TestVersionRow,
} from "../../../../lib/tests.ts";
import {
  Badge,
  Button,
  Problem,
  TextArea,
  TextInput,
} from "../../../../ui/controls.tsx";
import { Menu } from "../../../../ui/menu.tsx";
import { RelativeInstant } from "../../../../ui/relative-time.tsx";
import styles from "./editor.module.css";

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
    <div className={styles.behaviors}>
      <ul className={styles.behaviorList} aria-label="Expected behaviors">
        {behaviors.map((one, index) => (
          // These statements have no public id. Their position is kept only so
          // the frozen version and its grader assertions remain stable.
          // eslint-disable-next-line react/no-array-index-key
          <li className={styles.behavior} key={index}>
            <TextArea
              id={`${field}-behavior-${String(index)}`}
              value={one}
              rows={1}
              label={`Expected behavior ${String(index + 1)}`}
              placeholder="Verifies who it is speaking to before discussing the booking"
              disabled={disabled}
              onChange={(behavior) => at(index, behavior)}
            />
            <Button
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
      triggerClassName={styles.namedSelector}
      openClassName={styles.namedSelectorOpen}
      panelClassName={styles.namedSelectorPanel}
      trigger={
        <>
          <span className={names.length === 0 ? styles.selectorPlaceholder : ""}>
            {summary}
          </span>
          <span className={styles.selectorChevron} aria-hidden="true">⌄</span>
        </>
      }
    >
      {(close) => (
        <div className={styles.selectorBody}>
          <TextInput
            id={searchId}
            label={`Search ${label.toLocaleLowerCase()}`}
            placeholder={`Search ${label.toLocaleLowerCase()}`}
            value={typedSearch}
            disabled={disabled}
            autoFocusFirst
            onChange={setTypedSearch}
          />
          {problem === null ? (
            <>
              <div className={styles.selectorOptions}>
                {shown.length === 0 ? (
                  <p className={styles.selectorEmpty}>
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
                        className={styles.selectorOption}
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
                        <span className={styles.selectorMark} aria-hidden="true">
                          {selected ? "✓" : ""}
                        </span>
                        <span className={unavailable ? styles.gone : ""}>
                          {one.name}
                        </span>
                        {unavailable ? <Badge tone="warn">Archived</Badge> : null}
                      </button>
                    );
                  })
                )}
              </div>
              <div className={styles.selectorFooter}>
                <span className={styles.selectorPage}>
                  {busy ? "Loading…" : `Page ${String(page + 1)}`}
                </span>
                <div className={styles.selectorPager}>
                  <Button
                    disabled={disabled || busy || page === 0}
                    onClick={() => setPage(page - 1)}
                  >
                    Previous
                  </Button>
                  <Button
                    disabled={
                      disabled || busy || (current?.nextCursor ?? null) === null
                    }
                    onClick={() => void showNext()}
                  >
                    Next
                  </Button>
                  <Button onClick={close}>Done</Button>
                </div>
              </div>
            </>
          ) : (
            <div>
              <Problem>{problem}</Problem>
              <Button onClick={() => setRetry((held) => held + 1)}>
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
    <div className={styles.saveAction}>
      <p
        className={`${styles.saveState} ${state === "failed" ? styles.saveStateFailed : changed ? styles.saveStateChanged : ""}`}
        role="status"
      >
        <span aria-hidden="true">{mark}</span>
        {copy}
      </p>
      <Button
        weight="strong"
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
      <ul className={styles.history} aria-label="Version history">
        {versions.map((version) => (
          <li
            className={`${styles.version} ${version.current ? styles.versionCurrent : ""}`}
            key={version.id}
          >
            <span className={styles.versionNumber}>v{version.version}</span>
            <span className={styles.versionWhen}>
              <RelativeInstant instant={version.created_at} now={now} />
            </span>
            {version.current ? <Badge tone="good">Current</Badge> : null}
            <span className={styles.versionSpacer} />
            <Button
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
        <article className={styles.reading} aria-label={`Version ${reading.version}`}>
          <h3 className={styles.readingTitle}>
            Version {reading.version}, as it was written
          </h3>
          <p className={styles.readingBody}>{reading.scenario}</p>
          <ul className={styles.readingList}>
            {reading.expected_behaviors.map((one, at) => (
              // No identity of their own, and this list is read-only.
              // eslint-disable-next-line react/no-array-index-key
              <li key={at}>{one}</li>
            ))}
          </ul>
          <p className={styles.readingBody}>
            Personas: {reading.personas.map((one) => one.name).join(", ") || "none"}
            {"."}
          </p>
          <p className={styles.versionWhen}>
            Reading an older version changes nothing. To go back to what it says,
            copy it into the current version and save.
          </p>
        </article>
      )}
    </div>
  );
}
