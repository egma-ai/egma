"use client";

import Image from "next/image";
import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

import { useTheme } from "../ui/theme.tsx";
import { TrustGate } from "./trust-gate.tsx";

/**
 * The access pages' own shell, and nothing else.
 *
 * Signing in, signing up, accepting an invitation and authorizing a terminal
 * are not product pages: nobody has a project yet, there is nothing to navigate
 * between, and the page is the whole of what somebody is doing. They keep the
 * wide, unhurried composition here, and the large type `DESIGN.md` reserves for
 * auth, onboarding and public pages.
 *
 * **Everything a signed-in product page is drawn inside lives in `ui/`** — the
 * compact shell, the selector, the navigation, the page states, the lists and
 * the controls. This file re-exports the four pieces that pages already name so
 * that a page composes its own subject and never its own frame.
 *
 * **The controls here are the product's controls.** This surface once carried
 * its own `Button`, `TextInput` and `Field`; they are gone, and what is left is
 * composition — a shell, a card, a notice and a line of links. There is one
 * control vocabulary in this product and it is the shadcn base.
 */
export {
  AppShell,
  PageBody,
  PageHeader,
  ProductPage,
  ProductStatePage,
} from "../ui/shell.tsx";

/**
 * The full Egma logo, which belongs here and not in the signed-in sidebar.
 *
 * The dark-theme treatment is an arbitrary variant rather than a `dark:` one
 * because this product has no `dark:` variant: every other surface changes with
 * the token values, and a two-colour SVG has no token to change. `data-theme`
 * is written on the document element, so the ancestor selector is the theme.
 */
export function Brand() {
  return (
    <Image
      className="block h-auto w-[151px] [[data-theme=dark]_&]:invert"
      src="/brand/egma-wordmark.svg"
      alt="Egma"
      width={151}
      height={41}
      priority
    />
  );
}

export function ThemeToggle() {
  const { theme, toggle } = useTheme();

  return (
    <button
      className={cn(
        "grid size-(--tap-target) shrink-0 cursor-pointer place-items-center p-0",
        "rounded-button border border-foreground bg-surface",
        /*
         * Named properties, never `all`, and never `outline-color`: the focus
         * ring is drawn from outside every layer and must not fade in on a Tab
         * step. One duration for both, and `DESIGN.md` says to take the shorter
         * of two that would each explain the change.
         */
        "transition-[transform,background-color] duration-(--duration-press) ease-out",
        "pointer-hover:bg-surface-soft",
        "[&:active:not(:focus-visible)]:scale-97",
        "motion-reduce:transition-none",
        "motion-reduce:[&:active:not(:focus-visible)]:scale-100",
      )}
      type="button"
      aria-label={`Use ${theme === "light" ? "dark" : "light"} theme`}
      onClick={toggle}
    >
      <span aria-hidden="true">{theme === "light" ? "◐" : "◑"}</span>
    </button>
  );
}

/**
 * A quiet line of links under an access card: the way to sign up, the way back
 * to signing in, the way to ask for another link.
 *
 * It is a component rather than a class list repeated eleven times because the
 * link inside it carries five decisions — the Ember underline, the offset, the
 * thickening on hover, the 44px target a coarse pointer needs, and the press
 * feedback — and a page that wrote four of them would look right.
 *
 * The two spacing rules are relationships rather than properties: the first
 * line after a form is separated from it by a rule, and a second line follows
 * the first more closely than it follows the form.
 */
export function LinkLine({ children }: { readonly children: ReactNode }) {
  return (
    <p
      data-slot="link-line"
      className={cn(
        "mt-5 text-sm text-muted-foreground",
        "[[data-slot=link-line]+&]:mt-3",
        "[form+&]:mt-6 [form+&]:border-t [form+&]:border-border [form+&]:pt-5",
        "[&_a]:inline-block [&_a]:text-foreground",
        "[&_a]:decoration-brand [&_a]:decoration-1 [&_a]:underline-offset-4",
        "[&_a]:pointer-hover:decoration-2",
        "[&_a]:pointer-coarse:inline-flex [&_a]:pointer-coarse:items-center",
        "[&_a]:pointer-coarse:min-h-(--tap-target)",
        "[&_a]:transition-transform [&_a]:duration-(--duration-press) [&_a]:ease-out",
        "[&_a:active:not(:focus-visible)]:scale-97",
        "motion-reduce:[&_a]:transition-none",
        "motion-reduce:[&_a:active:not(:focus-visible)]:scale-100",
      )}
    >
      {children}
    </p>
  );
}

/**
 * The fields of an access page, in a column.
 *
 * **The shared `Form` draws a card, and this surface is already one.** The old
 * arrangement kept it and then reached into it from the access stylesheet —
 * `.authCard form { border: 0; background: transparent; … }` — to undo four of
 * its five declarations. That is a route styling the inside of a shared
 * component, which is the thing this migration exists to remove, and it stopped
 * working the moment the card became Tailwind.
 *
 * So the access surface composes its own form. What is left after the undoing
 * was a flex column and one gap, and that is what this is.
 */
