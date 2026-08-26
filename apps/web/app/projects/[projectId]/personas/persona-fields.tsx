"use client";

import type { ReactNode } from "react";

import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import {
  modelPairFrom,
  modelPairKey,
  modelSaid,
  type BehaviorDraft,
  type ModelsDraft,
  type PersonaForm,
  type PersonaModelCatalogEntry,
} from "../../../../lib/personas.ts";
import { Field, FormRow } from "../../../../ui/form.tsx";
import { NumberField } from "../../../../ui/number-field.tsx";
import { SheetSection } from "./sheet-parts.tsx";

/**
 * The fields a persona is authored in, in the three groups the boards draw.
 *
 * **One set of fields, two sheets.** Create and edit ask for exactly the same
 * things — the boards `RKF-0` and `S6H-0` are the same form with a different
 * head, a different footer, and one extra line of small print. Writing them
 * twice is how the two come to disagree about a placeholder, and this surface
 * has eleven fields to disagree about.
 *
 * **The label grammar is the product's, and it is kept by two halves.** A
 * mandatory label ends in `*`, drawn Ember by `LabelText`; an optional one ends
 * in `[optional]`. The star is never only a picture, so every starred control
 * here also carries `aria-required`. `DESIGN.md` calls a starred label with no
 * required semantics a bug rather than a style choice.
 *
 * **A field says what to write, and nothing about how egma stores it.** The
 * release-defaults note, the speed instruction and the version arithmetic that
 * used to sit in these groups were deleted on the developer's own reading of
 * the boards. What a save does to the version number is said once, in the one
 * line under the name block, where the distinction it draws is the point.
 *
 * The ids are prefixed because the create sheet and the read sheet can both be
 * mounted at once — one opening while the other finishes closing — and two
 * elements answering to `#persona-name` would leave every label pointing at
 * whichever the document happened to hold first.
 */

/** Which sheet these fields are in, and so which ids they answer to. */
export type FieldPrefix = "persona" | "new-persona";

/** One explanatory line, quieter than the fields it is about. */
function Note({ children }: { readonly children: ReactNode }) {
  return (
    <p className="m-0 text-sm leading-(--line-normal) text-faint">{children}</p>
  );
}

/**
 * The team's word for this persona, and the line people pick them by.
 *
 * Neither is versioned, and the sheet that can mint a version says so here —
 * before somebody has typed into the fields below, which are the ones that do.
 */
export function NameFields({
  prefix,
  name,
  description,
  disabled = false,
  /** Said by the edit sheet, where a version is a thing that can be minted. */
  note,
  onName,
  onDescription,
}: {
  readonly prefix: FieldPrefix;
  readonly name: string;
  readonly description: string;
  readonly disabled?: boolean;
  readonly note?: string;
  readonly onName: (value: string) => void;
  readonly onDescription: (value: string) => void;
}) {
  return (
    <div className="flex flex-col gap-4">
      <Field label="Name*" htmlFor={`${prefix}-name`}>
        <Input
          id={`${prefix}-name`}
          value={name}
          disabled={disabled}
          placeholder="What your team will call them. Names are not unique."
          aria-required="true"
          autoComplete="off"
          spellCheck={false}
          onChange={(event) => onName(event.target.value)}
        />
      </Field>
      <Field label="Description [optional]" htmlFor={`${prefix}-description`}>
        <Input
          id={`${prefix}-description`}
          value={description}
          disabled={disabled}
          placeholder="One line for the people who select this persona"
          autoComplete="off"
          spellCheck={false}
          onChange={(event) => onDescription(event.target.value)}
        />
      </Field>
      {note === undefined ? null : <Note>{note}</Note>}
    </div>
  );
}

/**
 * Who this persona is — the whole of the versioned half except the models.
 *
 * The identity name is the one field on this surface that is new, and it is the
 * reason the effort exists: it is the name the persona gives the agent, so the
 * same test hears the same person on every run instead of whatever the model
 * invented that morning.
 */
export function BehaviorFields({
  prefix,
  draft,
  disabled = false,
  onChange,
}: {
  readonly prefix: FieldPrefix;
  readonly draft: BehaviorDraft;
  readonly disabled?: boolean;
  readonly onChange: (draft: BehaviorDraft) => void;
}) {
  return (
    <SheetSection label="Who they are">
      <div className="flex flex-col gap-4">
        <Field
          label="Identity name*"
          htmlFor={`${prefix}-identity-name`}
          hint="A human name, such as Priya. Spoken in every simulation."
        >
          <Input
            id={`${prefix}-identity-name`}
            value={draft.identityName}
            disabled={disabled}
            placeholder="The name they give the agent"
            aria-required="true"
            autoComplete="off"
            spellCheck={false}
            onChange={(event) =>
              onChange({ ...draft, identityName: event.target.value })
            }
          />
        </Field>

        <Field
          label="Personality*"
          htmlFor={`${prefix}-personality`}
          hint="Who they are. What they want belongs to the test."
        >
          <Textarea
            id={`${prefix}-personality`}
            value={draft.personality}
            disabled={disabled}
            rows={3}
            placeholder="Who they are: age, temperament, how they speak, what they know."
            aria-required="true"
            onChange={(event) =>
              onChange({ ...draft, personality: event.target.value })
            }
          />
        </Field>

        <Field
          label="Language*"
          htmlFor={`${prefix}-language`}
          hint="A BCP 47 tag, such as en-US."
        >
          <Input
            id={`${prefix}-language`}
            value={draft.language}
            disabled={disabled}
            aria-required="true"
            autoComplete="off"
            spellCheck={false}
            onChange={(event) =>
              onChange({ ...draft, language: event.target.value })
            }
          />
        </Field>
      </div>
    </SheetSection>
  );
}

