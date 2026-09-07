"use client";

import type { ReactNode } from "react";

import { Empty } from "../../../ui/page-state.tsx";
import { AppShell, PageBody, PageHeader, ProductPage } from "../../../ui/shell.tsx";

/**
 * A product area the shell navigates to and the browser cannot work in yet.
 *
 * **Scaffolding, and deliberately visible as such.** The navigation names four
 * product areas and Personas from the day the shell exists, because that is
 * what tells somebody what egma is for — and a navigation item that lands on a
 * framework's own 404 page would say the opposite. Each of these is replaced
 * whole by the ticket that builds its area, and the last one to go takes this
 * file with it.
 *
 * It says what the area is and where the work can be done today. It never
 * pretends to be loading and never shows an empty list, because both would read
 * as *this project has none of those*.
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
