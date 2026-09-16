"use client";

import { useParams } from "next/navigation";

import { AppShell } from "@/ui/shell.tsx";

import { PersonaReadScreen } from "../persona-read.tsx";

export default function PersonaPage() {
  const { projectId, personaId } = useParams<{ projectId: string; personaId: string }>();
  return <AppShell><PersonaReadScreen projectId={projectId} personaId={personaId} /></AppShell>;
}
