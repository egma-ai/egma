"use client";

import { useParams } from "next/navigation";

import { AppShell } from "../../../../../ui/shell.tsx";

import { TranscriptsScreen } from "./screen.tsx";

/**
 * What this project's agents did in production, newest first.
 *
 * The page is the address and `screen.tsx` is the screen. Monitoring setup is
 * owned by the shared Connect agent flow on Agents; the retired
 * `monitoring/start` address forwards there too.
 */
export default function MonitoringTranscriptsPage() {
  const { projectId } = useParams<{ projectId: string }>();
  return (
    <AppShell>
      <TranscriptsScreen projectId={projectId} />
    </AppShell>
  );
}
