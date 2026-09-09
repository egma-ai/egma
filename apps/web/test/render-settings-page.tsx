import { render, type RenderResult } from "@testing-library/react";
import type { ReactElement } from "react";

import SettingsRouteLayout from "../app/projects/[projectId]/settings/layout.tsx";
import { AppShell } from "../ui/shell.tsx";

/** Render a settings page with the route layouts Next supplies in production. */
export function renderSettingsPage(page: ReactElement): RenderResult {
  return render(
    <AppShell>
      <SettingsRouteLayout>{page}</SettingsRouteLayout>
    </AppShell>,
  );
}
