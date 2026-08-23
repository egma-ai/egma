"use client";

import { useParams } from "next/navigation";

import { AppShell } from "../../../../../../ui/shell.tsx";
import { SuiteScreen } from "../../suite-screen.tsx";

/** One suite and the tests inside it. The screen itself is `suite-screen.tsx`. */
export default function TestSuitePage() {
  const { projectId, suiteId } = useParams<{
    projectId: string;
    suiteId: string;
  }>();
  return (
    <AppShell>
      <SuiteScreen projectId={projectId} suiteId={suiteId} />
    </AppShell>
  );
}
