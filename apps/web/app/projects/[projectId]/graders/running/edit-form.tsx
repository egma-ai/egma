"use client";

import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { NumberField } from "@/ui/number-field.tsx";
import { deleteJson, writeJson, type Refusal } from "../../../../../lib/api.ts";
import {
  EDIT,
  SCOPES,
  SWITCH_OFF,
} from "../../../../../lib/grader-running-copy.ts";
import {
  filledParams,
  firstChoices,
  graderPath,
  type GraderParameter,
  type RunningGrader,
} from "../../../../../lib/graders.ts";
import { graderDisplayName } from "../../../../../lib/presentation.ts";
import {
  Actions,
  Field,
  Form,
  FormActions,
  Help,
  Refused,
} from "../../../../../ui/controls.tsx";
import { EntryFields } from "../use-form.tsx";

/**
 * One group of the edit form, and the word that names it.
 *
 * A `fieldset` because that is what a named group of controls is, and because
 * `disabled` on one makes every control inside it inert in one place while a
 * write is in flight. The hairline between groups is on the group rather than
 * between them, so a group added later is spaced without anybody remembering.
 */
const FORM_GROUP =
  "m-0 grid min-w-0 gap-5 px-0 pb-0 pt-5 first:pt-0 " +
  "border-t border-border first:border-t-0";

const FORM_GROUP_TITLE = "m-0 mb-4 p-0 text-base font-medium text-foreground";

/**
 * The two acts that stop **Use** being a one-way door: changing a running copy,
 * and switching one off.
 *
 * **The edit form is the Use form's controls, drawn from the same
 * declaration.** A library entry says what filling it in asks for — latency
 * declares a measure from egma's catalog and a bound; expected behaviors
 * declares nothing — and both forms render that list through `EntryFields`.
 * There is no second reading of the entry anywhere in this section, which is
 * what stops the two screens from drifting the first time a parameter learns a
 * new kind of control.
 *
 * **What lives here and not on the shelf is the live settings**, because they
 * are only meaningful for a copy that already exists: where it applies, whether
 * it can fail a run, and how much live traffic it judges. Pressing Use asks for
 * the one of those a person has an opinion about before they have seen the
 * grader run; the rest are settings somebody comes back to.
 *
 * **One request carries both kinds of change**, and the platform decides which
 * happened. Values are what a verdict was decided by, so changing one starts
 * the next version and leaves the one behind it alone; a name, a scope, a rate
 * and the `required` flag rewrite no verdict, so they are written in place. A
 * browser page holding a copy of that rule would be a second opinion about it,
 * and the version number on the answer is how this one finds out.
 *
 * **`required` is the one that reaches a page about the past anyway**, and the
 * form says so beside the control rather than in a tooltip. It rewrites
 * nothing; it moves this grader's verdicts between the lane that decides a run
 * and the lane that only reports, and that is worked out fresh every time
 * somebody opens a result — so a run that failed on this grader alone reads as
 * passed from the moment the box is unticked. Saying "nothing already judged
 * changes" here would be the screen telling somebody the opposite of what they
 * see next.
 *
 * **Every write names the project in the address.** This section is rooted at
 * one project, and a write that let the API resolve a project for itself would
 * be an edit landing wherever the credential happened to act — the exact fault
 * that moved these screens off the organization-wide addresses.
 */

/**
 * What this copy currently holds, as controls hold it.
 *
 * A dropdown's default is where an unanswered question starts, and a stored
 * value written over it is where an answered one is — so a copy of an entry
 * that has grown a parameter since it was made opens with that parameter's
 * first option rather than with nothing in it.
 */
function filledFrom(
  params: readonly GraderParameter[],
  assertion: unknown,
): Record<string, string> {
  const chosen: Record<string, string> = { ...firstChoices(params) };
  const held =
    typeof assertion === "object" && assertion !== null
      ? (assertion as Readonly<Record<string, unknown>>)
      : undefined;

  for (const parameter of params) {
    const value = held?.[parameter.name];
    if (value !== undefined && value !== null) {
      chosen[parameter.name] = String(value);
    }
  }
  return chosen;
}

