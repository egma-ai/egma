import type { ComponentProps } from "react";

import { cn } from "@/lib/utils";

/**
 * A Pure Paper group at the 12px card radius.
 *
 * No shadow: "Tables, sidebars, inputs, and ordinary cards do not float." The
 * structure comes from the border and the change of surface, which is what
 * keeps a page of cards readable when there are twenty of them.
 *
 * The `m-0` on the title and the description is not decoration. Tailwind's
 * reset removes every default margin and `globals.css` gives those defaults
 * back for the CSS Modules pages that still expect them, so a heading or a
 * paragraph inside a new component has to say it wants none.
 */
function Card({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-slot="card"
      className={cn(
        "flex flex-col gap-6 rounded-card border border-border bg-card p-6 text-card-foreground",
        className,
      )}
      {...props}
    />
  );
}

function CardHeader({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-slot="card-header"
      className={cn("flex flex-col gap-2", className)}
      {...props}
    />
  );
}

function CardTitle({ className, ...props }: ComponentProps<"h3">) {
  return (
    <h3
      data-slot="card-title"
      className={cn("m-0 text-base font-medium", className)}
      {...props}
    />
  );
}

function CardDescription({ className, ...props }: ComponentProps<"p">) {
  return (
    <p
      data-slot="card-description"
      className={cn("m-0 text-sm text-muted-foreground", className)}
      {...props}
    />
  );
}

function CardContent({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-slot="card-content"
      className={cn("flex flex-col gap-4", className)}
      {...props}
    />
  );
}

function CardFooter({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-slot="card-footer"
      className={cn("flex flex-wrap items-center gap-3", className)}
      {...props}
    />
  );
}

export {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
};
