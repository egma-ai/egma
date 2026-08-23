"use client";

import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { type TraitsDraft } from "../../../../lib/personas.ts";
import { Field, FormRow } from "../../../../ui/form.tsx";

/**
 * The fields that describe who a persona is, written once and used by both the
 * create form and the editor on their page.
 *
 * **One definition, because the two forms are the same form.** A create screen
 * and an edit screen that spell them out twice can still drift. Technical
 * speech is owned separately by the Models fields on the same persona version.
 */
export function TraitFields({
  draft,
  disabled = false,
  onChange,
}: {
  readonly draft: TraitsDraft;
  readonly disabled?: boolean;
  readonly onChange: (draft: TraitsDraft) => void;
}) {
  /**
   * One trait, written back into the draft.
   *
   * It takes the event rather than the value because every control here is now
   * the browser's own — an input and a textarea both report a change the same
   * way, and unwrapping it once here keeps the call sites reading as traits
   * rather than as copies of `event.target.value`.
   */
  const set =
    <Key extends keyof TraitsDraft>(key: Key) =>
    (event: {
      readonly target: { readonly value: string };
    }): void => onChange({ ...draft, [key]: event.target.value });

  return (
    <>
      <Field
        label="Personality"
        htmlFor="persona-personality"
        hint="Who they are. What they want belongs to the test."
      >
        <Textarea
          id="persona-personality"
          value={draft.personality}
          rows={3}
          disabled={disabled}
          placeholder="Who they are: age, temperament, how they speak, what they know."
          onChange={set("personality")}
        />
      </Field>

      <Field
        label="Language"
        htmlFor="persona-language"
        hint="A BCP 47 tag, such as en-US."
      >
        <Input
          id="persona-language"
          value={draft.language}
          disabled={disabled}
          placeholder="en-US"
          autoComplete="off"
          spellCheck={false}
          onChange={set("language")}
        />
      </Field>

      <FormRow>
        <Field label="Manner" htmlFor="persona-manner" hint="Optional.">
          <Textarea
            id="persona-manner"
            value={draft.manner}
            rows={2}
            disabled={disabled}
            placeholder="Warm, brisk, formal, distracted"
            onChange={set("manner")}
          />
        </Field>
        <Field label="Patience" htmlFor="persona-patience" hint="Optional.">
          <Textarea
            id="persona-patience"
            value={draft.patience}
            rows={2}
            disabled={disabled}
            placeholder="How long they stay with something before they push"
            onChange={set("patience")}
          />
        </Field>
      </FormRow>

      <FormRow>
        <Field label="Accent" htmlFor="persona-accent" hint="Optional.">
          <Input
            id="persona-accent"
            value={draft.accent}
            disabled={disabled}
            placeholder="Where they sound from"
            autoComplete="off"
            spellCheck={false}
            onChange={set("accent")}
          />
        </Field>
        <Field
          label="Background noise"
          htmlFor="persona-background-noise"
          hint="Optional."
        >
          <Input
            id="persona-background-noise"
            value={draft.backgroundNoise}
            disabled={disabled}
            placeholder="What is around them"
            autoComplete="off"
            spellCheck={false}
            onChange={set("backgroundNoise")}
          />
        </Field>
      </FormRow>

      <Field
        label="Under friction"
        htmlFor="persona-under-friction"
        hint="Optional. What they do when the agent gets it wrong or will not budge."
      >
        <Textarea
          id="persona-under-friction"
          value={draft.underFriction}
          rows={2}
          disabled={disabled}
          placeholder="Repeats louder, asks for a person, ends the conversation"
          onChange={set("underFriction")}
        />
      </Field>

    </>
  );
}
