"use client";

import Link from "next/link";
import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import {
  getPersonaCapabilities,
  type GetPersonaCapabilitiesResponse,
} from "@egma/platform-api/client";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { DownwardSelect, type DownwardSelectOption } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import {
  BACKGROUND_SOUNDS,
  LIVE_MODEL,
  languageLabel,
  type BehaviorDraft,
  type CatalogJob,
  type ModelsDraft,
  type PersonaForm,
  type PersonaModelCatalogEntry,
} from "@/lib/personas.ts";
import { platformAnswer, platformClient } from "@/lib/platform-client.ts";
import { projectPath } from "@/lib/project-context.ts";
import { FieldHintContext } from "@/ui/field-hint.ts";
import { FormRow } from "@/ui/form.tsx";
import { SearchableSelect } from "@/ui/searchable-select.tsx";

import { PersonaField, PersonaGroupLabel, PersonaSubsection } from "./persona-parts.tsx";

/**
 * The persona create and clone form, read off Paper page 12 — boards 02
 * "Create persona · Cascaded", 03 "Create persona · Realtime" and the two
 * clone boards: three caps groups, plain subsections under Settings, white
 * text boxes and soft grey dropdowns, all 14px.
 */

export type FieldPrefix = "new-persona" | "clone-persona";

/** A text box on the boards: white fill, 44px, 14px ink and 14px placeholder. */
const TEXT_BOX = "text-sm placeholder:text-sm placeholder:text-faint";

/** A dropdown trigger on the boards: soft grey fill, 44px, 14px ink. */
const DROPDOWN = "bg-surface-soft text-sm";

/** The API's sentence when neither the organization nor the platform holds a key for the chosen provider. */
const MISSING_PROVIDER_KEY = /credential bundle has no \w+ key/u;

function Note({ children, bad = false }: { readonly children: ReactNode; readonly bad?: boolean }) {
  return (
    <p className={bad ? "m-0 text-sm text-failure" : "m-0 text-sm text-faint"}>
      {children}
    </p>
  );
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
    <>
      <PersonaGroupLabel>Metadata</PersonaGroupLabel>
      <FormRow>
        <PersonaField label="Name*" htmlFor={`${prefix}-name`}>
          <Input
            id={`${prefix}-name`}
            className={TEXT_BOX}
            value={name}
            disabled={disabled}
            placeholder="Ex Angry Spanish caller"
            aria-required="true"
            autoComplete="off"
            onChange={(event) => onName(event.target.value)}
          />
        </PersonaField>
        {/* Optional, and the boards print it with no suffix and no placeholder. */}
        <PersonaField label="Description" htmlFor={`${prefix}-description`}>
          <Input
            id={`${prefix}-description`}
            className={TEXT_BOX}
            value={description}
            disabled={disabled}
            autoComplete="off"
            onChange={(event) => onDescription(event.target.value)}
          />
        </PersonaField>
      </FormRow>
    </>
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
      <PersonaGroupLabel divider>Who they are</PersonaGroupLabel>
      <div className="flex flex-col gap-4">
        <PersonaField label="Identity name*" htmlFor={`${prefix}-identity-name`}>
          <Input
            id={`${prefix}-identity-name`}
            className={TEXT_BOX}
            value={draft.identityName}
            disabled={disabled}
            placeholder="John Doe"
            aria-required="true"
            autoComplete="off"
            onChange={(event) =>
              onChange({ ...draft, identityName: event.target.value })
            }
          />
        </PersonaField>
        <PersonaField label="Personality prompt*" htmlFor={`${prefix}-personality`}>
          <Textarea
            id={`${prefix}-personality`}
            className={TEXT_BOX}
            value={draft.personality}
            disabled={disabled}
            rows={3}
            placeholder="Ex Impatient, speaks quickly, and asks direct questions"
            aria-required="true"
            onChange={(event) =>
              onChange({ ...draft, personality: event.target.value })
            }
          />
        </PersonaField>
      </div>
    </>
  );
}

