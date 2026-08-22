"use client";

import Link from "next/link";
import { useParams } from "next/navigation";

import { Button } from "@/components/ui/button";

import { projectPath } from "../../../../../lib/project-context.ts";
import { Empty } from "../../../../../ui/page-state.tsx";
import {
  AppShell,
  PageBody,
  PageHeader,
  ProductPage,
} from "../../../../../ui/shell.tsx";

/**
 * The address the start-monitoring flow will live at, holding the place while
 * that flow is built.
 *
 * **There is no monitoring setup object any more.** Configuration collapsed
 * into the agent: an agent binds to its platform, holds that platform's sealed
 * monitoring key, and one per-agent switch — *Pull production calls* — turns
 * polling on. Push is not configured at all; the customer's own process sends
 * spans to the OTLP door with the project key and the stored evidence is the
 * whole record. See ADR-0015.
 *
 * So this page consults no server state and changes none. It says where the
 * choice now lives and sends the reader to the agent roster, which is the only
 * place that choice can be made.
 */
export default function MonitoringSetupPage() {
  const params = useParams<{ projectId: string }>();
  const projectId = params.projectId;

  return (
    <AppShell>
      <ProductPage>
        <PageHeader
          eyebrow="Monitoring"
          title="Start monitoring"
          breadcrumbs={[
            { label: "Monitoring", href: projectPath(projectId, "monitoring") },
            { label: "Start monitoring" },
          ]}
        />
        <PageBody>
          <Empty
            title="Monitoring is set up on the agent."
            lead="Open the agent egma should watch and turn on Pull production calls. An agent whose own process pushes its spans to Egma needs no setup at all — its traffic appears here on its own."
            action={
              <Button asChild>
                <Link href={projectPath(projectId, "agents")}>Open agents</Link>
              </Button>
            }
          />
        </PageBody>
      </ProductPage>
    </AppShell>
  );
}
