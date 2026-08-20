"use client";

import Link from "next/link";
import { useId, useRef, type Ref, type ReactNode } from "react";

import { useFieldHint } from "./field-hint.ts";
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
export type ButtonTone = "default" | "destructive";

function weightClass(weight: Weight): string {
  return weight === "strong" ? styles.button : styles.buttonQuiet;
}

function buttonClass(weight: Weight, tone: ButtonTone): string {
  return tone === "destructive"
    ? `${styles.button} ${styles.buttonDestructive}`
    : weightClass(weight);
}

/**
 * Why a control is not available, said where anybody can find it.
 *
 * **A disabled button cannot take focus, so a tooltip on one is a reason only
 * a mouse can reach.** The developer's decision was to *disable rather than
 * hide* precisely so a viewer is told why an action is not theirs — and a
 * reason half the people using egma cannot get to does not deliver that
 * decision, it only looks like it does.
 *
 * So the sentence is written on the page beside the control, and the control
 * points at it with `aria-describedby`. It stays a `title` as well, because a
 * pointer user hovering is a real way to ask.
 */
function WhyNot({ id, why }: { readonly id: string; readonly why: string }) {
  return (
    <span className={styles.whyNot} id={id}>
      {why}
    </span>
  );
}

export function Button({
  weight = "quiet",
  tone = "default",
  type = "button",
  disabled,
  busy = false,
  why,
  ariaExpanded,
  ariaControls,
  buttonRef,
  onClick,
  children,
}: {
  readonly weight?: Weight;
  /** Failure-colored confirmation for an action that removes or stops something. */
  readonly tone?: ButtonTone;
  readonly type?: "button" | "submit";
  readonly disabled?: boolean;
  /** A write is in flight. It remains visible, named, and inert until it settles. */
  readonly busy?: boolean;
  /**
   * Why it is not available. Shown beside the control and named by it, so it
   * reaches a keyboard and a screen reader and not only a pointer.
   */
  readonly why?: string;
  /** Whether this button's controlled region is open. */
  readonly ariaExpanded?: boolean;
  /** The id of the region this button opens or closes. */
  readonly ariaControls?: string;
  /** The native button, for focus restoration after a related surface closes. */
  readonly buttonRef?: Ref<HTMLButtonElement>;
  readonly onClick?: () => void;
  readonly children: ReactNode;
}) {
  const said = useId();
  const inert = disabled === true || busy;
  const explained = inert && why !== undefined;

  return (
    <>
      <button
        ref={buttonRef}
        className={buttonClass(weight, tone)}
        type={type}
        disabled={inert}
        aria-busy={busy ? "true" : undefined}
        aria-expanded={ariaExpanded}
        aria-controls={ariaControls}
        title={why}
        aria-describedby={explained ? said : undefined}
        onClick={onClick}
      >
        {children}
      </button>
      {explained ? <WhyNot id={said} why={why} /> : null}
    </>
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
      <Button weight={weight} disabled {...(why === undefined ? {} : { why })}>
        {children}
      </Button>
    );
  }

  return (
    <Link className={weightClass(weight)} href={href}>
      {children}
    </Link>
  );
}

/**
 * The hint this control is inside, for the controls that describe themselves.
 *
 * The context itself is in `field-hint.ts`, because the controls that read it
 * are being migrated onto the shadcn base one at a time and a shadcn primitive
 * must not import from this file to find it. What it means and why it is a
 * context rather than a prop is written there.
 */
function describedByHint(): string | undefined {
  // eslint-disable-next-line react-hooks/rules-of-hooks -- called from components only
  return useFieldHint();
}

