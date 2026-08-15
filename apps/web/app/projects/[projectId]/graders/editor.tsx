"use client";

import type { ReactNode } from "react";

import {
  defaultReads,
  readsAreChosen,
  samplingApplies,
  settled,
  TYPE_SUMMARY,
  type GraderRead,
  type GraderRegistry,
  type GraderType,
  type Modality,
  type Priority,
  type Scope,
} from "../../../../lib/graders.ts";
import { Field, TextInput } from "../../../../ui/controls.tsx";

/**
 * The fields a grader is written through, and the one rule they all obey: **a
 * form only ever shows fields that apply.**
 *
 * A grader's type decides what its judgment is made of, and the four types are
 * made of four completely different things — criteria in words, a measure and a
 * threshold, tool names, phrases. A single form carrying all of them would ask
 * everybody for three sets of fields they must leave blank, and a blank field
 * that means "not applicable" is indistinguishable from one somebody forgot.
 *
 * The other rule is the split, and it is drawn on the page rather than
 * explained in a paragraph. **Live** settings take effect everywhere the moment
 * they are saved and change nothing about any verdict already made. **Versioned
 * content** is what a verdict was *decided by*: saving it mints an immutable
 * version and applies from then on, so last week's run keeps meaning exactly
 * what it meant. Somebody about to tighten a rubric should be able to see that
 * they are making history, and somebody promoting a warning to a blocker should
 * be able to see that they are not.
 */

export const ALL_MODALITIES: readonly Modality[] = ["voice", "chat"];

export type ConfigDraft = Record<string, unknown>;

/**
 * What a new grader of each type starts with — enough shape that every field
 * the type needs has somewhere to go, and nothing filled in that an author has
 * not decided.
 */
export function emptyConfigFor(type: GraderType): ConfigDraft {
  switch (type) {
    case "llm_rubric":
      return { rubric: "" };
    case "metric_threshold":
      return {
        measure: "",
        aggregation: "p90",
        comparator: "below",
        threshold: 0,
      };
    case "tool_calls":
      return { required: [], forbidden: [] };
    case "phrase_match":
      return { required: [], banned: [], speaker: "agent" };
  }
}

/** Whether this draft is complete enough that the server would accept it. */
export function isConfigUsable(type: GraderType, config: ConfigDraft): boolean {
  switch (type) {
    case "llm_rubric":
      return String(config.rubric ?? "").trim() !== "";
    case "metric_threshold":
      return (
        String(config.measure ?? "").trim() !== "" &&
        typeof config.threshold === "number" &&
        Number.isFinite(config.threshold)
      );
    case "tool_calls":
      return (
        toolNames(config.required).length > 0 || toolNames(config.forbidden).length > 0
      );
    case "phrase_match":
      return (
        phraseTexts(config.required).length > 0 || phraseTexts(config.banned).length > 0
      );
  }
}

/** Tool names as the config holds them, from the lines a person typed. */
export function toolNames(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) =>
      typeof entry === "object" && entry !== null
        ? String((entry as { tool?: unknown }).tool ?? "")
        : "",
    )
    .filter((name) => name.trim() !== "");
}

export function phraseTexts(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) =>
      typeof entry === "object" && entry !== null
        ? String((entry as { text?: unknown }).text ?? "")
        : "",
    )
    .filter((text) => text.trim() !== "");
}

/** One tool or phrase per line, which is how a list is typed and read back. */
export function linesOf(names: readonly string[]): string {
  return names.join("\n");
}

export function toolsFromLines(lines: string): readonly { readonly tool: string }[] {
  return lines
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .map((tool) => ({ tool }));
}

export function phrasesFromLines(
  lines: string,
): readonly { readonly text: string }[] {
  return lines
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .map((text) => ({ text }));
}

function TextArea({
  id,
  label,
  value,
  hint,
  disabled,
  onChange,
}: {
  readonly id: string;
  readonly label: string;
  readonly value: string;
  readonly hint?: string;
  readonly disabled: boolean;
  readonly onChange: (value: string) => void;
}) {
  return (
    <Field label={label} htmlFor={id}>
      <textarea
        id={id}
        rows={4}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
      />
      {hint === undefined ? null : <small>{hint}</small>}
    </Field>
  );
}

function Choice<Value extends string>({
  id,
  label,
  value,
  options,
  disabled,
  onChange,
}: {
  readonly id: string;
  readonly label: string;
  readonly value: Value;
  readonly options: readonly Value[];
  readonly disabled: boolean;
  readonly onChange: (value: Value) => void;
}) {
  return (
    <Field label={label} htmlFor={id}>
      <select
        id={id}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value as Value)}
      >
        {options.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
    </Field>
  );
}

