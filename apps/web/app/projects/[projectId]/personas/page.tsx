"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { listPersonas } from "@egma/platform-api/client";

import { Button } from "@/components/ui/button";
import type { Refusal } from "@/lib/api.ts";
import { firstProjectOf, roleOf } from "@/lib/me.ts";
import {
  newPersonaPath,
  personaClonePath,
  personaPath,
  type Persona,
  type PersonaPage,
} from "@/lib/personas.ts";
import { platformAnswer, platformClient } from "@/lib/platform-client.ts";
import { projectLanding } from "@/lib/project-context.ts";
import { canAuthor } from "@/lib/roles.ts";
import { DataTable, type Column } from "@/ui/data-table.tsx";
import { MenuDivider, MenuItem } from "@/ui/menu.tsx";
import { Empty, Failure, Loading, NotFound } from "@/ui/page-state.tsx";
import { ListInstant } from "@/ui/relative-time.tsx";
import { useProjectRead } from "@/ui/resource.ts";
import { RowMenu } from "@/ui/row-menu.tsx";
import { SearchField } from "@/ui/section.tsx";
import { AppShell, PageBody, PageHeader, ProductPage, useShellSession } from "@/ui/shell.tsx";

import { DeletePersonaDialog } from "./persona-sheets.tsx";
import { PersonaTypeChip } from "./persona-parts.tsx";

const SEARCH_SETTLE_MS = 300;

export default function PersonasPage() {
  const { projectId } = useParams<{ projectId: string }>();
  return <AppShell><ProjectPersonas projectId={projectId} /></AppShell>;
}

