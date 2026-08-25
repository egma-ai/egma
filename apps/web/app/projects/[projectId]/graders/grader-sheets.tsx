"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  createCustomGrader,
  getGraderLibraryEntry,
  updateGrader,
  useGraderInProject,
} from "@egma/platform-api/client";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import {
  Sheet,
  SheetBody,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Textarea } from "@/components/ui/textarea";
import type { Refusal } from "../../../../lib/api.ts";
import {
  EMPTY_GRADER_SCOPE,
  graderDefinitionDisplayName,
  graderModalitiesLabel,
  graderOwnerLabel,
  graderTypeLabel,
  productionScopeLabel,
  simulationScopeLabel,
  type GraderLibraryEntry,
  type GraderModality,
  type GraderSettingDefinition,
  type ProjectGrader,
  type ProjectGraderScope,
} from "../../../../lib/graders.ts";
import {
  platformAnswer,
  platformClient,
} from "../../../../lib/platform-client.ts";
import { Field, Refused } from "../../../../ui/form.tsx";
import { NumberField } from "../../../../ui/number-field.tsx";
import { Loading } from "../../../../ui/page-state.tsx";
import { useProjectRead } from "../../../../ui/resource.ts";
import { useUnsavedChanges } from "../../../../ui/settings-read.ts";
import { ScopeFields } from "./scope-fields.tsx";

type SettingsDraft = Readonly<Record<string, string>>;

function initialSettings(
  definitions: readonly GraderSettingDefinition[],
  values?: Readonly<Record<string, unknown>>,
): SettingsDraft {
  return Object.fromEntries(
    definitions.map((definition) => {
      const held = values?.[definition.key];
      const value = typeof held === "number" ? held : definition.defaultValue;
      return [
        definition.key,
        definition.unit === "milliseconds"
          ? String(value / 1_000)
          : String(value),
      ];
    }),
  );
}

function settingValue(
  definition: GraderSettingDefinition,
  value: string,
): number | null {
  if (value.trim() === "") return null;
  const read = Number(value);
  if (!Number.isFinite(read)) return null;
  const converted =
    definition.unit === "milliseconds" ? Math.round(read * 1_000) : read;
  if (!Number.isInteger(converted)) return null;
  if (definition.minimum !== null && converted < definition.minimum) return null;
  if (definition.maximum !== null && converted > definition.maximum) return null;
  return converted;
}

function settingsFrom(
  definitions: readonly GraderSettingDefinition[],
  draft: SettingsDraft,
): Readonly<Record<string, number>> | null {
  const pairs: Array<readonly [string, number]> = [];
  for (const definition of definitions) {
    const value = settingValue(definition, draft[definition.key] ?? "");
    if (value === null) return null;
    pairs.push([definition.key, value]);
  }
  return Object.fromEntries(pairs);
}

function defaultSettingLabel(definition: GraderSettingDefinition): string {
  if (definition.unit === "milliseconds") {
    return `${String(definition.defaultValue / 1_000)} seconds`;
  }
  return definition.unit === null
    ? String(definition.defaultValue)
    : `${String(definition.defaultValue)} ${definition.unit}`;
}

function SettingsFields({
  definitions,
  draft,
  disabled,
  onChange,
}: {
  readonly definitions: readonly GraderSettingDefinition[];
  readonly draft: SettingsDraft;
  readonly disabled: boolean;
  readonly onChange: (draft: SettingsDraft) => void;
}) {
  if (definitions.length === 0) return null;
  return (
    <div className="flex flex-col gap-4 border-t border-border pt-5">
      <p className="m-0 text-sm font-medium text-foreground">Settings</p>
      {definitions.map((definition) => {
        const value = draft[definition.key] ?? "";
        const converted = settingValue(definition, value);
        const milliseconds = definition.unit === "milliseconds";
        return (
          <NumberField
            key={definition.key}
            id={`grader-setting-${definition.key}`}
            label={definition.label}
            value={value}
            onChange={(next) => onChange({ ...draft, [definition.key]: next })}
            unit={milliseconds ? "seconds" : (definition.unit ?? undefined)}
            min={
              definition.minimum === null
                ? undefined
                : milliseconds
                  ? definition.minimum / 1_000
                  : definition.minimum
            }
            max={
              definition.maximum === null
                ? undefined
                : milliseconds
                  ? definition.maximum / 1_000
                  : definition.maximum
            }
            step={milliseconds ? 0.001 : 1}
            disabled={disabled}
            required
            invalid={converted === null}
            hint={
              milliseconds
                ? "The grader compares the trace's average response time with this value."
                : undefined
            }
          />
        );
      })}
    </div>
  );
}

