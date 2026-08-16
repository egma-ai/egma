"use client";

import { useId, type ReactNode } from "react";

import { asDay } from "../../../../lib/instants.ts";
import {
  type Capability,
  type ExpectedBehavior,
  type Named,
  type TestVersionRow,
} from "../../../../lib/tests.ts";
import { Badge, Button, Checkbox, TextArea } from "../../../../ui/controls.tsx";
import styles from "./editor.module.css";

/**
 * The parts a test is authored and read through, and the three things they all
 * obey.
 *
 * **Order is content.** The personas a test names, the behaviors it expects and
 * the graders it adds are ordered lists, and a version that reorders one says
 * something the version before it did not. So the position is drawn, moving an
 * entry is a control rather than a drag nobody can reach from a keyboard, and
 * every list is edited the same way.
 *
 * **A choice comes from the server.** Which agents a test may apply to, which
 * personas may call about it and which capabilities it may require are all
 * lists the platform owns. A form holding its own copy would offer something
 * the platform refuses, and the refusal would arrive after somebody had written
 * a test around it.
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
 * An ordered list of things, with the order editable.
 *
 * One component for the personas, the graders and the behaviors, because all
 * three are the same shape and three hand-written lists would be three places
 * for the move-up control to be forgotten. What each entry *is* is the caller's
 * business and arrives as a child.
 */
export function Ordered({
  label,
  count,
  disabled = false,
  onMove,
  onRemove,
  onAdd,
  addLabel,
  children,
}: {
  /** What this is a list of, read out where there is no visible caption. */
  readonly label: string;
  readonly count: number;
  readonly disabled?: boolean;
  readonly onMove: (from: number, to: number) => void;
  readonly onRemove: (at: number) => void;
  readonly onAdd?: () => void;
  readonly addLabel?: string;
  /** One node per entry, in the order they are held. */
  readonly children: readonly ReactNode[];
}) {
  return (
    <div>
      <ul className={styles.ordered} aria-label={label}>
        {children.map((entry, at) => (
          // The index is the key on purpose: these entries have no identity of
          // their own, and a key derived from what somebody is typing would
          // remount the field on every keystroke.
          // eslint-disable-next-line react/no-array-index-key
          <li className={styles.entry} key={at}>
            <span className={styles.position} aria-hidden="true">
              {at + 1}
            </span>
            <div>{entry}</div>
            <div className={styles.entryActions}>
              <Button
                disabled={disabled || at === 0}
                onClick={() => onMove(at, at - 1)}
              >
                <span aria-hidden="true">↑</span>
                <span className={styles.named}>{`Move ${label} ${at + 1} up`}</span>
              </Button>
              <Button
                disabled={disabled || at === count - 1}
                onClick={() => onMove(at, at + 1)}
              >
                <span aria-hidden="true">↓</span>
                <span className={styles.named}>{`Move ${label} ${at + 1} down`}</span>
              </Button>
              <Button disabled={disabled} onClick={() => onRemove(at)}>
                <span aria-hidden="true">×</span>
                <span className={styles.named}>{`Remove ${label} ${at + 1}`}</span>
              </Button>
            </div>
          </li>
        ))}
      </ul>
      {onAdd === undefined ? null : (
        <p>
          <Button disabled={disabled} onClick={onAdd}>
            {addLabel ?? `Add ${label}`}
          </Button>
        </p>
      )}
    </div>
  );
}

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
    <Ordered
      label="expected behavior"
      count={behaviors.length}
      disabled={disabled}
      addLabel="Add an expected behavior"
      onAdd={() => onChange([...behaviors, ""])}
      onMove={(from, to) => onChange(moved(behaviors, from, to))}
      onRemove={(index) =>
        onChange(behaviors.filter((_one, position) => position !== index))
      }
    >
      {behaviors.map((one, index) => (
        <div className={styles.behavior} key={`${field}-${String(index)}`}>
          {/*
            One control per behavior, because a behavior is one sentence. The
            P0/P1/P2 select that used to sit beside it went with the ladder
            itself: every behavior has to hold, so there was nothing left for a
            per-sentence priority to say. How loudly a grader speaks is the
            running copy's own `required` flag now.
          */}
          <TextArea
            id={`${field}-behavior-${String(index)}`}
            value={one}
            rows={2}
            label={`Expected behavior ${String(index + 1)}`}
            placeholder="verifies who it is speaking to before discussing the booking"
            disabled={disabled}
            onChange={(behavior) => at(index, behavior)}
          />
        </div>
      ))}
    </Ordered>
  );
}