function ProjectPersonas({ projectId }: { readonly projectId: string }) {
  const router = useRouter();
  const { me } = useShellSession();
  const role = me === null ? null : roleOf(me);
  const mayAuthor = role !== null && canAuthor(role);
  const [typed, setTyped] = useState("");
  const [search, setSearch] = useState("");
  const [after, setAfter] = useState<PersonaPage | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreRefused, setMoreRefused] = useState<Refusal | null>(null);
  const [deleting, setDeleting] = useState<Persona | null>(null);
  const showing = useRef({ projectId, search });

  useEffect(() => { setTyped(""); setSearch(""); }, [projectId]);
  useEffect(() => {
    if (typed === search) return undefined;
    const timer = window.setTimeout(() => setSearch(typed), SEARCH_SETTLE_MS);
    return () => window.clearTimeout(timer);
  }, [typed, search]);

  const { answer, reload, refresh } = useProjectRead<PersonaPage>(
    (project) => platformAnswer(listPersonas({ projectId: project, ...(search === "" ? {} : { search }) }, { client: platformClient })),
    projectId,
    search,
  );

  useEffect(() => {
    if (answer?.status === "signed-out") window.location.replace("/sign-in");
  }, [answer]);

  useEffect(() => {
    showing.current = { projectId, search };
    setAfter(null);
    setMoreRefused(null);
  }, [projectId, search, answer]);

  const action = role === null ? undefined : (
    <Button asChild={mayAuthor} disabled={!mayAuthor} why={mayAuthor ? undefined : `Your ${role} role cannot author personas.`}>
      {mayAuthor ? <Link href={newPersonaPath(projectId)}>New persona</Link> : "New persona"}
    </Button>
  );

  function rowMenu(persona: Persona): ReactNode {
    return (
      <RowMenu label={`Open the menu for ${persona.name}`}>
        {(close) => (
          <>
            <MenuItem
              href={mayAuthor ? personaClonePath(projectId, persona.id) : undefined}
              disabled={!mayAuthor}
              onClick={close}
            >
              Clone
            </MenuItem>
            {persona.owner === "egma" ? null : (
              <>
                <MenuDivider />
                <MenuItem disabled={!mayAuthor} onClick={() => { close(); setDeleting(persona); }}>
                  <span className="text-failure">Delete</span>
                </MenuItem>
              </>
            )}
          </>
        )}
      </RowMenu>
    );
  }

  const columns: readonly Column<Persona>[] = [
    {
      key: "name", header: "Name", primary: true, width: "260px",
      cell: (persona) => <Link data-slot="persona-name-link" className="text-sm text-foreground" href={personaPath(projectId, persona.id)}>{persona.name}</Link>,
    },
    { key: "type", header: "Type", width: "130px", cell: (persona) => <PersonaTypeChip owner={persona.owner} /> },
    {
      key: "language", header: "Language", width: "110px",
      cell: (persona) => persona.settings?.controls.language ?? persona.language ?? "Default",
    },
    {
      key: "description", header: "Description", hideOnMobile: true,
      cell: (persona) => persona.description || <span className="text-faint">No description</span>,
    },
    { key: "version", header: "Version", hideOnMobile: true, mono: true, width: "90px", cell: (persona) => `v${persona.version}` },
    { key: "updated", header: "Updated", width: "130px", cell: (persona) => <ListInstant instant={persona.updatedAt} /> },
    { key: "actions", header: "Row actions", action: true, cell: rowMenu },
  ];

  function body(): ReactNode {
    if (answer === null || answer.status === "signed-out") return <Loading what="personas" />;
    if (answer.status === "missing") {
      const elsewhere = me === null ? undefined : firstProjectOf(me);
      return <NotFound message={answer.refusal.message} action={elsewhere === undefined ? undefined : <Button asChild variant="secondary"><Link href={projectLanding(elsewhere.id)}>Open {elsewhere.name}</Link></Button>} />;
    }
    if (answer.status === "failed") return <Failure message={answer.refusal.message} onRetry={reload} />;
    const items = [...answer.value.personas, ...(after?.personas ?? [])];
    const cursor = after === null
      ? answer.value.nextPageToken
      : after.nextPageToken;
    if (items.length === 0) {
      return search === ""
        ? <Empty title="No personas in this project yet" lead="Create a stable synthetic caller for your voice agent tests." action={action} />
        : <Empty title="No persona here matches that" lead="Clear the search to see every persona in this project." action={<Button type="button" variant="secondary" onClick={() => setTyped("")}>Clear search</Button>} />;
    }

    async function showMore(): Promise<void> {
      if (cursor === null || loadingMore) return;
      const request = { projectId, search };
      setLoadingMore(true);
      setMoreRefused(null);
      const next = await platformAnswer(listPersonas({ projectId, pageToken: cursor, ...(search === "" ? {} : { search }) }, { client: platformClient }));
      setLoadingMore(false);
      if (showing.current.projectId !== request.projectId || showing.current.search !== request.search) return;
      if (next.status === "signed-out") { window.location.replace("/sign-in"); return; }
      if (next.status !== "ready") { setMoreRefused(next.refusal); return; }
      setAfter({ personas: [...(after?.personas ?? []), ...next.value.personas], nextPageToken: next.value.nextPageToken });
    }

    return (
      <>
        <DataTable
          label="Personas in this project"
          columns={columns}
          rows={items}
          keyOf={(persona) => persona.id}
          stretchPrimaryLink
          onRowActivate={(persona) => router.push(personaPath(projectId, persona.id))}
          {...(cursor === null ? {} : { more: { onMore: () => void showMore(), loading: loadingMore } })}
        />
        {moreRefused === null ? null : <Failure title="Egma could not load more personas." message={moreRefused.message} onRetry={() => void showMore()} />}
      </>
    );
  }

  return (
    <ProductPage>
      <PageHeader
        title="Personas"
        toolbar={<SearchField aria-label="Search personas by name" placeholder="Search by name" value={typed} onChange={(event) => setTyped(event.target.value)} />}
        action={action}
      />
      <PageBody>{body()}</PageBody>
      {deleting === null ? null : (
        <DeletePersonaDialog
          persona={deleting}
          projectId={projectId}
          onClose={() => setDeleting(null)}
          onDeleted={() => { setDeleting(null); setAfter(null); refresh(); }}
        />
      )}
    </ProductPage>
  );
}
