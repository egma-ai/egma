"use client";

import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { NumberField } from "@/ui/number-field.tsx";
import { writeJson, type Refusal } from "../../../../lib/api.ts";
import {
  filledParams,
  firstChoices,
  GRADERS_PATH,
  unitOf,
  type GraderParameter,
  type LibraryEntry,
  type RunningGrader,
} from "../../../../lib/graders.ts";
import { USE } from "../../../../lib/grader-library-copy.ts";
import {
  Field,
  Form,
  FormActions,
  Help,
  Refused,
} from "../../../../ui/controls.tsx";

/**
 * The **Use** form: a library entry, filled in, and a running copy of it on
 * this project.
 *
 * **Drawn from the entry rather than written here, and that is the whole
 * design.** A library entry declares what pressing Use asks for — latency
 * declares a measure from egma's catalog and a bound; expected behaviors
 * declares nothing, because its assertions are each test's own sentences — and
 * that declaration rides the entry on the answer the shelf already read. So
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
 * **The project rides in the address, because a copy lands in exactly one
 * project.** This is what the organization-wide version of this form could not
 * say: it posted a body with no project in it and the API resolved one for
 * itself, so a person with three projects switched a grader on in whichever
 * came first. The project here is the one in the address, which is the only
 * project this page has ever been about.
 *
 * **The unit belongs to the measure**, so it is shown beside the bound rather
 * than fixed in the label: milliseconds for a latency, turns for a count. The
 * catalog says which, and the form repeats what it was told instead of assuming
 * every bound is a duration.
 */

/**
 * The entry's own questions, as controls — the block both forms in this section
 * are built around.
 *
 * **It is one component because there is one form.** Switching a grader on and
 * changing what it judges by ask exactly the same questions, in the same order,
 * with the same meanings, because both are the entry's declaration rendered. A
 * second copy of this for the edit screen would be a second reading of that
 * declaration, and the day one of them learned a new kind of control the other
 * would quietly go on drawing text boxes.
 *
 * `sentence` is the screen's own words for an entry that asks nothing, and it
 * is a parameter rather than a constant here so each screen keeps its copy in
 * its own file — which is what lets one test hold every word each screen says
 * against the banned list.
 *
 * `named` prefixes the control identifiers, so two of these on one page — a
 * form being filled in beside another — never label each other's inputs.
 */
export function EntryFields({
  params,
  filled,
  onFilled,
  named,
  sentence,
}: {
  readonly params: readonly GraderParameter[];
  readonly filled: Readonly<Record<string, string>>;
  readonly onFilled: (name: string, value: string) => void;
  readonly named: string;
  readonly sentence: string;
}) {
  const unit = unitOf(params, filled);

  if (params.length === 0) return <Help>{sentence}</Help>;

  return (
    <>
      {params.map((parameter) => {
        const control = `${named}-${parameter.name}`;
        const chosen = filled[parameter.name] ?? "";
        const write = (value: string): void =>
          onFilled(parameter.name, value);

        /*
          The catalog says whether this parameter is a number, and it says so in
          one place: `kind` already decides that what is typed is sent as a
          number rather than a string. The control has to agree, or a person is
          asked for a bound on a keyboard that has no digits on it.

          A number gets the shared numeric field, which is where the unit now
          lives. It used to be a sentence appended to the hint — "In ms." — and
          before that the placeholder, which vanished the instant somebody typed,
          exactly when knowing whether the number is milliseconds or turns starts
          to matter. On the field it is beside the value, it is read out with it,
          and it still changes with the choice above, because the unit belongs to
          the measure rather than to the box.
        */
        if (parameter.options === undefined && parameter.kind === "number") {
          return (
            <NumberField
              key={parameter.name}
              id={control}
              label={parameter.label}
              hint={parameter.means}
              value={chosen}
              {...(unit === undefined ? {} : { unit })}
              onChange={write}
            />
          );
        }

        return (
          <Field
            key={parameter.name}
            label={parameter.label}
            hint={
              unit === undefined || parameter.options !== undefined
                ? parameter.means
                : `${parameter.means} In ${unit}.`
            }
            htmlFor={control}
          >
            {parameter.options === undefined ? (
              <Input
                id={control}
                value={chosen}
                autoComplete="off"
                spellCheck={false}
                onChange={(event) => write(event.target.value)}
              />
            ) : (
              <Select
                id={control}
                value={chosen}
                onChange={(event) => write(event.target.value)}
              >
                {parameter.options.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        );
      })}
    </>
  );
}

export function UseForm({
  entry,
  projectId,
  onStarted,
  onCancel,
}: {
  readonly entry: LibraryEntry;
  readonly projectId: string;
  readonly onStarted: (name: string) => void;
  readonly onCancel: () => void;
}) {
  const params: readonly GraderParameter[] = entry.params ?? [];
  const [filled, setFilled] = useState<Readonly<Record<string, string>>>(() =>
    firstChoices(params),
  );
  const [required, setRequired] = useState(true);
  const [busy, setBusy] = useState(false);
  const [refused, setRefused] = useState<Refusal | null>(null);

  async function start(): Promise<void> {
    setBusy(true);
    setRefused(null);

    const answer = await writeJson<RunningGrader>(GRADERS_PATH, {
      method: "POST",
      project: projectId,
      body: {
        library_id: entry.id,
        required,
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

    onStarted(entry.name);
  }

  return (
    <Form onSubmit={() => void start()}>
      <Help>{USE.lead}</Help>
      {refused === null ? null : <Refused message={refused.message} />}

      <EntryFields
        params={params}
        filled={filled}
        onFilled={(name, value) =>
          setFilled((was) => ({ ...was, [name]: value }))
        }
        named="use"
        sentence={USE.asksNothing}
      />

      {/*
        `required` is the only loudness switch v0 has, so both readings are
        spelled out beside the control rather than left to the flag's name: on,
        and a test cannot pass while this grader does not; off, and it is a
        diagnostic that reports and gates nothing.
      */}
      <Field
        label={USE.required}
        hint={required ? USE.requiredOn : USE.requiredOff}
        htmlFor="use-required"
      >
        <Checkbox
          id="use-required"
          checked={required}
          onChange={(event) => setRequired(event.target.checked)}
        />
      </Field>

      <FormActions>
        <Button type="button" variant="secondary" onClick={onCancel}>
          {USE.cancel}
        </Button>
        <Button type="submit" disabled={busy}>
          {busy ? USE.submitting : USE.submit}
        </Button>
      </FormActions>
    </Form>
  );
}
