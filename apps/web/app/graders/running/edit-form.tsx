"use client";

import { useState } from "react";

import { EDIT, SCOPES, SWITCH_OFF } from "../../../lib/grader-running-copy.ts";
import { Field, Notice, styles } from "../../ui.tsx";
import {
  asWritten,
  EntryFields,
  firstChoices,
  type Filled,
  type Parameter,
} from "../use-form.tsx";

/**
 * The two acts that stop **Use** being a one-way door: changing a running copy,
 * and switching one off.
 *
 * **The edit form is the Use form's controls, drawn from the same declaration.**
 * A library entry says what filling it in asks for — latency declares a measure
 * from egma's catalog and a bound; expected behaviors declares nothing — and
 * both forms render that list through `EntryFields`. There is no second reading
 * of the entry anywhere in this section, which is what stops the two screens
 * from drifting the first time a parameter learns a new kind of control.
 *
 * **What lives here and not there is the live settings**, because they are only
 * meaningful for a copy that already exists: where it applies, whether it can
 * fail a run, and how much live traffic it judges. Pressing Use asks for the
 * one of those a person has an opinion about before they have seen the grader
 * run; the rest are settings somebody comes back to.
 *
 * **One request carries both kinds of change**, and the platform decides which
 * happened. Values are what a verdict was decided by, so changing one starts
 * the next version and leaves the one behind it alone; a name, a scope, a rate
 * and the `required` flag change nothing already judged, so they are written in
 * place. A browser page holding a copy of that rule would be a second opinion
 * about it, and the version number on the answer is how this one finds out.
 */

/** One running copy, as this screen reads one off the list. */
export type Copy = {
  readonly id: string;
  readonly library_id: string;
  readonly name: string;
  readonly description: string | null;
  readonly scope: string;
  readonly required: boolean;
  readonly production_sample_rate: number;
  readonly config: {
    readonly assertions?: readonly Readonly<Record<string, unknown>>[];
  } | null;
};

/**
 * What this copy currently holds, as controls hold it.
 *
 * A dropdown's default is where an unanswered question starts, and a stored
 * value written over it is where an answered one is — so a copy of an entry
 * that has grown a parameter since it was made opens with that parameter's
 * first option rather than with nothing in it.
 */
function filledFrom(
  params: readonly Parameter[],
  assertion: Readonly<Record<string, unknown>> | undefined,
): Filled {
  const chosen: Record<string, string> = { ...firstChoices(params) };
  for (const parameter of params) {
    const held = assertion?.[parameter.name];
    if (held !== undefined && held !== null) {
      chosen[parameter.name] = String(held);
    }
  }
  return chosen;
}

