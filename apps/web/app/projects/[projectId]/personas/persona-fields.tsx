"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { getPersonaCapabilities, type GetPersonaCapabilitiesResponse } from "@egma/platform-api/client";

import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import {
  modelPairFrom,
  modelPairKey,
  modelSaid,
  BACKGROUND_SOUNDS,
  decibelsToGain,
  type BehaviorDraft,
  type ModelsDraft,
  type PersonaForm,
  type PersonaModelCatalogEntry,
} from "../../../../lib/personas.ts";
import { platformAnswer, platformClient } from "../../../../lib/platform-client.ts";
import { Button } from "@/components/ui/button";
import { Field } from "../../../../ui/form.tsx";
import { NumberField } from "../../../../ui/number-field.tsx";
import { SheetSection } from "./sheet-parts.tsx";

/**
 * Share persona fields between create and edit sheets. Prefix control IDs
 * because both sheets can overlap during transitions. Required labels must
 * also carry aria-required; optional labels use the product's optional marker.
 */

/** Which sheet these fields are in, and so which ids they answer to. */
export type FieldPrefix = "persona" | "new-persona";

/** One explanatory line, quieter than the fields it is about. */
function Note({ children }: { readonly children: ReactNode }) {
  return (
    <p className="m-0 text-sm leading-(--line-normal) text-faint">{children}</p>
  );
}

function languageLabel(value: string): string {
  try {
    const locale = new Intl.Locale(value);
    const languages = new Intl.DisplayNames(["en"], { type: "language" });
    const regions = new Intl.DisplayNames(["en"], { type: "region" });
    const language = languages.of(locale.language) ?? locale.language;
    return locale.region === undefined ? language : `${language} (${regions.of(locale.region) ?? locale.region})`;
  } catch {
    return value;
  }
}

function accentLabel(value: string): string {
  return value === "voice_default"
    ? "Voice default"
    : value.replaceAll("_", " ").replace(/^./u, (letter) => letter.toUpperCase());
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
      </div>
    </SheetSection>
  );
}

