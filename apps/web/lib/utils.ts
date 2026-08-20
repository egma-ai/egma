import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/**
 * Join class names, and let the last one win.
 *
 * Every shadcn component takes a `className` and merges it over its own
 * classes with this. `clsx` flattens the conditional forms; `tailwind-merge`
 * then drops earlier classes that set the same property, so a caller passing
 * `rounded-card` to a component that already says `rounded-button` gets one
 * radius rather than two declarations racing on source order.
 *
 * It is `lib/utils.ts` because that is where `components.json` points the
 * shadcn CLI. A component added by the CLI imports `@/lib/utils` and needs no
 * edit to compile here.
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