/**
 * The complete model selection owned by a persona version.
 *
 * **One control per engine, and the control is the pair.** The server's catalog
 * is a list of provider-and-model pairs its adapters can actually execute, so
 * choosing from those pairs cannot produce a combination that does not exist.
 * The provider and the model used to be two selects that had to be kept in step
 * by hand; the boards draw one, and one is also the honest count of decisions
 * being made.
 *
 * Credentials do not appear here at all. The voice belongs to the text-to-speech
 * provider that speaks it, so changing that engine takes the new engine's
 * recommended voice with it — keeping the old one would leave a persona
 * pointing at a voice its new provider has never heard of.
 */
function EngineField({
  prefix,
  job,
  label,
  selection,
  form,
  disabled,
  onSelect,
}: {
  readonly prefix: FieldPrefix;
  readonly job: PersonaModelCatalogEntry["job"];
  readonly label: string;
  readonly selection: { readonly provider: string; readonly model: string };
  readonly form: PersonaForm;
  readonly disabled: boolean;
  readonly onSelect: (entry: PersonaModelCatalogEntry) => void;
}) {
  const offered = form.modelCatalog.filter((entry) => entry.job === job);
  const chosen = modelPairKey(selection);
  /*
   * A persona can name a pair this deployment has stopped offering. Showing an
   * empty select would be a form quietly proposing to rewrite a choice nobody
   * made, so the stored pair is offered too, said in the same words the read
   * view says it in.
   */
  const stored = offered.some((entry) => modelPairKey(entry) === chosen);

  return (
    <Field label={`${label}*`} htmlFor={`${prefix}-${job}`}>
      <Select
        id={`${prefix}-${job}`}
        value={chosen}
        disabled={disabled}
        aria-required="true"
        onChange={(event) => {
          const entry = modelPairFrom(
            form.modelCatalog,
            job,
            event.target.value,
          );
          if (entry !== undefined) onSelect(entry);
        }}
      >
        {stored ? null : (
          <option value={chosen}>
            {modelSaid(form.modelCatalog, job, selection)}
          </option>
        )}
        {offered.map((entry) => (
          <option key={modelPairKey(entry)} value={modelPairKey(entry)}>
            {modelSaid(form.modelCatalog, job, entry)}
          </option>
        ))}
      </Select>
    </Field>
  );
}

export function ModelFields({
  prefix,
  draft,
  form,
  disabled = false,
  onChange,
}: {
  readonly prefix: FieldPrefix;
  readonly draft: ModelsDraft;
  readonly form: PersonaForm;
  readonly disabled?: boolean;
  readonly onChange: (draft: ModelsDraft) => void;
}) {
  return (
    <SheetSection label="Models">
      <div className="flex flex-col gap-4">
        <FormRow>
          <EngineField
            prefix={prefix}
            job="llm"
            label="Language model"
            selection={{ provider: draft.llmProvider, model: draft.llmModel }}
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
          <EngineField
            prefix={prefix}
            job="stt"
            label="Speech-to-text"
            selection={{ provider: draft.sttProvider, model: draft.sttModel }}
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
        </FormRow>

        <FormRow>
          <EngineField
            prefix={prefix}
            job="tts"
            label="Text-to-speech"
            selection={{ provider: draft.ttsProvider, model: draft.ttsModel }}
            form={form}
            disabled={disabled}
            onSelect={(entry) =>
              onChange({
                ...draft,
                ttsProvider: entry.provider,
                ttsModel: entry.model,
                voiceId: entry.recommendedVoiceId ?? "",
              })
            }
          />
          {/*
           * The rate carries no `min`, `max` or `step`, and that is deliberate.
           * The accepted range is the server's rule, and a bound written here
           * as well would either refuse a rate egma would have taken or take
           * one egma will refuse. The one authoritative refusal is the
           * server's, and the instruction that used to explain the range here
           * was deleted on the developer's note against this very field.
           */}
          <NumberField
            id={`${prefix}-tts-speed`}
            label="Speech rate*"
            value={draft.speed}
            disabled={disabled}
            required
            onChange={(speed) => onChange({ ...draft, speed })}
          />
        </FormRow>

        <Field
          label="Voice*"
          htmlFor={`${prefix}-tts-voice`}
          hint="The voice id at the text-to-speech provider."
        >
          <Input
            id={`${prefix}-tts-voice`}
            className="font-mono"
            value={draft.voiceId}
            disabled={disabled}
            aria-required="true"
            autoComplete="off"
            spellCheck={false}
            onChange={(event) =>
              onChange({ ...draft, voiceId: event.target.value })
            }
          />
        </Field>
      </div>
    </SheetSection>
  );
}
