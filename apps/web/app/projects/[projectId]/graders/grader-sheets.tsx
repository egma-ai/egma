"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  createCustomGrader,
  getGraderLibraryEntry,
  updateGrader,
  useGraderInProject,
} from "@egma/platform-api/client";

import { Badge } from "@/components/ui/badge";
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
import { cn } from "@/lib/utils";
import type { Refusal } from "../../../../lib/api.ts";
import {
  EMPTY_GRADER_SCOPE,
  graderDefinitionDisplayName,
  graderEvidenceLabel,
  graderModalityLabel,
  graderOwnerLabel,
  productionScopeSummary,
  simulationScopeSummary,
  SCOPE_OFF,
  type GraderLibraryEntry,
  type GraderModality,
  type GraderSettingDefinition,
  type GraderType,
  type ProjectGrader,
  type ProjectGraderScope,
} from "../../../../lib/graders.ts";
import {
  platformAnswer,
  platformClient,
} from "../../../../lib/platform-client.ts";
import { Field, Refused } from "../../../../ui/form.tsx";
import { NumberField } from "../../../../ui/number-field.tsx";
import { Empty, Loading } from "../../../../ui/page-state.tsx";
import { useProjectRead } from "../../../../ui/resource.ts";
import { useUnsavedChanges } from "../../../../ui/settings-read.ts";
import { ScopeFields } from "./scope-fields.tsx";

/**
 * The words this surface repeats, written once.
 *
 * The pass threshold is asked for in three places — using a library grader,
 * editing an active one, creating a custom one — and a sentence that drifted
 * between them would be three different promises about one number.
 */
const COPY = {
  passThreshold: "Pass threshold*",
  passThresholdHint:
    "From 0 to 1. A simulation passes this grader at or above this score.",
  gradingInstructionsHint:
    "Describe what the agent must do. The grader returns a score between 0 and 1.",
  reads: "The evidence this grader needs from a simulation.",
} as const;

/**
 * One chip, and every chip on this surface is this one.
 *
 * It is the shared `Badge` with two things said about it: the count shape's
 * 22px height, which is the small chip this product already draws beside a row
 * of facts, and no fill, because `DESIGN.md` asks a chip for a hairline and a
 * word. The verdict shape is deliberately not used here — it letter-spaces and
 * capitalises, and `llm_as_judge` is an identifier that must read exactly as
 * the API writes it.
 */
function GraderChip({
  variant = "neutral",
  mono = false,
  children,
}: {
  readonly variant?: "neutral" | "success";
  /** An identifier, in the shared monospace stack. */
  readonly mono?: boolean;
  readonly children: ReactNode;
}) {
  return (
    <Badge
      className={cn("bg-transparent", mono && "font-mono")}
      shape="count"
      variant={variant}
    >
      {children}
    </Badge>
  );
}

/** What a grader is, as the API's own word for it. */
export function GraderTypeChip({ type }: { readonly type: GraderType }) {
  return <GraderChip mono>{type}</GraderChip>;
}

/** Which modalities a grader can grade — one chip each, never a joined phrase. */
export function GraderModalityChips({
  modalities,
}: {
  readonly modalities: readonly GraderModality[];
}) {
  if (modalities.length === 0) return <span className="text-faint">None</span>;
  return (
    <span className="inline-flex items-center gap-2">
      {modalities.map((modality) => (
        <GraderChip key={modality}>{graderModalityLabel(modality)}</GraderChip>
      ))}
    </span>
  );
}

/**
 * Whether this project already grades with a library entry.
 *
 * Active is the success chip: the green hairline and green word are the only
 * colour on the row, and the word carries the state on its own for anybody who
 * cannot see the colour.
 */
export function ProjectUseChip({ active }: { readonly active: boolean }) {
  return (
    <GraderChip variant={active ? "success" : "neutral"}>
      {active ? "Active" : "Available"}
    </GraderChip>
  );
}

/**
 * One scope column's word, drawn the same in the list and in the sheet.
 *
 * `Off` is the absence of a scope rather than a scope, so it is faint: a column
 * of graders should let the eye fall on the ones that are grading something.
 */
