"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  getPersonaCapabilities,
  type GetPersonaCapabilitiesResponse,
} from "@egma/platform-api/client";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import {
  BACKGROUND_SOUNDS,
  type BehaviorDraft,
  type ModelsDraft,
  type PersonaForm,
} from "@/lib/personas.ts";
import { platformAnswer, platformClient } from "@/lib/platform-client.ts";
import { Field, FormRow } from "@/ui/form.tsx";
import { SearchableSelect } from "@/ui/searchable-select.tsx";

import { PersonaGroupLabel, PersonaSection } from "./sheet-parts.tsx";

export type FieldPrefix = "new-persona" | "clone-persona";

function Note({ children, bad = false }: { readonly children: ReactNode; readonly bad?: boolean }) {
  return (
    <p className={bad ? "m-0 text-sm text-failure" : "m-0 text-sm text-faint"}>
      {children}
    </p>
  );
}

function languageLabel(value: string): string {
  try {
    const locale = new Intl.Locale(value);
    const languages = new Intl.DisplayNames(["en"], { type: "language" });
    const regions = new Intl.DisplayNames(["en"], { type: "region" });
    const language = languages.of(locale.language) ?? locale.language;
    return locale.region === undefined
      ? language
      : `${language} (${regions.of(locale.region) ?? locale.region})`;
  } catch {
    return value;
  }
}

export function NameFields({
  prefix,
  name,
  description,
  disabled = false,
  onName,
  onDescription,
}: {
  readonly prefix: FieldPrefix;
  readonly name: string;
  readonly description: string;
  readonly disabled?: boolean;
  readonly onName: (value: string) => void;
  readonly onDescription: (value: string) => void;
}) {
  return (
    <FormRow>
      <Field label="Name*" htmlFor={`${prefix}-name`}>
        <Input
          id={`${prefix}-name`}
          value={name}
          disabled={disabled}
          placeholder="What your team will call them"
          aria-required="true"
          autoComplete="off"
          onChange={(event) => onName(event.target.value)}
        />
      </Field>
      <Field label="Description [optional]" htmlFor={`${prefix}-description`}>
        <Input
          id={`${prefix}-description`}
          value={description}
          disabled={disabled}
          placeholder="One line for people who select them"
          autoComplete="off"
          onChange={(event) => onDescription(event.target.value)}
        />
      </Field>
    </FormRow>
  );
}

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
    <>
      <PersonaGroupLabel>Who they are</PersonaGroupLabel>
      <div className="flex flex-col gap-4">
        <Field
          label="Identity name*"
          htmlFor={`${prefix}-identity-name`}
          hint="The human name they give the agent in every simulation."
        >
          <Input
            id={`${prefix}-identity-name`}
            value={draft.identityName}
            disabled={disabled}
            placeholder="For example, Priya"
            aria-required="true"
            autoComplete="off"
            onChange={(event) =>
              onChange({ ...draft, identityName: event.target.value })
            }
          />
        </Field>
        <Field
          label="Personality*"
          htmlFor={`${prefix}-personality`}
          hint="Describe who they are and how they speak. Put their situation and goal in the test scenario."
        >
          <Textarea
            id={`${prefix}-personality`}
            value={draft.personality}
            disabled={disabled}
            rows={5}
            placeholder="Age, temperament, speech style, and what they know"
            aria-required="true"
            onChange={(event) =>
              onChange({ ...draft, personality: event.target.value })
            }
          />
        </Field>
      </div>
    </>
  );
}

function ProviderModelFields({
  prefix,
  job,
  title,
  provider,
  model,
  form,
  disabled,
  modelPlaceholder,
  onChange,
}: {
  readonly prefix: FieldPrefix;
  readonly job: "llm" | "stt" | "tts";
  readonly title: string;
  readonly provider: string;
  readonly model: string;
  readonly form: PersonaForm;
  readonly disabled: boolean;
  readonly modelPlaceholder?: string;
  readonly onChange: (provider: string, model: string) => void;
}) {
  const offered = form.modelCatalog.filter((entry) => entry.job === job);
  const providers = [...new Map(offered.map((entry) => [entry.provider, entry.label])).entries()];
  const models = offered.filter((entry) => entry.provider === provider);
  const chosenModel = models.some((entry) => entry.model === model);
  return (
    <FormRow>
      <Field label={`${title} provider*`} htmlFor={`${prefix}-${job}-provider`}>
        <Select
          id={`${prefix}-${job}-provider`}
          value={provider}
          disabled={disabled}
          aria-required="true"
          onChange={(event) => {
            const next = offered.find((entry) => entry.provider === event.target.value);
            if (next !== undefined) onChange(next.provider, next.model);
          }}
        >
          {providers.some(([id]) => id === provider) ? null : (
            <option value={provider}>{provider} · Unavailable</option>
          )}
          {providers.map(([id, label]) => <option key={id} value={id}>{label}</option>)}
        </Select>
      </Field>
      <Field label={`${title} model*`} htmlFor={`${prefix}-${job}-model`}>
        <Select
          id={`${prefix}-${job}-model`}
          value={model}
          disabled={disabled}
          aria-required="true"
          onChange={(event) => onChange(provider, event.target.value)}
        >
          {modelPlaceholder === undefined ? null : (
            <option value="" disabled>{modelPlaceholder}</option>
          )}
          {chosenModel ? null : <option value={model}>{model} · Unavailable</option>}
          {models.map((entry) => (
            <option key={entry.model} value={entry.model}>
              {entry.modelLabel ?? entry.model}
            </option>
          ))}
        </Select>
      </Field>
    </FormRow>
  );
}

