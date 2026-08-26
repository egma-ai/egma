"use client";

import { useParams } from "next/navigation";

import { CreateRunSheet } from "../create-run-sheet.tsx";
import { RunsScreen } from "../runs-screen.tsx";

export default function NewRunPage() {
  const { projectId } = useParams<{ projectId: string }>();

  return (
    <RunsScreen
      projectId={projectId}
      overlay={<CreateRunSheet projectId={projectId} />}
    />
  );
}