export function EditForm({
  copy,
  params,
  projectId,
  onSaved,
  onProtectionChange,
  onCancel,
}: {
  readonly copy: RunningGrader;
  /** What this copy's entry asks for, as the entry declares it. */
  readonly params: readonly GraderParameter[];
  readonly projectId: string;
  readonly onSaved: (name: string) => void;
  /** Whether leaving now would lose a changed value or an active write. */
  readonly onProtectionChange: (state: {
    readonly atRisk: boolean;
    readonly busy: boolean;
  }) => void;
  readonly onCancel: () => void;
}) {
  const originalName = graderDisplayName(copy.name);
  const [initial] = useState(() => ({
    filled: filledFrom(params, copy.config?.assertions?.[0]),
    name: originalName,
    description: copy.description ?? "",
    scope: copy.scope,
    required: copy.required,
    sampleRate: String(copy.production_sample_rate),
  }));
  const [filled, setFilled] = useState<Readonly<Record<string, string>>>(
    initial.filled,
  );
  const [name, setName] = useState(initial.name);
  const [description, setDescription] = useState(initial.description);
  const [scope, setScope] = useState(initial.scope);
  const [required, setRequired] = useState(initial.required);
  const [sampleRate, setSampleRate] = useState(initial.sampleRate);
  const [busy, setBusy] = useState(false);
  const [refused, setRefused] = useState<Refusal | null>(null);

  const changed =
    name !== initial.name ||
    description !== initial.description ||
    scope !== initial.scope ||
    required !== initial.required ||
    sampleRate !== initial.sampleRate ||
    params.some(
      (parameter) =>
        (filled[parameter.name] ?? "") !==
        (initial.filled[parameter.name] ?? ""),
    );

  useEffect(() => {
    onProtectionChange({ atRisk: changed || busy, busy });
  }, [busy, changed, onProtectionChange]);

  // Clear the page-owned guard when a save or confirmed discard unmounts this
  // form. Without this cleanup, the next clean editor would inherit a warning
  // for values that no longer exist.
  useEffect(
    () => () => {
      onProtectionChange({ atRisk: false, busy: false });
    },
    [onProtectionChange],
  );

  /** The share of live traffic, where the box actually states one. */
  const saidRate =
    sampleRate.trim() === "" || !Number.isFinite(Number(sampleRate))
      ? undefined
      : Number(sampleRate);

  async function save(): Promise<void> {
    if (busy) return;
    setBusy(true);
    setRefused(null);

    const answer = await writeJson<RunningGrader>(graderPath(copy.id), {
      method: "PATCH",
      project: projectId,
      body: {
        // A predefined grader is stored with a machine key but shown with a
        // human name. Keeping that unchanged must not silently rename it when
        // somebody saves a different setting.
        name: name === originalName ? copy.name : name,
        // Null rather than an empty string, because emptying a note is a thing
        // somebody means to do and the platform reads null as exactly that.
        description: description.trim() === "" ? null : description,
        scope,
        required,
        /*
          **An empty box is left out rather than sent as nought**, which is the
          rule the entry's own values already follow: a parameter nobody filled
          in is not sent, so the refusal a person reads is about what they
          typed. Here the reason is sharper. `Number("")` is `0`, and `0` is a
          perfectly good share of live traffic — so a cleared box would be
          written as *stop judging live traffic*, accepted, and reported as
          saved. The key being absent means "keep what is there", which is the
          honest reading of a box that says nothing.
        */
        ...(saidRate === undefined ? {} : { production_sample_rate: saidRate }),
        ...(params.length === 0
          ? {}
          : { params: filledParams(params, filled) }),
      },
    });

    setBusy(false);

    if (answer.status === "signed-out") {
      window.location.replace("/sign-in");
      return;
    }

    if (answer.status !== "ready") {
      setRefused(answer.refusal);
      return;
    }

    onSaved(name);
  }

  return (
    <Form onSubmit={() => void save()}>
      <Help>{EDIT.lead}</Help>
      {refused === null ? null : <Refused message={refused.message} />}

      <fieldset className={FORM_GROUP} disabled={busy}>
        <legend className={FORM_GROUP_TITLE}>{EDIT.groups.general}</legend>
        <Field label={EDIT.name} hint={EDIT.nameMeans} htmlFor="edit-name">
          <Input
            id="edit-name"
            value={name}
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => setName(event.target.value)}
          />
        </Field>

        <Field
          label={EDIT.description}
          hint={EDIT.descriptionMeans}
          htmlFor="edit-description"
        >
          <Input
            id="edit-description"
            value={description}
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => setDescription(event.target.value)}
          />
        </Field>
      </fieldset>

      <fieldset className={FORM_GROUP} disabled={busy}>
        <legend className={FORM_GROUP_TITLE}>{EDIT.groups.logic}</legend>
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
      </fieldset>

      <fieldset className={FORM_GROUP} disabled={busy}>
        <legend className={FORM_GROUP_TITLE}>
          {EDIT.groups.applicability}
        </legend>
        <Field label={EDIT.scope} hint={EDIT.scopeMeans} htmlFor="edit-scope">
          <Select
            id="edit-scope"
            value={scope}
            onChange={(event) => setScope(event.target.value)}
          >
            {Object.entries(SCOPES).map(([stored, said]) => (
              <option key={stored} value={stored}>
                {said}
              </option>
            ))}
          </Select>
        </Field>

        {/*
          The share of live traffic, on the shared numeric field.

          **The bounds are now on the control rather than only in the
          sentence.** `sampleRateMeans` says "a whole percentage from 0 to 100",
          which is a claim a text box told to look numeric would happily take
          900 against; `min`, `max` and `step` are the browser's own validation
          and its own arrow-key stepping, so the sentence and the box agree. The
          sentence stays as it is, because its second half — that a change
          reaches future live traffic only — is the part a bound cannot say.

          An empty box is still left out of the write rather than sent as
          nought. That rule is in `save` below, and it is where it has to be:
          `Number("")` is `0`, and `0` is a perfectly good share of live
          traffic.
        */}
        {scope === "production" || scope === "both" ? (
          <NumberField
            id="edit-sample-rate"
            label={EDIT.sampleRate}
            hint={EDIT.sampleRateMeans}
            value={sampleRate}
            unit="%"
            min={0}
            max={100}
            step={1}
            onChange={setSampleRate}
          />
        ) : null}
      </fieldset>

      <fieldset className={FORM_GROUP} disabled={busy}>
        <legend className={FORM_GROUP_TITLE}>{EDIT.groups.impact}</legend>
        {/*
          Both readings of `required` are spelled out beside the control, and
          both carry the same warning: no verdict is rewritten, and every run
          already read is counted again the next time somebody opens it.
        */}
        <Field
          label={EDIT.required}
          hint={required ? EDIT.requiredOn : EDIT.requiredOff}
          htmlFor="edit-required"
        >
          <Checkbox
            id="edit-required"
            checked={required}
            onChange={(event) => setRequired(event.target.checked)}
          />
        </Field>
      </fieldset>

      <FormActions>
        <Button
          type="button"
          variant="secondary"
          onClick={onCancel}
          disabled={busy}
        >
          {EDIT.cancel}
        </Button>
        <Button type="submit" busy={busy}>
          {busy ? EDIT.submitting : EDIT.submit}
        </Button>
      </FormActions>
    </Form>
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
 *
 * **A third sentence appears on the last copy.** A project judged by nothing is
 * a state it is allowed to be in — the run door lets it through — so this is a
 * warning and never a refusal, and it has to arrive before the act rather than
 * on a results page that came back empty.
 */
