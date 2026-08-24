"use client";

import { useParams } from "next/navigation";

import { AppShell } from "../../../../ui/shell.tsx";
import { PersonasScreen } from "./personas-screen.tsx";

/**
 * The personas of one project.
 *
 * The page is three lines because the screen is one thing: this address, plus
 * `personas/new` and `personas/{personaId}`, all draw the same list and differ
 * only in which panel is open over it. `personas-screen.tsx` holds the whole
 * of it, and each of the three routes says which panel it is.
 */
export default function PersonasPage() {
  const { projectId } = useParams<{ projectId: string }>();

  return (
    <AppShell>
      <PersonasScreen projectId={projectId} sheet={{ kind: "none" }} />
    </AppShell>
  );
}