/**
 * A set of checkboxes over a settled list, which **refuses to become empty**.
 *
 * A grader that reads nothing or scores nothing can never fire — it is a check
 * somebody wrote, believes in, and that will never say anything. So the last
 * box cannot be cleared, and the control says why rather than letting the save
 * fail at the server.
 */
function SetOf<Value extends string>({
  legend,
  name,
  options,
  chosen,
  disabled,
  why,
  onChange,
}: {
  readonly legend: string;
  readonly name: string;
  readonly options: readonly Value[];
  readonly chosen: readonly Value[];
  readonly disabled: boolean;
  readonly why?: string;
  readonly onChange: (chosen: readonly Value[]) => void;
}) {
  const last = chosen.length === 1;
  return (
    <fieldset>
      <legend>{legend}</legend>
      {options.map((option) => {
        const on = chosen.includes(option);
        const locked = disabled || (on && last);
        return (
          <label key={option} htmlFor={`${name}-${option}`}>
            <input
              id={`${name}-${option}`}
              type="checkbox"
              name={name}
              checked={on}
              disabled={locked}
              title={
                on && last && !disabled
                  ? `A grader must ${legend.toLowerCase()} at least one thing, or it could never fire.`
                  : why
              }
              onChange={() =>
                onChange(
                  settled(
                    options,
                    on
                      ? chosen.filter((value) => value !== option)
                      : [...chosen, option],
                  ),
                )
              }
            />
            {option}
          </label>
        );
      })}
      {why === undefined ? null : <small>{why}</small>}
    </fieldset>
  );
}

/**
 * The fields this type's judgment is made of, and no others.
 *
 * Versioned content, every one of them: saving any of these mints a version, so
 * the section says so once rather than the fields saying it four times.
 */
export function ConfigFields({
  type,
  config,
  disabled,
  onChange,
}: {
  readonly type: GraderType;
  readonly config: ConfigDraft;
  readonly disabled: boolean;
  readonly onChange: (config: ConfigDraft) => void;
}) {
  const set = (changes: ConfigDraft) => onChange({ ...config, ...changes });

  if (type === "llm_rubric") {
    return (
      <TextArea
        id="grader-rubric"
        label="Rubric"
        hint="The criteria a judge model reads, in your own words."
        value={String(config.rubric ?? "")}
        disabled={disabled}
        onChange={(rubric) => set({ rubric })}
      />
    );
  }

  if (type === "metric_threshold") {
    return (
      <>
        <Field label="Measure" htmlFor="grader-measure">
          <TextInput
            id="grader-measure"
            value={String(config.measure ?? "")}
            onChange={(measure) => set({ measure })}
          />
          <small>
            The name of what egma measured. A name nothing emits is refused when
            you save, because a grader reading it could never fire.
          </small>
        </Field>
        <Choice
          id="grader-aggregation"
          label="Reduced by"
          value={String(config.aggregation ?? "p90")}
          options={["mean", "median", "p90", "p95", "max", "min", "sum", "count"]}
          disabled={disabled}
          onChange={(aggregation) => set({ aggregation })}
        />
        <Choice
          id="grader-comparator"
          label="Passes when it is"
          value={String(config.comparator ?? "below")}
          options={["below", "at_most", "above", "at_least"]}
          disabled={disabled}
          onChange={(comparator) => set({ comparator })}
        />
        <Field label="Threshold" htmlFor="grader-threshold">
          <input
            id="grader-threshold"
            type="number"
            value={String(config.threshold ?? 0)}
            disabled={disabled}
            onChange={(event) => set({ threshold: Number(event.target.value) })}
          />
        </Field>
      </>
    );
  }

  if (type === "tool_calls") {
    return (
      <>
        <TextArea
          id="grader-required-tools"
          label="Tools that must have fired"
          hint="One tool name per line."
          value={linesOf(toolNames(config.required))}
          disabled={disabled}
          onChange={(lines) => set({ required: toolsFromLines(lines) })}
        />
        <TextArea
          id="grader-forbidden-tools"
          label="Tools that must never fire"
          hint="One tool name per line."
          value={linesOf(toolNames(config.forbidden))}
          disabled={disabled}
          onChange={(lines) => set({ forbidden: toolsFromLines(lines) })}
        />
      </>
    );
  }

  return (
    <>
      <TextArea
        id="grader-required-phrases"
        label="Words that must be said"
        hint="One phrase per line."
        value={linesOf(phraseTexts(config.required))}
        disabled={disabled}
        onChange={(lines) => set({ required: phrasesFromLines(lines) })}
      />
      <TextArea
        id="grader-banned-phrases"
        label="Words that must never be said"
        hint="One phrase per line."
        value={linesOf(phraseTexts(config.banned))}
        disabled={disabled}
        onChange={(lines) => set({ banned: phrasesFromLines(lines) })}
      />
      <Choice
        id="grader-speaker"
        label="Whose turns are searched"
        value={String(config.speaker ?? "agent")}
        options={["agent", "persona", "either"]}
        disabled={disabled}
        onChange={(speaker) => set({ speaker })}
      />
    </>
  );
}

