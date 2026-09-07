"use client";

import { createContext, useContext } from "react";

/**
 * Share hint IDs through context so wrapped inputs can set aria-describedby.
 * Keep the context separate from both Field and the input primitives to avoid
 * a dependency cycle.
 */
export const FieldHintContext = createContext<string | undefined>(undefined);

/** The hint this control is inside, for the controls that describe themselves. */
export function useFieldHint(): string | undefined {
  return useContext(FieldHintContext);
}
