"use client";

import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

import { useTheme } from "../ui/theme.tsx";

/**
 * Compose access pages in a centered shell with shared product controls.
 * Signed-in product navigation and page layouts live in ui/.
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
 * Set logo height and let the SVG preserve its aspect ratio. Keep it unlinked
 * on access pages. The document data-theme selector handles the two-color SVG.
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
 * Share access-page links, interaction targets, and spacing. Separate the
 * first link row from the form and place subsequent rows closer together.
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
 * Use a plain form column inside the existing access card. Remove a notice's
 * bottom margin here so it does not add to the form gap.
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
 * Access shell with one entrance transition. @starting-style falls back to
 * visible content; reduced motion removes travel. The panel uses a hairline
 * without the shadow reserved for overlays.
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
        "relative grid min-h-[100svh] place-items-center bg-background",
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
          {/* Space the heading block from content only when content follows it. */}
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
 * Errors use alert semantics; neutral notices do not. The data-slot allows
 * composition-specific spacing, including removal of margin inside AuthForm.
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
