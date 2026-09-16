"use client";

import { CheckIcon, ChevronDownIcon } from "lucide-react";
import { useId, useState, type ReactNode } from "react";

import {
  Command,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { useFieldHint } from "@/ui/field-hint.ts";

export type SearchableOption = {
  readonly value: string;
  readonly label: string;
  readonly detail?: string;
};

/** A searchable single-choice field with truthful loading and failure states. */
export function SearchableSelect({
  id,
  value,
  displayValue,
  options,
  search,
  searchLabel,
  searchPlaceholder,
  disabled = false,
  required = false,
  invalid = false,
  loading = false,
  error,
  toolbar,
  empty,
  emptyDetail,
  emptyAction,
  className,
  onSearchChange,
  onValueChange,
}: {
  readonly id: string;
  readonly value: string;
  readonly displayValue: string;
  readonly options: readonly SearchableOption[];
  readonly search: string;
  readonly searchLabel: string;
  readonly searchPlaceholder: string;
  readonly disabled?: boolean;
  readonly required?: boolean;
  readonly invalid?: boolean;
  readonly loading?: boolean;
  readonly error?: ReactNode;
  readonly toolbar?: ReactNode;
  /** Classes for the trigger, merged after the shared field styles. */
  readonly className?: string;
  readonly empty: string;
  readonly emptyDetail?: string;
  readonly emptyAction?: ReactNode;
  readonly onSearchChange: (value: string) => void;
  readonly onValueChange: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const hint = useFieldHint();
  const list = useId();

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          id={id}
          className={cn(
            "flex min-h-(--control-lg) w-full min-w-0 items-center justify-between gap-3",
            "rounded-input border border-input bg-surface-soft px-3 text-left text-sm text-foreground",
            /* Touch screens keep 16px text: iOS zooms the page into any focused control set smaller. */
            "pointer-coarse:text-base",
            "disabled:cursor-not-allowed disabled:opacity-60",
            "pointer-coarse:min-h-(--tap-target)",
            className,
          )}
          type="button"
          role="combobox"
          disabled={disabled}
          aria-required={required ? "true" : undefined}
          aria-invalid={invalid ? "true" : undefined}
          aria-describedby={hint}
          aria-expanded={open}
          aria-controls={list}
          aria-haspopup="listbox"
        >
          <span className="min-w-0 truncate">{displayValue}</span>
          <ChevronDownIcon className="size-4 flex-none text-faint" aria-hidden="true" />
        </button>
      </PopoverTrigger>
      {/* Below the field when the window has room there, above it when not; the page never moves. */}
      <PopoverContent
        align="start"
        side="bottom"
        className="w-(--radix-popover-trigger-width) min-w-[min(var(--searchable-select-min-width),calc(100vw-var(--space-8)))] p-0"
        aria-label={searchLabel}
      >
        <Command label={searchLabel}>
          <CommandInput
            autoFocus
            placeholder={searchPlaceholder}
            value={search}
            onValueChange={onSearchChange}
          />
          {toolbar}
          <CommandList id={list} role="listbox">
            {error !== undefined && error !== null ? (
              <p className="m-0 px-3 py-3 text-sm text-failure" role="alert">
                {error}
              </p>
            ) : loading ? (
              <p className="m-0 px-3 py-3 text-sm text-muted-foreground">
                Loading choices…
              </p>
            ) : options.length === 0 ? (
              <div className="flex flex-col items-start gap-2 px-3 py-4">
                <p className="m-0 text-base font-medium text-foreground">{empty}</p>
                {emptyDetail === undefined ? null : (
                  <p className="m-0 text-sm text-muted-foreground">{emptyDetail}</p>
                )}
                {emptyAction}
              </div>
            ) : (
              <CommandGroup>
                {options.map((option) => (
                  <CommandItem
                    key={option.value}
                    value={option.value}
                    aria-checked={option.value === value}
                    onSelect={() => {
                      onValueChange(option.value);
                      setOpen(false);
                    }}
                  >
                    <span className="flex w-5 flex-none items-center justify-center">
                      {option.value === value ? (
                        <CheckIcon className="size-4 text-brand" aria-hidden="true" />
                      ) : null}
                    </span>
                    <span className="min-w-0 flex-1 truncate">{option.label}</span>
                    {option.detail === undefined ? null : (
                      <span className="w-20 flex-none truncate text-right text-faint">
                        {option.detail}
                      </span>
                    )}
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