/** The same list with one entry moved, and the original untouched. */
export function moved<Value>(
  held: readonly Value[],
  from: number,
  to: number,
): readonly Value[] {
  if (to < 0 || to >= held.length || from === to) return held;
  const next = [...held];
  const [taken] = next.splice(from, 1);
  if (taken === undefined) return held;
  next.splice(to, 0, taken);
  return next;
}

/**
 * A set chosen from a list the platform owns.
 *
 * Checkboxes rather than a multi-select, because every option carries a
 * sentence saying what it is and a select cannot show one — and because a set
 * somebody is building out of four things should not need a modifier key.
 *
 * **An option that is no longer available stays on screen when it is already
 * chosen**, struck through and said plainly. Dropping it would make an archived
 * agent silently vanish from a test's coverage the moment somebody opened the
 * editor.
 */
export function Choices({
  legend,
  options,
  chosen,
  disabled = false,
  onChange,
}: {
  readonly legend: string;
  readonly options: readonly {
    readonly value: string;
    readonly label: string;
    readonly note?: string;
    /** Set when this option cannot be newly chosen — an archived agent. */
    readonly unavailable?: boolean;
  }[];
  readonly chosen: readonly string[];
  readonly disabled?: boolean;
  readonly onChange: (chosen: readonly string[]) => void;
}) {
  const field = useId();

  return (
    <fieldset className={styles.choices}>
      <legend className={styles.named}>{legend}</legend>
      {options.map((option) => {
        const on = chosen.includes(option.value);
        return (
          <div
            className={`${styles.choice} ${on ? styles.choiceOn : ""}`}
            key={option.value}
          >
            <Checkbox
              id={`${field}-${option.value}`}
              checked={on}
              // An archived option can be taken off and never newly put on,
              // which is the same rule the platform holds a link edit to.
              disabled={disabled || (option.unavailable === true && !on)}
              onChange={(checked) =>
                onChange(
                  checked
                    ? [...chosen, option.value]
                    : chosen.filter((held) => held !== option.value),
                )
              }
            />
            <label
              className={styles.choiceLabel}
              htmlFor={`${field}-${option.value}`}
            >
              <span className={option.unavailable === true ? styles.gone : ""}>
                {option.label}
              </span>
              {option.unavailable === true ? (
                <>
                  {" "}
                  <Badge tone="warn">Archived</Badge>
                </>
              ) : null}
              {option.note === undefined ? null : (
                <span className={styles.choiceNote}>{option.note}</span>
              )}
            </label>
          </div>
        );
      })}
    </fieldset>
  );
}

/** The capability catalog as choices, with each key's own sentence under it. */
export function CapabilityChoices({
  catalog,
  chosen,
  disabled = false,
  onChange,
}: {
  readonly catalog: readonly Capability[];
  readonly chosen: readonly string[];
  readonly disabled?: boolean;
  readonly onChange: (chosen: readonly string[]) => void;
}) {
  return (
    <Choices
      legend="Required capabilities"
      chosen={chosen}
      disabled={disabled}
      onChange={onChange}
      options={catalog.map((entry) => ({
        value: entry.key,
        label: entry.label,
        note: entry.description,
      }))}
    />
  );
}

/** A list of named things as choices, archived ones marked and kept. */
export function NamedChoices({
  legend,
  available,
  chosen,
  disabled = false,
  onChange,
}: {
  readonly legend: string;
  readonly available: readonly Named[];
  readonly chosen: readonly string[];
  readonly disabled?: boolean;
  readonly onChange: (chosen: readonly string[]) => void;
}) {
  return (
    <Choices
      legend={legend}
      chosen={chosen}
      disabled={disabled}
      onChange={onChange}
      options={available.map((one) => ({
        value: one.id,
        label: one.name,
        unavailable: (one.archived_at ?? null) !== null,
      }))}
    />
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
  onRead,
}: {
  readonly versions: readonly TestVersionRow[];
  /** The version currently opened, or nothing. */
  readonly reading: TestVersionRow | null;
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
              {asDay(version.created_at)}
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
          <ol className={styles.readingList}>
            {reading.expected_behaviors.map((one, at) => (
              // No identity of their own, and this list is read-only.
              // eslint-disable-next-line react/no-array-index-key
              <li key={at}>{one}</li>
            ))}
          </ol>
          <p className={styles.readingBody}>
            Personas: {reading.personas.map((one) => one.name).join(", ") || "none"}
            {". "}
            Requires:{" "}
            {reading.required_capabilities.join(", ") || "nothing in particular"}
            {"."}
            {reading.override_count > 0
              ? ` Overrides present: ${String(reading.override_count)}.`
              : ""}
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
