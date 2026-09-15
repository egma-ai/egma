"use client";

import { useParams } from "next/navigation";

import { AppShell } from "@/ui/shell.tsx";

import { PersonaCreateScreen } from "../persona-screen.tsx";

export default function NewPersonaPage() {
  const { projectId } = useParams<{ projectId: string }>();
  return <AppShell><PersonaCreateScreen projectId={projectId} /></AppShell>;
}