/**
 * Edit model settings for the persona in this project. Each engine control
 * selects a catalog provider/model pair. Changing the speech engine also
 * selects a catalog provider/model pair. Draft voice choices are never reset.
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
  projectId,
  onValidityChange,
}: {
  readonly prefix: FieldPrefix;
  readonly draft: ModelsDraft;
  readonly form: PersonaForm;
  readonly disabled?: boolean;
  readonly onChange: (draft: ModelsDraft) => void;
  readonly projectId: string;
  readonly onValidityChange?: (valid: boolean) => void;
}) {
  const [capabilities, setCapabilities] = useState<GetPersonaCapabilitiesResponse | null>(null);
  const [capabilityError, setCapabilityError] = useState<string | null>(null);
  const [voiceSearch, setVoiceSearch] = useState("");
  const [voiceType, setVoiceType] = useState("all");
  const request = useRef(0);

  function change(next: ModelsDraft): void {
    if (next.ttsProvider !== draft.ttsProvider || next.ttsModel !== draft.ttsModel || next.sttProvider !== draft.sttProvider || next.sttModel !== draft.sttModel || next.language !== draft.language || next.voiceId !== draft.voiceId) {
      setCapabilities(null);
    }
    onChange(next);
  }


  useEffect(() => {
    const turn = request.current + 1;
    request.current = turn;
    setCapabilities(null);
    setCapabilityError(null);
    void platformAnswer(getPersonaCapabilities(draft.mode === "live" ? {
      projectId, mode: "live", liveProvider: "openai", liveModel: "gpt-live-1",
      language: draft.language, voiceId: draft.liveVoiceId,
    } : {
      projectId, mode: "separate",
      ttsProvider: draft.ttsProvider, ttsModel: draft.ttsModel,
      sttProvider: draft.sttProvider, sttModel: draft.sttModel,
      language: draft.language, voiceId: draft.separateVoiceId,
    }, { client: platformClient })).then((answer) => {
      if (request.current !== turn) return;
      if (answer.status === "ready") setCapabilities(answer.value);
      else if (answer.status !== "signed-out") setCapabilityError(answer.refusal.message);
    });
    return undefined;
  }, [projectId, draft.mode, draft.ttsProvider, draft.ttsModel, draft.sttProvider, draft.sttModel, draft.language, draft.separateVoiceId, draft.liveVoiceId]);

  const activeVoiceId = draft.mode === "live" ? draft.liveVoiceId : draft.separateVoiceId;

  const voices = useMemo(() => {
    const all = capabilities?.voices.choices ?? [];
    const query = voiceSearch.trim().toLowerCase();
    return all.filter((voice) => {
      const presentation = voice.presentation;
      const matchesType = voiceType === "all" || presentation === voiceType || presentation === "unknown";
      return matchesType && (query === "" || `${voice.name} ${voice.id}`.toLowerCase().includes(query));
    });
  }, [capabilities, voiceSearch, voiceType]);
  function accepts(state: { status: string; choices?: readonly (string | number)[]; value?: string | number; range?: { minimum: number; maximum: number } }, value: string | number, unsupportedValue: string | number): boolean {
    if (state.status === "unknown") return false;
    if (state.status === "fixed") return value === state.value;
    if (state.status === "unsupported") return value === unsupportedValue;
    if (state.choices !== undefined) return state.choices.includes(value);
    if (state.range !== undefined) return typeof value === "number" && value >= state.range.minimum && value <= state.range.maximum;
    return true;
  }
  function acceptsLanguage(state: GetPersonaCapabilitiesResponse["language"], value: string): boolean {
    if (accepts(state, value, "en-US")) return true;
    if (state.status !== "supported" || state.choices === undefined) return false;
    const base = value.toLowerCase().split("-")[0];
    return state.choices.some((choice) => choice.toLowerCase().split("-")[0] === base);
  }
  const catalogHasVoice = capabilities?.voices.status === "supported"
    && (capabilities.voices.choices ?? []).some((voice) => voice.id === activeVoiceId);
  const valid = capabilities !== null
    && acceptsLanguage(capabilities.language, draft.language)
    && accepts(capabilities.accent, draft.accent, "voice_default")
    && accepts(capabilities.emotion, draft.emotion, "neutral")
    && accepts(capabilities.speechSpeed, draft.speechSpeed, "normal")
    && accepts(capabilities.speechVolume, Number(draft.speechVolume), 1)
    && Number.isFinite(Number(draft.backgroundVolumeDb))
    && Number(draft.backgroundVolumeDb) >= -36
    && Number(draft.backgroundVolumeDb) <= -12
    && (capabilities.voices.status === "supported"
      ? catalogHasVoice
      : capabilities.voices.status === "fixed" && capabilities.voices.value?.id === activeVoiceId);
  useEffect(() => {
    if (capabilities !== null || capabilityError !== null) onValidityChange?.(valid);
  }, [valid, capabilities, capabilityError, onValidityChange]);

  const stateNote = (label: string, state: { status: string; reason?: string }) => state.status === "supported" ? null : <Note>{label}: {state.status}. {state.reason ?? "The provider did not explain this capability."}</Note>;
  return (
    <SheetSection label="Settings">
      <div className="flex flex-col gap-4">
        <Field label="Speech mode*" htmlFor={`${prefix}-speech-mode`} hint="Separate uses speech recognition and generation services. GPT Live combines both.">
          <Select id={`${prefix}-speech-mode`} value={draft.mode} aria-required="true" disabled={disabled} onChange={(event) => change({ ...draft, mode: event.target.value as ModelsDraft["mode"], voiceId: event.target.value === "live" ? draft.liveVoiceId : draft.separateVoiceId })}>
            <option value="separate">Separate speech models</option>
            <option value="live">GPT Live</option>
          </Select>
        </Field>
        {draft.mode === "live" ? <EngineField prefix={prefix} job="live" label="Live speech model" selection={{ provider: "openai", model: "gpt-live-1" }} form={form} disabled={true} onSelect={() => undefined} /> : <><EngineField
          prefix={prefix}
          job="stt"
          label="Speech-to-text"
          selection={{ provider: draft.sttProvider, model: draft.sttModel }}
          form={form}
          disabled={disabled}
          onSelect={(entry) =>
            change({
              ...draft,
              sttProvider: entry.provider,
              sttModel: entry.model,
            })
          }
        />

        <EngineField
          prefix={prefix}
          job="tts"
          label="Text-to-speech"
          selection={{ provider: draft.ttsProvider, model: draft.ttsModel }}
          form={form}
          disabled={disabled}
          onSelect={(entry) =>
            change({
              ...draft,
              ttsProvider: entry.provider,
              ttsModel: entry.model,
            })
          }
        /></>}
        <EngineField prefix={prefix} job="llm" label="Language model" selection={{ provider: draft.llmProvider, model: draft.llmModel }} form={form} disabled={disabled} onSelect={(entry) => change({ ...draft, llmProvider: entry.provider, llmModel: entry.model })} />
        {capabilityError === null ? null : <p role="alert" className="m-0 text-sm text-failure">{capabilityError}</p>}
        <Field label="Language*" htmlFor={`${prefix}-language`}>
          <Select id={`${prefix}-language`} value={draft.language} aria-required="true" disabled={disabled || capabilities?.language.status === "fixed"} onChange={(event) => change({ ...draft, language: event.target.value })}>
            {capabilities?.language.choices?.includes(draft.language) === false ? <option value={draft.language}>{languageLabel(draft.language)} · Saved locale</option> : null}
            {(capabilities?.language.choices ?? [draft.language]).map((value) => <option key={value} value={value}>{languageLabel(value)}</option>)}
          </Select>
        </Field>
        {capabilities === null ? <Note>Loading voice capabilities…</Note> : stateNote("Language", capabilities.language)}
        <Field label="Find a voice" htmlFor={`${prefix}-voice-search`}><Input id={`${prefix}-voice-search`} value={voiceSearch} disabled={disabled} placeholder="Search the full voice catalog" onChange={(event) => setVoiceSearch(event.target.value)} /></Field>
        <Field label="Voice type" htmlFor={`${prefix}-voice-type`}><Select id={`${prefix}-voice-type`} value={voiceType} disabled={disabled} onChange={(event) => setVoiceType(event.target.value)}><option value="all">All</option><option value="male">Male</option><option value="female">Female</option></Select></Field>
        <Field label="Voice*" htmlFor={`${prefix}-tts-voice`}><Select id={`${prefix}-tts-voice`} value={activeVoiceId} aria-required="true" disabled={disabled || capabilities?.voices.status !== "supported"} onChange={(event) => change({ ...draft, voiceId: event.target.value, ...(draft.mode === "live" ? { liveVoiceId: event.target.value } : { separateVoiceId: event.target.value }) })}>{voices.some((voice) => voice.id === activeVoiceId) ? null : <option value={activeVoiceId}>{activeVoiceId}</option>}{voices.map((voice) => <option key={voice.id} value={voice.id}>{voice.name} · {voice.presentation === "unknown" ? "Type unknown" : voice.presentation}</option>)}</Select></Field>
        {capabilities === null ? null : stateNote("Voice", capabilities.voices)}
        <Field label="Accent*" htmlFor={`${prefix}-accent`}>
          <Select id={`${prefix}-accent`} value={draft.accent} aria-required="true" disabled={disabled || capabilities?.accent.status !== "supported"} onChange={(event) => change({ ...draft, accent: event.target.value })}>
            {(capabilities?.accent.choices ?? [draft.accent]).map((value) => <option key={value} value={value}>{accentLabel(value)}</option>)}
          </Select>
        </Field>
        {capabilities === null ? null : stateNote("Accent", capabilities.accent)}
        {capabilities?.accent.status === "fixed" && draft.accent !== capabilities.accent.value && capabilities.accent.value === "voice_default" ? <Button type="button" variant="secondary" disabled={disabled} onClick={() => change({ ...draft, accent: "voice_default" })}>Use voice default</Button> : null}
        <Field label="Emotion*" htmlFor={`${prefix}-emotion`}>
          <Select id={`${prefix}-emotion`} value={draft.emotion} aria-required="true" disabled={disabled || capabilities?.emotion.status !== "supported"} onChange={(event) => change({ ...draft, emotion: event.target.value as ModelsDraft["emotion"] })}>
            {(capabilities?.emotion.choices ?? [draft.emotion]).map((value) => <option key={value} value={value}>{value[0]?.toUpperCase()}{value.slice(1)}</option>)}
          </Select>
        </Field>
        {capabilities === null ? null : stateNote("Emotion", capabilities.emotion)}
        {capabilities?.emotion.status === "fixed" && draft.emotion !== capabilities.emotion.value && capabilities.emotion.value === "neutral" ? <Button type="button" variant="secondary" disabled={disabled} onClick={() => change({ ...draft, emotion: "neutral" })}>Use Neutral</Button> : null}
        <Field label="Interruptions*" htmlFor={`${prefix}-interruption-level`} hint="An interruption finishes one brief sentence, then the caller listens again.">
          <Select id={`${prefix}-interruption-level`} value={draft.interruptionLevel} aria-required="true" disabled={disabled} onChange={(event) => change({ ...draft, interruptionLevel: event.target.value as ModelsDraft["interruptionLevel"] })}>
            <option value="none">None</option>
            <option value="occasional">Occasional</option>
            <option value="frequent">Frequent</option>
          </Select>
        </Field>
        <Field label="Speech rate*" htmlFor={`${prefix}-tts-speed`}>
          <Select id={`${prefix}-tts-speed`} value={draft.speechSpeed} aria-required="true" disabled={disabled} onChange={(event) => change({ ...draft, speechSpeed: event.target.value as ModelsDraft["speechSpeed"] })}>
            <option value="slow" disabled={capabilities?.speechSpeed.status === "fixed" || capabilities?.speechSpeed.choices?.includes("slow") === false}>Slow</option>
            <option value="normal">Normal</option>
            <option value="fast" disabled={capabilities?.speechSpeed.status === "fixed" || capabilities?.speechSpeed.choices?.includes("fast") === false}>Fast</option>
          </Select>
        </Field>
        {capabilities === null ? null : stateNote("Speech rate", capabilities.speechSpeed)}

        <NumberField id={`${prefix}-speech-volume`} label="Speech volume*" value={draft.speechVolume} disabled={disabled || capabilities?.speechVolume.status !== "supported"} required onChange={(speechVolume) => change({ ...draft, speechVolume })} />
        {capabilities === null ? null : stateNote("Speech volume", capabilities.speechVolume)}

        <Field label="Background sound*" htmlFor={`${prefix}-background-sound`}>
          <Select id={`${prefix}-background-sound`} value={draft.backgroundSoundId} aria-required="true" disabled={disabled} onChange={(event) => change({ ...draft, backgroundSoundId: event.target.value as ModelsDraft["backgroundSoundId"] })}>
            {BACKGROUND_SOUNDS.map((sound) => <option key={sound.id} value={sound.id}>{sound.label}</option>)}
          </Select>
        </Field>
        {draft.backgroundSoundId === "none" ? null : <NumberField id={`${prefix}-background-volume`} label="Background level*" value={draft.backgroundVolumeDb} disabled={disabled} required min={-36} max={-12} step={1} unit="dB" hint="Independent of speech volume." onChange={(backgroundVolumeDb) => change({ ...draft, backgroundVolumeDb, backgroundVolume: decibelsToGain(backgroundVolumeDb) })} />}

      </div>
    </SheetSection>
  );
}
