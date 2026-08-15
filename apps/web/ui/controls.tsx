"use client";

import Link from "next/link";
import type { ReactNode } from "react";

import styles from "./system.module.css";

/**
 * The controls a product page is built from: a button, a link that looks like
 * one, a labelled field, and a small status badge.
 *
 * Two weights and no more. `strong` carries the one thing a page is mainly for;
 * everything else is `quiet`. A page with three strong buttons has told
 * somebody nothing about which one they came for.
 */

export type Weight = "strong" | "quiet";

function weightClass(weight: Weight): string {
  return weight === "strong" ? styles.button : styles.buttonQuiet;
}

export function Button({
  weight = "quiet",
  type = "button",
  disabled,
  why,
  onClick,
  children,
}: {
  readonly weight?: Weight;
  readonly type?: "button" | "submit";
  readonly disabled?: boolean;
  /**
   * Why it is not available, for whoever hovers or focuses it. A disabled
   * control that cannot say why is a control somebody presses twice and then
   * gives up on.
   */
  readonly why?: string;
  readonly onClick?: () => void;
  readonly children: ReactNode;
}) {
  return (
    <button
      className={weightClass(weight)}
      type={type}
      disabled={disabled}
      title={why}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

/**
 * Somewhere to go, dressed as a control — and what it becomes when whoever is
 * looking at it may not go there.
 *
 * **A disabled control is genuinely inert or it is a lie.** A link cannot be
 * disabled: `aria-disabled` on an anchor greys it out and it still follows on
 * click and still takes the keyboard. So when this is not available it stops
 * being a link and becomes a disabled `button` — unfocusable, unclickable, and
 * disabled to assistive technology because the element really is.
 *
 * It stays on the page rather than disappearing. One page, one layout, and a
 * viewer is told plainly that an action is not theirs instead of quietly not
 * being shown that it exists. `why` is the sentence they get for asking.
 *
 * None of this is authorization. The server checks the same permission on
 * every request and refuses a viewer's write whether or not a browser was
 * involved; this is a courtesy to a reader, and never a lock.
 */
export function ButtonLink({
  href,
  weight = "quiet",
  disabled = false,
  why,
  children,
}: {
  readonly href: string;
  readonly weight?: Weight;
  readonly disabled?: boolean;
  /** Why it is not available, for whoever hovers or focuses it. */
  readonly why?: string;
  readonly children: ReactNode;
}) {
  if (disabled) {
    return (
      <button className={weightClass(weight)} type="button" disabled title={why}>
        {children}
      </button>
    );
  }

  return (
    <Link className={weightClass(weight)} href={href}>
      {children}
    </Link>
  );
}

export function Field({
  label,
  htmlFor,
  hint,
  children,
}: {
  readonly label: string;
  readonly htmlFor: string;
  /** One line saying what belongs here, for a field whose name is not enough. */
  readonly hint?: ReactNode;
  readonly children: ReactNode;
}) {
  return (
    <div className={styles.field}>
      <label className={styles.fieldLabel} htmlFor={htmlFor}>
        {label}
      </label>
      {children}
      {hint === undefined ? null : <p className={styles.fieldHint}>{hint}</p>}
    </div>
  );
}

/**
 * A form, its rows, and the controls that finish it.
 *
 * The three exist so that no page decides for itself how far a form runs
 * across a wide screen or how two fields sit beside each other. A row is a
 * grid that collapses to one column on a narrow screen, which is the whole of
 * the responsive story for every editor in the product.
 */
export function Form({
  onSubmit,
  children,
}: {
  readonly onSubmit?: () => void;
  readonly children: ReactNode;
}) {
  return (
    <form
      className={styles.form}
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit?.();
      }}
    >
      {children}
    </form>
  );
}

export function FormRow({ children }: { readonly children: ReactNode }) {
  return <div className={styles.formRow}>{children}</div>;
}

export function FormActions({ children }: { readonly children: ReactNode }) {
  return <div className={styles.formActions}>{children}</div>;
}

export function TextInput({
  id,
  value,
  placeholder,
  label,
  disabled = false,
  autoFocusFirst = false,
  onChange,
  onKeyDown,
}: {
  readonly id: string;
  readonly value: string;
  readonly placeholder?: string;
  /** When the field carries its own name rather than a visible label. */
  readonly label?: string;
  /**
   * Genuinely inert, to pointer and keyboard alike. A read-only role sees the
   * field and what is in it, and cannot change it — and the server refuses
   * their write either way, which is where the boundary actually is.
   */
  readonly disabled?: boolean;
  /** Whether an opening menu should put focus here. */
  readonly autoFocusFirst?: boolean;
  readonly onChange: (value: string) => void;
  readonly onKeyDown?: (event: React.KeyboardEvent<HTMLInputElement>) => void;
}) {
  return (
    <input
      className={styles.input}
      id={id}
      type="text"
      value={value}
      placeholder={placeholder}
      aria-label={label}
      disabled={disabled}
      autoComplete="off"
      spellCheck={false}
      onChange={(event) => onChange(event.target.value)}
      onKeyDown={onKeyDown}
      {...(autoFocusFirst ? { "data-menu-focus-first": "" } : {})}
    />
  );
}

