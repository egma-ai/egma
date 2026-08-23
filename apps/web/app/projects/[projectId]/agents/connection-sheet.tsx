"use client";

import { useEffect, useState, type ReactNode } from "react";
import {
  archiveConnection,
  getConnection,
  listConnectionOptions,
  updateConnection,
} from "@egma/platform-api/client";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Sheet,
  SheetBody,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import type { Refusal } from "@/lib/api.ts";
import { NO_ENVIRONMENT, type ListedConnection } from "@/lib/agents.ts";
import {
  optionNamed,
  type ConnectionOption,
  type ConnectionOptionCatalog,
} from "@/lib/connection-options.ts";
import { asDay } from "@/lib/instants.ts";
import { platformAnswer, platformClient } from "@/lib/platform-client.ts";
import { agentPlatformLabel } from "@/lib/transcripts.ts";
import { Field, Help, Problem } from "@/ui/form.tsx";
import { Failure, Loading, NotFound } from "@/ui/page-state.tsx";
import { useProjectRead } from "@/ui/resource.ts";
import { useUnsavedChanges } from "@/ui/settings-read.ts";

import { ArchiveConfirm } from "./archive.tsx";
import { modalityLabel } from "./connection-facts.tsx";
import { ConnectionFields, type Draft } from "./[agentId]/connections/fields.tsx";
import {
  configForLiveKitDispatch,
  liveKitDispatchForm,
  LiveKitDispatchSetup,
  savedLiveKitDispatch,
  type LiveKitDispatch,
} from "./[agentId]/connections/livekit-dispatch.tsx";

/**
 * One way egma reaches an agent, read and changed in the panel the board draws
 * (`77F-0`).
 *
 * **It opens over whatever a person was reading.** The list stays behind it, so
 * following a connection off a row and coming back is not two page loads;
 * `DESIGN.md` records the side sheet as where one record is created, read and
 * edited. The address `/agents/:agent/connections/:connection` still works and
 * opens exactly this, so every link in the docs and the CLI still lands
 * somewhere honest.
 *
 * **Read first, edit on purpose.** The board draws Save and Edit side by side,
 * which would put a save on a panel with nothing to save; what is drawn here is
 * the honest half of it — Edit while reading, Save and Cancel while editing,
 * and Archive at the far end of the footer in both.
 *
 * **The destructive action says "Archive", because that is the write.** There
 * is no delete for a connection anywhere in the contract. See `archive.tsx`.
 *
 * **The credential is never in this panel, on either side.** A read answers
 * whether one is present and a hint of which it is; it never answers with the
 * secret, so there is nothing here to show and nothing to merge. Replacing one
 * is not a control this product has yet.
 */

type Answered = { readonly connection: ListedConnection };

/** Everything the edit half holds, seeded from the record when Edit is pressed. */
type Editing = {
  readonly name: string;
  readonly environment: string;
  readonly draft: Draft;
  readonly dispatch: LiveKitDispatch;
  /** What the dispatch mode was when editing began, so "changed" is truthful. */
  readonly startingDispatch: LiveKitDispatch;
};

