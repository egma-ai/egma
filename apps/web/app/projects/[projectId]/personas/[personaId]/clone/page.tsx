"use client";

import { useParams } from "next/navigation";

import { AppShell } from "@/ui/shell.tsx";

import { PersonaCloneScreen } from "../../persona-screen.tsx";

export default function ClonePersonaPage() {
  const { projectId, personaId } = useParams<{ projectId: string; personaId: string }>();
  return <AppShell><PersonaCloneScreen projectId={projectId} personaId={personaId} /></AppShell>;
}
