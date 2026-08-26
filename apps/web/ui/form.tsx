"use client";

import { useId, type ReactNode } from "react";

import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

import { FieldHintContext } from "./field-hint.ts";

/**
 * A form, the rows it is laid out in, the fields inside it, and the three
 * sentences a form says.
 *
 * The seven pieces are one file because they are one thing: no page decides
 * for itself how far a form runs across a wide screen, how two fields sit
 * beside each other, or what a refusal looks like above the form it refused.
 *
 * They are here rather than in `components/ui/` because that directory holds
 * shadcn's own primitives, added with its CLI and named as the registry names
 * them. These are egma's compositions *of* those primitives — a `Field` wraps
 * whichever control it is given — so they live beside the product's other
 * shared components, which is where every page already looks for them.
 */

/**
 * A label's own words, with a mandatory field's star drawn in Ember.
 *
 * `DESIGN.md` sets one label grammar for the whole product: a mandatory
 * field's label ends in `*` and an optional one ends in `[optional]`. The
 * colour of that star is Ember, and it is decided here rather than by each
 * screen, so one star cannot be a different colour from the next.
 *
 * **The star stays inside the label's own text.** It is a `<span>` for its
 * colour and its 4px of air, not a separate element beside the label, so the
 * name a screen reader announces is exactly the name it announced before —
 * and the star's promise is still kept by `aria-required` on the control,
 * which is the half no styling can stand in for.
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

/**
 * A labelled field, and the hint it lends to whatever control it wraps.
 *
 * The hint's id travels through context rather than through a prop: a caller
 * wiring `aria-describedby` by hand forgets exactly the fields nobody checks,
 * because the page still looks right without it. `field-hint.ts` says why it
 * is a context and holds the context itself.
 *
 * The label is the kit's, which is Radix's: a double click on a plain `<label>`
 * selects the words around it, which is what a person sees when they meant to
 * select the value in the field beside it.
 */
export function Field({
  label,
  htmlFor,
  hint,
  children,
}: {
  readonly label: string;
  readonly htmlFor: string;
  /** One line saying what belongs here, for a field whose name is not enough. */
  readonly hint?: ReactNode;
  readonly children: ReactNode;
}) {
  const said = useId();

  return (
    <div className="flex flex-col gap-2" data-slot="field">
      <Label htmlFor={htmlFor}>
        <LabelText label={label} />
      </Label>
      <FieldHintContext.Provider value={hint === undefined ? undefined : said}>
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
 * The form itself.
 *
 * It is held to 72ch because a line somebody has to read across is a line they
 * lose their place in, and it is the same measure every editor in the product
 * is set at.
 *
 * The first `Section` inside a form loses its top margin: the form's own
 * padding has already opened the space, and the margin on top of it read as a
 * gap nobody asked for. The rule is on the form rather than on the section
 * because it is the form that knows it is first.
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

/**
 * What went wrong with one field, or with the whole form.
 *
 * It is announced rather than merely coloured, and it never replaces what
 * somebody typed. A refusal that cleared the form would make the person type
 * their work again to find out whether the second attempt fails the same way.
 *
 * `Refused` is the same news one level up: this one names a field, that one
 * heads the form it refused and can carry the way to ask again.
 */
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
