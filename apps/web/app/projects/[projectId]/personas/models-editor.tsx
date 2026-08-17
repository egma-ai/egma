"use client";

import {
  providerOptions,
  type ModelsDraft,
  type PersonaForm,
} from "../../../../lib/personas.ts";
import { Field, FormRow, Help, Select, TextInput } from "../../../../ui/controls.tsx";

/**
 * What a persona thinks, listens and speaks with — three independent choices,
 * written once and used by both the create form and the editor on its page.
 *
 * **Three choices rather than one bundle** (ADR-0010): changing what a persona
 * listens with must not require inventing a new package for what it thinks and
 * speaks with. So each job has its own provider and its own model id, and the
 * speaking one has the two facts only it needs.
 *
 * **There is no key field here and there never will be.** Who pays for a model
 * is the organization's model access, under Model providers; a persona names a
 * provider and never a secret, which is what keeps a rotation from minting a
 * persona version and what keeps a version from ever holding a key.
 *
 * **There is no voice-activity field either.** What tells the persona the agent
 * started and stopped speaking is internal simulator behavior rather than a
 * model anybody chooses, and putting it here would make an implementation
 * detail into a question every persona author has to answer.
 *
 * A model id is free text on purpose. A release proves one default per
 * provider; a model released this morning has to be nameable without shipping
 * a new browser bundle, and the provider is the authority on the rest.
 */
export function ModelFields({
  draft,
  form,
  disabled = false,
  onChange,
}: {
  readonly draft: ModelsDraft;
  /**
   * The catalog as the server listed it, or `null` while that read has not
   * answered. Never a copy kept here: a hand-written list is wrong the day the
   * server's grows, and wrong silently.
   */
  readonly form: PersonaForm | null;
  readonly disabled?: boolean;
  readonly onChange: (draft: ModelsDraft) => void;
}) {
  const set =
    <Key extends keyof ModelsDraft>(key: Key) =>
    (value: string) =>
      onChange({ ...draft, [key]: value });

  const providersFor = (job: "llm" | "stt" | "tts", held: string) =>
    providerOptions(
      form === null
        ? null
        : form.model_catalog
            .filter((entry) => entry.job === job)
            .map((entry) => entry.provider),
      held,
    ).map((provider) => ({ value: provider, label: provider }));

  const reading = form === null ? "Reading the providers Egma supports…" : null;
  const range = form?.speed_range;

  return (
    <>
      <Help>
        A persona names a provider and a model. The key behind it belongs to the
        organization and is set under Model providers, so replacing a key never
        changes what this persona is.
      </Help>

      <FormRow>
        <Field
          label="Language model provider"
          htmlFor="persona-llm-provider"
          hint={reading ?? "What the persona thinks with."}
        >
          <Select
            id="persona-llm-provider"
            value={draft.llmProvider}
            disabled={disabled || form === null}
            options={providersFor("llm", draft.llmProvider)}
            onChange={set("llmProvider")}
          />
        </Field>
        <Field
          label="Language model"
          htmlFor="persona-llm-model"
          hint="The provider's own id. Any model that provider accepts."
        >
          <TextInput
            id="persona-llm-model"
            value={draft.llmModel}
            disabled={disabled}
            onChange={set("llmModel")}
          />
        </Field>
      </FormRow>

      <FormRow>
        <Field
          label="Speech-to-text provider"
          htmlFor="persona-stt-provider"
          hint={reading ?? "What the persona hears with."}
        >
          <Select
            id="persona-stt-provider"
            value={draft.sttProvider}
            disabled={disabled || form === null}
            options={providersFor("stt", draft.sttProvider)}
            onChange={set("sttProvider")}
          />
        </Field>
        <Field
          label="Speech-to-text model"
          htmlFor="persona-stt-model"
          hint="The provider's own id."
        >
          <TextInput
            id="persona-stt-model"
            value={draft.sttModel}
            disabled={disabled}
            onChange={set("sttModel")}
          />
        </Field>
      </FormRow>

      <FormRow>
        <Field
          label="Text-to-speech provider"
          htmlFor="persona-tts-provider"
          hint={reading ?? "What the persona speaks with."}
        >
          <Select
            id="persona-tts-provider"
            value={draft.ttsProvider}
            disabled={disabled || form === null}
            options={providersFor("tts", draft.ttsProvider)}
            onChange={set("ttsProvider")}
          />
        </Field>
        <Field
          label="Text-to-speech model"
          htmlFor="persona-tts-model"
          hint="The provider's own id."
        >
          <TextInput
            id="persona-tts-model"
            value={draft.ttsModel}
            disabled={disabled}
            onChange={set("ttsModel")}
          />
        </Field>
      </FormRow>

      <FormRow>
        <Field
          label="Voice"
          htmlFor="persona-tts-voice"
          hint="The provider's own id for the voice, so every simulation casts the same person."
        >
          <TextInput
            id="persona-tts-voice"
            value={draft.ttsVoiceId}
            disabled={disabled}
            onChange={set("ttsVoiceId")}
          />
        </Field>
        <Field
          label="Speech rate"
          htmlFor="persona-tts-speed"
          hint={
            range === undefined
              ? "A multiple of the provider's natural pace."
              : `A multiple of the provider's natural pace, between ${range.slowest} and ${range.fastest}.`
          }
        >
          <TextInput
            id="persona-tts-speed"
            value={draft.ttsSpeed}
            disabled={disabled}
            onChange={set("ttsSpeed")}
          />
        </Field>
      </FormRow>
    </>
  );
}
