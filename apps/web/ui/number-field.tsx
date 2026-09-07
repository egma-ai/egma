"use client";

import { useId } from "react";

import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

import { LabelText } from "./form.tsx";

/**
 * Numeric input with native min/max/step, tabular digits, and an accessible unit.
 * Keep values as strings until submission so empty and partial drafts survive.
 * Hide native spin buttons while retaining keyboard stepping.
 */
export function NumberField({
  id,
  label,
  value,
  onChange,
  hint,
  unit,
  min,
  max,
  step,
  name,
  placeholder,
  disabled = false,
  readOnly = false,
  required = false,
  invalid,
  describedBy,
}: {
  readonly id: string;
  /** What the value is. Visible, because placeholder text is not a label. */
  readonly label: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  /** What to write in it, or what changing it will do. */
  readonly hint?: string;
  /** Percent, seconds, turns — shown in the field and read out with it. */
  readonly unit?: string;
  readonly min?: number;
  readonly max?: number;
  /**
   * The size of one step, which is also what says whether this is a whole
   * number. Left off, the browser's own default of 1 applies.
   */
  readonly step?: number;
  /** The name submitted by a native form. */
  readonly name?: string;
  readonly placeholder?: string;
  /**
   * Genuinely inert, to pointer and keyboard alike. The server refuses the
   * write either way, which is where the boundary actually is.
   */
  readonly disabled?: boolean;
  /** A value shown for context but not editable. */
  readonly readOnly?: boolean;
  readonly required?: boolean;
  /** Whether this field is what a refusal was about. */
  readonly invalid?: boolean;
  /**
   * The element saying what is wrong, so the two are read together. It wins
   * over the hint, because a field that is being refused has something more
   * urgent to say than what to write in it.
   */
  readonly describedBy?: string;
}) {
  const own = useId();
  const hintId = `${own}-hint`;
  const unitId = `${own}-unit`;

  /*
   * What the field is described by, in the order it should be read: the
   * refusal if there is one, otherwise the hint, and the unit either way.
   * Joined rather than replaced, so naming a refusal never silences the unit.
   */
  const described = [
    describedBy ?? (hint === undefined ? undefined : hintId),
    unit === undefined ? undefined : unitId,
  ]
    .filter((one): one is string => one !== undefined)
    .join(" ");

  /*
   * A whole number gets the digits-only keypad. A step that is not a whole
   * number needs the separator, so it asks for the decimal one instead.
   */
  const keypad =
    step === undefined || Number.isInteger(step) ? "numeric" : "decimal";

  return (
    <div className="flex flex-col gap-2" data-slot="number-field">
      <label className="text-sm font-medium text-foreground" htmlFor={id}>
        <LabelText label={label} />
      </label>
      {/*
       * Place the unit beside the input so it takes its measured width instead of
       * a fixed inset that could overlap a long value.
       */}
      <div className="flex items-center gap-2">
        <Input
          className={cn(
            "min-w-0 flex-1 tabular-nums",
            /*
             * The spin buttons, in both families of browser. They are drawn
             * differently by each and match nothing else in this product.
             */
            "[appearance:textfield]",
            "[&::-webkit-inner-spin-button]:appearance-none",
            "[&::-webkit-outer-spin-button]:appearance-none",
          )}
          id={id}
          name={name}
          type="number"
          inputMode={keypad}
          value={value}
          placeholder={placeholder}
          min={min}
          max={max}
          step={step}
          disabled={disabled}
          readOnly={readOnly}
          required={required}
          aria-required={required === true ? true : undefined}
          aria-invalid={invalid === true ? true : undefined}
          aria-describedby={described === "" ? undefined : described}
          autoComplete="off"
          onChange={(event) => onChange(event.target.value)}
        />
        {unit === undefined ? null : (
          <span className="shrink-0 text-sm text-muted-foreground" id={unitId}>
            {unit}
          </span>
        )}
      </div>
      {hint === undefined ? null : (
        <p className="m-0 text-sm text-faint" id={hintId}>
          {hint}
        </p>
      )}
    </div>
  );
}
