"use client";

import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import {
  providerOptions,
  type TraitsDraft,
} from "../../../../lib/personas.ts";
import { Field, FormRow } from "../../../../ui/form.tsx";

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
  voiceProviders,
  disabled = false,
  onChange,
}: {
  readonly draft: TraitsDraft;
  /**
   * The voices egma can ask for, as the server listed them, or `null` while
   * that read has not answered. Never a copy kept here: a hand-written list is
   * wrong the day the server's grows, and wrong silently.
   */
  readonly voiceProviders: readonly string[] | null;
  readonly disabled?: boolean;
  readonly onChange: (draft: TraitsDraft) => void;
}) {
  /**
   * One trait, written back into the draft.
   *
   * It takes the event rather than the value because every control here is now
   * the browser's own — an input, a textarea and a select all report a change
   * the same way, and unwrapping it once here keeps ten call sites reading as
   * ten traits rather than as ten copies of `event.target.value`.
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
        hint="Who they are, in their own right. Not what they are calling about — that belongs to the test."
      >
        <Textarea
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
          <Textarea
            id="persona-manner"
            value={draft.manner}
            rows={2}
            disabled={disabled}
            placeholder="Warm, and talks over the end of a sentence."
            onChange={set("manner")}
          />
        </Field>
        <Field label="Patience" htmlFor="persona-patience" hint="Optional.">
          <Textarea
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
          <Input
            id="persona-accent"
            value={draft.accent}
            disabled={disabled}
            placeholder="Glaswegian"
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
            placeholder="A busy kitchen"
            autoComplete="off"
            spellCheck={false}
            onChange={set("backgroundNoise")}
          />
        </Field>
      </FormRow>

      <Field
        label="Under friction"
        htmlFor="persona-under-friction"
        hint="Optional. What they do when the agent gets it wrong, or will not budge."
      >
        <Textarea
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
        <Field
          label="Voice provider"
          htmlFor="persona-provider"
          hint={
            voiceProviders === null
              ? "Reading the voices Egma can ask for…"
              : "The providers this Egma instance can ask for."
          }
        >
          <Select
            id="persona-provider"
            value={draft.provider}
            disabled={disabled || voiceProviders === null}
            onChange={set("provider")}
          >
            {providerOptions(voiceProviders, draft.provider).map((provider) => (
              <option key={provider} value={provider}>
                {provider}
              </option>
            ))}
          </Select>
        </Field>
      </FormRow>

      <FormRow>
        <Field
          label="Voice"
          htmlFor="persona-voice-id"
          hint="The provider's own id for the voice, so every simulation casts the same person."
        >
          <Input
            id="persona-voice-id"
            value={draft.voiceId}
            disabled={disabled}
            placeholder="EXAVITQu4vr4xnSDxMaL"
            autoComplete="off"
            spellCheck={false}
            onChange={set("voiceId")}
          />
        </Field>
        <Field
          label="Speech rate"
          htmlFor="persona-speed"
          hint="A multiple of the provider's natural pace."
        >
          <Input
            id="persona-speed"
            value={draft.speed}
            disabled={disabled}
            placeholder="1"
            autoComplete="off"
            spellCheck={false}
            onChange={set("speed")}
          />
        </Field>
      </FormRow>
    </>
  );
}
