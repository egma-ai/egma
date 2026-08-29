"use client";

import {
  CircleCheckIcon,
  InfoIcon,
  Loader2Icon,
  OctagonXIcon,
  TriangleAlertIcon,
} from "lucide-react";
import type { CSSProperties } from "react";
import { Toaster as Sonner, type ToasterProps } from "sonner";

import { useTheme } from "@/ui/theme.tsx";

/**
 * The registry's notification region, dressed in egma's values.
 *
 * It reads the product's own `useTheme` rather than `next-themes`, because
 * this application already has one place that decides light or dark and two
 * controls that write to it. A second theme source would be a second answer.
 *
 * **The product's own notification is not built on this, and that is
 * deliberate.** `ui/feedback.tsx` exports a `Toast` a page controls with an
 * `open` prop, and `DESIGN.md` asks that toast for a short translate plus
 * opacity on an *interruptible transition*. Sonner is a queue a caller pushes
 * into, and it leaves on a CSS animation and a fixed unmount timer — so a
 * dismissal cannot be answered at once, which is what keyboard dismissal has
 * to be. The two would also disagree about who owns the region. This file is
 * here, house-correct, for the day a queue is what a surface needs; until
 * then the shared `Toast` is what pages use, and the icons below are the ones
 * it draws, so the two would read as one product.
 *
 * Every value here is a theme key. Sonner reads its own custom properties, so
 * they are set to egma's rather than overridden later in a class list, and the
 * neutral surface with a state-coloured edge is the same shape a status chip
 * and the shared `Toast` already use.
 */
const Toaster = ({ ...props }: ToasterProps) => {
  const { theme } = useTheme();

  return (
    <Sonner
      theme={theme}
      className="toaster group"
      icons={{
        success: <CircleCheckIcon className="size-4 text-success" />,
        info: <InfoIcon className="size-4 text-muted-foreground" />,
        warning: <TriangleAlertIcon className="size-4 text-warning" />,
        error: <OctagonXIcon className="size-4 text-failure" />,
        /*
         * The one turning thing here. "Loading: show progress — fast, quiet
         * indicator", and the words beside it carry the meaning, so reduced
         * motion drops the turn and loses nothing.
         */
        loading: (
          <Loader2Icon className="size-4 animate-spin text-muted-foreground motion-reduce:animate-none" />
        ),
      }}
      toastOptions={{
        classNames: {
          title: "text-sm font-medium text-foreground",
          description: "text-sm text-muted-foreground",
        },
        /*
         * Sonner injects its own stylesheet outside every cascade layer, where
         * a Tailwind utility cannot reach it — and its own transition is 400ms,
         * which is past the 300ms ceiling on interaction motion. An inline
         * declaration is what beats it, and it still reads a motion token
         * rather than naming a number.
         */
        style: { transitionDuration: "var(--duration-popover-in)" } as CSSProperties,
      }}
      style={
        {
          "--normal-bg": "var(--raised)",
          "--normal-text": "var(--foreground)",
          "--normal-border": "var(--border)",
          "--success-bg": "var(--raised)",
          "--success-text": "var(--foreground)",
          "--success-border": "var(--good-border)",
          "--warning-bg": "var(--raised)",
          "--warning-text": "var(--foreground)",
          "--warning-border": "var(--warn-border)",
          "--error-bg": "var(--raised)",
          "--error-text": "var(--foreground)",
          "--error-border": "var(--bad-border)",
          "--info-bg": "var(--raised)",
          "--info-text": "var(--foreground)",
          "--info-border": "var(--border)",
          /* The card radius, which is what a raised surface this size wears. */
          "--border-radius": "var(--radius-card)",
        } as CSSProperties
      }
      {...props}
    />
  );
};

export { Toaster };
