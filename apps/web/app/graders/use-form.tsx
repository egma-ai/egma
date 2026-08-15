"use client";

import { useState } from "react";

import { USE } from "../../lib/grader-library-copy.ts";
import { Field, Notice, styles } from "../ui.tsx";

/**
 * The **Use** form: a library entry, filled in, and a running copy of it on the
 * project.
 *
 * **Drawn from the entry rather than written here, and that is the whole
 * design.** A library entry declares what pressing Use asks for — latency
 * declares a measure from egma's catalog and a bound; expected behaviors
 * declares nothing, because its assertions are each test's own sentences — and
 * that declaration rides the entry on the answer this page already read. So
 * this component renders controls from a list it was handed and knows nothing
 * about latency, about measures, or about what any grader does.
 *
 * That is not tidiness. A dropdown whose options were typed into a browser page
 * would be a second copy of the measure catalog: it would go stale the first
 * time a measure joined or left, and the developer's first sign of it would be
 * a write refused for offering exactly what the form offered. The options come
 * off the entry, the write door checks the same catalog they were built from,
 * and the two cannot disagree.
 *
 * **The unit belongs to the measure, so it is shown beside the bound rather
 * than fixed in the label.** Milliseconds for a latency, turns for a count: the
 * catalog says which, and the form repeats what it was told instead of assuming
 * every bound is a duration.
 *
 * **A number is sent as a number.** An input's value is a string, and a bound
 * arriving as `"2000"` is refused by the write door with a message about types
 * — correct, and useless to somebody who typed a perfectly good number. The
 * conversion happens here, once, at the edge that knows the control was numeric.
 */

/** One value the entry's form asks for, exactly as the entry declares it. */
export type Parameter = {
  readonly name: string;
  readonly label: string;
  readonly kind: string;
  readonly means: string;
  /** Present on a parameter that is one of a list; absent on one typed into. */
  readonly options?: readonly {
    readonly value: string;
    readonly label: string;
    readonly means: string;
    readonly unit: string;
  }[];
};

export type UsableEntry = {
  readonly id: string;
  readonly name: string;
  readonly params?: readonly Parameter[];
};

type Filled = Readonly<Record<string, string>>;

/**
 * What was typed, as the API takes it: text stays text, a number becomes one.
 *
 * A parameter left blank is left out rather than sent empty, so the refusal a
 * developer reads is the entry's own — "this grader needs a bound" — rather
 * than one about the empty string.
 */
function asWritten(
  params: readonly Parameter[],
  filled: Filled,
): Record<string, string | number> {
  const written: Record<string, string | number> = {};
  for (const parameter of params) {
    const typed = filled[parameter.name] ?? "";
    if (typed.trim() === "") continue;
    written[parameter.name] =
      parameter.kind === "number" ? Number(typed) : typed.trim();
  }
  return written;
}

/** The first option of a list, which is what a dropdown shows before a choice. */
function firstChoices(params: readonly Parameter[]): Filled {
  const chosen: Record<string, string> = {};
  for (const parameter of params) {
    const first = parameter.options?.[0];
    if (first !== undefined) chosen[parameter.name] = first.value;
  }
  return chosen;
}

export function UseForm({
  entry,
  onStarted,
  onCancel,
}: {
  entry: UsableEntry;
  onStarted: (name: string) => void;
  onCancel: () => void;
}) {
  const params = entry.params ?? [];
  const [filled, setFilled] = useState<Filled>(() => firstChoices(params));
  const [required, setRequired] = useState(true);
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);

  /**
   * The unit the bound is counted in: the chosen measure's own.
   *
   * Read off whichever parameter carries options rather than off a parameter
   * called `metric`, because the name of the parameter is the entry's business
   * and this component is not supposed to know it.
   */
  const unit = params
    .flatMap((parameter) => parameter.options ?? [])
    .find((option) => Object.values(filled).includes(option.value))?.unit;

  async function start(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setRefusal(null);

    try {
      const answer = await fetch("/api/graders", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          library_id: entry.id,
          required,
          ...(params.length === 0
            ? {}
            : { params: asWritten(params, filled) }),
        }),
      });

      if (!answer.ok) {
        const said = (await answer.json().catch(() => ({}))) as {
          message?: string;
        };
        setRefusal(said.message ?? USE.unreachable);
        return;
      }

      onStarted(entry.name);
    } catch {
      setRefusal(USE.unreachable);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className={styles.form} onSubmit={(event) => void start(event)}>
      <p className={styles.muted}>{USE.lead}</p>
      {refusal === null ? null : <Notice tone="error">{refusal}</Notice>}

      {params.length === 0 ? (
        <Notice>{USE.asksNothing}</Notice>
      ) : (
        params.map((parameter) => {
          const control = `use-${parameter.name}`;
          const chosen = filled[parameter.name] ?? "";
          const write = (value: string): void =>
            setFilled((was) => ({ ...was, [parameter.name]: value }));

          return (
            <Field
              key={parameter.name}
              label={parameter.label}
              hint={parameter.means}
              htmlFor={control}
            >
              {parameter.options === undefined ? (
                <input
                  className={styles.input}
                  id={control}
                  // The kind decides the control exactly as it decides the check
                  // behind it, so what a person can type and what a write will
                  // take are one decision made in the entry.
                  type={parameter.kind === "number" ? "number" : "text"}
                  required
                  value={chosen}
                  // Shown rather than baked into the label: the unit belongs to
                  // the measure beside it, and this one changes with the choice
                  // above.
                  placeholder={unit ?? ""}
                  onChange={(event) => write(event.target.value)}
                />
              ) : (
                <select
                  className={styles.select}
                  id={control}
                  value={chosen}
                  onChange={(event) => write(event.target.value)}
                >
                  {parameter.options.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              )}
            </Field>
          );
        })
      )}

      <Field
        label={USE.required}
        hint={required ? USE.requiredOn : USE.requiredOff}
        htmlFor="use-required"
      >
        <input
          id="use-required"
          type="checkbox"
          checked={required}
          onChange={(event) => setRequired(event.target.checked)}
        />
      </Field>

      <div className={styles.buttonRow}>
        <button
          className={styles.buttonSecondary}
          type="button"
          onClick={onCancel}
        >
          {USE.cancel}
        </button>
        <button className={styles.button} type="submit" disabled={busy}>
          {busy ? USE.submitting : USE.submit}
        </button>
      </div>
    </form>
  );
}
