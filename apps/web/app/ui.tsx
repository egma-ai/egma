"use client";

import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

import { useTheme } from "../ui/theme.tsx";

/**
 * The access pages' own shell, and nothing else.
 *
 * Signing in, signing up, accepting an invitation and authorizing a terminal
 * are not product pages: nobody has a project yet, there is nothing to navigate
 * between, and the page is the whole of what somebody is doing. They keep the
 * large type `DESIGN.md` reserves for auth, onboarding and public pages.
 *
 * **One column, centred, and nothing beside it.** The surface used to be a
 * split screen — a brand panel on the left with a canvas of drifting dots
 * behind it, the work on the right. The 2026-08-23 look is the opposite of
 * that: Neutral Paper, one Pure Paper panel inside a hairline with no corner
 * and no shadow, the wordmark and one quiet sentence above it, and a single
 * entrance. Nothing else on the page moves.
 *
 * **Everything a signed-in product page is drawn inside lives in `ui/`** — the
 * compact shell, the selector, the navigation, the page states, the lists and
 * the controls. This file re-exports the four pieces that pages already name so
 * that a page composes its own subject and never its own frame.
 *
 * **The controls here are the product's controls.** This surface once carried
 * its own `Button`, `TextInput` and `Field`; they are gone, and what is left is
 * composition — a shell, a panel, a notice and a line of links. There is one
 * control vocabulary in this product and it is the shadcn base.
 */
export {
  AppShell,
  PageBody,
  PageHeader,
  ProductPage,
  ProductStatePage,
} from "../ui/shell.tsx";

/** The sentence the access surface says, and the only warm line on the page. */
const STATEMENT = "Trust the voice agents you ship in production.";

/**
 * The full Egma logo, which belongs here and in the signed-in sidebar.
 *
 * 32px tall, and only that: the width comes off the SVG's own viewBox, the way
 * the signed-in sidebar's copy of this mark takes it. A number in the class
 * list would be a second declaration of the logo's proportion, and a logo has
 * exactly one. It is left-aligned to the panel's edge and is deliberately
 * **not a link**: signed
 * out, `/` sends everybody straight back to `/sign-in`, so a link here would be
 * a control that reloads the page somebody is already on.
 *
 * The dark-theme treatment is an arbitrary variant rather than a `dark:` one
 * because this product has no `dark:` variant: every other surface changes with
 * the token values, and a two-colour SVG has no token to change. `data-theme`
 * is written on the document element, so the ancestor selector is the theme.
 */
export function Brand() {
  return (
    /* eslint-disable-next-line @next/next/no-img-element */
    <img
      /*
       * `self-start` is the half that keeps the mark a mark. The column it
       * sits in stretches its children to 440px, and a stretched item with
       * `w-auto` and a fixed height is a logo squashed to the width of the
       * panel — which `DESIGN.md` forbids outright. Sized by its own content,
       * the width comes off the viewBox and the proportion is the SVG's.
       */
      className="block h-8 w-auto self-start [[data-theme=dark]_&]:invert"
      src="/brand/egma-wordmark.svg"
      alt="Egma"
      height={32}
    />
  );
}

