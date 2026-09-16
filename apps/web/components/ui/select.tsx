"use client";

import { cva, type VariantProps } from "class-variance-authority";
import { CheckIcon, ChevronDownIcon } from "lucide-react";
import { Select as SelectPrimitive } from "radix-ui";
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
    /* A dropdown sits on the soft grey surface, so a field that opens a list looks different from one that takes typing. */
    "w-full min-w-0 rounded-input border border-input bg-surface-soft pl-3 pr-10",
    "text-sm text-foreground",
    /* Touch screens keep 16px text: iOS zooms the page into any focused control set smaller. */
    "pointer-coarse:text-base",
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

type DownwardSelectOption = {
  readonly value: string;
  readonly label: string;
  readonly disabled?: boolean;
};

/**
 * A select whose picker opens below its trigger when the window has room
 * there and above it when it does not, the way any dropdown places itself.
 * The page never moves to make room: the list is capped to the space Radix
 * measures on the side it chose, and scrolls inside that.
 */
function DownwardSelect({
  id,
  value,
  options,
  disabled = false,
  required = false,
  className,
  onValueChange,
}: {
  readonly id: string;
  readonly value: string;
  readonly options: readonly DownwardSelectOption[];
  readonly disabled?: boolean;
  readonly required?: boolean;
  /** Classes for the trigger, merged after the shared select styles. */
  readonly className?: string;
  readonly onValueChange: (value: string) => void;
}) {
  const hint = useFieldHint();

  return (
    <SelectPrimitive.Root
      value={value}
      disabled={disabled}
      required={required}
      onValueChange={onValueChange}
    >
      <SelectPrimitive.Trigger
        id={id}
        data-slot="select"
        className={cn(selectVariants({ size: "lg" }), "flex items-center justify-between gap-3 pr-3", className)}
        aria-required={required ? "true" : undefined}
        aria-describedby={hint}
      >
        <SelectPrimitive.Value />
        <SelectPrimitive.Icon asChild>
          <ChevronDownIcon className="size-4 flex-none text-faint" aria-hidden="true" />
        </SelectPrimitive.Icon>
      </SelectPrimitive.Trigger>
      <SelectPrimitive.Portal>
        <SelectPrimitive.Content
          data-slot="downward-select-content"
          position="popper"
          side="bottom"
          align="start"
          sideOffset={8}
          collisionPadding={8}
          className={cn(
            "z-30 flex w-(--radix-select-trigger-width) flex-col overflow-hidden",
            "max-h-[calc(var(--radix-select-content-available-height)-var(--space-2))]",
            "border border-border bg-popover text-popover-foreground shadow-popover outline-none",
          )}
        >
          <SelectPrimitive.Viewport className="min-h-0 max-h-(--dropdown-max-height) overflow-y-auto p-1">
            {options.map((option) => (
              <SelectPrimitive.Item
                key={option.value}
                value={option.value}
                disabled={option.disabled}
                className="flex min-h-(--control-md) cursor-pointer items-center gap-3 px-3 py-2 text-sm text-foreground outline-none data-[disabled]:pointer-events-none data-[disabled]:text-faint data-[highlighted]:bg-surface-soft data-[state=checked]:bg-surface-active pointer-coarse:min-h-(--tap-target)"
              >
                <SelectPrimitive.ItemText>{option.label}</SelectPrimitive.ItemText>
                <SelectPrimitive.ItemIndicator className="ml-auto flex-none text-brand">
                  <CheckIcon className="size-4" aria-hidden="true" />
                </SelectPrimitive.ItemIndicator>
              </SelectPrimitive.Item>
            ))}
          </SelectPrimitive.Viewport>
        </SelectPrimitive.Content>
      </SelectPrimitive.Portal>
    </SelectPrimitive.Root>
  );
}

export { DownwardSelect, Select, selectVariants, type DownwardSelectOption };
