"use client";

import {
  VOICE_PROVIDERS,
  type TraitsDraft,
} from "../../../../lib/personas.ts";
import {
  Field,
  FormRow,
  Select,
  TextArea,
  TextInput,
} from "../../../../ui/controls.tsx";

/**
 * The fields that describe who a persona is, written once and used by both the
 * create form and the editor on their page.
 *
 * **One definition, because the two forms are the same form.** A create screen
 * and an edit screen that each spelled out ten fields would drift the day an
 * eleventh arrived, and the one that fell behind would be the one nobody
 * noticed — a trait quietly unauthorable from one of the two places it is
 * authored.
 *
 * The order is the domain's: what the caller is like, then how they sound,
 * then how they behave when things go wrong. Every described trait is optional
 * and says so, because **an unstated trait is honest** — inventing a
 * background noise for somebody would put a fact into the simulation that
 * nobody decided.
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
  const set = <Key extends keyof TraitsDraft>(key: Key) =>
    (value: string) => onChange({ ...draft, [key]: value });

  return (
    <>
      <Field
        label="Personality"
        htmlFor="persona-personality"
        hint="Who they are, in their own right. Not what they are calling about — that belongs to the test."
      >
        <TextArea
          id="persona-personality"
          value={draft.personality}
          rows={3}
          disabled={disabled}
          placeholder="Seventy, hard of hearing, and gets louder when she mishears."
          onChange={set("personality")}
        />
      </Field>

      <FormRow>
        <Field label="Manner" htmlFor="persona-manner" hint="Optional.">
          <TextArea
            id="persona-manner"
            value={draft.manner}
            rows={2}
            disabled={disabled}
            placeholder="Warm, and talks over the end of a sentence."
            onChange={set("manner")}
          />
        </Field>
        <Field label="Patience" htmlFor="persona-patience" hint="Optional.">
          <TextArea
            id="persona-patience"
            value={draft.patience}
            rows={2}
            disabled={disabled}
            placeholder="Gives it about a minute before asking for somebody else."
            onChange={set("patience")}
          />
        </Field>
      </FormRow>

      <FormRow>
        <Field label="Accent" htmlFor="persona-accent" hint="Optional.">
          <TextInput
            id="persona-accent"
            value={draft.accent}
            disabled={disabled}
            placeholder="Glaswegian"
            onChange={set("accent")}
          />
        </Field>
        <Field
          label="Background noise"
          htmlFor="persona-background-noise"
          hint="Optional."
        >
          <TextInput
            id="persona-background-noise"
            value={draft.backgroundNoise}
            disabled={disabled}
            placeholder="A busy kitchen"
            onChange={set("backgroundNoise")}
          />
        </Field>
      </FormRow>

      <Field
        label="Under friction"
        htmlFor="persona-under-friction"
        hint="Optional. What they do when the agent gets it wrong, or will not budge."
      >
        <TextArea
          id="persona-under-friction"
          value={draft.underFriction}
          rows={2}
          disabled={disabled}
          placeholder="Repeats the question louder, then asks to escalate."
          onChange={set("underFriction")}
        />
      </Field>

      <FormRow>
        <Field
          label="Language"
          htmlFor="persona-language"
          hint="A BCP 47 tag, like en-US."
        >
          <TextInput
            id="persona-language"
            value={draft.language}
            disabled={disabled}
            placeholder="en-US"
            onChange={set("language")}
          />
        </Field>
        <Field label="Voice provider" htmlFor="persona-provider">
          <Select
            id="persona-provider"
            value={draft.provider}
            disabled={disabled}
            options={VOICE_PROVIDERS.map((provider) => ({
              value: provider,
              label: provider,
            }))}
            onChange={set("provider")}
          />
        </Field>
      </FormRow>

      <FormRow>
        <Field
          label="Voice"
          htmlFor="persona-voice-id"
          hint="The provider's own id for the voice, so every simulation casts the same person."
        >
          <TextInput
            id="persona-voice-id"
            value={draft.voiceId}
            disabled={disabled}
            placeholder="EXAVITQu4vr4xnSDxMaL"
            onChange={set("voiceId")}
          />
        </Field>
        <Field
          label="Speech rate"
          htmlFor="persona-speed"
          hint="A multiple of the provider's natural pace."
        >
          <TextInput
            id="persona-speed"
            value={draft.speed}
            disabled={disabled}
            placeholder="1"
            onChange={set("speed")}
          />
        </Field>
      </FormRow>
    </>
  );
}
