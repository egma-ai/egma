"use client";

import type { ReactNode } from "react";

import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import {
  type ModelsDraft,
  type PersonaForm,
  type PersonaModelCatalogEntry,
} from "../../../../lib/personas.ts";
import { Field, FormRow } from "../../../../ui/form.tsx";
import { NumberField } from "../../../../ui/number-field.tsx";

/**
 * The complete model selection owned by a persona version.
 *
 * Each model control selects an exact provider/model pair from the server's
 * adapter catalog. The form never lets an author combine a provider from one
 * adapter with a model from another. Technical Voice appears only in the TTS
 * group. Credentials do not appear here at all.
 *
 * **What a change here does to the version number is said at the end rather
 * than at the start**, which is where the boards put it (`AZC-0`, `B0J-0`).
 * The sentence is about the whole group above it, and a person reads it in the
 * moment they have finished choosing rather than before they have begun. The
 * caller writes it, because a create and a save say different things: one
 * makes v1, the other makes the next one.
 */
export function ModelFields({
  draft,
  form,
  disabled = false,
  note,
  onChange,
}: {
  readonly draft: ModelsDraft;
  readonly form: PersonaForm;
  readonly disabled?: boolean;
  /** What a save of these choices does to the version, drawn under them. */
  readonly note?: ReactNode;
  readonly onChange: (draft: ModelsDraft) => void;
}) {
  return (
    <>
      <ProviderModelFields
        job="llm"
        providerLabel="Language model provider"
        modelLabel="Language model"
        provider={draft.llmProvider}
        model={draft.llmModel}
        form={form}
        disabled={disabled}
        onSelect={(entry) =>
          onChange({
            ...draft,
            llmProvider: entry.provider,
            llmModel: entry.model,
          })
        }
      />

      <ProviderModelFields
        job="stt"
        providerLabel="Speech-to-text provider"
        modelLabel="Speech-to-text model"
        provider={draft.sttProvider}
        model={draft.sttModel}
        form={form}
        disabled={disabled}
        onSelect={(entry) =>
          onChange({
            ...draft,
            sttProvider: entry.provider,
            sttModel: entry.model,
          })
        }
      />

      <ProviderModelFields
        job="tts"
        providerLabel="Text-to-speech provider"
        modelLabel="Text-to-speech model"
        provider={draft.ttsProvider}
        model={draft.ttsModel}
        form={form}
        disabled={disabled}
        onSelect={(entry) => {
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
            voiceId: entry.recommendedVoiceId ?? "",
          });
        }}
      />

      <FormRow>
        <Field
          label="Voice"
          htmlFor="persona-tts-voice"
          hint="The voice id at the text-to-speech provider."
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
          hint={`A multiple of the natural pace, from ${form.speedRange.slowest} to ${form.speedRange.fastest}.`}
          onChange={(speed) => onChange({ ...draft, speed })}
        />
      </FormRow>

      {note}
    </>
  );
}

/**
 * One provider choice followed by one model choice from that provider.
 *
 * The server catalog remains the interface. This browser module derives both
 * dropdowns from it, so a provider/model pair cannot exist here unless the
 * server said its adapter can execute that exact pair.
 */
function ProviderModelFields({
  job,
  providerLabel,
  modelLabel,
  provider,
  model,
  form,
  disabled,
  onSelect,
}: {
  readonly job: PersonaModelCatalogEntry["job"];
  readonly providerLabel: string;
  readonly modelLabel: string;
  readonly provider: string;
  readonly model: string;
  readonly form: PersonaForm;
  readonly disabled: boolean;
  readonly onSelect: (entry: PersonaModelCatalogEntry) => void;
}) {
  const entries = form.modelCatalog.filter((entry) => entry.job === job);
  const providers = [
    ...new Map(entries.map((entry) => [entry.provider, entry.label])).entries(),
  ];
  const models = entries.filter((entry) => entry.provider === provider);

  const firstEntryForProvider = (nextProvider: string) =>
    entries.find((entry) => entry.provider === nextProvider);
  const entryForModel = (nextModel: string) =>
    models.find((entry) => entry.model === nextModel);

  return (
    <FormRow>
      <Field
        label={providerLabel}
        htmlFor={`persona-${job}-provider`}
        hint={`Who the persona ${job === "llm" ? "thinks" : job === "stt" ? "hears" : "speaks"} with.`}
      >
        <Select
          id={`persona-${job}-provider`}
          value={provider}
          disabled={disabled}
          onChange={(event) => {
            const entry = firstEntryForProvider(event.target.value);
            if (entry !== undefined) onSelect(entry);
          }}
        >
          {providers.map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </Select>
      </Field>

      <Field
        label={modelLabel}
        htmlFor={`persona-${job}-model`}
        hint="The exact model Egma will run."
      >
        <Select
          id={`persona-${job}-model`}
          value={model}
          disabled={disabled}
          onChange={(event) => {
            const entry = entryForModel(event.target.value);
            if (entry !== undefined) onSelect(entry);
          }}
        >
          {models.map((entry) => (
            <option key={entry.model} value={entry.model}>
              {entry.modelLabel === undefined
                ? entry.model
                : `${entry.modelLabel} — ${entry.model}`}
            </option>
          ))}
        </Select>
      </Field>
    </FormRow>
  );
}
