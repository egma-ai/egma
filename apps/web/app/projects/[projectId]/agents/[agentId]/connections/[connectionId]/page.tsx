"use client";

import { useParams } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { readJson, writeJson, type Refusal } from "../../../../../../../lib/api.ts";
import {
  agentDetailQuery,
  connectionPath,
  type AgentDetail,
  type ListedConnection,
} from "../../../../../../../lib/agents.ts";
import {
  CONNECTION_TYPES_PATH,
  typeNamed,
  variantNamed,
  type ConnectionTypeCatalog,
  type ConnectionVariant,
} from "../../../../../../../lib/connection-types.ts";
import { roleOf } from "../../../../../../../lib/me.ts";
import { projectPath } from "../../../../../../../lib/project-context.ts";
import { canAuthor } from "../../../../../../../lib/roles.ts";
import { Actions } from "../../../../../../../ui/section.tsx";
import {
  Field,
  Form,
  FormActions,
  Help,
  Problem,
} from "../../../../../../../ui/form.tsx";
import { Dialog } from "../../../../../../../ui/dialog.tsx";
import { Failure, Loading, NotFound } from "../../../../../../../ui/page-state.tsx";
import { useProjectRead } from "../../../../../../../ui/resource.ts";
import { useUnsavedChanges } from "../../../../../../../ui/settings-read.ts";
import {
  AppShell,
  PageBody,
  PageHeader,
  ProductPage,
  useShellSession,
} from "../../../../../../../ui/shell.tsx";
import { ConnectionFields, type Draft } from "../fields.tsx";
import {
  configForLiveKitDispatch,
  liveKitDispatchForm,
  LiveKitDispatchSetup,
  savedLiveKitDispatch,
  type LiveKitDispatch,
} from "../livekit-dispatch.tsx";

/*
 * This route's own layout: the card each block is drawn on, the header inside
 * one, and the grid of facts under it. The shared components this page
 * composes bring their own.
 *
 * They are named here rather than repeated, because each is one decision about
 * how the page reads — the card, the heading step, the fact grid — and a
 * decision written out twice is two decisions to keep in step.
 */

/** One block of the page: what this connection is, and where it points. */
const SURFACE =
  "flex min-w-0 flex-col gap-5 rounded-card border border-border bg-surface p-6 " +
  "max-[40rem]:gap-4 max-[40rem]:p-5";

/**
 * A block's name and its one sentence, with room beside them for a control.
 * The header stacks at the narrow width, where there is no room for both.
 */
const SURFACE_HEADER =
  "flex min-w-0 flex-wrap items-start justify-between gap-4 max-[40rem]:flex-col";

/**
 * `DESIGN.md`: "Headings carry no size of their own. Every heading takes its
 * size from a class." This is that class, and `text-lg` is the 24px lead step,
 * which carries its own line height and letter spacing.
 */
const BLOCK_TITLE = "m-0 text-lg font-medium text-foreground";

/**
 * The sentence under a block heading. `68ch` is written out rather than named,
 * because a reading measure is the width of the text itself and egma has no
 * value for it: `ch` is not on the 4px grid and no theme key holds one.
 */
const BLOCK_LEAD = "mt-1 mb-0 max-w-[68ch] text-sm text-muted-foreground";

type DetailFact = {
  readonly label: string;
  readonly value: ReactNode;
};