function changeSelection(
  draft: ModelsDraft,
  job: "llm" | "stt" | "tts",
  provider: string,
  model: string,
): ModelsDraft {
  if (job === "llm") return { ...draft, llmProvider: provider, llmModel: model };
  if (job === "stt") return { ...draft, sttProvider: provider, sttModel: model };
  return { ...draft, ttsProvider: provider, ttsModel: model };
}

function capabilityMessage(
  label: string,
  state: { readonly status: string; readonly reason?: string },
): ReactNode {
  if (state.status === "supported") return null;
  return <Note bad={state.status === "unsupported"}>{label}: {state.reason ?? state.status}</Note>;
}

export function ModelFields({
  prefix,
  draft,
  form,
  disabled = false,
  projectId,
  onChange,
  onValidityChange,
}: {
  readonly prefix: FieldPrefix;
  readonly draft: ModelsDraft;
  readonly form: PersonaForm;
  readonly disabled?: boolean;
  readonly projectId: string;
  readonly onChange: (draft: ModelsDraft) => void;
  readonly onValidityChange?: (valid: boolean) => void;
}) {
  const [capabilities, setCapabilities] = useState<GetPersonaCapabilitiesResponse | null>(null);
  const [capabilityError, setCapabilityError] = useState<string | null>(null);
  const [languageSearch, setLanguageSearch] = useState("");
  const [voiceSearch, setVoiceSearch] = useState("");
  const [voiceType, setVoiceType] = useState<"all" | "male" | "female" | "unknown">("all");
  const request = useRef(0);
  const reportValidity = useRef(onValidityChange);
  reportValidity.current = onValidityChange;

  useEffect(() => {
    const turn = request.current + 1;
    request.current = turn;
    setCapabilities(null);
    setCapabilityError(null);
    reportValidity.current?.(false);
    void platformAnswer(
      getPersonaCapabilities(
        draft.mode === "live"
          ? {
              projectId,
              mode: "live",
              liveProvider: "openai",
              liveModel: "gpt-live-1",
              language: draft.language,
              voiceId: draft.liveVoiceId,
            }
          : {
              projectId,
              mode: "separate",
              ttsProvider: draft.ttsProvider,
              ttsModel: draft.ttsModel,
              sttProvider: draft.sttProvider,
              sttModel: draft.sttModel,
              language: draft.language,
              voiceId: draft.separateVoiceId,
            },
        { client: platformClient },
      ),
    ).then((answer) => {
      if (request.current !== turn) return;
      if (answer.status === "ready") setCapabilities(answer.value);
      else if (answer.status === "signed-out") window.location.replace("/sign-in");
      else setCapabilityError(answer.refusal.message);
    });
  }, [
    projectId,
    draft.mode,
    draft.ttsProvider,
    draft.ttsModel,
    draft.sttProvider,
    draft.sttModel,
    draft.language,
    draft.separateVoiceId,
    draft.liveVoiceId,
  ]);

  const activeVoiceId = draft.mode === "live" ? draft.liveVoiceId : draft.separateVoiceId;
  const allVoices = capabilities?.voices.choices ?? [];
  const voiceAvailable =
    capabilities?.voices.status === "fixed"
      ? capabilities.voices.value?.id === activeVoiceId
      : allVoices.some((voice) => voice.id === activeVoiceId);
  const languageChoices = capabilities?.language.choices ?? [];
  const selectedLanguageBase = draft.language.toLocaleLowerCase().split("-")[0];
  const languageAvailable =
    capabilities?.language.status === "fixed"
      ? capabilities.language.value === draft.language
      : languageChoices.some((value) =>
          value === draft.language ||
          (selectedLanguageBase !== undefined && value.toLocaleLowerCase() === selectedLanguageBase),
        );
  const valid = capabilities !== null && languageAvailable && voiceAvailable;

  useEffect(() => reportValidity.current?.(valid), [valid]);

  const languages = useMemo(() => {
    const query = languageSearch.trim().toLocaleLowerCase();
    return languageChoices
      .map((value) => ({ value, label: languageLabel(value), detail: value }))
      .filter((option) => `${option.label} ${option.value}`.toLocaleLowerCase().includes(query));
  }, [languageChoices, languageSearch]);

  const voices = useMemo(() => {
    const query = voiceSearch.trim().toLocaleLowerCase();
    return allVoices
      .filter((voice) => {
        const presentation = voice.presentation === "neutral" ? "unknown" : voice.presentation;
        return (voiceType === "all" || presentation === voiceType) &&
          `${voice.name} ${voice.id}`.toLocaleLowerCase().includes(query);
      })
      .map((voice) => ({
        value: voice.id,
        label: voice.name,
        detail: voice.presentation === "male" ? "Male" : voice.presentation === "female" ? "Female" : "Unknown",
      }));
  }, [allVoices, voiceSearch, voiceType]);

  function change(next: ModelsDraft): void {
    onChange(next);
  }

  const languageDisplay = capabilities === null || languageAvailable
    ? languageLabel(draft.language)
    : `${languageLabel(draft.language)} · Unavailable`;
  const selectedVoice = allVoices.find((voice) => voice.id === activeVoiceId) ?? capabilities?.voices.value;
  const voiceDisplay = capabilities === null || voiceAvailable
    ? selectedVoice?.name ?? activeVoiceId
    : `${activeVoiceId} · Unavailable`;

  return (
    <>
      <PersonaGroupLabel>Settings</PersonaGroupLabel>
      {capabilityError === null ? null : <Note bad>{capabilityError}</Note>}
      <PersonaSection label="Language">
        <Field
          label="Language*"
          htmlFor={`${prefix}-language`}
          hint={!languageAvailable && capabilities !== null ? "Choose an available language before creating this persona." : undefined}
        >
          <SearchableSelect
            id={`${prefix}-language`}
            value={draft.language}
            displayValue={languageDisplay}
            options={languages}
            search={languageSearch}
            searchLabel="Choose a language"
            searchPlaceholder="Search languages"
            disabled={disabled || capabilities?.language.status === "fixed"}
            required
            invalid={capabilities !== null && !languageAvailable}
            loading={capabilities === null && capabilityError === null}
            error={capabilityError}
            empty="No languages found"
            emptyDetail="Try another search."
            onSearchChange={setLanguageSearch}
            onValueChange={(language) => change({ ...draft, language })}
          />
        </Field>
        {capabilities === null ? null : capabilityMessage("Language", capabilities.language)}
      </PersonaSection>

      {draft.mode === "separate" ? (
        <>
          <PersonaSection label="Text to speech">
            <div className="flex flex-col gap-4">
              <ProviderModelFields
                prefix={prefix}
                job="tts"
                title="Voice"
                provider={draft.ttsProvider}
                model={draft.ttsModel}
                form={form}
                disabled={disabled}
                onChange={(provider, model) => change(changeSelection(draft, "tts", provider, model))}
              />
              <VoiceField
                prefix={prefix}
                disabled={disabled}
                value={activeVoiceId}
                displayValue={voiceDisplay}
                valid={voiceAvailable}
                loading={capabilities === null && capabilityError === null}
                error={capabilityError}
                options={voices}
                search={voiceSearch}
                type={voiceType}
                onSearch={setVoiceSearch}
                onType={setVoiceType}
                onClear={() => { setVoiceSearch(""); setVoiceType("all"); }}
                onChange={(separateVoiceId) => change({ ...draft, separateVoiceId })}
              />
              {capabilities === null ? null : capabilityMessage("Voice", capabilities.voices)}
            </div>
          </PersonaSection>
          <PersonaSection label="Speech to text">
            <ProviderModelFields
              prefix={prefix}
              job="stt"
              title="Transcription"
              provider={draft.sttProvider}
              model={draft.sttModel}
              form={form}
              disabled={disabled}
              onChange={(provider, model) => change(changeSelection(draft, "stt", provider, model))}
            />
          </PersonaSection>
          <PersonaSection label="Reasoning">
            <ProviderModelFields
              prefix={prefix}
              job="llm"
              title="Reasoning"
              provider={draft.llmProvider}
              model={draft.llmModel}
              form={form}
              disabled={disabled}
              modelPlaceholder="GPT 5.6 Terra"
              onChange={(provider, model) => change(changeSelection(draft, "llm", provider, model))}
            />
          </PersonaSection>
        </>
      ) : (
        <PersonaSection label="Realtime voice">
          <div className="flex flex-col gap-4">
            <VoiceField
              prefix={prefix}
              disabled={disabled}
              value={activeVoiceId}
              displayValue={voiceDisplay}
              valid={voiceAvailable}
              loading={capabilities === null && capabilityError === null}
              error={capabilityError}
              options={voices}
              search={voiceSearch}
              type={voiceType}
              onSearch={setVoiceSearch}
              onType={setVoiceType}
              onClear={() => { setVoiceSearch(""); setVoiceType("all"); }}
              onChange={(liveVoiceId) => change({ ...draft, liveVoiceId })}
            />
            <ProviderModelFields
              prefix={prefix}
              job="llm"
              title="Reasoning"
              provider={draft.llmProvider}
              model={draft.llmModel}
              form={form}
              disabled={disabled}
              modelPlaceholder="GPT 5.6 Terra"
              onChange={(provider, model) => change(changeSelection(draft, "llm", provider, model))}
            />
          </div>
        </PersonaSection>
      )}

      <PersonaSection label="Advanced" open={false}>
        <div className="flex flex-col gap-4">
          <Field label="Background sound*" htmlFor={`${prefix}-background-sound`}>
            <Select
              id={`${prefix}-background-sound`}
              value={draft.backgroundSoundId}
              disabled={disabled}
              aria-required="true"
              onChange={(event) => change({
                ...draft,
                backgroundSoundId: event.target.value as ModelsDraft["backgroundSoundId"],
              })}
            >
              {BACKGROUND_SOUNDS.map((sound) => <option key={sound.id} value={sound.id}>{sound.label}</option>)}
            </Select>
          </Field>
          {draft.mode === "separate" ? (
            <Field label="Interruptions*" htmlFor={`${prefix}-interruptions`}>
              <Select
                id={`${prefix}-interruptions`}
                value={draft.interruptionLevel}
                disabled={disabled}
                aria-required="true"
                onChange={(event) => change({
                  ...draft,
                  interruptionLevel: event.target.value as ModelsDraft["interruptionLevel"],
                })}
              >
                <option value="none">None</option>
                <option value="occasional">Occasional</option>
                <option value="frequent">Frequent</option>
              </Select>
            </Field>
          ) : null}
        </div>
      </PersonaSection>
    </>
  );
}

