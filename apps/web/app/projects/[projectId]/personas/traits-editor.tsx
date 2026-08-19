"use client";

import { type TraitsDraft } from "../../../../lib/personas.ts";
import { Field, TextArea } from "../../../../ui/controls.tsx";

/**
 * The field that describes who a persona is, written once and used by both the
 * create form and the editor on their page.
 *
 * **One definition, because the two forms are the same form.** A create screen
 * and an edit screen that spell it out twice can still drift. Personality is
 * the one place for manner, patience, and behavior under friction. Speech is
 * configured outside persona authoring.
 */
export function PersonalityField({
  draft,
  disabled = false,
  onChange,
}: {
  readonly draft: TraitsDraft;
  readonly disabled?: boolean;
  readonly onChange: (draft: TraitsDraft) => void;
}) {
  const set = <Key extends keyof TraitsDraft>(key: Key) =>
    (value: string) => onChange({ ...draft, [key]: value });

  return (
    <>
      <Field
        label="Personality"
        htmlFor="persona-personality"
        hint="Describe their manner, patience, and behavior under friction. What they want belongs to the test."
      >
        <TextArea
          id="persona-personality"
          value={draft.personality}
          rows={5}
          disabled={disabled}
          placeholder="Patient at first. Speaks plainly. If the agent repeats a mistake, asks for a person."
          onChange={set("personality")}
        />
      </Field>
    </>
  );
}
