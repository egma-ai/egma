"use client";

import {
  type ModelsDraft,
  type PersonaForm,
  type PersonaModelCatalogEntry,
} from "../../../../lib/personas.ts";
import {
  Field,
  FormRow,
  Help,
  Select,
  TextInput,
} from "../../../../ui/controls.tsx";

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
            options={options("llm")}
            onChange={(value) => {
              const entry = selected("llm", value);
              if (entry === undefined) return;
              onChange({
                ...draft,
                llmProvider: entry.provider,
                llmModel: entry.model,
              });
            }}
          />
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
            options={options("stt")}
            onChange={(value) => {
              const entry = selected("stt", value);
              if (entry === undefined) return;
              onChange({
                ...draft,
                sttProvider: entry.provider,
                sttModel: entry.model,
              });
            }}
          />
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
          options={options("tts")}
          onChange={(value) => {
            const entry = selected("tts", value);
            if (entry === undefined) return;
            onChange({
              ...draft,
              ttsProvider: entry.provider,
              ttsModel: entry.model,
              voiceId: entry.recommended_voice_id ?? "",
            });
          }}
        />
      </Field>

      <FormRow>
        <Field
          label="Voice"
          htmlFor="persona-tts-voice"
          hint="The TTS provider's voice id."
        >
          <TextInput
            id="persona-tts-voice"
            value={draft.voiceId}
            disabled={disabled}
            onChange={(voiceId) => onChange({ ...draft, voiceId })}
          />
        </Field>

        <Field
          label="Speech rate"
          htmlFor="persona-tts-speed"
          hint={`A multiple of the natural pace, from ${form.speed_range.slowest} to ${form.speed_range.fastest}.`}
        >
          <TextInput
            id="persona-tts-speed"
            value={draft.speed}
            numeric
            disabled={disabled}
            onChange={(speed) => onChange({ ...draft, speed })}
          />
        </Field>
      </FormRow>
    </>
  );
}