/**
 * What the grader may look at and which conversations it can score.
 *
 * **Reads are the registry's for three of the four types.** A threshold reads
 * measures because that is what a threshold *is*; a tool check reads tool
 * calls; a phrase check reads the transcript. There is no author decision in
 * any of them, so the control states the fact rather than offering a choice
 * that would be refused. Only a rubric's author chooses, because only they know
 * what their criteria are written about.
 *
 * **Every type may narrow its modalities**, and narrowing has one consequence
 * worth stating on the page: a grader that cannot score a simulation's modality
 * is `skipped`, never failed. That is the difference between "this check was
 * never about this conversation" and "the agent got it wrong".
 */
export function EvidenceFields({
  registry,
  type,
  reads,
  modalities,
  disabled,
  onReads,
  onModalities,
}: {
  readonly registry: GraderRegistry | null;
  readonly type: GraderType;
  readonly reads: readonly GraderRead[];
  readonly modalities: readonly Modality[];
  readonly disabled: boolean;
  readonly onReads: (reads: readonly GraderRead[]) => void;
  readonly onModalities: (modalities: readonly Modality[]) => void;
}) {
  const chosen = readsAreChosen(registry, type);
  const fixed = defaultReads(registry, type);

  return (
    <>
      {chosen ? (
        <SetOf
          legend="Reads"
          name="grader-reads"
          options={registry?.reads ?? []}
          chosen={reads}
          disabled={disabled}
          why="What the judge is shown. Changing it makes a new version."
          onChange={onReads}
        />
      ) : (
        <p>
          Reads {fixed.join(", ")}. A {type} grader reads that because it is what
          this kind of judgment is made of — it is not a choice.
        </p>
      )}

      <SetOf
        legend="Scores"
        name="grader-modalities"
        options={ALL_MODALITIES}
        chosen={modalities}
        disabled={disabled}
        why="A grader that cannot score a simulation's modality is skipped, never failed."
        onChange={onModalities}
      />
    </>
  );
}

/**
 * The settings that take effect everywhere the moment they are written.
 *
 * None of them changes what any verdict already made meant, which is why they
 * mint no version — and why the production sampling control only appears once
 * production is in scope. A rate on a simulations-only grader is a number that
 * changes nothing, and offering it would suggest otherwise.
 */
export function LiveFields({
  name,
  description,
  priority,
  scope,
  sampleRate,
  disabled,
  onChange,
}: {
  readonly name: string;
  readonly description: string;
  readonly priority: Priority;
  readonly scope: Scope;
  readonly sampleRate: number;
  readonly disabled: boolean;
  readonly onChange: (changes: {
    readonly name?: string;
    readonly description?: string;
    readonly priority?: Priority;
    readonly scope?: Scope;
    readonly sampleRate?: number;
  }) => void;
}) {
  return (
    <>
      <Field label="Name" htmlFor="grader-name">
        <TextInput
          id="grader-name"
          value={name}
          onChange={(next) => onChange({ name: next })}
        />
      </Field>
      <TextArea
        id="grader-description"
        label="Description"
        value={description}
        disabled={disabled}
        onChange={(next) => onChange({ description: next })}
      />
      <Choice
        id="grader-priority"
        label="Priority"
        value={priority}
        options={["P0", "P1", "P2"] as const}
        disabled={disabled}
        onChange={(next) => onChange({ priority: next })}
      />
      <Choice
        id="grader-scope"
        label="Applies to"
        value={scope}
        options={["simulations", "production", "both"] as const}
        disabled={disabled}
        onChange={(next) => onChange({ scope: next })}
      />
      {samplingApplies(scope) ? (
        <Field label="Production sampling (%)" htmlFor="grader-sample-rate">
          <input
            id="grader-sample-rate"
            type="number"
            min={0}
            max={100}
            value={String(sampleRate)}
            disabled={disabled}
            onChange={(event) =>
              onChange({ sampleRate: Number(event.target.value) })
            }
          />
          <small>
            How much of the traffic egma did not cause gets judged. Simulations
            are always all judged.
          </small>
        </Field>
      ) : null}
    </>
  );
}

/** The one line a shelf and an editor both use to say what a type judges by. */
export function typeSummary(type: GraderType): string {
  return TYPE_SUMMARY[type];
}

/** A section with its heading and the one sentence that says what saving does. */
export function EditSection({
  title,
  effect,
  children,
}: {
  readonly title: string;
  readonly effect: string;
  readonly children: ReactNode;
}) {
  return (
    <section aria-label={title}>
      <h2>{title}</h2>
      <p>{effect}</p>
      {children}
    </section>
  );
}