export function ThemeToggle() {
  const { theme, toggle } = useTheme();

  return (
    <button
      className={cn(
        "grid size-(--tap-target) shrink-0 cursor-pointer place-items-center p-0",
        "rounded-button border border-border-strong bg-surface",
        /*
         * Named properties, never `all`, and never `outline-color`: the focus
         * ring is drawn from outside every layer and must not fade in on a Tab
         * step. One duration for all three, and `DESIGN.md` says to take the
         * shorter of two that would each explain the change.
         */
        "transition-[transform,background-color,border-color] duration-(--duration-press) ease-out",
        /*
         * The edge answers a hover as well as the fill, which is what the
         * secondary button does and for the same reason: in dark theme
         * `--border-strong` and `--foreground` part company, and a control
         * whose edge stayed put would answer a pointer with a faint wash and
         * nothing else.
         */
        "pointer-hover:border-foreground pointer-hover:bg-surface-soft",
        "[&:active:not(:focus-visible)]:scale-97",
        /*
         * Reduced motion takes the movement away and leaves the colour. The
         * transition itself stays: `DESIGN.md` asks every movement for "a
         * reduced-motion form with useful opacity or color feedback", and
         * removing the transition outright leaves the control answering a
         * press with nothing at all.
         */
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
 * A quiet line of links under an access panel: the way to sign up, the way back
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
        /*
         * `mb-0` is load-bearing. `globals.css` gives a `<p>` the browser's own
         * `margin: 1em 0` back, and a class list that sets only the top margin
         * leaves 14px hanging under the last line — which the panel then pays
         * on top of its own 32px, so every access page with a link line ended
         * in 46px of nothing.
         */
        "mt-5 mb-0 text-sm text-muted-foreground",
        "[[data-slot=link-line]+&]:mt-3",
        "[form+&]:mt-6 [form+&]:border-t [form+&]:border-border [form+&]:pt-5",
        "[&_a]:inline-block [&_a]:text-foreground",
        "[&_a]:decoration-brand [&_a]:decoration-1 [&_a]:underline-offset-4",
        "[&_a]:pointer-hover:decoration-2",
        "[&_a]:pointer-coarse:inline-flex [&_a]:pointer-coarse:items-center",
        "[&_a]:pointer-coarse:min-h-(--tap-target)",
        "[&_a]:transition-transform [&_a]:duration-(--duration-press) [&_a]:ease-out",
        "[&_a:active:not(:focus-visible)]:scale-97",
        /* The movement goes; the colour feedback stays. See ThemeToggle. */
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
 *
 * **A notice inside it pays the gap once.** `Notice` carries its own bottom
 * margin, because on two access pages it stands over a fact list or a lone
 * button rather than over a form. Inside this column that margin lands on top
 * of the flex gap and opens 40px where the rhythm says 20, so the form — the
 * one element that can see it is a row among rows — takes it back.
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
      className="flex flex-col gap-5 [&>[data-slot=notice]]:mb-0"
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
 * The access composition: the wordmark, one sentence, and the panel that holds
 * the work — one centred column on Neutral Paper.
 *
 * **The whole column enters once and nothing else ever moves.** Opacity and 8px
 * of travel on the dialog's own duration, drawn by `@starting-style` rather
 * than by a script, so nothing decides at runtime whether this page is visible:
 * a browser without it draws the column already arrived, which is the only
 * failure a sign-in page is allowed to have. Reduced motion keeps the fade and
 * drops the travel.
 *
 * The panel is `--surface` inside a 1px hairline with **no corner and no
 * shadow**. `DESIGN.md` gives the shared shadow to menus, sheets and dialogs —
 * surfaces that sit *over* something. This one floats over nothing.
 */
export function AuthShell({
  eyebrow,
  title,
  lead,
  children,
}: {
  eyebrow?: string;
  title: string;
  lead?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <main
      className={cn(
        /*
         * The ground is chrome, and the panel on it is the work — the same
         * rule the signed-in product took on 2026-08-28, read onto a page
         * that has no sidebar and no title bar to carry it. An access page is
         * all frame and one panel, so the frame is the whole ground.
         *
         * It reads `--chrome` rather than `--background` because
         * `--background` is Pure Paper now and the panel below is Pure Paper
         * too: the two would be one surface with a hairline between them, and
         * the panel would stop being a panel.
         */
        "relative grid min-h-[100svh] place-items-center bg-chrome",
        "px-6 py-16",
        "max-[620px]:py-12 max-[400px]:px-4",
      )}
    >
      <div className="absolute top-6 right-6 max-[620px]:top-3 max-[620px]:right-4">
        <ThemeToggle />
      </div>

      <div
        data-slot="auth-column"
        className={cn(
          "flex w-full max-w-(--access-panel-width) flex-col items-stretch",
          /*
           * The one entrance. `translate` rather than `transform`, so what the
           * movement writes is a property nothing else on this column writes —
           * the same separation the drawer and the side sheet already keep.
           */
          "transition-[opacity,translate] duration-(--duration-dialog-in) ease-out",
          "starting:opacity-0 motion-safe:starting:translate-y-2",
        )}
      >
        <Brand />

        {/*
         * The statement, which used to be the whole left half of a split
         * screen and is now one quiet line. It is product copy and the only
         * warm sentence on the page, so it outlived the panel it was written
         * inside.
         */}
        <p className="mt-3 mb-8 text-base text-muted-foreground">{STATEMENT}</p>

        <div
          data-slot="auth-panel"
          className={cn(
            "rounded-card border border-border bg-surface p-8",
            "max-[620px]:p-6",
          )}
        >
          {/*
           * The eyebrow, the title and the lead are one block with one rhythm,
           * so a page with no eyebrow or no lead is spaced by what it has
           * rather than by a margin written for the page that has both.
           *
           * The 32px under the block is a relationship rather than a property:
           * it is paid only when there is something below to pay it to, which
           * is what keeps a bare loading state from ending in a band of
           * nothing.
           */}
          <div className="flex flex-col gap-3 [&:not(:last-child)]:mb-8">
            {eyebrow === undefined ? null : (
              <p className="m-0 text-sm tracking-(--tracking-label) text-faint uppercase">
                {eyebrow}
              </p>
            )}
            {/*
             * "Headings carry no size of their own." This one takes the 32px
             * Subheading step at weight 500, and one size at every width: a
             * title that shrank on a phone would be the only thing on this
             * page that changes with the viewport.
             */}
            <h1 className="m-0 text-xl font-medium text-foreground">{title}</h1>
            {lead === undefined ? null : (
              <div className="text-base text-muted-foreground">{lead}</div>
            )}
          </div>
          {children}
        </div>
      </div>
    </main>
  );
}

export function StatePage({
  title,
  lead,
  children,
}: {
  title: string;
  lead?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <AuthShell title={title} lead={lead}>
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
 * something they can point at. `AuthForm` uses the same handle to take the
 * bottom margin back inside a gapped column.
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
        /*
         * The failure colour, never the brand one. `DESIGN.md`: "Brand orange
         * does not mean passed, failed, skipped, or errored." The edge is the
         * only thing separating this from a neutral notice at a glance, so
         * painting it Ember said "look here" where it had to say "this went
         * wrong". The `role="alert"` above carries the same news to anybody
         * not looking, which is why the colour is supporting information
         * rather than the whole signal.
         */
        tone === "error" && "border-l-failure",
        tone === "success" && "border-l-foreground",
      )}
      role={role}
    >
      {children}
    </div>
  );
}