export function ConnectionSheet({
  projectId,
  agentId,
  connectionId,
  environments = [],
  mayAuthor,
  role,
  onClose,
  onChanged,
}: {
  readonly projectId: string;
  readonly agentId: string;
  readonly connectionId: string;
  /** Environment labels already in use nearby, offered as suggestions. */
  readonly environments?: readonly string[];
  readonly mayAuthor: boolean;
  /** Null while the session read is in flight, so nothing is claimed yet. */
  readonly role: string | null;
  readonly onClose: () => void;
  /** The record moved: whatever is behind this panel should read again. */
  readonly onChanged: () => void;
}) {
  const { answer, reload } = useProjectRead<Answered>(
    (projectId) =>
      platformAnswer(
        getConnection(
          { agentId, connectionId, projectId },
          { client: platformClient },
        ),
      ),
    projectId,
    `${agentId}:${connectionId}`,
  );

  const [catalog, setCatalog] = useState<ConnectionOptionCatalog | null>(null);
  const [catalogRefused, setCatalogRefused] = useState<Refusal | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [archiving, setArchiving] = useState(false);
  const [saving, setSaving] = useState(false);
  const [refused, setRefused] = useState<Refusal | null>(null);
  const [nameProblem, setNameProblem] = useState<string | null>(null);

  useEffect(() => {
    let current = true;
    setCatalogRefused(null);
    void platformAnswer(listConnectionOptions({ client: platformClient })).then(
      (read) => {
        if (!current) return;
        if (read.status === "signed-out") window.location.replace("/sign-in");
        else if (read.status === "ready") setCatalog(read.value);
        else setCatalogRefused(read.refusal);
      },
    );
    return () => {
      current = false;
    };
  }, [attempt]);

  useEffect(() => {
    if (answer?.status === "signed-out") window.location.replace("/sign-in");
  }, [answer]);

  const connection = answer?.status === "ready" ? answer.value.connection : null;
  const option = connection === null ? undefined : optionNamed(catalog, connection);

  const liveKitForm = liveKitDispatchForm({
    connectionType: connection?.connectionType,
    option,
    config: editing?.draft.config ?? {},
    mode: editing?.dispatch ?? "named",
  });
  const changed =
    connection !== null &&
    editing !== null &&
    (editing.name !== connection.name ||
      editing.environment !== (connection.environment ?? "") ||
      editing.dispatch !== editing.startingDispatch ||
      JSON.stringify(editing.draft.config) !== JSON.stringify(connection.config));
  useUnsavedChanges(changed && !saving, saving);

  function startEditing(): void {
    if (connection === null) return;
    const dispatch = savedLiveKitDispatch(connection.config);
    setRefused(null);
    setNameProblem(null);
    setEditing({
      name: connection.name,
      environment: connection.environment ?? "",
      draft: { config: { ...connection.config }, credentials: {} },
      dispatch,
      startingDispatch: dispatch,
    });
  }

  function chooseLiveKitDispatch(next: LiveKitDispatch): void {
    setEditing((current) =>
      current === null
        ? current
        : {
            ...current,
            dispatch: next,
            draft: {
              ...current.draft,
              config: configForLiveKitDispatch(current.draft.config, next),
            },
          },
    );
  }

  async function save(): Promise<void> {
    if (saving || connection === null || editing === null || option === undefined) {
      return;
    }
    const wanted = editing.name.trim();
    if (wanted === "") {
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
    for (const field of option.fields) {
      const written = editing.draft.config[field.key]?.trim() ?? "";
      if (written === "") delete config[field.key];
      else config[field.key] = written;
    }

    setNameProblem(null);
    setRefused(null);
    setSaving(true);
    const done = await platformAnswer(
      updateConnection(
        {
          agentId: connection.agentId,
          connectionId: connection.id,
          projectId,
          name: wanted,
          config,
          /*
           * Sent only when it moved. `environment` is nullable in and out, so
           * an empty box means unlabelled and `null` is how that is written.
           */
          ...(editing.environment === (connection.environment ?? "")
            ? {}
            : {
                environment:
                  editing.environment.trim() === "" ? null : editing.environment.trim(),
              }),
        },
        { client: platformClient },
      ),
    );
    setSaving(false);

    if (done.status === "signed-out") {
      window.location.replace("/sign-in");
      return;
    }
    if (done.status !== "ready") {
      setRefused(done.refusal);
      return;
    }
    setEditing(null);
    reload();
    onChanged();
  }

  async function archive(): Promise<Refusal | null> {
    if (connection === null) return null;
    const done = await platformAnswer(
      archiveConnection(
        { agentId: connection.agentId, connectionId: connection.id, projectId },
        { client: platformClient },
      ),
    );
    if (done.status === "signed-out") {
      window.location.replace("/sign-in");
      return null;
    }
    return done.status === "ready" ? null : done.refusal;
  }

  function body(): ReactNode {
    if (answer === null || answer.status === "signed-out") {
      return <Loading what="this connection" />;
    }
    if (answer.status === "missing") {
      return <NotFound message={answer.refusal.message} />;
    }
    if (answer.status === "failed") {
      return <Failure message={answer.refusal.message} onRetry={reload} />;
    }
    if (connection === null) return null;

    if (editing !== null && option !== undefined) {
      return (
        <>
          <Field label="Name" htmlFor="edit-connection-name">
            <Input
              id="edit-connection-name"
              value={editing.name}
              aria-invalid={nameProblem !== null ? true : undefined}
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => {
                const next = event.target.value;
                setEditing((current) =>
                  current === null ? current : { ...current, name: next },
                );
                if (nameProblem !== null) setNameProblem(null);
              }}
            />
            {nameProblem === null ? null : <Problem>{nameProblem}</Problem>}
          </Field>

          {/*
           * **A box with suggestions, not a select.** The board draws a select,
           * and the contract takes free text with no operation that lists the
           * labels a project uses — so a select here would have to invent the
           * set and would refuse a label somebody is already running with. The
           * suggestions are the labels egma can see on this screen, which is
           * what a select would have offered, and typing past them still works.
           */}
          <Field label="Env" htmlFor="edit-connection-environment">
            <Input
              id="edit-connection-environment"
              value={editing.environment}
              list={environments.length === 0 ? undefined : "connection-environments"}
              placeholder={NO_ENVIRONMENT}
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => {
                const next = event.target.value;
                setEditing((current) =>
                  current === null ? current : { ...current, environment: next },
                );
              }}
            />
            {environments.length === 0 ? null : (
              <datalist id="connection-environments">
                {environments.map((one) => (
                  <option key={one} value={one} />
                ))}
              </datalist>
            )}
            <Help>
              {`Which deployment this points at. An empty box means ${NO_ENVIRONMENT.toLowerCase()}.`}
            </Help>
          </Field>

          <ConnectionFields
            option={liveKitForm.option ?? option}
            draft={editing.draft}
            onChange={(next) =>
              setEditing((current) =>
                current === null ? current : { ...current, draft: next },
              )
            }
            credentialsEditable={false}
            beforeCredentialFields={
              !liveKitForm.enabled ? undefined : (
                <LiveKitDispatchSetup
                  mode={liveKitForm.mode}
                  agentName={liveKitForm.agentName}
                  onModeChange={chooseLiveKitDispatch}
                  onAgentNameChange={(agentName) =>
                    setEditing((current) =>
                      current === null
                        ? current
                        : {
                            ...current,
                            draft: {
                              ...current.draft,
                              config: { ...current.draft.config, agentName },
                            },
                          },
                    )
                  }
                />
              )
            }
          />
          {refused === null ? null : <Problem>{refused.message}</Problem>}
        </>
      );
    }

    return (
      <>
        {catalogRefused === null ? null : (
          <Failure
            title="Egma could not describe this connection."
            message={catalogRefused.message}
            onRetry={() => setAttempt((current) => current + 1)}
          />
        )}
        <ReadConnection connection={connection} option={option} />
      </>
    );
  }

  const title = connection === null ? "Connection" : connection.name;
  const lead =
    connection === null
      ? null
      : `${connection.productLabel} · ${modalityLabel(connection.modality)}`;
  const whyNotMine =
    role === null
      ? undefined
      : `Your ${role} role cannot change connections. Ask an organization admin to change your role.`;

  return (
    <>
      <Sheet
        open
        onOpenChange={(next) => {
          if (!next) onClose();
        }}
      >
        <SheetContent aria-describedby={undefined}>
          <form
            className="contents"
            data-slot="form"
            onSubmit={(event) => {
              event.preventDefault();
              void save();
            }}
          >
            <SheetHeader>
              <SheetTitle>{title}</SheetTitle>
              {lead === null ? null : <SheetDescription>{lead}</SheetDescription>}
            </SheetHeader>
            <SheetBody>{body()}</SheetBody>
            {connection === null || role === null ? null : (
              <SheetFooter
                destructive={
                  <Button
                    className="text-failure"
                    disabled={!mayAuthor}
                    onClick={() => setArchiving(true)}
                    size="lg"
                    type="button"
                    variant="ghost"
                    why={mayAuthor ? undefined : whyNotMine}
                  >
                    Archive
                  </Button>
                }
              >
                {editing === null ? (
                  <Button
                    disabled={!mayAuthor || option === undefined}
                    onClick={startEditing}
                    size="lg"
                    type="button"
                    variant="secondary"
                    why={
                      option === undefined
                        ? "Egma could not describe this connection's fields."
                        : mayAuthor
                          ? undefined
                          : whyNotMine
                    }
                  >
                    Edit
                  </Button>
                ) : (
                  <>
                    <Button
                      disabled={saving || !changed || !liveKitForm.ready}
                      size="lg"
                      type="submit"
                      why={
                        liveKitForm.ready
                          ? undefined
                          : "Enter the exact LiveKit agent name, or choose automatic dispatch."
                      }
                    >
                      {saving ? "Saving…" : "Save"}
                    </Button>
                    <Button
                      onClick={() => setEditing(null)}
                      size="lg"
                      type="button"
                      variant="secondary"
                    >
                      Cancel
                    </Button>
                  </>
                )}
              </SheetFooter>
            )}
          </form>
        </SheetContent>
      </Sheet>

      {archiving && connection !== null ? (
        <ArchiveConfirm
          title="Archive connection"
          onArchive={archive}
          onClose={() => setArchiving(false)}
          onArchived={() => {
            setArchiving(false);
            onChanged();
            onClose();
          }}
        >
          {`Egma stops using “${connection.name}” to reach this agent, and every run waiting on it stops. Transcripts already stored stay stored.`}
        </ArchiveConfirm>
      ) : null}
    </>
  );
}

