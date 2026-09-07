"use client";

import { useId, type ReactNode } from "react";

import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

import { FieldHintContext } from "./field-hint.ts";

/**
 * Shared form compositions built from input primitives: layout, fields,
 * hints, and save/refusal feedback.
 */

/**
 * Render trailing required stars in the form accent color and preserve them
 * inside the label. Controls still need aria-required. Grid column headings
 * use their own muted marker and accessible name.
 */
export function LabelText({ label }: { readonly label: string }) {
  if (!label.endsWith("*")) return <>{label}</>;
  return (
    <span>
      {label.slice(0, -1)}
      <span className="pl-1 text-brand">*</span>
    </span>
  );
}

/** Provide the hint ID to nested controls and render the shared label primitive. */
export function Field({
  label,
  htmlFor,
  annotation,
  hint,
  children,
}: {
  readonly label: string;
  readonly htmlFor: string;
  /**
   * Describe a value mapping beside the label without changing the control's
   * accessible name. Reserve square brackets for the optional-field marker.
   */
  readonly annotation?: string;
  /** One line saying what belongs here, for a field whose name is not enough. */
  readonly hint?: ReactNode;
  readonly children: ReactNode;
}) {
  const said = useId();
  const noted = useId();
  const describes = [
    annotation === undefined ? undefined : noted,
    hint === undefined ? undefined : said,
  ].filter((one) => one !== undefined).join(" ");

  return (
    <div className="flex flex-col gap-2" data-slot="field">
      <div className="flex flex-wrap items-baseline gap-2">
        <Label htmlFor={htmlFor}>
          <LabelText label={label} />
        </Label>
        {annotation === undefined ? null : (
          <span className="text-sm text-faint" id={noted}>
            {annotation}
          </span>
        )}
      </div>
      <FieldHintContext.Provider value={describes === "" ? undefined : describes}>
        {children}
      </FieldHintContext.Provider>
      {hint === undefined ? null : (
        <p
          className="m-0 text-sm leading-(--line-normal) text-faint"
          id={said}
        >
          {hint}
        </p>
      )}
    </div>
  );
}

/**
 * Limit form reading width and remove the first section's extra top margin
 * where form padding already supplies separation.
 */
export function Form({
  onSubmit,
  children,
}: {
  readonly onSubmit?: () => void;
  readonly children: ReactNode;
}) {
  return (
    <form
      className={cn(
        "flex max-w-[72ch] flex-col gap-5",
        "rounded-card border border-border bg-surface p-6",
        "max-[900px]:p-5",
        "[&>[data-slot=section]:first-child]:mt-0",
      )}
      data-slot="form"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit?.();
      }}
    >
      {children}
    </form>
  );
}

/**
 * Two or more fields side by side, and one under the other once there is no
 * room for that. `auto-fit` is the whole of the responsive story for every
 * editor in the product: no page names a breakpoint of its own.
 */
export function FormRow({ children }: { readonly children: ReactNode }) {
  return (
    <div className="grid grid-cols-[repeat(auto-fit,minmax(180px,1fr))] items-start gap-4">
      {children}
    </div>
  );
}

/** The controls that finish a form. */
export function FormActions({ children }: { readonly children: ReactNode }) {
  return (
    <div
      className="flex items-center gap-3 pt-2 max-[900px]:flex-wrap"
      data-slot="form-actions"
    >
      {children}
    </div>
  );
}

/**
 * The sentence under a field that says what to write in it.
 *
 * It is the server's own words for a connection field, relayed unchanged: the
 * registry knows what a token endpoint is for and this application deliberately
 * does not, so paraphrasing here would put a second, quieter description beside
 * the one that is kept in step with the gate.
 */
export function Help({
  id,
  children,
}: {
  readonly id?: string;
  readonly children: ReactNode;
}) {
  return (
    <p
      className="m-0 text-sm leading-(--line-normal) text-muted-foreground"
      id={id}
    >
      {children}
    </p>
  );
}

/** Announce field or form refusal without clearing the user's draft. */
export function Problem({
  id,
  children,
}: {
  readonly id?: string;
  readonly children: ReactNode;
}) {
  return (
    <p
      className="m-0 text-sm leading-(--line-normal) text-failure"
      id={id}
      role="alert"
    >
      {children}
    </p>
  );
}

/**
 * What a page says when a write was refused.
 *
 * **The refusal's own sentence, shown unchanged, above the form that was
 * refused — and the form keeps everything typed into it.** A refusal that
 * cleared the fields would make somebody retype an afternoon's work to find
 * out whether the second attempt fails the same way, which is how a person
 * learns to stop trying.
 */
export function Refused({
  message,
  action,
}: {
  readonly message: string;
  readonly action?: ReactNode;
}) {
  return (
    <div
      className={cn(
        "flex flex-col items-start gap-3",
        "rounded-input border border-failure bg-surface p-4",
      )}
      role="alert"
    >
      <p className="m-0 max-w-[72ch] text-base leading-(--line-normal) text-failure">
        {message}
      </p>
      {action}
    </div>
  );
}
