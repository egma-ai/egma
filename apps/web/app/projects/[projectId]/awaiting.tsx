"use client";

import type { ReactNode } from "react";

import { Empty } from "../../../ui/page-state.tsx";
import { AppShell, PageBody, PageHeader, ProductPage } from "../../../ui/shell.tsx";

/**
 * Placeholder for an unavailable product area. Currently unused by routes;
 * do not describe it as a loading state or an empty collection.
 */
export function AwaitingArea({
  area,
  title,
  what,
  meanwhile,
}: {
  readonly area: string;
  readonly title: string;
  readonly what: string;
  readonly meanwhile: ReactNode;
}) {
  return (
    <AppShell>
      <ProductPage>
        <PageHeader eyebrow="Project" title={title} lead={what} />
        <PageBody>
          <Empty title={`${area} is not in the browser yet`} lead={meanwhile} />
        </PageBody>
      </ProductPage>
    </AppShell>
  );
}