/** One fact about this connection: its name at the label step, its value under. */
function ReadRow({
  label,
  children,
  mono = false,
}: {
  readonly label: string;
  readonly children: ReactNode;
  readonly mono?: boolean;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <p className="m-0 text-sm text-faint">{label}</p>
      <p
        className={
          mono
            ? "m-0 min-w-0 font-mono text-sm text-foreground [overflow-wrap:anywhere]"
            : "m-0 min-w-0 text-sm text-foreground [overflow-wrap:anywhere]"
        }
      >
        {children}
      </p>
    </div>
  );
}

/**
 * The record, read.
 *
 * **The labelled rows come from the catalog and the raw block comes from the
 * record**, and both are drawn because they answer different questions. A row
 * says what a value *is* — "Retell agent ID" — in the registry's own words. The
 * block says what egma actually stored. A key from a newer server has no label
 * in this browser, so it is listed by its own name and loses nothing while
 * clients and servers roll forward separately.
 */
function ReadConnection({
  connection,
  option,
}: {
  readonly connection: ListedConnection;
  readonly option: ConnectionOption | undefined;
}) {
  const known = new Set(option?.fields.map((field) => field.key) ?? []);
  const rows: readonly { readonly label: string; readonly value: string }[] = [
    ...(option?.fields.flatMap((field) => {
      const value = connection.config[field.key];
      return value === undefined ? [] : [{ label: field.label, value }];
    }) ?? []),
    ...Object.entries(connection.config)
      .filter(([key]) => !known.has(key))
      .map(([key, value]) => ({ label: key, value })),
  ];

  return (
    <>
      <ReadRow label="Name">{connection.name}</ReadRow>
      <ReadRow label="Env">{connection.environment ?? NO_ENVIRONMENT}</ReadRow>
      <ReadRow label="Platform">
        {option?.agentPlatformLabel ??
          (connection.agentPlatform === null
            ? "Any or unknown"
            : agentPlatformLabel(connection.agentPlatform))}
      </ReadRow>
      <ReadRow label="Access">
        {option?.accessVariantLabel ?? connection.accessVariant}
      </ReadRow>
      {rows.map((row) => (
        <ReadRow key={row.label} label={row.label} mono>
          {row.value}
        </ReadRow>
      ))}
      <div className="flex min-w-0 flex-col gap-2">
        <p className="m-0 text-sm text-faint">Config</p>
        <pre className="m-0 overflow-x-auto border border-border bg-surface-soft p-3 font-mono text-sm text-muted-foreground">
          {JSON.stringify(connection.config)}
        </pre>
      </div>
      <p className="m-0 text-sm text-faint">
        {`Created ${asDay(connection.createdAt)} · Updated ${asDay(connection.updatedAt)}`}
      </p>
    </>
  );
}