/** The Provider and Model pair a subsection carries, side by side. */
function ProviderModelFields({
  prefix,
  job,
  provider,
  model,
  catalog,
  disabled,
  onChange,
}: {
  readonly prefix: FieldPrefix;
  readonly job: CatalogJob;
  readonly provider: string;
  readonly model: string;
  /** The rows the pair may offer; a pair the API fixes is handed exactly one. */
  readonly catalog: readonly PersonaModelCatalogEntry[];
  readonly disabled: boolean;
  /** Absent when the API fixes the pair: the one row offered is the one shown. */
  readonly onChange?: (provider: string, model: string) => void;
}) {
  const offered = catalog.filter((entry) => entry.job === job);
  const providers = [...new Map(offered.map((entry) => [entry.provider, entry.label])).entries()];
  const models = offered.filter((entry) => entry.provider === provider);
  const chosenModel = models.some((entry) => entry.model === model);
  const providerOptions: DownwardSelectOption[] = [
    ...(providers.some(([id]) => id === provider) ? [] : [{ value: provider, label: `${provider} · Unavailable` }]),
    ...providers.map(([value, label]) => ({ value, label })),
  ];
  const modelOptions: DownwardSelectOption[] = [
    ...(chosenModel ? [] : [{ value: model, label: `${model} · Unavailable` }]),
    ...models.map((entry) => ({ value: entry.model, label: entry.modelLabel ?? entry.model })),
  ];
  return (
    <FormRow>
      <PersonaField label="Provider*" htmlFor={`${prefix}-${job}-provider`}>
        <DownwardSelect
          id={`${prefix}-${job}-provider`}
          className={DROPDOWN}
          value={provider}
          disabled={disabled}
          required
          options={providerOptions}
          onValueChange={(value) => {
            const next = offered.find((entry) => entry.provider === value);
            if (next !== undefined) onChange?.(next.provider, next.model);
          }}
        />
      </PersonaField>
      <PersonaField label="Model*" htmlFor={`${prefix}-${job}-model`}>
        <DownwardSelect
          key={provider}
          id={`${prefix}-${job}-model`}
          className={DROPDOWN}
          value={model}
          disabled={disabled}
          required
          options={modelOptions}
          onValueChange={(value) => onChange?.(provider, value)}
        />
      </PersonaField>
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

function capabilityInvalidReason(
  state: { readonly status: string; readonly reason?: string },
  available: boolean,
  chooseAvailable: string,
): string | undefined {
  if (available) return undefined;
  if (state.status === "supported" || state.status === "fixed") return chooseAvailable;
  return state.reason ?? "Support could not be verified";
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
  const [capabilityAttempt, setCapabilityAttempt] = useState(0);
  const [languageSearch, setLanguageSearch] = useState("");
  const [voiceSearch, setVoiceSearch] = useState("");
  const [voiceType, setVoiceType] = useState<"all" | "male" | "female" | "unknown">("all");
  /* The voice reason is drawn in the subsection header and read from the voice picker. */
  const voiceReasonId = useId();
  /*
   * The realtime pair the API fixes, so the Realtime LLM dropdowns offer that
   * one catalog row and nothing a choice could change.
   */
  const liveCatalog = form.modelCatalog.filter(
    (entry) => entry.job === "live" && entry.provider === LIVE_MODEL.provider && entry.model === LIVE_MODEL.model,
  );
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
              liveProvider: LIVE_MODEL.provider,
              liveModel: LIVE_MODEL.model,
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
    capabilityAttempt,
  ]);

  /* A missing provider key is fixed on the Provider API Keys page, so the notice says where. */
  const capabilityNotice: ReactNode = capabilityError === null
    ? null
    : MISSING_PROVIDER_KEY.test(capabilityError)
      ? (
        <>
          Please set the Provider API key in{" "}
          <Link className="text-foreground underline pointer-hover:text-brand" href={projectPath(projectId, "settings", "provider-api-keys")}>
            Settings
          </Link>
          .
        </>
      )
      : capabilityError;

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

  function retryCapabilities(): void {
    setCapabilities(null);
    setCapabilityError(null);
    reportValidity.current?.(false);
    setCapabilityAttempt((current) => current + 1);
  }

  const languageDisplay = capabilities === null || languageAvailable
    ? languageLabel(draft.language)
    : `${languageLabel(draft.language)} · Unavailable`;
  const selectedVoice = allVoices.find((voice) => voice.id === activeVoiceId) ?? capabilities?.voices.value;
  const voiceDisplay = capabilities === null || voiceAvailable
    ? selectedVoice?.name ?? activeVoiceId
    : `${activeVoiceId} · Unavailable`;
  const languageInvalidReason = capabilities === null
    ? undefined
    : capabilityInvalidReason(
        capabilities.language,
        languageAvailable,
        "Choose an available language",
      );
  const voiceInvalidReason = capabilities === null
    ? undefined
    : capabilityInvalidReason(
        capabilities.voices,
        voiceAvailable,
        "Choose an available voice",
      );

  /* A realtime persona reasons on an OpenAI chat model, so the one dropdown offers those. */
  const reasoning = form.modelCatalog.filter(
    (entry) => entry.job === "llm" && entry.provider === "openai",
  );
  const reasoningOptions: DownwardSelectOption[] = [
    ...(reasoning.some((entry) => entry.model === draft.llmModel)
      ? []
      : [{ value: draft.llmModel, label: `${draft.llmModel} · Unavailable` }]),
    ...reasoning.map((entry) => ({ value: entry.model, label: entry.modelLabel ?? entry.model })),
  ];

  return (
    <>
      <PersonaGroupLabel divider>Settings</PersonaGroupLabel>
      {capabilityError === null ? null : (
        <div className="flex flex-wrap items-center gap-3">
          <Note bad>{capabilityNotice}</Note>
          <Button type="button" size="sm" variant="secondary" disabled={disabled} onClick={retryCapabilities}>
            Retry options
          </Button>
        </div>
      )}
      {/* The subsection header is the combobox's own label: Language holds one control. */}
      <PersonaSubsection
        label="Language*"
        htmlFor={`${prefix}-language`}
        invalidReason={languageInvalidReason}
      >
        <SearchableSelect
          id={`${prefix}-language`}
          className={DROPDOWN}
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
          error={capabilityNotice}
          empty="No languages found"
          emptyDetail="Try another search."
          onSearchChange={setLanguageSearch}
          onValueChange={(language) => change({ ...draft, language })}
        />
        {capabilities === null ? null : capabilityMessage("Language", capabilities.language)}
      </PersonaSubsection>

      {draft.mode === "separate" ? (
        <>
          <PersonaSubsection label="Text-to-speech" invalidReason={voiceInvalidReason} invalidReasonId={voiceReasonId}>
            <ProviderModelFields
              prefix={prefix}
              job="tts"
              provider={draft.ttsProvider}
              model={draft.ttsModel}
              catalog={form.modelCatalog}
              disabled={disabled}
              onChange={(provider, model) => change(changeSelection(draft, "tts", provider, model))}
            />
            <VoiceField
              prefix={prefix}
              disabled={disabled}
              value={activeVoiceId}
              displayValue={voiceDisplay}
              valid={voiceAvailable}
              describedBy={voiceInvalidReason === undefined ? undefined : voiceReasonId}
              loading={capabilities === null && capabilityError === null}
              error={capabilityNotice}
              options={voices}
              search={voiceSearch}
              type={voiceType}
              onSearch={setVoiceSearch}
              onType={setVoiceType}
              onClear={() => { setVoiceSearch(""); setVoiceType("all"); }}
              onChange={(separateVoiceId) => change({ ...draft, separateVoiceId })}
            />
            {capabilities === null ? null : capabilityMessage("Voice", capabilities.voices)}
          </PersonaSubsection>
          <PersonaSubsection label="Speech-to-text">
            <ProviderModelFields
              prefix={prefix}
              job="stt"
              provider={draft.sttProvider}
              model={draft.sttModel}
              catalog={form.modelCatalog}
              disabled={disabled}
              onChange={(provider, model) => change(changeSelection(draft, "stt", provider, model))}
            />
          </PersonaSubsection>
          <PersonaSubsection label="LLM">
            <ProviderModelFields
              prefix={prefix}
              job="llm"
              provider={draft.llmProvider}
              model={draft.llmModel}
              catalog={form.modelCatalog}
              disabled={disabled}
              onChange={(provider, model) => change(changeSelection(draft, "llm", provider, model))}
            />
          </PersonaSubsection>
        </>
      ) : (
        <PersonaSubsection label="Realtime LLM" invalidReason={voiceInvalidReason} invalidReasonId={voiceReasonId}>
          <ProviderModelFields
            prefix={prefix}
            job="live"
            provider={LIVE_MODEL.provider}
            model={LIVE_MODEL.model}
            catalog={liveCatalog}
            disabled={disabled}
          />
          <VoiceField
            prefix={prefix}
            disabled={disabled}
            value={activeVoiceId}
            displayValue={voiceDisplay}
            valid={voiceAvailable}
            describedBy={voiceInvalidReason === undefined ? undefined : voiceReasonId}
            loading={capabilities === null && capabilityError === null}
            error={capabilityNotice}
            options={voices}
            search={voiceSearch}
            type={voiceType}
            onSearch={setVoiceSearch}
            onType={setVoiceType}
            onClear={() => { setVoiceSearch(""); setVoiceType("all"); }}
            onChange={(liveVoiceId) => change({ ...draft, liveVoiceId })}
          />
          {capabilities === null ? null : capabilityMessage("Voice", capabilities.voices)}
          <PersonaField label="Reasoning LLM*" htmlFor={`${prefix}-llm-model`}>
            <DownwardSelect
              id={`${prefix}-llm-model`}
              className={DROPDOWN}
              value={draft.llmModel}
              disabled={disabled}
              required
              options={reasoningOptions}
              onValueChange={(value) => change(changeSelection(draft, "llm", "openai", value))}
            />
          </PersonaField>
        </PersonaSubsection>
      )}

      <PersonaSubsection label="Advanced Settings">
        {/* Two lanes even when the API leaves the second empty, so one dropdown stays the width of every other. */}
        <div className="grid grid-cols-2 gap-4 max-[900px]:grid-cols-1">
          <PersonaField label="Background sound*" htmlFor={`${prefix}-background-sound`}>
            <DownwardSelect
              id={`${prefix}-background-sound`}
              className={DROPDOWN}
              value={draft.backgroundSoundId}
              disabled={disabled}
              required
              options={BACKGROUND_SOUNDS.map((sound) => ({ value: sound.id, label: sound.label }))}
              onValueChange={(value) => change({
                ...draft,
                backgroundSoundId: value as ModelsDraft["backgroundSoundId"],
              })}
            />
          </PersonaField>
          {/* A realtime persona carries no interruption level, so the API has no control to draw. */}
          {draft.mode === "separate" ? (
            <PersonaField label="Interruptions*" htmlFor={`${prefix}-interruptions`}>
              <DownwardSelect
                id={`${prefix}-interruptions`}
                className={DROPDOWN}
                value={draft.interruptionLevel}
                disabled={disabled}
                required
                options={[
                  { value: "none", label: "None" },
                  { value: "occasional", label: "Occasional" },
                  { value: "frequent", label: "Frequent" },
                ]}
                onValueChange={(value) => change({
                  ...draft,
                  interruptionLevel: value as ModelsDraft["interruptionLevel"],
                })}
              />
            </PersonaField>
          ) : null}
        </div>
      </PersonaSubsection>
    </>
  );
}

function VoiceField({
  prefix,
  disabled,
  value,
  displayValue,
  valid,
  describedBy,
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
  /** The id of the reason an unavailable voice blocks the form, for the picker to point at. */
  readonly describedBy?: string;
  readonly loading: boolean;
  readonly error: ReactNode;
  readonly options: readonly { readonly value: string; readonly label: string; readonly detail: string }[];
  readonly search: string;
  readonly type: "all" | "male" | "female" | "unknown";
  readonly onSearch: (value: string) => void;
  readonly onType: (value: "all" | "male" | "female" | "unknown") => void;
  readonly onClear: () => void;
  readonly onChange: (value: string) => void;
}) {
  return (
    <PersonaField label="Voice*" htmlFor={`${prefix}-voice`}>
      <FieldHintContext.Provider value={describedBy}>
      <SearchableSelect
        id={`${prefix}-voice`}
        className={DROPDOWN}
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
      </FieldHintContext.Provider>
    </PersonaField>
  );
}
