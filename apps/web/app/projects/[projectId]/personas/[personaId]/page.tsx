"use client";

import { useParams } from "next/navigation";

import { AppShell } from "../../../../../ui/shell.tsx";
import { PersonasScreen } from "../personas-screen.tsx";

/**
 * One persona, read and edited over the list it belongs to.
 *
 * Read, edit and one frozen version are the same address: they are what this
 * panel is showing, not where anybody is. What is *not* the same address is
 * which persona — so a link to this one still opens this one, and the list
 * behind it is still there to compare against. See `persona-sheet.tsx`.
 */
export default function PersonaPage() {
  const { projectId, personaId } = useParams<{
    projectId: string;
    personaId: string;
  }>();

  return (
    <AppShell>
      <PersonasScreen
        projectId={projectId}
        sheet={{ kind: "persona", personaId }}
      />
    </AppShell>
  );
}
