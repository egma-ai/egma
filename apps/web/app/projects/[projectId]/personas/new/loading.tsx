"use client";

import { useParams } from "next/navigation";

import { projectPath } from "../../../../../lib/project-context.ts";
import { Loading } from "../../../../../ui/page-state.tsx";
import { ProductStatePage } from "../../../../../ui/shell.tsx";

/**
 * What the router draws between the press and
 * `/projects/:projectId/personas/new` arriving.
 *
 * The form cannot be drawn until egma says which models a persona may speak
 * with, so that read is what it names.
 *
 * Its header is the page's own down to its shape — the same eyebrow or the
 * same crumbs, never one standing in for the other — so nothing is redrawn a
 * second way when the page arrives. `agents/loading.tsx` carries the
 * reasoning every one of these shares.
 */
export default function NewPersonaLoading() {
  const { projectId } = useParams<{ projectId: string }>();

  return (
    <div data-slot="route-loading">
      <ProductStatePage
        title="New persona"
        breadcrumbs={[
          { label: "Personas", href: projectPath(projectId, "personas") },
          { label: "New persona" },
        ]}
      >
        <Loading what="the supported persona models" />
      </ProductStatePage>
    </div>
  );
}