export function ScopeValue({ value }: { readonly value: string }) {
  return (
    <span className={value === SCOPE_OFF ? "text-faint" : undefined}>
      {value}
    </span>
  );
}

/** A labelled row of facts, in one lane, in a sheet. */
function Facts({ children }: { readonly children: ReactNode }) {
  return (
    <dl className="m-0 grid grid-cols-[112px_minmax(0,1fr)] gap-x-3 gap-y-2 text-sm">
      {children}
    </dl>
  );
}

/** One fact in that lane. */
function Fact({
  label,
  children,
}: {
  readonly label: string;
  readonly children: ReactNode;
}) {
  return (
    <>
      <dt className="text-faint">{label}</dt>
      <dd className="m-0 leading-(--line-normal) text-muted-foreground">
        {children}
      </dd>
    </>
  );
}

/** One part of a sheet's body, under its own heading. */
function Section({
  title,
  lead,
  children,
}: {
  readonly title: string;
  /** One faint line saying what the part below is. */
  readonly lead?: string;
  readonly children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-3 border-t border-border pt-5">
      <div className="flex flex-col gap-1">
        <p className="m-0 text-sm font-medium text-foreground">{title}</p>
        {lead === undefined ? null : (
          <p className="m-0 text-sm leading-(--line-normal) text-faint">
            {lead}
          </p>
        )}
      </div>
      {children}
    </div>
  );
}

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
    <Section title="Settings">
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
    </Section>
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
    /*
     * The star on the label is presentation, and the field says the same thing
     * to a screen reader through `required` — the native attribute the
     * accessibility tree reads as the required state. `DESIGN.md` asks that a
     * starred label never be only a picture; this is that promise kept by the
     * control rather than by a second attribute beside it.
     */
    <NumberField
      id="grader-pass-threshold"
      label={COPY.passThreshold}
      value={value}
      onChange={onChange}
      min={0}
      max={1}
      step={0.01}
      disabled={disabled}
      required
      invalid={!valid}
      hint={COPY.passThresholdHint}
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

/**
 * What a library grader is, before anybody chooses it.
 *
 * **The description is the first row of the list rather than a paragraph over
 * it.** It is one of the facts, and a sentence floating above a labelled lane
 * read as the sheet's own introduction instead of as this grader's. A grader
 * with no description has no row: an empty lane says less than nothing.
 */
function LibraryFacts({
  entry,
  historical,
}: {
  readonly entry: GraderLibraryEntry;
  readonly historical: boolean;
}) {
  return (
    <Facts>
      {entry.description === null ? null : (
        <Fact label="Description">{entry.description}</Fact>
      )}
      <Fact label="Owner">{graderOwnerLabel(entry.owner)}</Fact>
      <Fact label="Type">
        <GraderTypeChip type={entry.type} />
      </Fact>
      <Fact label="Modalities">
        <GraderModalityChips modalities={entry.modalities} />
      </Fact>
      {historical ? (
        <Fact label="Definition version">v{entry.definitionVersion}</Fact>
      ) : (
        <Fact label="Project use">
          <ProjectUseChip active={entry.activeProjectGraderId !== null} />
        </Fact>
      )}
    </Facts>
  );
}

/**
 * The evidence this grader needs, as its own part of the sheet.
 *
 * It was a row in the fact list, where a list of six sources ran past the lane
 * and read as one long value. It is a section now, because "what does this
 * grader look at" is the question somebody choosing a grader asks second.
 */
function ReadsSection({ entry }: { readonly entry: GraderLibraryEntry }) {
  return (
    <Section title="Reads" lead={COPY.reads}>
      {entry.requiredEvidence.length === 0 ? (
        <p className="m-0 text-sm text-muted-foreground">No trace evidence</p>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          {entry.requiredEvidence.map((evidence) => (
            <GraderChip key={evidence}>
              {graderEvidenceLabel(evidence)}
            </GraderChip>
          ))}
        </div>
      )}
    </Section>
  );
}

