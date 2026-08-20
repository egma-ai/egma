"use client";

import { useParams } from "next/navigation";

import { Loading } from "../../../../../ui/page-state.tsx";
import { settingsPath } from "../../../../../ui/settings-nav.tsx";
import { ProductStatePage } from "../../../../../ui/shell.tsx";

/**
 * What the router draws between the press and
 * `/projects/:projectId/settings/keys` arriving.
 *
 * Its own boundary, so moving between settings views stays instant.
 *
 * Its header is the page's own down to its shape — the same eyebrow or the
 * same crumbs, never one standing in for the other — so nothing is redrawn a
 * second way when the page arrives. `agents/loading.tsx` carries the
 * reasoning every one of these shares.
 */
export default function KeysSettingsLoading() {
  const { projectId } = useParams<{ projectId: string }>();

  return (
    <div data-slot="route-loading">
      <ProductStatePage
        title="API keys"
        breadcrumbs={[
          { label: "Settings", href: settingsPath(projectId) },
          { label: "API keys" },
        ]}
      >
        <Loading what="your keys" />
      </ProductStatePage>
    </div>
  );
}
