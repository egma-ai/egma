"use client";

import { useParams } from "next/navigation";

import { AppShell } from "../../../../../ui/shell.tsx";

import { TranscriptsScreen } from "./screen.tsx";

/**
 * What this project's agents did in production, newest first.
 *
 * The page is the address; `screen.tsx` is the screen, and the picker this area
 * opens is a state of it. One other address renders the same component with
 * that panel forced open, which is what keeps `monitoring/start` working after
 * it stopped being a page of its own.
 */
export default function MonitoringTranscriptsPage() {
  const { projectId } = useParams<{ projectId: string }>();
  return (
    <AppShell>
      <TranscriptsScreen projectId={projectId} />
    </AppShell>
  );
}