function VoiceField({
  prefix,
  disabled,
  value,
  displayValue,
  valid,
  loading,
  error,
  options,
  search,
  type,
  onSearch,
  onType,
  onClear,
  onChange,
}: {
  readonly prefix: FieldPrefix;
  readonly disabled: boolean;
  readonly value: string;
  readonly displayValue: string;
  readonly valid: boolean;
  readonly loading: boolean;
  readonly error: string | null;
  readonly options: readonly { readonly value: string; readonly label: string; readonly detail: string }[];
  readonly search: string;
  readonly type: "all" | "male" | "female" | "unknown";
  readonly onSearch: (value: string) => void;
  readonly onType: (value: "all" | "male" | "female" | "unknown") => void;
  readonly onClear: () => void;
  readonly onChange: (value: string) => void;
}) {
  return (
    <Field
      label="Voice*"
      htmlFor={`${prefix}-voice`}
      hint={!valid && !loading ? "Choose an available voice before creating this persona." : undefined}
    >
      <SearchableSelect
        id={`${prefix}-voice`}
        value={value}
        displayValue={displayValue}
        options={options}
        search={search}
        searchLabel="Choose a voice"
        searchPlaceholder="Search voices"
        disabled={disabled}
        required
        invalid={!valid && !loading}
        loading={loading}
        error={error}
        toolbar={
          <div className="grid w-full grid-cols-4 border-b border-border bg-surface-soft p-1" role="group" aria-label="Filter voice type">
            {(["all", "male", "female", "unknown"] as const).map((one) => (
              <button
                key={one}
                type="button"
                className="relative min-h-(--control-sm) w-full border border-transparent bg-transparent px-3 text-sm text-muted-foreground data-[selected=true]:bg-surface data-[selected=true]:font-medium data-[selected=true]:text-foreground data-[selected=true]:before:absolute data-[selected=true]:before:inset-x-0 data-[selected=true]:before:-top-px data-[selected=true]:before:h-0.5 data-[selected=true]:before:bg-brand pointer-coarse:min-h-(--tap-target)"
                data-selected={type === one ? "true" : undefined}
                aria-pressed={type === one}
                onClick={() => onType(one)}
              >
                {one[0]!.toUpperCase() + one.slice(1)}
              </button>
            ))}
          </div>
        }
        empty="No voices found"
        emptyDetail="Try another search or clear the filters."
        emptyAction={<Button type="button" size="sm" variant="secondary" onClick={onClear}>Clear search and filters</Button>}
        onSearchChange={onSearch}
        onValueChange={onChange}
      />
    </Field>
  );
}
