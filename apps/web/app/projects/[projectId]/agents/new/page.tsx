"use client";

import { useParams } from "next/navigation";

import { AppShell } from "@/ui/shell.tsx";

import { AgentsScreen } from "../screen.tsx";

/**
 * Registering an agent — the address, which is now a state of the list.
 *
 * **It stayed an address on purpose.** The form moved into a side sheet over
 * the agents list, and this route could have gone with it; what stopped that is
 * every place that already points here. The CLI prints this path, the
 * documentation links it, the browser walk follows it, and somebody has it in a
 * bookmark. So the address opens exactly what it always opened — the first step
 * of connecting an agent — and the list it is drawn over is the thing the
 * person will land on when they are finished.
 *
 * `screen.tsx` carries the reasoning for the panel itself.
 */
export default function RegisterAgentPage() {
  const { projectId } = useParams<{ projectId: string }>();
  return (
    <AppShell>
      <AgentsScreen projectId={projectId} forced={{ kind: "connect" }} />
    </AppShell>
  );
}
