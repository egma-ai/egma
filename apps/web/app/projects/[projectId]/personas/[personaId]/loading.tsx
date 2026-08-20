"use client";

import { useParams } from "next/navigation";

import { projectPath } from "../../../../../lib/project-context.ts";
import { Loading } from "../../../../../ui/page-state.tsx";
import { ProductStatePage } from "../../../../../ui/shell.tsx";

/**
 * What the router draws between the press and
 * `/projects/:projectId/personas/:personaId` arriving.
 *
 * The page titles itself with the persona's name once it has one and with
 * the word until then; this is the second half of that, which is the half a
 * fallback can honestly say.
 *
 * Its header is the page's own down to its shape — the same eyebrow or the
 * same crumbs, never one standing in for the other — so nothing is redrawn a
 * second way when the page arrives. `agents/loading.tsx` carries the
 * reasoning every one of these shares.
 */
export default function PersonaLoading() {
  const { projectId } = useParams<{ projectId: string }>();

  return (
    <div data-slot="route-loading">
      <ProductStatePage
        title="Persona"
        breadcrumbs={[
          { label: "Personas", href: projectPath(projectId, "personas") },
          { label: "Persona" },
        ]}
      >
        <Loading what="this persona" />
      </ProductStatePage>
    </div>
  );
}
