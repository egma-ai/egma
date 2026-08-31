"use client";

import { useParams } from "next/navigation";

import { AppShell } from "@/ui/shell.tsx";

import { AgentsScreen } from "../../../screen.tsx";

/**
 * A first connection for one agent — the address, which is now a state of the
 * list.
 *
 * The kept address is the same argument as `agents/new`: the CLI, the
 * documentation and the browser walk all point here.
 */
export default function NewConnectionPage() {
  const { projectId, agentId } = useParams<{
    projectId: string;
    agentId: string;
  }>();
  return (
    <AppShell>
      <AgentsScreen
        projectId={projectId}
        forced={{ kind: "connect", agentId }}
      />
    </AppShell>
  );
}
