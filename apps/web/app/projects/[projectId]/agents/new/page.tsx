"use client";

import { useParams } from "next/navigation";

import { AppShell } from "@/ui/shell.tsx";

import { AgentsScreen } from "../screen.tsx";

/** Preserve direct setup links by opening the connection sheet over the Agents list. */
export default function RegisterAgentPage() {
  const { projectId } = useParams<{ projectId: string }>();
  return (
    <AppShell>
      <AgentsScreen projectId={projectId} forced={{ kind: "connect" }} />
    </AppShell>
  );
}