function PassThresholdField({
  value,
  disabled,
  onChange,
}: {
  readonly value: string;
  readonly disabled: boolean;
  readonly onChange: (value: string) => void;
}) {
  const parsed = Number(value);
  const valid =
    value.trim() !== "" &&
    Number.isFinite(parsed) &&
    parsed >= 0 &&
    parsed <= 1;
  return (
    <NumberField
      id="grader-pass-threshold"
      label="Pass threshold"
      value={value}
      onChange={onChange}
      min={0}
      max={1}
      step={0.01}
      disabled={disabled}
      required
      invalid={!valid}
      hint="This decides only whether this grader's own result passes."
    />
  );
}

function thresholdValue(value: string): number | null {
  if (value.trim() === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 1
    ? parsed
    : null;
}

function Facts({ entry }: { readonly entry: GraderLibraryEntry }) {
  const evidence = entry.requiredEvidence.map((one) =>
    one.replaceAll("_", " "),
  );
  return (
    <dl className="m-0 grid grid-cols-[112px_minmax(0,1fr)] gap-x-3 gap-y-2 text-sm">
      <dt className="text-faint">Owner</dt>
      <dd className="m-0 text-muted-foreground">
        {graderOwnerLabel(entry.owner)}
      </dd>
      <dt className="text-faint">Type</dt>
      <dd className="m-0 text-muted-foreground">
        {graderTypeLabel(entry.type)}
      </dd>
      <dt className="text-faint">Modalities</dt>
      <dd className="m-0 text-muted-foreground">
        {graderModalitiesLabel(entry.modalities)}
      </dd>
      <dt className="text-faint">Reads</dt>
      <dd className="m-0 text-muted-foreground">
        {evidence.length === 0 ? "No trace evidence" : evidence.join(", ")}
      </dd>
      <dt className="text-faint">Project use</dt>
      <dd className="m-0 text-muted-foreground">
        {entry.activeProjectGraderId === null
          ? "Not active in this project"
          : "Active in this project"}
      </dd>
    </dl>
  );
}

function DefinitionRead({
  projectId,
  definitionId,
  children,
}: {
  readonly projectId: string;
  readonly definitionId: string;
  readonly children: (entry: GraderLibraryEntry) => ReactNode;
}) {
  const { answer, reload } = useProjectRead<GraderLibraryEntry>(
    (selectedProjectId) =>
      platformAnswer(
        getGraderLibraryEntry(
          { graderDefinitionId: definitionId, projectId: selectedProjectId },
          { client: platformClient },
        ),
      ),
    projectId,
    definitionId,
  );
  useEffect(() => {
    if (answer?.status === "signed-out") window.location.replace("/sign-in");
  }, [answer]);
  if (answer === null || answer.status === "signed-out") {
    return <Loading what="grader details" />;
  }
  if (answer.status !== "ready") {
    return (
      <Refused
        message={answer.refusal.message}
        action={
          <Button type="button" variant="secondary" onClick={reload}>
            Try again
          </Button>
        }
      />
    );
  }
  return children(answer.value);
}

export function LibraryGraderSheet({
  entry,
  projectId,
  open,
  mayAuthor,
  onClose,
  onUsed,
  onEditActive,
}: {
  readonly entry: GraderLibraryEntry;
  readonly projectId: string;
  readonly open: boolean;
  readonly mayAuthor: boolean;
  readonly onClose: () => void;
  readonly onUsed: () => void;
  readonly onEditActive: (projectGraderId: string) => void;
}) {
  const [mode, setMode] = useState<"details" | "use">("details");
  useEffect(() => {
    if (open) setMode("details");
  }, [open]);
  return (
    <Sheet open={open} onOpenChange={(next) => !next && onClose()}>
      <SheetContent aria-describedby={undefined}>
        <SheetHeader>
          <SheetTitle>
            {graderDefinitionDisplayName(entry.id, entry.name)}
          </SheetTitle>
          <SheetDescription>
            {mode === "details"
              ? "Review this grader before choosing it for the project."
              : "Choose how this project will use the grader."}
          </SheetDescription>
        </SheetHeader>
        <DefinitionRead projectId={projectId} definitionId={entry.id}>
          {(read) =>
            mode === "details" ? (
              <LibraryDetails
                entry={read}
                mayAuthor={mayAuthor}
                onUse={() => setMode("use")}
                onEditActive={onEditActive}
              />
            ) : (
              <UseGraderForm
                entry={read}
                projectId={projectId}
                onCancel={() => setMode("details")}
                onUsed={onUsed}
              />
            )
          }
        </DefinitionRead>
      </SheetContent>
    </Sheet>
  );
}

function LibraryDetails({
  entry,
  mayAuthor,
  onUse,
  onEditActive,
}: {
  readonly entry: GraderLibraryEntry;
  readonly mayAuthor: boolean;
  readonly onUse: () => void;
  readonly onEditActive: (projectGraderId: string) => void;
}) {
  return (
    <>
      <SheetBody>
        {entry.description === null ? null : (
          <p className="m-0 text-sm leading-(--line-normal) text-muted-foreground">
            {entry.description}
          </p>
        )}
        <Facts entry={entry} />
        {entry.settingDefinitions.length === 0 ? null : (
          <div className="flex flex-col gap-2 border-t border-border pt-5">
            <p className="m-0 text-sm font-medium text-foreground">Settings</p>
            {entry.settingDefinitions.map((setting) => (
              <p className="m-0 text-sm text-muted-foreground" key={setting.key}>
                {setting.label}: {defaultSettingLabel(setting)} by default
              </p>
            ))}
          </div>
        )}
        {entry.gradingInstructions === null ? null : (
          <div className="flex flex-col gap-2 border-t border-border pt-5">
            <p className="m-0 text-sm font-medium text-foreground">
              Grading instructions
            </p>
            <p className="m-0 whitespace-pre-wrap text-sm leading-(--line-normal) text-muted-foreground">
              {entry.gradingInstructions}
            </p>
          </div>
        )}
      </SheetBody>
      <SheetFooter>
        {entry.activeProjectGraderId === null ? (
          <Button
            type="button"
            size="lg"
            disabled={!mayAuthor}
            {...(!mayAuthor
              ? { why: "Your role can view this grader but cannot use it in a project." }
              : {})}
            onClick={onUse}
          >
            Use in project
          </Button>
        ) : (
          <Button
            type="button"
            size="lg"
            variant="secondary"
            onClick={() => onEditActive(entry.activeProjectGraderId as string)}
          >
            View active grader
          </Button>
        )}
        <SheetClose asChild>
          <Button type="button" size="lg" variant="secondary">
            Close
          </Button>
        </SheetClose>
      </SheetFooter>
    </>
  );
}

function UseGraderForm({
  entry,
  projectId,
  onCancel,
  onUsed,
}: {
  readonly entry: GraderLibraryEntry;
  readonly projectId: string;
  readonly onCancel: () => void;
  readonly onUsed: () => void;
}) {
  const [scope, setScope] = useState<ProjectGraderScope>(EMPTY_GRADER_SCOPE);
  const [scopeValid, setScopeValid] = useState(true);
  const [settings, setSettings] = useState<SettingsDraft>(() =>
    initialSettings(entry.settingDefinitions),
  );
  const [threshold, setThreshold] = useState("1");
  const [saving, setSaving] = useState(false);
  const [refused, setRefused] = useState<Refusal | null>(null);
  const filledSettings = settingsFrom(entry.settingDefinitions, settings);
  const filledThreshold = thresholdValue(threshold);
  const valid =
    scopeValid && filledSettings !== null && filledThreshold !== null;
  const changed =
    JSON.stringify(scope) !== JSON.stringify(EMPTY_GRADER_SCOPE) ||
    JSON.stringify(settings) !==
      JSON.stringify(initialSettings(entry.settingDefinitions)) ||
    threshold !== "1";
  useUnsavedChanges(changed && !saving, saving);

  async function useGrader(): Promise<void> {
    if (!valid || saving) return;
    setSaving(true);
    setRefused(null);
    const answer = await platformAnswer(
      useGraderInProject(
        {
          graderDefinitionId: entry.id,
          projectId,
          scope: {
            simulations: [...scope.simulations],
            production: scope.production,
          },
          settings: filledSettings,
          passThreshold: filledThreshold,
        },
        { client: platformClient },
      ),
    );
    setSaving(false);
    if (answer.status === "signed-out") {
      window.location.replace("/sign-in");
      return;
    }
    if (answer.status !== "ready") {
      setRefused(answer.refusal);
      return;
    }
    onUsed();
  }

  return (
    <form
      className="flex min-h-0 flex-1 flex-col gap-5"
      onSubmit={(event) => {
        event.preventDefault();
        void useGrader();
      }}
    >
      <SheetBody>
        {refused === null ? null : <Refused message={refused.message} />}
        <ScopeFields
          projectId={projectId}
          scope={scope}
          disabled={saving}
          onChange={setScope}
          onValidityChange={setScopeValid}
        />
        <SettingsFields
          definitions={entry.settingDefinitions}
          draft={settings}
          disabled={saving}
          onChange={setSettings}
        />
        <div className="border-t border-border pt-5">
          <PassThresholdField
            value={threshold}
            disabled={saving}
            onChange={setThreshold}
          />
        </div>
      </SheetBody>
      <SheetFooter>
        <Button type="submit" size="lg" busy={saving} disabled={!valid}>
          {saving ? "Using…" : "Use in project"}
        </Button>
        <Button
          type="button"
          size="lg"
          variant="secondary"
          disabled={saving}
          onClick={onCancel}
        >
          Back
        </Button>
      </SheetFooter>
    </form>
  );
}

export function ActiveGraderSheet({
  grader,
  projectId,
  open,
  mayAuthor,
  onClose,
  onSaved,
  onRemove,
}: {
  readonly grader: ProjectGrader;
  readonly projectId: string;
  readonly open: boolean;
  readonly mayAuthor: boolean;
  readonly onClose: () => void;
  readonly onSaved: () => void;
  readonly onRemove: () => void;
}) {
  return (
    <Sheet open={open} onOpenChange={(next) => !next && onClose()}>
      <SheetContent aria-describedby={undefined}>
        <SheetHeader>
          <SheetTitle>
            {graderDefinitionDisplayName(
              grader.graderDefinitionId,
              grader.name,
            )}
          </SheetTitle>
          <SheetDescription>
            This project&apos;s scope, settings, and individual pass threshold.
          </SheetDescription>
        </SheetHeader>
        <DefinitionRead
          projectId={projectId}
          definitionId={grader.graderDefinitionId}
        >
          {(entry) => (
            <EditGraderForm
              grader={grader}
              entry={entry}
              projectId={projectId}
              open={open}
              mayAuthor={mayAuthor}
              onSaved={onSaved}
              onRemove={onRemove}
            />
          )}
        </DefinitionRead>
      </SheetContent>
    </Sheet>
  );
}

function EditGraderForm({
  grader,
  entry,
  projectId,
  open,
  mayAuthor,
  onSaved,
  onRemove,
}: {
  readonly grader: ProjectGrader;
  readonly entry: GraderLibraryEntry;
  readonly projectId: string;
  readonly open: boolean;
  readonly mayAuthor: boolean;
  readonly onSaved: () => void;
  readonly onRemove: () => void;
}) {
  const [scope, setScope] = useState<ProjectGraderScope>(grader.scope);
  const [scopeRevision, setScopeRevision] = useState(0);
  const [scopeValid, setScopeValid] = useState(true);
  const [settings, setSettings] = useState<SettingsDraft>(() =>
    initialSettings(entry.settingDefinitions, grader.settings),
  );
  const [threshold, setThreshold] = useState(String(grader.passThreshold));
  const [saving, setSaving] = useState(false);
  const [refused, setRefused] = useState<Refusal | null>(null);
  const filledSettings = settingsFrom(entry.settingDefinitions, settings);
  const filledThreshold = thresholdValue(threshold);
  const originalSettings = useMemo(
    () => initialSettings(entry.settingDefinitions, grader.settings),
    [entry.settingDefinitions, grader.settings],
  );
  const wasOpen = useRef(open);
  useEffect(() => {
    const reopened = open && !wasOpen.current;
    wasOpen.current = open;
    if (!reopened) return;
    setScope(grader.scope);
    setScopeRevision((current) => current + 1);
    setScopeValid(true);
    setSettings(originalSettings);
    setThreshold(String(grader.passThreshold));
    setRefused(null);
  }, [grader.passThreshold, grader.scope, open, originalSettings]);
  const changed =
    JSON.stringify(scope) !== JSON.stringify(grader.scope) ||
    JSON.stringify(settings) !== JSON.stringify(originalSettings) ||
    threshold !== String(grader.passThreshold);
  const valid =
    scopeValid && filledSettings !== null && filledThreshold !== null;
  useUnsavedChanges(changed && !saving, saving);

  async function save(): Promise<void> {
    if (!valid || saving || !changed || !mayAuthor) return;
    setSaving(true);
    setRefused(null);
    const answer = await platformAnswer(
      updateGrader(
        {
          graderId: grader.id,
          projectId,
          ...(grader.scopeEditable
            ? {
                scope: {
                  simulations: [...scope.simulations],
                  production: scope.production,
                },
              }
            : {}),
          settings: filledSettings,
          passThreshold: filledThreshold,
        },
        { client: platformClient },
      ),
    );
    setSaving(false);
    if (answer.status === "signed-out") {
      window.location.replace("/sign-in");
      return;
    }
    if (answer.status !== "ready") {
      setRefused(answer.refusal);
      return;
    }
    onSaved();
  }

  return (
    <form
      className="flex min-h-0 flex-1 flex-col gap-5"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <SheetBody>
        {refused === null ? null : <Refused message={refused.message} />}
        <dl className="m-0 grid grid-cols-[112px_minmax(0,1fr)] gap-x-3 gap-y-2 text-sm">
          <dt className="text-faint">Owner</dt>
          <dd className="m-0 text-muted-foreground">
            {graderOwnerLabel(grader.owner)}
          </dd>
          <dt className="text-faint">Type</dt>
          <dd className="m-0 text-muted-foreground">
            {graderTypeLabel(grader.type)}
          </dd>
          <dt className="text-faint">Modalities</dt>
          <dd className="m-0 text-muted-foreground">
            {graderModalitiesLabel(grader.modalities)}
          </dd>
        </dl>
        {grader.scopeEditable ? (
          <div className="flex flex-col gap-3 border-t border-border pt-5">
            <p className="m-0 text-sm font-medium text-foreground">Scope</p>
            <ScopeFields
              key={scopeRevision}
              projectId={projectId}
              scope={scope}
              disabled={saving || !mayAuthor}
              onChange={setScope}
              onValidityChange={setScopeValid}
            />
          </div>
        ) : (
          <div className="flex flex-col gap-2 border-t border-border pt-5">
            <div className="flex items-center justify-between gap-3">
              <p className="m-0 text-sm font-medium text-foreground">Scope</p>
              <span className="text-sm text-faint">Fixed by Egma</span>
            </div>
            <p className="m-0 text-sm text-muted-foreground">
              {simulationScopeLabel(grader)}
            </p>
            <p className="m-0 text-sm text-muted-foreground">
              {productionScopeLabel(grader)}
            </p>
          </div>
        )}
        <SettingsFields
          definitions={entry.settingDefinitions}
          draft={settings}
          disabled={saving || !mayAuthor}
          onChange={setSettings}
        />
        <div className="border-t border-border pt-5">
          <PassThresholdField
            value={threshold}
            disabled={saving || !mayAuthor}
            onChange={setThreshold}
          />
        </div>
      </SheetBody>
      <SheetFooter
        destructive={
          grader.removable ? (
            <Button
              type="button"
              size="lg"
              variant="ghost"
              className="px-0 text-failure pointer-hover:text-failure"
              disabled={saving || !mayAuthor}
              onClick={onRemove}
            >
              Remove grader
            </Button>
          ) : undefined
        }
      >
        <Button
          type="submit"
          size="lg"
          busy={saving}
          disabled={!mayAuthor || !valid || !changed}
        >
          {saving ? "Saving…" : "Save changes"}
        </Button>
        <SheetClose asChild>
          <Button
            type="button"
            size="lg"
            variant="secondary"
            disabled={saving}
          >
            Cancel
          </Button>
        </SheetClose>
      </SheetFooter>
    </form>
  );
}

export function CreateCustomGraderSheet({
  projectId,
  open,
  onClose,
  onCreated,
}: {
  readonly projectId: string;
  readonly open: boolean;
  readonly onClose: () => void;
  readonly onCreated: () => void;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [instructions, setInstructions] = useState("");
  const [modalities, setModalities] = useState<readonly GraderModality[]>([
    "chat",
    "voice",
  ]);
  const [scope, setScope] = useState<ProjectGraderScope>(EMPTY_GRADER_SCOPE);
  const [scopeRevision, setScopeRevision] = useState(0);
  const [scopeValid, setScopeValid] = useState(true);
  const [threshold, setThreshold] = useState("1");
  const [saving, setSaving] = useState(false);
  const [refused, setRefused] = useState<Refusal | null>(null);
  useEffect(() => {
    if (!open) return;
    setName("");
    setDescription("");
    setInstructions("");
    setModalities(["chat", "voice"]);
    setScope(EMPTY_GRADER_SCOPE);
    setScopeRevision((current) => current + 1);
    setScopeValid(true);
    setThreshold("1");
    setRefused(null);
  }, [open]);
  const filledThreshold = thresholdValue(threshold);
  const valid =
    name.trim() !== "" &&
    instructions.trim() !== "" &&
    modalities.length > 0 &&
    scopeValid &&
    filledThreshold !== null;
  const changed =
    name !== "" ||
    description !== "" ||
    instructions !== "" ||
    modalities.length !== 2 ||
    !modalities.includes("chat") ||
    !modalities.includes("voice") ||
    scope.simulations.length > 0 ||
    scope.production !== null ||
    threshold !== "1";
  useUnsavedChanges(changed && !saving, saving);

  function toggleModality(modality: GraderModality, checked: boolean): void {
    setModalities((current) =>
      checked
        ? current.includes(modality)
          ? current
          : [...current, modality]
        : current.filter((one) => one !== modality),
    );
  }

  async function create(): Promise<void> {
    if (!valid || saving || filledThreshold === null) return;
    setSaving(true);
    setRefused(null);
    const answer = await platformAnswer(
      createCustomGrader(
        {
          projectId,
          name: name.trim(),
          description: description.trim() === "" ? null : description.trim(),
          gradingInstructions: instructions.trim(),
          modalities: [...modalities],
          scope: {
            simulations: [...scope.simulations],
            production: scope.production,
          },
          passThreshold: filledThreshold,
        },
        { client: platformClient },
      ),
    );
    setSaving(false);
    if (answer.status === "signed-out") {
      window.location.replace("/sign-in");
      return;
    }
    if (answer.status !== "ready") {
      setRefused(answer.refusal);
      return;
    }
    onCreated();
  }

  return (
    <Sheet open={open} onOpenChange={(next) => !next && onClose()}>
      <SheetContent aria-describedby={undefined}>
        <SheetHeader>
          <SheetTitle>Create custom grader</SheetTitle>
          <SheetDescription>
            Create an LLM judge for this organization and use it in this project.
          </SheetDescription>
        </SheetHeader>
        <form
          className="flex min-h-0 flex-1 flex-col gap-5"
          onSubmit={(event) => {
            event.preventDefault();
            void create();
          }}
        >
          <SheetBody>
            {refused === null ? null : <Refused message={refused.message} />}
            <Field label="Name" htmlFor="custom-grader-name">
              <Input
                id="custom-grader-name"
                value={name}
                disabled={saving}
                autoComplete="off"
                onChange={(event) => setName(event.target.value)}
              />
            </Field>
            <Field
              label="Description"
              htmlFor="custom-grader-description"
              hint="Optional. Explain what quality this grader checks."
            >
              <Textarea
                id="custom-grader-description"
                value={description}
                disabled={saving}
                rows={3}
                onChange={(event) => setDescription(event.target.value)}
              />
            </Field>
            <Field
              label="Grading instructions"
              htmlFor="custom-grader-instructions"
              hint="Describe what the agent must do for this grader to return a score of 1."
            >
              <Textarea
                id="custom-grader-instructions"
                value={instructions}
                disabled={saving}
                rows={7}
                onChange={(event) => setInstructions(event.target.value)}
              />
            </Field>
            <fieldset className="m-0 flex flex-col gap-3 border-0 p-0">
              <legend className="mb-1 text-sm font-medium text-foreground">
                Compatible modalities
              </legend>
              {(["chat", "voice"] as const).map((modality) => (
                <label
                  className="flex min-h-(--control-md) items-center gap-3 text-sm text-foreground"
                  key={modality}
                >
                  <Checkbox
                    checked={modalities.includes(modality)}
                    disabled={saving}
                    onChange={(event) =>
                      toggleModality(modality, event.target.checked)
                    }
                  />
                  {modality === "chat" ? "Chat" : "Voice"}
                </label>
              ))}
            </fieldset>
            <div className="flex flex-col gap-3 border-t border-border pt-5">
              <p className="m-0 text-sm font-medium text-foreground">Scope</p>
              <ScopeFields
                key={scopeRevision}
                projectId={projectId}
                scope={scope}
                disabled={saving}
                onChange={setScope}
                onValidityChange={setScopeValid}
              />
            </div>
            <div className="border-t border-border pt-5">
              <PassThresholdField
                value={threshold}
                disabled={saving}
                onChange={setThreshold}
              />
            </div>
          </SheetBody>
          <SheetFooter>
            <Button type="submit" size="lg" busy={saving} disabled={!valid}>
              {saving ? "Creating…" : "Create grader"}
            </Button>
            <SheetClose asChild>
              <Button
                type="button"
                size="lg"
                variant="secondary"
                disabled={saving}
              >
                Cancel
              </Button>
            </SheetClose>
          </SheetFooter>
        </form>
      </SheetContent>
    </Sheet>
  );
}
