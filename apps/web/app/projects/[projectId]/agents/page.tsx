"use client";

import { useParams } from "next/navigation";

import { AppShell } from "@/ui/shell.tsx";

import { AgentsScreen } from "./screen.tsx";

/**
 * The agents of one project.
 *
 * The page is the address; `screen.tsx` is the screen, and every panel this
 * area opens is a state of it. Three other addresses render the same component
 * with one panel forced open, which is what keeps `agents/new`,
 * `connections/new` and `connections/:id` working after they stopped being
 * pages of their own.
 */
export default function AgentsPage() {
  const { projectId } = useParams<{ projectId: string }>();
  return (
    <AppShell>
      <AgentsScreen projectId={projectId} />
    </AppShell>
  );
}