export function AuthForm({
  onSubmit,
  children,
}: {
  readonly onSubmit?: () => void;
  readonly children: ReactNode;
}) {
  return (
    <form
      className="flex flex-col gap-5"
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
 * The access composition: a brand panel, and the card that holds the work.
 *
 * `animated` is what the sign-in and sign-up pages ask for — the trust field
 * drawn behind the brand. A state page does not animate, and on a narrow screen
 * it also gives up the statement and most of the panel, because a person who is
 * being told one sentence should not scroll past a picture to reach it.
 */
export function AuthShell({
  eyebrow,
  title,
  lead,
  animated = false,
  children,
}: {
  eyebrow?: string;
  title: string;
  lead?: ReactNode;
  animated?: boolean;
  children: ReactNode;
}) {
  return (
    <main
      className={cn(
        "grid min-h-[100svh] bg-background",
        "grid-cols-[minmax(340px,0.92fr)_minmax(520px,1.08fr)]",
        "max-[900px]:block",
      )}
    >
      <aside
        className={cn(
          "relative min-w-0 overflow-hidden border-r border-border bg-surface-soft",
          /* The small Ember square in the corner, which is the panel's only mark. */
          "after:absolute after:right-6 after:bottom-6 after:size-4",
          "after:bg-brand after:content-['']",
          "max-[900px]:min-h-[220px] max-[900px]:border-r-0 max-[900px]:border-b",
          "max-[620px]:min-h-[144px]",
          !animated && "max-[900px]:min-h-[144px]",
        )}
      >
        {animated ? <TrustGate /> : null}
        <div
          className={cn(
            "pointer-events-none absolute inset-0 z-[1] flex flex-col justify-between",
            "p-[clamp(var(--space-7),5vw,var(--space-10))]",
            "max-[900px]:p-8 max-[620px]:p-6",
          )}
        >
          <Brand />
          <div
            className={cn(
              "max-w-[520px] max-[620px]:hidden",
              !animated && "max-[900px]:hidden",
            )}
          >
            <p
              className={cn(
                "m-0 max-w-[480px] tracking-(--tracking-heading-sm)",
                "text-[clamp(var(--text-lead),2.8vw,var(--text-heading-sm))]",
                /* After the font size, never before it: tailwind-merge counts a
                   font size as conflicting with a line height, so a `leading-`
                   ahead of a `text-` is dropped and the heading silently takes
                   the body's 1.5. */
                "leading-[1.08]",
              )}
            >
              Trust the voice agents you ship in production.
            </p>
          </div>
        </div>
      </aside>
      <section
        className={cn(
          "relative grid min-h-[100svh] place-items-center px-16 py-20",
          "max-[900px]:min-h-auto max-[900px]:px-6 max-[900px]:pt-16 max-[900px]:pb-20",
          "max-[620px]:px-4 max-[620px]:pt-18 max-[620px]:pb-10",
        )}
      >
        <div className="absolute top-6 right-6 max-[620px]:top-3 max-[620px]:right-4">
          <ThemeToggle />
        </div>
        <div
          data-slot="auth-card"
          className={cn(
            "w-full max-w-[520px] rounded-card border border-border bg-surface p-10",
            "shadow-popover",
            "max-[620px]:p-6 max-[620px]:shadow-none",
          )}
        >
          {eyebrow === undefined ? null : (
            <p className="m-0 mb-3 font-mono text-sm tracking-(--tracking-label) text-muted-foreground uppercase">
              {eyebrow}
            </p>
          )}
          {/*
           * "Headings carry no size of their own." This one takes the large
           * steps `DESIGN.md` reserves for auth: Small heading up to Heading,
           * and Small heading alone once the card is the whole screen.
           */}
          <h1
            className={cn(
              "m-0 max-w-[440px] tracking-(--tracking-heading)",
              "text-[clamp(var(--text-heading-sm),3.4vw,var(--text-heading))]",
              /* See the statement above: the line height follows the size. */
              "leading-(--line-heading)",
              "max-[620px]:text-2xl",
            )}
          >
            {title}
          </h1>
          {lead === undefined ? null : (
            <div className="mt-3 mb-8 max-w-[440px] text-base text-muted-foreground">
              {lead}
            </div>
          )}
          {children}
        </div>
      </section>
    </main>
  );
}

export function StatePage({
  title,
  lead,
  animated = false,
  children,
}: {
  title: string;
  lead?: ReactNode;
  animated?: boolean;
  children?: ReactNode;
}) {
  return (
    <AuthShell title={title} lead={lead} animated={animated}>
      {children}
    </AuthShell>
  );
}

/**
 * One thing worth saying above the form it is about.
 *
 * The tone decides the edge and the announcement, never the words: an error is
 * an `alert` because somebody has to hear it without looking, and a neutral
 * notice is neither, because a page that announces everything announces
 * nothing.
 *
 * `data-slot` is on it because the transcript pages space themselves against a
 * notice from their own stylesheet, and a class name they cannot see is not
 * something they can point at.
 */
export function Notice({
  tone = "neutral",
  children,
}: {
  tone?: "neutral" | "error" | "success";
  children: ReactNode;
}) {
  const role = tone === "error" ? "alert" : tone === "success" ? "status" : undefined;

  return (
    <div
      data-slot="notice"
      data-tone={tone}
      className={cn(
        "mb-5 rounded-input border border-l-[3px] border-border bg-surface-soft",
        "px-4 py-3 text-sm text-foreground",
        "[&_p]:m-0 [&_p+p]:mt-2",
        tone === "error" && "border-l-brand",
        tone === "success" && "border-l-foreground",
      )}
      role={role}
    >
      {children}
    </div>
  );
}
