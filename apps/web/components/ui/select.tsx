"use client";

import { cva, type VariantProps } from "class-variance-authority";
import type { ComponentProps } from "react";

import { useFieldHint } from "@/ui/field-hint.ts";
import { cn } from "@/lib/utils";

/**
 * Use native select behavior for forms, keyboard input, and platform pickers.
 * Shared CSS styles the trigger and supported custom pickers. Callers supply
 * options. Default to the larger form size; compact sizes retain coarse-pointer targets.
 */
const selectVariants = cva(
  [
    "w-full min-w-0 rounded-input border border-input bg-surface pl-3 pr-10",
    "text-base text-foreground",
    "disabled:cursor-not-allowed disabled:opacity-60",
    /* "Pointer targets are at least 44px on coarse pointers." */
    "pointer-coarse:min-h-(--tap-target)",
  ],
  {
    variants: {
      size: {
        /* Denser still, for a control inside a row rather than above a list. */
        sm: "min-h-(--control-sm)",
        /* 36px: the toolbar control, and the one a table row holds. */
        default: "min-h-(--control-md)",
        /* 44px: the form control, which is what a field or a sheet holds. */
        lg: "min-h-(--control-lg)",
      },
    },
    defaultVariants: { size: "lg" },
  },
);

/** The browser can flip the picker above the field when there is more room. */
function followPickerOrigin(select: HTMLSelectElement): void {
  if (!globalThis.CSS?.supports("appearance", "base-select")) return;
  requestAnimationFrame(() => {
    if (!select.isConnected || !select.matches(":open")) return;
    const selected = select.selectedOptions[0];
    if (!selected) return;
    const field = select.getBoundingClientRect();
    const option = selected.getBoundingClientRect();
    select.style.setProperty(
      "--select-picker-origin",
      option.bottom <= field.top ? "bottom" : "top",
    );
  });
}

function Select({
  className,
  size,
  onPointerDown,
  onKeyDown,
  ...props
}: Omit<ComponentProps<"select">, "size"> &
  VariantProps<typeof selectVariants>) {
  const hint = useFieldHint();

  return (
    <select
      data-slot="select"
      className={cn(selectVariants({ size }), className)}
      {...props}
      onPointerDown={(event) => {
        onPointerDown?.(event);
        if (!event.defaultPrevented) followPickerOrigin(event.currentTarget);
      }}
      onKeyDown={(event) => {
        onKeyDown?.(event);
        if (!event.defaultPrevented) followPickerOrigin(event.currentTarget);
      }}
      /* After the spread, so a caller passing nothing cannot erase the hint. */
      aria-describedby={props["aria-describedby"] ?? hint}
    />
  );
}

export { Select, selectVariants };