export function EditForm({
  copy,
  params,
  onSaved,
  onCancel,
}: {
  copy: Copy;
  /** What this copy's entry asks for, as the entry declares it. */
  params: readonly Parameter[];
  onSaved: (name: string) => void;
  onCancel: () => void;
}) {
  const [filled, setFilled] = useState<Filled>(() =>
    filledFrom(params, copy.config?.assertions?.[0]),
  );
  const [name, setName] = useState(copy.name);
  const [description, setDescription] = useState(copy.description ?? "");
  const [scope, setScope] = useState(copy.scope);
  const [required, setRequired] = useState(copy.required);
  const [sampleRate, setSampleRate] = useState(
    String(copy.production_sample_rate),
  );
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);

  async function save(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setRefusal(null);

    try {
      const answer = await fetch(`/api/graders/${copy.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name,
          // Null rather than an empty string, because emptying a note is a
          // thing somebody means to do and the platform reads null as it.
          description: description.trim() === "" ? null : description,
          scope,
          required,
          production_sample_rate: Number(sampleRate),
          ...(params.length === 0 ? {} : { params: asWritten(params, filled) }),
        }),
      });

      if (!answer.ok) {
        const said = (await answer.json().catch(() => ({}))) as {
          message?: string;
        };
        setRefusal(said.message ?? EDIT.unreachable);
        return;
      }

      onSaved(name);
    } catch {
      setRefusal(EDIT.unreachable);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className={styles.form} onSubmit={(event) => void save(event)}>
      <p className={styles.muted}>{EDIT.lead}</p>
      {refusal === null ? null : <Notice tone="error">{refusal}</Notice>}

      <Field label={EDIT.name} hint={EDIT.nameMeans} htmlFor="edit-name">
        <input
          className={styles.input}
          id="edit-name"
          type="text"
          required
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
      </Field>

      <Field
        label={EDIT.description}
        hint={EDIT.descriptionMeans}
        htmlFor="edit-description"
      >
        <input
          className={styles.input}
          id="edit-description"
          type="text"
          value={description}
          onChange={(event) => setDescription(event.target.value)}
        />
      </Field>

      {/*
        The entry's own questions, rendered by the component the Use form
        renders them with — one declaration, one reading of it.
      */}
      <EntryFields
        params={params}
        filled={filled}
        onFilled={(parameter, value) =>
          setFilled((was) => ({ ...was, [parameter]: value }))
        }
        named="edit"
        sentence={EDIT.asksNothing}
      />

      <Field label={EDIT.scope} hint={EDIT.scopeMeans} htmlFor="edit-scope">
        <select
          className={styles.select}
          id="edit-scope"
          value={scope}
          onChange={(event) => setScope(event.target.value)}
        >
          {Object.entries(SCOPES).map(([stored, said]) => (
            <option key={stored} value={stored}>
              {said}
            </option>
          ))}
        </select>
      </Field>

      <Field
        label={EDIT.required}
        hint={required ? EDIT.requiredOn : EDIT.requiredOff}
        htmlFor="edit-required"
      >
        <input
          id="edit-required"
          type="checkbox"
          checked={required}
          onChange={(event) => setRequired(event.target.checked)}
        />
      </Field>

      <Field
        label={EDIT.sampleRate}
        hint={EDIT.sampleRateMeans}
        htmlFor="edit-sample-rate"
      >
        <input
          className={styles.input}
          id="edit-sample-rate"
          type="number"
          min={0}
          max={100}
          required
          value={sampleRate}
          onChange={(event) => setSampleRate(event.target.value)}
        />
      </Field>

      <div className={styles.buttonRow}>
        <button
          className={styles.buttonSecondary}
          type="button"
          onClick={onCancel}
        >
          {EDIT.cancel}
        </button>
        <button className={styles.button} type="submit" disabled={busy}>
          {busy ? EDIT.submitting : EDIT.submit}
        </button>
      </div>
    </form>
  );
}

/**
 * Switching one off, and saying what that costs before anybody presses it.
 *
 * **Two sentences and a button, and the second sentence is the reason this is
 * not a plain confirmation.** What stops is obvious from the word; what stays
 * is not, and it is the thing somebody is actually worried about. A grader
 * making every run red is a grader a team has to be able to remove without
 * being asked to trade away the runs they have already read.
 */
export function SwitchOffPanel({
  copy,
  onSwitchedOff,
  onCancel,
}: {
  copy: Copy;
  onSwitchedOff: (name: string) => void;
  onCancel: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);

  async function switchOff(): Promise<void> {
    setBusy(true);
    setRefusal(null);

    try {
      const answer = await fetch(`/api/graders/${copy.id}`, {
        method: "DELETE",
      });

      if (!answer.ok) {
        const said = (await answer.json().catch(() => ({}))) as {
          message?: string;
        };
        setRefusal(said.message ?? SWITCH_OFF.unreachable);
        return;
      }

      onSwitchedOff(copy.name);
    } catch {
      setRefusal(SWITCH_OFF.unreachable);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={styles.form}>
      {refusal === null ? null : <Notice tone="error">{refusal}</Notice>}
      <Notice>
        <p>{SWITCH_OFF.stops}</p>
        <p>{SWITCH_OFF.keeps}</p>
        <p>{SWITCH_OFF.again}</p>
      </Notice>

      <div className={styles.buttonRow}>
        <button
          className={styles.buttonSecondary}
          type="button"
          onClick={onCancel}
        >
          {SWITCH_OFF.cancel}
        </button>
        <button
          className={styles.buttonDanger}
          type="button"
          disabled={busy}
          onClick={() => void switchOff()}
        >
          {busy ? SWITCH_OFF.confirming : SWITCH_OFF.confirm}
        </button>
      </div>
    </div>
  );
}
