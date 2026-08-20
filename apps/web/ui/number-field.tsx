"use client";

import { useId } from "react";

import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

/**
 * A field whose value is a number, with its bounds and its unit on it.
 *
 * The shared control set has never had one. Two places in the product needed
 * one and got a text field told to look numeric instead: a grader's numeric
 * parameter, and the share of live traffic a running grader judges. Both then
 * had to say the rest in prose — "a whole percentage from 0 to 100" is a
 * sentence beside a control that would happily take 900, and a bound with a
 * unit had the unit written into its hint because the field could not show it.
 *
 * So this control carries the three things that sentence was standing in for:
 *
 * - **The bounds are on the field.** `min`, `max` and `step` are the browser's
 *   own validation and the browser's own arrow-key stepping. A caller that
 *   knows the range says it once here instead of twice, once in prose.
 * - **The unit is beside the value**, inside the field and at the trailing
 *   edge, and it is part of what the field is described by rather than being
 *   hidden decoration. A person reading with a screen reader is told the unit.
 * - **The digits are tabular**, because `DESIGN.md` asks that of every metric,
 *   and a value somebody is editing against a limit is exactly that.
 *
 * **The value stays a string, and that is deliberate.** An input's value is a
 * string whatever type it wears, and this product converts at the edge that
 * sends — `filledParams` is where a bound becomes a number. A control that
 * handed back a number would have to decide what an empty field and a
 * half-typed minus sign are, and it would decide differently from that edge.
 *
 * The native spin buttons are hidden. They are drawn differently by every
 * browser, they are the one part of a form that never matches the rest of it,
 * and they take a pointer to a target smaller than this product allows
 * anywhere else. Nothing is lost to the keyboard: the arrow keys still step
 * the value, because the field is still `type="number"`.
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
        {label}
      </label>
      {/*
       * The unit sits beside the field rather than inside it.
       *
       * Inside, the field has to reserve room for it, and the room has to be a
       * fixed number — which is a guess about the longest unit anybody will
       * ever pass. The first guess was 56px, and "seconds" already needs more
       * than that, so a value long enough to reach it would have slid under
       * the word. Beside it, the field takes whatever is left and every unit
       * fits, including ones nobody has written yet.
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
