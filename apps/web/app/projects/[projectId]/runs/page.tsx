"use client";

import { useParams } from "next/navigation";

import { RunsScreen } from "./runs-screen.tsx";

export default function RunsPage() {
  const { projectId } = useParams<{ projectId: string }>();
  return <RunsScreen projectId={projectId} />;
}