/**
 * Somewhere to write more than a line.
 *
 * A persona's manner and what they do under friction are sentences, and a
 * single-line field for a sentence is a field that scrolls sideways while
 * somebody is still deciding what to say. It grows with a `rows` count rather
 * than auto-sizing, so the page's layout is decided by the page.
 */
export function TextArea({
  id,
  value,
  rows = 3,
  placeholder,
  disabled = false,
  onChange,
}: {
  readonly id: string;
  readonly value: string;
  readonly rows?: number;
  readonly placeholder?: string;
  readonly disabled?: boolean;
  readonly onChange: (value: string) => void;
}) {
  return (
    <textarea
      className={styles.textarea}
      id={id}
      value={value}
      rows={rows}
      placeholder={placeholder}
      disabled={disabled}
      spellCheck
      onChange={(event) => onChange(event.target.value)}
    />
  );
}

/**
 * A choice among things egma already knows about — a voice provider, a
 * replacement persona.
 *
 * The options always come from the server. A hand-written copy of a list the
 * server owns is a list that is wrong the day the server grows an entry, and
 * silently: the form would keep offering yesterday's choices and refusing
 * today's.
 */
export function Select({
  id,
  value,
  options,
  disabled = false,
  label,
  onChange,
}: {
  readonly id: string;
  readonly value: string;
  readonly options: readonly { readonly value: string; readonly label: string }[];
  readonly disabled?: boolean;
  /** When the control carries its own name rather than a visible label. */
  readonly label?: string;
  readonly onChange: (value: string) => void;
}) {
  return (
    <select
      className={styles.select}
      id={id}
      value={value}
      disabled={disabled}
      aria-label={label}
      onChange={(event) => onChange(event.target.value)}
    >
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  );
}

/**
 * Which of two lists a page is showing.
 *
 * **Two lists, chosen deliberately, never one list with a column saying which
 * rows are archived.** A mixed list is a list somebody picks the wrong row out
 * of.
 *
 * It is announced as a radio group because that is what it is — exactly one of
 * a small closed set is chosen — and every option is reachable with Tab and
 * chosen with Enter or Space, which is what a `button` gives for free.
 */
export function Choice<Value extends string>({
  label,
  value,
  options,
  onChange,
}: {
  readonly label: string;
  readonly value: Value;
  readonly options: readonly { readonly value: Value; readonly label: string }[];
  readonly onChange: (value: Value) => void;
}) {
  return (
    <div className={styles.choice} role="radiogroup" aria-label={label}>
      {options.map((option) => (
        <button
          key={option.value}
          className={`${styles.choiceItem} ${
            option.value === value ? styles.choiceItemOn : ""
          }`}
          type="button"
          role="radio"
          aria-checked={option.value === value}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

export type BadgeTone = "neutral" | "good" | "bad" | "warn";

const TONE: Record<BadgeTone, string> = {
  neutral: "",
  good: styles.badgeGood,
  bad: styles.badgeBad,
  warn: styles.badgeWarn,
};

/**
 * A small, quiet statement of state: a role, an archive state, a verdict.
 *
 * It never carries an action. A badge somebody can click is a button that has
 * been made hard to see.
 */
export function Badge({
  tone = "neutral",
  title,
  children,
}: {
  readonly tone?: BadgeTone;
  readonly title?: string;
  readonly children: ReactNode;
}) {
  return (
    <span className={`${styles.badge} ${TONE[tone]}`} title={title}>
      {children}
    </span>
  );
}

/**
 * What a page says when a write was refused.
 *
 * **The refusal's own sentence, shown unchanged, above the form that was
 * refused — and the form keeps everything typed into it.** A refusal that
 * cleared the fields would make somebody retype an afternoon's work to find
 * out whether the second attempt fails the same way, which is how a person
 * learns to stop trying.
 */
export function Refused({
  message,
  action,
}: {
  readonly message: string;
  readonly action?: ReactNode;
}) {
  return (
    <div className={styles.refused} role="alert">
      <p className={styles.refusedText}>{message}</p>
      {action}
    </div>
  );
}

/**
 * A labelled group of facts about one thing — what a detail page is mostly
 * made of. A definition list because that is what it is, so a screen reader
 * reads each fact with the name of the fact.
 */
export function Facts({
  facts,
}: {
  readonly facts: readonly {
    readonly label: string;
    readonly value: ReactNode;
  }[];
}) {
  return (
    <dl className={styles.facts}>
      {facts.map((fact) => (
        <div className={styles.fact} key={fact.label}>
          <dt>{fact.label}</dt>
          <dd>{fact.value}</dd>
        </div>
      ))}
    </dl>
  );
}
