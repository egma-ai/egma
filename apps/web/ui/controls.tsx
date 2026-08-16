"use client";

import Link from "next/link";
import {
  createContext,
  useContext,
  useId,
  useRef,
  type ReactNode,
} from "react";

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
  type = "button",
  disabled,
  busy = false,
  why,
  onClick,
  children,
}: {
  readonly weight?: Weight;
  readonly type?: "button" | "submit";
  readonly disabled?: boolean;
  /** A write is in flight. It remains visible, named, and inert until it settles. */
  readonly busy?: boolean;
  /**
   * Why it is not available. Shown beside the control and named by it, so it
   * reaches a keyboard and a screen reader and not only a pointer.
   */
  readonly why?: string;
  readonly onClick?: () => void;
  readonly children: ReactNode;
}) {
  const said = useId();
  const inert = disabled === true || busy;
  const explained = inert && why !== undefined;

  return (
    <>
      <button
        className={weightClass(weight)}
        type={type}
        disabled={inert}
        aria-busy={busy ? "true" : undefined}
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
 * The id of the hint a field is wearing, offered to whatever control it wraps.
 *
 * **A hint nothing points at is a hint only a sighted reader ever gets.** It
 * travels through context rather than through a prop because the alternative
 * is every caller remembering to wire `aria-describedby` on every control —
 * and the ones they forget are exactly the ones nobody notices, because the
 * page still looks right.
 */
const FieldHintContext = createContext<string | undefined>(undefined);

/** The hint this control is inside, for the controls that describe themselves. */
function describedByHint(): string | undefined {
  // eslint-disable-next-line react-hooks/rules-of-hooks -- called from components only
  return useContext(FieldHintContext);
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
  const said = useId();

  return (
    <div className={styles.field}>
      <label className={styles.fieldLabel} htmlFor={htmlFor}>
        {label}
      </label>
      <FieldHintContext.Provider value={hint === undefined ? undefined : said}>
        {children}
      </FieldHintContext.Provider>
      {hint === undefined ? null : (
        <p className={styles.fieldHint} id={said}>
          {hint}
        </p>
      )}
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
  return (
    <label className={styles.checkboxTarget}>
      <input
        className={styles.checkbox}
        id={id}
        type="checkbox"
        checked={checked}
        disabled={disabled}
        aria-label={label}
        onChange={(event) => onChange(event.target.checked)}
      />
    </label>
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
  /**
   * The radios themselves, so that moving with an arrow key can put focus on
   * the one it moved to. A radio group that changes selection without moving
   * focus leaves a screen reader announcing one thing and the keyboard on
   * another.
   */
  const radios = useRef<(HTMLButtonElement | null)[]>([]);

  const move = (from: number, by: number) => {
    const to = (from + by + options.length) % options.length;
    const going = options[to];
    if (going === undefined) return;
    onChange(going.value);
    radios.current[to]?.focus();
  };

  const STEPS: Readonly<Record<string, number>> = {
    ArrowRight: 1,
    ArrowDown: 1,
    ArrowLeft: -1,
    ArrowUp: -1,
  };

  return (
    <div className={styles.choice} role="radiogroup" aria-label={label}>
      {options.map((option, at) => (
        <button
          key={option.value}
          ref={(held) => {
            radios.current[at] = held;
          }}
          className={`${styles.choiceItem} ${
            option.value === value ? styles.choiceItemOn : ""
          }`}
          type="button"
          role="radio"
          aria-checked={option.value === value}
          /**
           * Roving: the group is one Tab stop, and the arrow keys move inside
           * it. Every option being tabbable would make a two-option filter
           * cost two Tab presses on the way to the table, and a ten-option one
           * cost ten.
           */
          tabIndex={option.value === value ? 0 : -1}
          onKeyDown={(event) => {
            const step = STEPS[event.key];
            if (step !== undefined) {
              event.preventDefault();
              move(at, step);
              return;
            }
            if (event.key === "Home" || event.key === "End") {
              event.preventDefault();
              move(at, event.key === "Home" ? -at : options.length - 1 - at);
            }
          }}
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
 * What went wrong with one field, or with the whole form.
 *
 * It is announced rather than merely coloured, and it never replaces what
 * somebody typed. A refusal that cleared the form would make the person type
 * their work again to find out whether the second attempt fails the same way.
 *
 * `Refused` is the same news one level up: this one names a field, that one
 * heads the form it refused and can carry the way to ask again.
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
