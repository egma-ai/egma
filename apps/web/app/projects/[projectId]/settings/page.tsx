import { redirect } from "next/navigation";

import { settingsPath } from "../../../../ui/settings-nav.tsx";

/** Settings opens on the organization before project-specific settings. */
export default async function SettingsPage({
  params,
}: {
  readonly params: Promise<{ readonly projectId: string }>;
}) {
  const { projectId } = await params;
  redirect(settingsPath(projectId, "organization"));
}
