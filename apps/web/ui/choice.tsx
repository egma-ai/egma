"use client";

import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";

/**
 * Which of two lists a page is showing.
 *
 * **Two lists, chosen deliberately, never one list with a column saying which
 * rows are archived.** A mixed list is a list somebody picks the wrong row out
 * of.
 *
 * It is announced as a radio group because that is what it is — exactly one of
 * a small closed set is chosen. The group is one Tab stop, the arrow keys move
 * inside it and come back round, Home and End reach the ends, and selection
 * follows focus so the keyboard and the announcement never disagree. None of
 * that is written here any more: it is the kit's radio group, which is Radix's,
 * and every part of it used to be hand-written in this file where a refactor
 * could lose it without one visible pixel changing.
 *
 * It is not a shadcn Tabs or ToggleGroup. Both would draw this, and both would
 * say something else about it: tabs name panels that a page is switching
 * between, and this switches which rows a table is asked for. The radio group
 * is what a person's assistive technology is told.
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
