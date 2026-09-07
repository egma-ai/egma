"use client";

import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";

/**
 * Choose one list filter with a radio group. The shared primitive owns arrow
 * keys and focus; this changes queried rows rather than switching tab panels.
 */
export function Choice<Value extends string>({
  label,
  value,
  options,
  onChange,
}: {
  readonly label: string;
  readonly value: Value;
  readonly options: readonly { readonly value: Value; readonly label: string }[];
  readonly onChange: (value: Value) => void;
}) {
  return (
    <RadioGroup
      className="inline-flex gap-0 rounded-input border border-border bg-surface p-0.5"
      aria-label={label}
      value={value}
      /*
       * Radix reports the chosen value as a `string`, because it does not know
       * the closed set this group was built from. Every item below was given
       * one of `options`, and Radix returns the value it was given, so the
       * narrowing is a fact about this component rather than a hope.
       */
      onValueChange={(chosen) => onChange(chosen as Value)}
    >
      {options.map((option) => (
        <RadioGroupItem key={option.value} shape="segment" value={option.value}>
          {option.label}
        </RadioGroupItem>
      ))}
    </RadioGroup>
  );
}
