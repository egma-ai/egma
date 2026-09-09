"use client";

import { createContext, useContext, type ReactNode } from "react";
import { useParams, usePathname } from "next/navigation";

import type { SettingsSection } from "../../../../ui/settings-nav.tsx";
import { SettingsLayout } from "../../../../ui/settings-nav.tsx";
import { AppShell, PageBody, PageHeader, ProductPage } from "../../../../ui/shell.tsx";

const settingsRouteShell = createContext(false);

const SETTINGS_PAGE: Record<SettingsSection, { readonly title: string }> = {
  organization: { title: "Organization" },
  billing: { title: "Usage and billing" },
  "provider-api-keys": { title: "Provider API Keys" },
  people: { title: "People" },
  keys: { title: "API keys" },
  project: { title: "Project" },
};

function sectionAt(pathname: string): SettingsSection {
  if (pathname.endsWith("/billing")) return "billing";
  if (pathname.endsWith("/provider-api-keys")) return "provider-api-keys";
  if (pathname.endsWith("/people")) return "people";
  if (pathname.endsWith("/keys")) return "keys";
  if (pathname.endsWith("/project")) return "project";
  return "organization";
}

function SettingsChrome({
  children,
  section,
  projectId,
}: {
  readonly children: ReactNode;
  readonly section: SettingsSection;
  readonly projectId: string;
}) {
  return (
    <ProductPage viewport>
      <PageHeader title={SETTINGS_PAGE[section].title} />
      <PageBody>
        <SettingsLayout projectId={projectId} current={section}>
          {children}
        </SettingsLayout>
      </PageBody>
    </ProductPage>
  );
}

/** Persistent settings chrome for sibling settings routes. */
export function SettingsRouteShell({ children }: { readonly children: ReactNode }) {
  const { projectId } = useParams<{ projectId: string }>();
  const section = sectionAt(usePathname() ?? "");
  return (
    <settingsRouteShell.Provider value>
      <SettingsChrome projectId={projectId} section={section}>
        {children}
      </SettingsChrome>
    </settingsRouteShell.Provider>
  );
}

/** Preserve direct page-component test renders outside the route layout. */
export function SettingsPageShell({
  children,
  section,
}: {
  readonly children: ReactNode;
  readonly section: SettingsSection;
}) {
  const { projectId } = useParams<{ projectId: string }>();
  return (
    <AppShell>
      <settingsRouteShell.Provider value>
        <SettingsChrome projectId={projectId} section={section}>
          {children}
        </SettingsChrome>
      </settingsRouteShell.Provider>
    </AppShell>
  );
}

export function useSettingsRouteShell(): boolean {
  return useContext(settingsRouteShell);
}