function DefinitionRead({
  projectId,
  definitionId,
  definitionVersion,
  children,
}: {
  readonly projectId: string;
  readonly definitionId: string;
  readonly definitionVersion?: number;
  readonly children: (entry: GraderLibraryEntry) => ReactNode;
}) {
  const { answer, reload } = useProjectRead<GraderLibraryEntry>(
    (selectedProjectId) =>
      platformAnswer(
        getGraderLibraryEntry(
          {
            graderDefinitionId: definitionId,
            projectId: selectedProjectId,
            ...(definitionVersion === undefined ? {} : { definitionVersion }),
          },
          { client: platformClient },
        ),
      ),
    projectId,
    `${definitionId}:${String(definitionVersion ?? "current")}`,
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
  mode: opened = "details",
  definitionVersion,
  mayAuthor,
  onClose,
  onUsed,
  onEditActive,
}: {
  readonly entry: GraderLibraryEntry;
  readonly projectId: string;
  readonly open: boolean;
  /**
   * Which half of this sheet the opener asked for.
   *
   * A row press is a person reading, so it opens the review. The row menu's
   * **Use in project** is a person who has already decided, so it opens the
   * form and does not make them press past the review to reach it.
   */
  readonly mode?: "details" | "use";
  /** An immutable historical definition. Historical reads have no live actions. */
  readonly definitionVersion?: number;
  readonly mayAuthor: boolean;
  readonly onClose: () => void;
  readonly onUsed: () => void;
  readonly onEditActive: (projectGraderId: string) => void;
}) {
  const [mode, setMode] = useState<"details" | "use">(opened);
  useEffect(() => {
    if (open) setMode(opened);
  }, [open, opened]);
  return (
    <Sheet open={open} onOpenChange={(next) => !next && onClose()}>
      <SheetContent aria-describedby={undefined}>
        <SheetHeader>
          <SheetTitle>
            {graderDefinitionDisplayName(entry.id, entry.name)}
          </SheetTitle>
          <SheetDescription>
            {definitionVersion !== undefined
              ? "The immutable grader definition used for this recorded result."
              : mode === "details"
              ? "Review this grader before choosing it for the project."
              : "Choose how this project will use the grader."}
          </SheetDescription>
        </SheetHeader>
        <DefinitionRead
          projectId={projectId}
          definitionId={entry.id}
          definitionVersion={definitionVersion}
        >
          {(read) =>
            definitionVersion !== undefined || mode === "details" ? (
              <LibraryDetails
                entry={read}
                historical={definitionVersion !== undefined}
                mayAuthor={mayAuthor && definitionVersion === undefined}
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
  historical,
  mayAuthor,
  onUse,
  onEditActive,
}: {
  readonly entry: GraderLibraryEntry;
  readonly historical: boolean;
  readonly mayAuthor: boolean;
  readonly onUse: () => void;
  readonly onEditActive: (projectGraderId: string) => void;
}) {
  return (
    <>
      <SheetBody>
        <LibraryFacts entry={entry} historical={historical} />
        <ReadsSection entry={entry} />
        {entry.settingDefinitions.length === 0 ? null : (
          <Section title="Settings">
            <div className="flex flex-col gap-2">
              {entry.settingDefinitions.map((setting) => (
                <p
                  className="m-0 text-sm text-muted-foreground"
                  key={setting.key}
                >
                  {setting.label}: {defaultSettingLabel(setting)} by default
                </p>
              ))}
            </div>
          </Section>
        )}
        {entry.gradingInstructions === null ? null : (
          <Section title="Grading instructions">
            <p className="m-0 whitespace-pre-wrap text-sm leading-(--line-normal) text-muted-foreground">
              {entry.gradingInstructions}
            </p>
          </Section>
        )}
      </SheetBody>
      <SheetFooter>
        {historical ? null : entry.activeProjectGraderId === null ? (
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
}: {
  readonly grader: ProjectGrader;
  readonly projectId: string;
  readonly open: boolean;
  readonly mayAuthor: boolean;
  readonly onClose: () => void;
  readonly onSaved: () => void;
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
}: {
  readonly grader: ProjectGrader;
  readonly entry: GraderLibraryEntry;
  readonly projectId: string;
  readonly open: boolean;
  readonly mayAuthor: boolean;
  readonly onSaved: () => void;
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
        <Facts>
          <Fact label="Owner">{graderOwnerLabel(grader.owner)}</Fact>
          <Fact label="Type">
            <GraderTypeChip type={grader.type} />
          </Fact>
          <Fact label="Modalities">
            <GraderModalityChips modalities={grader.modalities} />
          </Fact>
        </Facts>
        {/*
         * **A scope nobody here can change is read in the same lane the facts
         * above it are.** It used to be two sentences under a "Fixed by Egma"
         * caption, which answered a question nobody asked — the controls are
         * simply not there — while saying the two evidence sources in a shape
         * that matched neither the list behind the sheet nor the form that
         * replaces this block on an editable grader. The caption is gone
         * (developer decision, 2026-08-25) and the two lines are the two
         * columns of the list, word for word.
         */}
        <Section title="Scope">
          {grader.scopeEditable ? (
            <ScopeFields
              key={scopeRevision}
              projectId={projectId}
              scope={scope}
              disabled={saving || !mayAuthor}
              onChange={setScope}
              onValidityChange={setScopeValid}
            />
          ) : (
            <Facts>
              <Fact label="Simulations">
                <ScopeValue value={simulationScopeSummary(grader.scope)} />
              </Fact>
              <Fact label="Production">
                <ScopeValue value={productionScopeSummary(grader.scope)} />
              </Fact>
            </Facts>
          )}
        </Section>
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
      {/*
       * **The footer answers and gets out of the way, and nothing else.**
       * Removing a grader left this sheet with the redesign: it is a thing done
       * *to* a row rather than a thing said *in* the editor, so it is offered
       * by the ⋮ on the row — in the active list and in the library — and it
       * still opens the same confirmation that names the grader.
       */}
      <SheetFooter>
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

/**
 * Which kind of grader is being written, as the two segments of one control.
 *
 * **It is a radio group, not two buttons**, and the recipe is the one the
 * connect sheet already draws: one of these is true and the other is not, the
 * arrow keys move between them, and only the chosen one is a tab stop.
 *
 * **The chosen segment carries a two-pixel Ember line on its top edge**, over a
 * plain fill, plus weight 500 so the state is not colour alone (`DESIGN.md`,
 * developer decision 2026-08-24).
 */
function MechanismChoice({
  value,
  disabled,
  onChange,
}: {
  readonly value: GraderType;
  readonly disabled: boolean;
  readonly onChange: (next: GraderType) => void;
}) {
  const segments: readonly { readonly value: GraderType; readonly label: string }[] =
    [
      { value: "llm_as_judge", label: "LLM judge" },
      { value: "code", label: "Code" },
    ];

  function step(by: number): void {
    const here = segments.findIndex((one) => one.value === value);
    const next = segments[(here + by + segments.length) % segments.length];
    if (next !== undefined) onChange(next.value);
  }

  return (
    <div className="flex flex-col gap-2">
      <p className="m-0 text-sm text-faint" id="custom-grader-mechanism-label">
        Mechanism
      </p>
      <div
        aria-labelledby="custom-grader-mechanism-label"
        className="flex w-fit border border-border"
        role="radiogroup"
      >
        {segments.map((segment, index) => (
          <button
            aria-checked={segment.value === value}
            className={cn(
              "relative flex min-h-(--control-md) cursor-pointer items-center justify-center px-6",
              "border-0 bg-transparent text-sm",
              "transition-colors duration-(--duration-hover) ease-out",
              "disabled:cursor-not-allowed disabled:opacity-55",
              index > 0 && "border-l border-border",
              /*
               * The line is painted by the segment rather than mounted as an
               * element, so choosing the other one moves one edge.
               */
              "before:absolute before:inset-x-0 before:top-0 before:h-0.5 before:content-['']",
              "before:origin-left before:bg-brand before:transition-[opacity,transform]",
              "before:duration-(--duration-hover) before:ease-out",
              "motion-reduce:before:transition-none",
              segment.value === value
                ? "font-medium text-foreground before:scale-x-100 before:opacity-100"
                : "text-muted-foreground before:scale-x-0 before:opacity-0 pointer-hover:text-foreground",
            )}
            disabled={disabled}
            key={segment.value}
            onClick={() => onChange(segment.value)}
            onKeyDown={(event) => {
              if (event.key === "ArrowRight" || event.key === "ArrowDown") {
                event.preventDefault();
                step(1);
              } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
                event.preventDefault();
                step(-1);
              }
            }}
            role="radio"
            tabIndex={segment.value === value ? 0 : -1}
            type="button"
          >
            {segment.label}
          </button>
        ))}
      </div>
    </div>
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
  /**
   * Which kind of grader this sheet is writing.
   *
   * Only the LLM judge can be written today, and the other segment says so
   * rather than being missing: a person who came here to write a code grader is
   * told when it arrives instead of being left to wonder whether Egma has one.
   */
  const [mechanism, setMechanism] = useState<GraderType>("llm_as_judge");
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
    setMechanism("llm_as_judge");
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
            Create a grader for this organization and use it in this project.
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
            {/*
             * **The choice is the first thing in the body**, because it decides
             * what the rest of the body is. Nothing typed is thrown away by
             * changing it: every value below lives in this component, so the
             * other segment and back leaves the form exactly as it was.
             */}
            <MechanismChoice
              value={mechanism}
              disabled={saving}
              onChange={setMechanism}
            />
            {mechanism === "code" ? (
              <Empty
                title="Code graders are coming soon"
                lead="Write pass rules in code and run them on every simulation. Custom code graders arrive in a later release."
              />
            ) : (
              <>
                {refused === null ? null : <Refused message={refused.message} />}
                <Field label="Name*" htmlFor="custom-grader-name">
                  <Input
                    id="custom-grader-name"
                    value={name}
                    disabled={saving}
                    aria-required="true"
                    autoComplete="off"
                    onChange={(event) => setName(event.target.value)}
                  />
                </Field>
                {/*
                 * One line, at the height of the name above it. A description
                 * is the phrase a person reads beside this grader in a list,
                 * and a seven-line box invited a paragraph that no list can
                 * show.
                 */}
                <Field
                  label="Description [optional]"
                  htmlFor="custom-grader-description"
                  hint="Explain what quality this grader checks."
                >
                  <Input
                    id="custom-grader-description"
                    value={description}
                    disabled={saving}
                    autoComplete="off"
                    onChange={(event) => setDescription(event.target.value)}
                  />
                </Field>
                <Field
                  label="Grading instructions*"
                  htmlFor="custom-grader-instructions"
                  hint={COPY.gradingInstructionsHint}
                >
                  <Textarea
                    id="custom-grader-instructions"
                    value={instructions}
                    disabled={saving}
                    aria-required="true"
                    rows={7}
                    onChange={(event) => setInstructions(event.target.value)}
                  />
                </Field>
                {/*
                 * A group rather than a field: at least one of these two has
                 * to be chosen, and neither checkbox is required on its own.
                 * `aria-required` is not a supported state on a group, so the
                 * star's promise is kept where assistive technology reads it —
                 * the described line below, and `aria-invalid` while nothing
                 * is chosen.
                 */}
                <fieldset
                  aria-describedby="custom-grader-modalities-help"
                  aria-invalid={modalities.length === 0 ? true : undefined}
                  className="m-0 flex flex-col gap-3 border-0 p-0"
                >
                  <legend className="mb-1 text-sm font-medium text-foreground">
                    Compatible modalities*
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
                      {graderModalityLabel(modality)}
                    </label>
                  ))}
                  <p
                    className="m-0 text-sm text-faint"
                    id="custom-grader-modalities-help"
                  >
                    Choose at least one.
                  </p>
                </fieldset>
                <Section title="Scope">
                  <ScopeFields
                    key={scopeRevision}
                    projectId={projectId}
                    scope={scope}
                    disabled={saving}
                    onChange={setScope}
                    onValidityChange={setScopeValid}
                  />
                </Section>
                <div className="border-t border-border pt-5">
                  <PassThresholdField
                    value={threshold}
                    disabled={saving}
                    onChange={setThreshold}
                  />
                </div>
              </>
            )}
          </SheetBody>
          <SheetFooter>
            {mechanism === "code" ? null : (
              <Button type="submit" size="lg" busy={saving} disabled={!valid}>
                {saving ? "Creating…" : "Create grader"}
              </Button>
            )}
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
