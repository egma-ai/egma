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
   * Why it is not available, for whoever hovers or focuses it.
   *
   * A disabled control that says nothing is a dead end. It stays on the page
   * rather than disappearing — one page, one layout, and somebody is told
   * plainly that an action is not theirs instead of quietly not being shown
   * that it exists — and this is the sentence they get for asking. None of it
   * is authorization: the server checks the same permission on every request.
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
      title={disabled === true ? why : undefined}
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
  children,
}: {
  readonly label: string;
  readonly htmlFor: string;
  readonly children: ReactNode;
}) {
  return (
    <div className={styles.field}>
      <label className={styles.fieldLabel} htmlFor={htmlFor}>
        {label}
      </label>
      {children}
    </div>
  );
}

export function TextInput({
  id,
  value,
  placeholder,
  label,
  secret = false,
  invalid,
  describedBy,
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
   * A value nobody should be able to read off the screen. It changes what the
   * browser draws and what it offers to remember, and it is deliberately not
   * a claim about what happens to the value afterwards — the secrecy that
   * matters is the server sealing it and never answering with it again.
   */
  readonly secret?: boolean;
  /** Whether this field is what a refusal was about. */
  readonly invalid?: boolean;
  /** The element saying what is wrong, so the two are read together. */
  readonly describedBy?: string;
  /** Whether an opening menu should put focus here. */
  readonly autoFocusFirst?: boolean;
  readonly onChange: (value: string) => void;
  readonly onKeyDown?: (event: React.KeyboardEvent<HTMLInputElement>) => void;
}) {
  return (
    <input
      className={styles.input}
      id={id}
      type={secret ? "password" : "text"}
      value={value}
      placeholder={placeholder}
      aria-label={label}
      aria-invalid={invalid === true ? true : undefined}
      aria-describedby={describedBy}
      autoComplete={secret ? "new-password" : "off"}
      spellCheck={false}
      onChange={(event) => onChange(event.target.value)}
      onKeyDown={onKeyDown}
      {...(autoFocusFirst ? { "data-menu-focus-first": "" } : {})}
    />
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
 * A strip of controls above a list: a search box, the filters, and nothing that
 * belongs in the page header.
 *
 * It is here rather than in each list page so that every list in the product
 * puts its controls in the same place and at the same density. A page that
 * needs a fifth control puts it here beside the others rather than inventing a
 * second row.
 */
export function Toolbar({ children }: { readonly children: ReactNode }) {
  return <div className={styles.toolbar}>{children}</div>;
}

/**
 * A choice among a few named states, drawn as radio buttons rather than as a
 * pair of buttons that look pressed.
 *
 * Radios because that is what this is: exactly one is chosen, arrow keys move
 * between them, and assistive technology reads the group's name and the
 * chosen option without anything having to be told to. Two toggle buttons
 * would need `aria-pressed`, would not answer arrow keys, and would let both
 * be off.
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
        <label className={styles.choiceOption} key={option.value}>
          <input
            type="radio"
            name={label}
            value={option.value}
            checked={option.value === value}
            onChange={() => onChange(option.value)}
          />
          <span>{option.label}</span>
        </label>
      ))}
    </div>
  );
}

/**
 * A field whose answer is long enough to need room: a description, a rubric,
 * a JSON object written out.
 */
export function TextArea({
  id,
  value,
  placeholder,
  rows = 3,
  label,
  invalid,
  describedBy,
  onChange,
}: {
  readonly id: string;
  readonly value: string;
  readonly placeholder?: string;
  readonly rows?: number;
  readonly label?: string;
  readonly invalid?: boolean;
  readonly describedBy?: string;
  readonly onChange: (value: string) => void;
}) {
  return (
    <textarea
      className={styles.textarea}
      id={id}
      rows={rows}
      value={value}
      placeholder={placeholder}
      aria-label={label}
      aria-invalid={invalid === true ? true : undefined}
      aria-describedby={describedBy}
      spellCheck={false}
      onChange={(event) => onChange(event.target.value)}
    />
  );
}

/** A choice from a list too long to draw as radios. */
export function Select<Value extends string>({
  id,
  value,
  options,
  label,
  onChange,
}: {
  readonly id: string;
  readonly value: Value;
  readonly options: readonly { readonly value: Value; readonly label: string }[];
  readonly label?: string;
  readonly onChange: (value: Value) => void;
}) {
  return (
    <select
      className={styles.select}
      id={id}
      value={value}
      aria-label={label}
      onChange={(event) => onChange(event.target.value as Value)}
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
 * What went wrong with one field, or with the whole form.
 *
 * It is announced rather than merely coloured, and it never replaces what
 * somebody typed. A refusal that cleared the form would make the person type
 * their work again to find out whether the second attempt fails the same way.
 */
export function Problem({
  id,
  children,
}: {
  readonly id?: string;
  readonly children: ReactNode;
}) {
  return (
    <p className={styles.problem} id={id} role="alert">
      {children}
    </p>
  );
}

/**
 * A short list of facts about one thing: the label, and the answer.
 *
 * A detail page is mostly this, and it is a definition list because that is
 * what it is — pairing a name with a value in a `div` would leave a screen
 * reader with two unrelated pieces of text.
 */
export function Facts({
  label,
  children,
}: {
  readonly label: string;
  readonly children: ReactNode;
}) {
  return (
    <dl className={styles.facts} aria-label={label}>
      {children}
    </dl>
  );
}

export function Fact({
  name,
  mono = false,
  children,
}: {
  readonly name: string;
  readonly mono?: boolean;
  readonly children: ReactNode;
}) {
  return (
    <div className={styles.fact}>
      <dt>{name}</dt>
      <dd className={mono ? styles.cellMono : undefined}>{children}</dd>
    </div>
  );
}

/** A group of controls that act on the thing the page is about. */
export function Actions({ children }: { readonly children: ReactNode }) {
  return <div className={styles.actions}>{children}</div>;
}

/** A titled block inside a page: connections, capabilities, history. */
export function Section({
  title,
  lead,
  action,
  children,
}: {
  readonly title: string;
  readonly lead?: ReactNode;
  readonly action?: ReactNode;
  readonly children: ReactNode;
}) {
  return (
    <section className={styles.section}>
      <header className={styles.sectionHead}>
        <div>
          <h2 className={styles.sectionTitle}>{title}</h2>
          {lead === undefined ? null : (
            <p className={styles.sectionLead}>{lead}</p>
          )}
        </div>
        {action === undefined ? null : <div>{action}</div>}
      </header>
      {children}
    </section>
  );
}

/**
 * The sentence under a field that says what to write in it.
 *
 * It is the server's own words for a connection field, relayed unchanged: the
 * registry knows what a token endpoint is for and this application deliberately
 * does not, so paraphrasing here would put a second, quieter description beside
 * the one that is kept in step with the gate.
 */
export function Help({
  id,
  children,
}: {
  readonly id?: string;
  readonly children: ReactNode;
}) {
  return (
    <p className={styles.help} id={id}>
      {children}
    </p>
  );
}
