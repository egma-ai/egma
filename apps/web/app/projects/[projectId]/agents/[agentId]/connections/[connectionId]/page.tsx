"use client";

import { useParams } from "next/navigation";

import { AppShell } from "@/ui/shell.tsx";

import { AgentsScreen } from "../../../screen.tsx";

/**
 * One connection — the address, which is now a state of the list.
 *
 * The panel it opens is the same one a link on a row opens, so a person who
 * followed a link from somewhere else sees exactly what a person who pressed
 * the name in the table sees, over the same list. Closing it leaves this
 * address for the list, which is where the panel was always drawn.
 */
export default function ConnectionDetailPage() {
  const { projectId, agentId, connectionId } = useParams<{
    projectId: string;
    agentId: string;
    connectionId: string;
  }>();

  return (
    <AppShell>
      <AgentsScreen
        projectId={projectId}
        forced={{ kind: "connection", agentId, connectionId }}
      />
    </AppShell>
  );
}
