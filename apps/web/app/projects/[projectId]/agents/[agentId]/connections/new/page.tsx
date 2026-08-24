"use client";

import { useParams, useSearchParams } from "next/navigation";

import { AppShell } from "@/ui/shell.tsx";

import { AgentsScreen } from "../../../screen.tsx";

/**
 * A first connection for one agent — the address, which is now a state of the
 * list.
 *
 * **`?onboarding=connection` is the one place a two-stage progress bar is
 * true.** An agent registered a moment ago really did have a first stage, and
 * this address is where that flow lands. Everywhere else the sheet is one
 * submit, so a bar over it would be claiming a stage that never happened.
 *
 * The kept address is the same argument as `agents/new`: the CLI, the
 * documentation and the browser walk all point here.
 */
export default function NewConnectionPage() {
  const { projectId, agentId } = useParams<{
    projectId: string;
    agentId: string;
  }>();
  const onboarding = useSearchParams().get("onboarding") === "connection";

  return (
    <AppShell>
      <AgentsScreen
        projectId={projectId}
        forced={{ kind: "connect", agentId, onboarding }}
      />
    </AppShell>
  );
}