function DetailFacts({ facts }: { readonly facts: readonly DetailFact[] }) {
  return (
    <dl className="m-0 grid min-w-0 grid-cols-2 gap-5 max-[40rem]:grid-cols-1">
      {facts.map((fact) => (
        <div className="min-w-0" key={fact.label}>
          <dt className="mb-1 text-sm text-muted-foreground">{fact.label}</dt>
          <dd className="m-0 min-w-0 text-base text-foreground [overflow-wrap:anywhere]">
            {fact.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

function SurfaceHeader({
  id,
  title,
  lead,
}: {
  readonly id: string;
  readonly title: string;
  readonly lead: string;
}) {
  return (
    <header className={SURFACE_HEADER}>
      <div className="min-w-0">
        <h2 className={BLOCK_TITLE} id={id}>
          {title}
        </h2>
        <p className={BLOCK_LEAD}>{lead}</p>
      </div>
    </header>
  );
}

/** One active way Egma reaches an agent. Provider internals stay out of the UI. */
export default function ConnectionDetailPage() {
  const { projectId, agentId, connectionId } = useParams<{
    projectId: string;
    agentId: string;
    connectionId: string;
  }>();
  return (
    <AppShell>
      <ConnectionDetail
        projectId={projectId}
        agentId={agentId}
        connectionId={connectionId}
      />
    </AppShell>
  );
}

type Answered = { readonly connection: ListedConnection };

function ConnectionDetail({
  projectId,
  agentId,
  connectionId,
}: {
  readonly projectId: string;
  readonly agentId: string;
  readonly connectionId: string;
}) {
  const { me } = useShellSession();
  const role = me === null ? null : roleOf(me);
  const { answer, reload } = useProjectRead<Answered>(
    connectionPath(agentId, connectionId),
    projectId,
  );
  const { answer: parentAgent } = useProjectRead<AgentDetail>(
    agentDetailQuery(agentId, "active"),
    projectId,
  );
  const [catalog, setCatalog] = useState<ConnectionTypeCatalog | null>(null);
  const [catalogRefused, setCatalogRefused] = useState<Refusal | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [editing, setEditing] = useState(false);

  useEffect(() => {
    let current = true;
    setCatalogRefused(null);
    void readJson<ConnectionTypeCatalog>(CONNECTION_TYPES_PATH).then((read) => {
      if (!current) return;
      if (read.status === "signed-out") {
        window.location.replace("/sign-in");
      } else if (read.status === "ready") {
        setCatalog(read.value);
      } else {
        setCatalogRefused(read.refusal);
      }
    });
    return () => {
      current = false;
    };
  }, [attempt]);

  useEffect(() => {
    if (answer?.status === "signed-out" || parentAgent?.status === "signed-out") {
      window.location.replace("/sign-in");
    }
  }, [answer, parentAgent]);

  const agentHome = projectPath(projectId, "agents", agentId);
  const agentLabel =
    parentAgent?.status === "ready" ? parentAgent.value.agent.name : "Agent";
  const header = (title: string) => (
    <PageHeader
      eyebrow="Connection"
      title={title}
      breadcrumbs={[
        { label: "Agents", href: projectPath(projectId, "agents") },
        { label: agentLabel, href: agentHome },
        { label: title },
      ]}
    />
  );

  if (
    answer === null ||
    answer.status === "signed-out" ||
    parentAgent === null ||
    parentAgent.status === "signed-out"
  ) {
    return (
      <ProductPage>
        {header("Connection")}
        <PageBody>
          <Loading what="this connection" />
        </PageBody>
      </ProductPage>
    );
  }

  if (answer.status === "missing") {
    return (
      <ProductPage>
        {header("Connection")}
        <PageBody>
          <NotFound message={answer.refusal.message} />
        </PageBody>
      </ProductPage>
    );
  }

  if (answer.status === "failed") {
    return (
      <ProductPage>
        {header("Connection")}
        <PageBody>
          <Failure message={answer.refusal.message} onRetry={reload} />
        </PageBody>
      </ProductPage>
    );
  }

  const connection = answer.value.connection;
  const type = typeNamed(catalog, connection.type);
  const variant = variantNamed(catalog, connection.type, connection.variant_id);
  const mayAuthor = role !== null && canAuthor(role);
  const configKeys = new Set(variant?.fields.map((field) => field.key) ?? []);
  const configFacts: readonly DetailFact[] = [
    ...(variant?.fields.flatMap((field) => {
      const value = connection.config[field.key];
      return value === undefined
        ? []
        : [{ label: field.label, value: <code>{value}</code> }];
    }) ?? []),
    ...Object.entries(connection.config)
      .filter(([key]) => !configKeys.has(key))
      .map(([key, value]) => ({ label: key, value: <code>{value}</code> })),
  ];

  return (
    <ProductPage>
      <PageHeader
        eyebrow="Connection"
        title={connection.name}
        breadcrumbs={[
          { label: "Agents", href: projectPath(projectId, "agents") },
          { label: agentLabel, href: agentHome },
          { label: connection.name },
        ]}
        lead={`${type?.label ?? connection.type} · ${connection.modality === "voice" ? "Voice" : "Text"}`}
        action={
          role === null ? undefined : (
            <Actions>
              <Button
                type="button"
                variant="secondary"
                disabled={!mayAuthor || variant === undefined}
                why={
                  variant === undefined
                    ? "Egma could not describe this connection's fields."
                    : mayAuthor
                      ? undefined
                      : `Your ${role} role cannot change connections. Ask an organization admin to change your role.`
                }
                onClick={() => setEditing(true)}
              >
                Edit
              </Button>
            </Actions>
          )
        }
      />
      <PageBody>
        {catalogRefused === null ? null : (
          <Failure
            title="Egma could not describe this connection."
            message={catalogRefused.message}
            onRetry={() => setAttempt((current) => current + 1)}
          />
        )}

        <section className={cn(SURFACE, "mb-6")}>
          <SurfaceHeader
            id="connection-overview-title"
            title="Overview"
            lead="The provider and channel this connection uses."
          />
          <DetailFacts
            facts={[
              { label: "Provider", value: type?.label ?? connection.type },
              {
                label: "Modality",
                value: connection.modality === "voice" ? "Voice" : "Text",
              },
            ]}
          />
        </section>

        <section className={SURFACE}>
          <SurfaceHeader
            id="connection-target-title"
            title="Where it points"
            lead="The destination Egma uses for this connection."
          />
          {configFacts.length === 0 ? (
            <Help>This connection has no destination settings.</Help>
          ) : (
            <DetailFacts facts={configFacts} />
          )}
        </section>
      </PageBody>

      {editing && variant !== undefined ? (
        <EditConnection
          projectId={projectId}
          connection={connection}
          variant={variant}
          onClose={() => setEditing(false)}
          onSaved={() => {
            setEditing(false);
            reload();
          }}
        />
      ) : null}
    </ProductPage>
  );
}

function EditConnection({
  projectId,
  connection,
  variant,
  onClose,
  onSaved,
}: {
  readonly projectId: string;
  readonly connection: ListedConnection;
  readonly variant: ConnectionVariant;
  readonly onClose: () => void;
  readonly onSaved: () => void;
}) {
  const [name, setName] = useState(connection.name);
  const [draft, setDraft] = useState<Draft>({
    config: { ...connection.config },
    credentials: {},
  });
  const initialLiveKitDispatch = savedLiveKitDispatch(connection.config);
  const [livekitDispatch, setLivekitDispatch] =
    useState<LiveKitDispatch>(initialLiveKitDispatch);
  const [saving, setSaving] = useState(false);
  const [refused, setRefused] = useState<Refusal | null>(null);
  const [nameProblem, setNameProblem] = useState<string | null>(null);
  const liveKitForm = liveKitDispatchForm({
    type: connection.type,
    variant,
    config: draft.config,
    mode: livekitDispatch,
  });
  const changed =
    name !== connection.name ||
    livekitDispatch !== initialLiveKitDispatch ||
    JSON.stringify(draft.config) !== JSON.stringify(connection.config);
  useUnsavedChanges(changed && !saving, saving);

  function chooseLiveKitDispatch(next: LiveKitDispatch): void {
    setLivekitDispatch(next);
    setDraft((current) => ({
      ...current,
      config: configForLiveKitDispatch(current.config, next),
    }));
  }

  async function save(): Promise<void> {
    if (saving) return;
    const wantedName = name.trim();
    if (wantedName === "") {
      setNameProblem("A connection needs a name.");
      return;
    }
    if (!liveKitForm.ready) {
      setRefused({
        error: "unprocessable",
        message: "Enter the exact LiveKit agent name, or choose automatic dispatch.",
      });
      return;
    }

    const config: Record<string, string> = { ...connection.config };
    for (const field of variant.fields) {
      const written = draft.config[field.key]?.trim() ?? "";
      if (written === "") delete config[field.key];
      else config[field.key] = written;
    }

    setNameProblem(null);
    setRefused(null);
    setSaving(true);
    const answer = await writeJson<Answered>(
      connectionPath(connection.agent_id, connection.id),
      {
        method: "PATCH",
        project: projectId,
        body: {
          name: wantedName,
          config,
          expected_revision: connection.revision,
        },
      },
    );
    setSaving(false);

    if (answer.status === "signed-out") {
      window.location.replace("/sign-in");
    } else if (answer.status === "ready") {
      onSaved();
    } else {
      setRefused(answer.refusal);
    }
  }

  return (
    <Dialog title={`Edit ${connection.name}`} onClose={onClose}>
      {(dismiss) => (
        <Form onSubmit={() => void save()}>
          <Field label="Name" htmlFor="edit-connection-name">
            <Input
              id="edit-connection-name"
              value={name}
              aria-invalid={nameProblem !== null ? true : undefined}
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => {
                setName(event.target.value);
                if (nameProblem !== null) setNameProblem(null);
              }}
            />
            {nameProblem === null ? null : <Problem>{nameProblem}</Problem>}
          </Field>
          <ConnectionFields
            variant={liveKitForm.variant ?? variant}
            draft={draft}
            onChange={setDraft}
            credentialsEditable={false}
            beforeCredentialFields={
              !liveKitForm.enabled ? undefined : (
                <LiveKitDispatchSetup
                  mode={liveKitForm.mode}
                  agentName={liveKitForm.agentName}
                  onModeChange={chooseLiveKitDispatch}
                  onAgentNameChange={(agentName) =>
                    setDraft((current) => ({
                      ...current,
                      config: { ...current.config, agentName },
                    }))
                  }
                />
              )
            }
          />
          {refused === null ? null : <Problem>{refused.message}</Problem>}
          <FormActions>
            <Button
              type="submit"
              disabled={saving || !changed || !liveKitForm.ready}
              why={
                liveKitForm.ready
                  ? undefined
                  : "Enter the exact LiveKit agent name, or choose automatic dispatch."
              }
            >
              {saving ? "Saving…" : "Save"}
            </Button>
            <Button type="button" variant="secondary" onClick={dismiss}>
              Cancel
            </Button>
          </FormActions>
        </Form>
      )}
    </Dialog>
  );
}
