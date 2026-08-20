"use client";

import { createContext, useContext } from "react";

/**
 * The id of the hint a field is wearing, offered to whatever control it wraps.
 *
 * **A hint nothing points at is a hint only a sighted reader ever gets.** It
 * travels through context rather than through a prop because the alternative
 * is every caller remembering to wire `aria-describedby` on every control —
 * and the ones they forget are exactly the ones nobody notices, because the
 * page still looks right.
 *
 * It lives in its own file rather than inside `controls.tsx` because the two
 * halves of the product now sit on either side of it: `Field` provides it and
 * is still a CSS Modules component, while the controls that consume it —
 * `components/ui/input`, `textarea`, `select` and `checkbox` — are on the
 * shadcn base. A shadcn primitive reaching into the legacy control set for a
 * context would be a dependency pointing the wrong way and would break when
 * that file is retired. This module outlives it: when `Field` is migrated, it
 * goes on providing exactly this.
 */
export const FieldHintContext = createContext<string | undefined>(undefined);

/** The hint this control is inside, for the controls that describe themselves. */
export function useFieldHint(): string | undefined {
  return useContext(FieldHintContext);
}
