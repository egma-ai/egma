"use client";

import { useParams, useSearchParams } from "next/navigation";

import { AGENT_PARAMETER } from "../../../../../lib/monitoring.ts";
import { AppShell } from "../../../../../ui/shell.tsx";
import { TranscriptsScreen } from "../transcripts/screen.tsx";

/**
 * The old Start-monitoring address, kept as a deep link and nothing else.
 *
 * **The page it named is gone.** Its agent and connection selects, its "List
 * Retell agents" button and its tick list were a whole screen for one verb —
 * and the screen the verb belongs on is Transcripts, where its results land.
 * The picker that replaced it is a sheet over that screen (boards `JGS-0`,
 * `JN2-0`, `JTL-0`).
 *
 * **It renders rather than redirects**, which is what the blanket rule asks
 * for: a link somebody saved, or a message the CLI printed, lands on the
 * Transcripts screen with the picker already open, in one load. A redirect
 * would be a second navigation for a link that already named exactly one
 * thing.
 *
 * `?agent=` rides through. It named which agent the flow was about when the
 * old page read it, and it means the same thing to the picker.
 */
export default function StartMonitoringPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const agentId = useSearchParams().get(AGENT_PARAMETER);

  return (
    <AppShell>
      <TranscriptsScreen projectId={projectId} forced={{ agentId }} />
    </AppShell>
  );
}