export function SwitchOffPanel({
  copy,
  projectId,
  theLastOne,
  onSwitchedOff,
  onCancel,
}: {
  readonly copy: RunningGrader;
  readonly projectId: string;
  /** Whether this is the only copy left, which changes what is said. */
  readonly theLastOne: boolean;
  readonly onSwitchedOff: (name: string) => void;
  readonly onCancel: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [refused, setRefused] = useState<Refusal | null>(null);

  async function switchOff(): Promise<void> {
    setBusy(true);
    setRefused(null);

    const answer = await deleteJson<unknown>(graderPath(copy.id), {
      project: projectId,
    });

    setBusy(false);

    if (answer.status === "signed-out") {
      window.location.replace("/sign-in");
      return;
    }

    if (answer.status !== "ready") {
      setRefused(answer.refusal);
      return;
    }

    onSwitchedOff(copy.name);
  }

  return (
    <>
      <p>{SWITCH_OFF.stops}</p>
      <p>{SWITCH_OFF.keeps}</p>
      <p>{SWITCH_OFF.again}</p>
      {theLastOne ? <p>{SWITCH_OFF.theLastOne}</p> : null}
      {refused === null ? null : <Refused message={refused.message} />}

      <Actions>
        <Button type="button" variant="secondary" onClick={onCancel}>
          {SWITCH_OFF.cancel}
        </Button>
        <Button
          type="button"
          variant="destructive"
          disabled={busy}
          onClick={() => void switchOff()}
        >
          {busy ? SWITCH_OFF.confirming : SWITCH_OFF.confirm}
        </Button>
      </Actions>
    </>
  );
}
