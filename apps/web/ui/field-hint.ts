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
 * It lives in its own file rather than inside the component that provides it,
 * because the two halves of the product sat on either side of it while they
 * were being migrated: a shadcn primitive reaching into the legacy control set
 * for a context would have been a dependency pointing the wrong way, and would
 * have broken when that file was retired. It was, and this module outlived it —
 * `ui/form.tsx` provides the context and `components/ui/input`, `textarea`,
 * `select` and `checkbox` read it, with neither importing the other.
 */
export const FieldHintContext = createContext<string | undefined>(undefined);

/** The hint this control is inside, for the controls that describe themselves. */
export function useFieldHint(): string | undefined {
  return useContext(FieldHintContext);
}
