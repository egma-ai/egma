"use client";

import { useRef } from "react";

import { cn } from "@/lib/utils";

/**
 * Which of two lists a page is showing.
 *
 * **Two lists, chosen deliberately, never one list with a column saying which
 * rows are archived.** A mixed list is a list somebody picks the wrong row out
 * of.
 *
 * It is announced as a radio group because that is what it is — exactly one of
 * a small closed set is chosen — and every option is reachable with Tab and
 * chosen with Enter or Space, which is what a `button` gives for free.
 *
 * It is not a shadcn Tabs or ToggleGroup. Both would draw this, and both would
 * say something else about it: tabs name panels that a page is switching
 * between, and this switches which rows a table is asked for. The radio group
 * is what a person's assistive technology is told, and it is what the old
 * control set already said.
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
  /**
   * The radios themselves, so that moving with an arrow key can put focus on
   * the one it moved to. A radio group that changes selection without moving
   * focus leaves a screen reader announcing one thing and the keyboard on
   * another.
   */
  const radios = useRef<(HTMLButtonElement | null)[]>([]);

  const move = (from: number, by: number) => {
    const to = (from + by + options.length) % options.length;
    const going = options[to];
    if (going === undefined) return;
    onChange(going.value);
    radios.current[to]?.focus();
  };

  const STEPS: Readonly<Record<string, number>> = {
    ArrowRight: 1,
    ArrowDown: 1,
    ArrowLeft: -1,
    ArrowUp: -1,
  };

  return (
    <div
      className="inline-flex rounded-input border border-border bg-surface p-0.5"
      role="radiogroup"
      aria-label={label}
    >
      {options.map((option, at) => (
        <button
          key={option.value}
          ref={(held) => {
            radios.current[at] = held;
          }}
          className={cn(
            "inline-flex h-[calc(var(--control-md)-6px)] items-center px-4",
            "rounded-[calc(var(--radius-sm)-1px)] border-0 bg-transparent",
            "cursor-pointer text-sm whitespace-nowrap text-muted-foreground",
            /*
             * A real touch target on a coarse pointer, without growing the
             * control a mouse gets. The group's own height follows the item.
             */
            "pointer-coarse:min-h-(--tap-target)",
            "pointer-hover:text-foreground",
            /* Pointer press feedback only. Keyboard activation is immediate. */
            "transition-transform duration-(--duration-press) ease-out",
            "[&:active:not(:focus-visible)]:scale-97",
            "motion-reduce:transition-none",
            "motion-reduce:[&:active:not(:focus-visible)]:scale-100",
            option.value === value && [
              "bg-selected text-foreground",
              /*
               * The chosen option carries an Ember underline as well as the
               * wash, because state is never colour alone.
               */
              "shadow-[inset_0_-2px_0_var(--accent)]",
            ],
          )}
          type="button"
          role="radio"
          aria-checked={option.value === value}
          /**
           * Roving: the group is one Tab stop, and the arrow keys move inside
           * it. Every option being tabbable would make a two-option filter
           * cost two Tab presses on the way to the table, and a ten-option one
           * cost ten.
           */
          tabIndex={option.value === value ? 0 : -1}
          onKeyDown={(event) => {
            const step = STEPS[event.key];
            if (step !== undefined) {
              event.preventDefault();
              move(at, step);
              return;
            }
            if (event.key === "Home" || event.key === "End") {
              event.preventDefault();
              move(at, event.key === "Home" ? -at : options.length - 1 - at);
            }
          }}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
