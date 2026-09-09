import type { ReactNode } from "react";

import { SettingsRouteShell } from "./route-shell.tsx";

/** Keep the application shell mounted while one settings page changes. */
export default function SettingsRouteLayout({ children }: { readonly children: ReactNode }) {
  return <SettingsRouteShell>{children}</SettingsRouteShell>;
}