export function TextInput({
  id,
  name,
  value,
  type,
  placeholder,
  label,
  disabled = false,
  secret = false,
  numeric = false,
  required = false,
  readOnly = false,
  minLength,
  autoComplete,
  autoCapitalize,
  spellCheck = false,
  invalid,
  describedBy,
  autoFocusFirst = false,
  onChange,
  onKeyDown,
}: {
  readonly id: string;
  /** The name submitted by a native form. */
  readonly name?: string;
  readonly value: string;
  /** Browser input behavior that cannot be inferred from the visible label. */
  readonly type?: "email" | "password" | "text";
  readonly placeholder?: string;
  /** When the field carries its own name rather than a visible label. */
  readonly label?: string;
  /**
   * Genuinely inert, to pointer and keyboard alike. A read-only role sees the
   * field and what is in it, and cannot change it — and the server refuses
   * their write either way, which is where the boundary actually is.
   */
  readonly disabled?: boolean;
  /**
   * A value nobody should be able to read off the screen. It changes what the
   * browser draws and what it offers to remember, and it is deliberately not
   * a claim about what happens to the value afterwards — the secrecy that
   * matters is the server sealing it and never answering with it again.
   */
  readonly secret?: boolean;
  /**
   * A field whose value is a number rather than words. It changes the keypad a
   * phone offers and what the browser will accept, and it is deliberately not
   * what makes the value a number — the caller converts before sending, because
   * an input's value is a string whatever type it wears.
   */
  readonly numeric?: boolean;
  /** Keep native browser validation available to forms that require a value. */
  readonly required?: boolean;
  /** A value shown for context but not editable, such as an invitation email. */
  readonly readOnly?: boolean;
  /** The auth provider's minimum, also enforced by the browser before submit. */
  readonly minLength?: number;
  /** Tell password managers what this value means. */
  readonly autoComplete?: string;
  readonly autoCapitalize?: string;
  readonly spellCheck?: boolean;
  /** Whether this field is what a refusal was about. */
  readonly invalid?: boolean;
  /**
   * The element saying what is wrong, so the two are read together. It wins
   * over the hint the enclosing `Field` offers, because a field that is being
   * refused has something more urgent to say than what to write in it.
   */
  readonly describedBy?: string;
  /** Whether an opening menu should put focus here. */
  readonly autoFocusFirst?: boolean;
  readonly onChange?: (value: string) => void;
  readonly onKeyDown?: (event: React.KeyboardEvent<HTMLInputElement>) => void;
}) {
  const hint = describedByHint();

  return (
    <input
      className={styles.input}
      id={id}
      name={name}
      type={type ?? (secret ? "password" : numeric ? "number" : "text")}
      value={value}
      placeholder={placeholder}
      aria-label={label}
      aria-invalid={invalid === true ? true : undefined}
      aria-describedby={describedBy ?? hint}
      disabled={disabled}
      required={required}
      readOnly={readOnly}
      minLength={minLength}
      autoComplete={autoComplete ?? (secret ? "new-password" : "off")}
      autoCapitalize={autoCapitalize}
      spellCheck={spellCheck}
      onChange={(event) => onChange?.(event.target.value)}
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
  label,
  invalid,
  describedBy,
  onChange,
}: {
  readonly id: string;
  readonly value: string;
  readonly rows?: number;
  readonly placeholder?: string;
  readonly disabled?: boolean;
  /** When the field carries its own name rather than a visible label. */
  readonly label?: string;
  /** Whether this field is what a refusal was about. */
  readonly invalid?: boolean;
  /** The element saying what is wrong; it wins over the `Field`'s hint. */
  readonly describedBy?: string;
  readonly onChange: (value: string) => void;
}) {
  const hint = describedByHint();

  return (
    <textarea
      className={styles.textarea}
      id={id}
      value={value}
      rows={rows}
      placeholder={placeholder}
      aria-label={label}
      aria-invalid={invalid === true ? true : undefined}
      aria-describedby={describedBy ?? hint}
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
export function Select<Value extends string>({
  id,
  value,
  options,
  disabled = false,
  label,
  onChange,
}: {
  readonly id: string;
  readonly value: Value;
  readonly options: readonly { readonly value: Value; readonly label: string }[];
  readonly disabled?: boolean;
  /** When the control carries its own name rather than a visible label. */
  readonly label?: string;
  readonly onChange: (value: Value) => void;
}) {
  const describedBy = describedByHint();

  return (
    <select
      className={styles.select}
      id={id}
      value={value}
      disabled={disabled}
      aria-label={label}
      aria-describedby={describedBy}
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
 * One native binary choice, styled once without replacing browser behavior.
 *
 * `label` is only for a checkbox that does not have a visible `<label>` linked
 * through `id`. Callers with visible copy should keep that copy visible and
 * use `htmlFor`, so the whole label remains a pointer target.
 */
export function Checkbox({
  id,
  checked,
  disabled = false,
  label,
  onChange,
}: {
  readonly id: string;
  readonly checked: boolean;
  readonly disabled?: boolean;
  readonly label?: string;
  readonly onChange: (checked: boolean) => void;
}) {
  const describedBy = describedByHint();

  return (
    <label className={styles.checkboxTarget}>
      <input
        className={styles.checkbox}
        id={id}
        type="checkbox"
        checked={checked}
        disabled={disabled}
        aria-label={label}
        aria-describedby={describedBy}
        onChange={(event) => onChange(event.target.checked)}
      />
    </label>
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

