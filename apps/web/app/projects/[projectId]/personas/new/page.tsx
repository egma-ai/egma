"use client";

import { useParams } from "next/navigation";

import { AppShell } from "../../../../../ui/shell.tsx";
import { PersonasScreen } from "../personas-screen.tsx";

/**
 * Authoring a persona, over the list it will join.
 *
 * It is still an address rather than a piece of state, so the New sheet is
 * linkable, survives a reload, and is left by pressing Back. What draws it is
 * the personas screen with `new` in hand; see `personas-screen.tsx`.
 */
export default function NewPersonaPage() {
  const { projectId } = useParams<{ projectId: string }>();

  return (
    <AppShell>
      <PersonasScreen projectId={projectId} sheet={{ kind: "new" }} />
    </AppShell>
  );
}
