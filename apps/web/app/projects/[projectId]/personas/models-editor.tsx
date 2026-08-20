"use client";

import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import {
  type ModelsDraft,
  type PersonaForm,
  type PersonaModelCatalogEntry,
} from "../../../../lib/personas.ts";
import { Field, FormRow, Help } from "../../../../ui/form.tsx";
import { NumberField } from "../../../../ui/number-field.tsx";

/**
 * The complete model selection owned by a persona version.
 *
 * Each model control selects an exact provider/model pair from the server's
 * adapter catalog. The form never lets an author combine a provider from one
 * adapter with a model from another. Technical Voice appears only in the TTS
 * group. Credentials do not appear here at all.
 */
export function ModelFields({
  draft,
  form,
  disabled = false,
  onChange,
}: {
  readonly draft: ModelsDraft;
  readonly form: PersonaForm;
  readonly disabled?: boolean;
  readonly onChange: (draft: ModelsDraft) => void;
}) {
  const entries = (job: PersonaModelCatalogEntry["job"]) =>
    form.model_catalog.filter((entry) => entry.job === job);

  /*
   * **One option carries both halves of the choice, encoded together.** A
   * select whose value was the model alone would let a provider from one
   * adapter stand beside a model from another, which is the exact combination
   * this version is meant to make impossible.
   */
  const choice = (provider: string, model: string) =>
    JSON.stringify([provider, model]);

  const options = (job: PersonaModelCatalogEntry["job"]) =>
    entries(job).map((entry) => ({
      value: choice(entry.provider, entry.model),
      label: `${entry.label} — ${entry.model}`,
    }));

  const selected = (
    job: PersonaModelCatalogEntry["job"],
    value: string,
  ): PersonaModelCatalogEntry | undefined =>
    entries(job).find((entry) => choice(entry.provider, entry.model) === value);

  /** The options of one job, drawn as the browser's own. */
  const optionsOf = (job: PersonaModelCatalogEntry["job"]) =>
    options(job).map((option) => (
      <option key={option.value} value={option.value}>
        {option.label}
      </option>
    ));

  return (
    <>
      <Help>
        These choices are part of this persona version. Provider keys belong to
        the Egma deployment and never become persona data.
      </Help>

      <FormRow>
        <Field
          label="Language model"
          htmlFor="persona-llm-model"
          hint="What the persona thinks with."
        >
          <Select
            id="persona-llm-model"
            value={choice(draft.llmProvider, draft.llmModel)}
            disabled={disabled}
            onChange={(event) => {
              const entry = selected("llm", event.target.value);
              if (entry === undefined) return;
              onChange({
                ...draft,
                llmProvider: entry.provider,
                llmModel: entry.model,
              });
            }}
          >
            {optionsOf("llm")}
          </Select>
        </Field>

        <Field
          label="Speech-to-text model"
          htmlFor="persona-stt-model"
          hint="What the persona hears with."
        >
          <Select
            id="persona-stt-model"
            value={choice(draft.sttProvider, draft.sttModel)}
            disabled={disabled}
            onChange={(event) => {
              const entry = selected("stt", event.target.value);
              if (entry === undefined) return;
              onChange({
                ...draft,
                sttProvider: entry.provider,
                sttModel: entry.model,
              });
            }}
          >
            {optionsOf("stt")}
          </Select>
        </Field>
      </FormRow>

      <Field
        label="Text-to-speech model"
        htmlFor="persona-tts-model"
        hint="What the persona speaks with."
      >
        <Select
          id="persona-tts-model"
          value={choice(draft.ttsProvider, draft.ttsModel)}
          disabled={disabled}
          onChange={(event) => {
            const entry = selected("tts", event.target.value);
            if (entry === undefined) return;
            /*
             * The voice travels with the model that speaks it. A voice id
             * belongs to one TTS provider, so keeping the old one after the
             * provider changed would leave a persona pointing at a voice its
             * new provider has never heard of.
             */
            onChange({
              ...draft,
              ttsProvider: entry.provider,
              ttsModel: entry.model,
              voiceId: entry.recommended_voice_id ?? "",
            });
          }}
        >
          {optionsOf("tts")}
        </Select>
      </Field>

      <FormRow>
        <Field
          label="Voice"
          htmlFor="persona-tts-voice"
          hint="The TTS provider's voice id."
        >
          <Input
            id="persona-tts-voice"
            value={draft.voiceId}
            disabled={disabled}
            autoComplete="off"
            spellCheck={false}
            onChange={(event) =>
              onChange({ ...draft, voiceId: event.target.value })
            }
          />
        </Field>

        {/*
         * The rate carries no `min`, `max` or `step`, and that is deliberate.
         * The accepted range is the server's rule, and a bound written here as
         * well would either refuse a rate egma would have taken or take one
         * egma will refuse. The range is said in the hint, in the server's own
         * numbers, and the one authoritative refusal comes from the server.
         */}
        <NumberField
          id="persona-tts-speed"
          label="Speech rate"
          value={draft.speed}
          disabled={disabled}
          hint={`A multiple of the natural pace, from ${form.speed_range.slowest} to ${form.speed_range.fastest}.`}
          onChange={(speed) => onChange({ ...draft, speed })}
        />
      </FormRow>
    </>
  );
}
