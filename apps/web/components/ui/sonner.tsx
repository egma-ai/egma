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
 * Queued notifications using the product's shared theme and status icons.
 * The controlled Toast in ui/feedback.tsx has a separate owner-driven lifecycle;
 * choose based on whether the caller needs a queue or explicit open state.
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
          "--normal-bg": "var(--surface)",
          "--normal-text": "var(--foreground)",
          "--normal-border": "var(--border)",
          "--success-bg": "var(--surface)",
          "--success-text": "var(--foreground)",
          "--success-border": "var(--good-border)",
          "--warning-bg": "var(--surface)",
          "--warning-text": "var(--foreground)",
          "--warning-border": "var(--warn-border)",
          "--error-bg": "var(--surface)",
          "--error-text": "var(--foreground)",
          "--error-border": "var(--bad-border)",
          "--info-bg": "var(--surface)",
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
