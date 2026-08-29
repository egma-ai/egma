"use client";

import { useParams } from "next/navigation";

import { AppShell } from "@/ui/shell.tsx";

import { AgentsScreen } from "../../../screen.tsx";

/**
 * A first connection for one agent — the address, which is now a state of the
 * list.
 *
 * The old address remains valid, but the sheet now hands the repository work
 * to a coding agent. It does not keep wizard state or make setup writes.
 */
export default function NewConnectionPage() {
  const { projectId } = useParams<{
    projectId: string;
    agentId: string;
  }>();

  return (
    <AppShell>
      <AgentsScreen projectId={projectId} forced={{ kind: "connect" }} />
    </AppShell>
  );
}
