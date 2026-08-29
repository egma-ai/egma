"use client";

import { useEffect, useId, useState, type ReactNode } from "react";
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
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import type { Refusal } from "@/lib/api.ts";
import { modalityLabel, type ListedConnection } from "@/lib/agents.ts";
import {
  optionNamed,
  type ConnectionOption,
  type ConnectionOptionCatalog,
} from "@/lib/connection-options.ts";
import { asListInstant } from "@/lib/instants.ts";
import { platformAnswer, platformClient } from "@/lib/platform-client.ts";
import { agentPlatformLabel } from "@/lib/transcripts.ts";
import { Field, Help, Problem } from "@/ui/form.tsx";
import { Failure, Loading, NotFound } from "@/ui/page-state.tsx";
import { useProjectRead } from "@/ui/resource.ts";
import { useUnsavedChanges } from "@/ui/settings-read.ts";

import { ArchiveConfirm } from "./archive.tsx";
import { RowMenu, RowMenuDestructive, RowMenuItem } from "./row-menu.tsx";
import { ConnectionFields, type Draft } from "./[agentId]/connections/fields.tsx";
import {
  liveKitAgentNameForm,
  LiveKitAgentName,
} from "./[agentId]/connections/livekit-agent-name.tsx";

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
 * **Read first, edit on purpose, and manage from the ⋮.** Reading is plain
 * labelled rows with no controls in front of them; Edit connection and Delete
 * connection live in a menu in the head, and the footer exists only while
 * something is being edited.
 *
 * **The destructive action says "Delete", and the write underneath archives**
 * (founder ruling, 2026-08-24). The word matches what a person meant; the
 * sentence in the confirmation is what says what actually happens to stored
 * transcripts. See `archive.tsx`.
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
  readonly draft: Draft;
};

/**
 * Why Save is not available on a LiveKit room with no worker name.
 *
 * Written once because it is said three times — on the control, to a screen
 * reader, and in the panel — and three copies of one sentence are three
 * sentences waiting to disagree.
 */
const LIVEKIT_NAME_NEEDED = "Enter the exact LiveKit agent name.";

export function ConnectionSheet({
  projectId,
  agentId,
  connectionId,
  mayAuthor,
  role,
  onClose,
  onChanged,
}: {
  readonly projectId: string;
  readonly agentId: string;
  readonly connectionId: string;
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
  /**
   * Where the reason a footer control is not available is written.
   *
   * **It is a line of the panel, not a line of the footer.** `Button`'s own
   * `why` draws the sentence beside the control, which is right in a toolbar
   * and wrong in a 440px footer: two disabled controls would put two long
   * sentences between Edit and Archive. The controls still name it, and still
   * carry it as a `title`, so a pointer, a keyboard and a screen reader all
   * reach it.
   */
  const whySaid = useId();

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

  const liveKitForm = liveKitAgentNameForm({
    connectionType: connection?.connectionType,
    option,
    config: editing?.draft.config ?? {},
  });
  const changed =
    connection !== null &&
    editing !== null &&
    (editing.name !== connection.name ||
      JSON.stringify(editing.draft.config) !== JSON.stringify(connection.config));
  useUnsavedChanges(changed && !saving, saving);

  function startEditing(): void {
    if (connection === null) return;
    setRefused(null);
    setNameProblem(null);
    setEditing({
      name: connection.name,
      draft: { config: { ...connection.config }, credentials: {} },
    });
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
      setRefused({ error: "unprocessable", message: LIVEKIT_NAME_NEEDED });
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
          <Field label="Connection name*" htmlFor="edit-connection-name">
            <Input
              aria-required="true"
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
                <LiveKitAgentName
                  agentName={liveKitForm.agentName}
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
          {liveKitForm.ready ? null : (
            <Help id={whySaid}>{LIVEKIT_NAME_NEEDED}</Help>
          )}
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
        {whyNotRead === undefined ? null : <Help id={whySaid}>{whyNotRead}</Help>}
      </>
    );
  }

  const title = connection === null ? "Connection" : connection.name;
  const whyNotMine =
    role === null
      ? undefined
      : `Your ${role} role cannot change connections. Ask an organization admin to change your role.`;
  /** Why the read view offers no Edit, when it does not. */
  const whyNotRead =
    option === undefined && connection !== null
      ? "Egma could not describe this connection's fields."
      : mayAuthor
        ? undefined
        : whyNotMine;

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
            {/*
              * **The head is the name and a ⋮, and no subtitle** (`ITZ-0`).
              * The old "Retell phone · Voice" line under the name said what
              * the Access row says two lines below it, and the first thing a
              * panel says should be the record rather than its category.
              *
              * **Managing lives in the menu, and reading lives in the body.**
              * Edit and Delete used to stand in the footer under a record
              * nobody had asked to change yet, which made every read of a
              * connection look like a form.
              */}
            <SheetHeader
              {...(connection === null || role === null || editing !== null
                ? {}
                : {
                    actions: (
                      <RowMenu label={`Actions for ${connection.name}`}>
                        <RowMenuItem
                          onSelect={startEditing}
                          {...(whyNotRead === undefined ? {} : { why: whyNotRead })}
                        >
                          Edit connection
                        </RowMenuItem>
                        <RowMenuDestructive
                          onSelect={() => setArchiving(true)}
                          {...(mayAuthor ? {} : { why: whyNotMine })}
                        >
                          Delete connection
                        </RowMenuDestructive>
                      </RowMenu>
                    ),
                  })}
            >
              <SheetTitle>{title}</SheetTitle>
            </SheetHeader>
            <SheetBody>{body()}</SheetBody>
            {connection === null || role === null || editing === null ? null : (
              <SheetFooter>
                <Button
                  disabled={saving || !changed || !liveKitForm.ready}
                  size="lg"
                  type="submit"
                  title={liveKitForm.ready ? undefined : LIVEKIT_NAME_NEEDED}
                  aria-describedby={liveKitForm.ready ? undefined : whySaid}
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
              </SheetFooter>
            )}
          </form>
        </SheetContent>
      </Sheet>

      {archiving && connection !== null ? (
        <ArchiveConfirm
          title="Delete connection"
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
 * **Six kinds of row and no more** (`ITZ-0`, `JYY-0`, `K40-0`): Name, Access,
 * Modality, the rows the catalog names for what is stored, the Config block,
 * and Created. Updated-at, Env and Platform left with the 2026-08-24 boards —
 * Platform because Access already says which product this is, Updated-at
 * because nobody reads a connection to find out when it was touched, and Env
 * because the product stopped speaking that word (the column stays where it
 * is, unspoken).
 *
 * **The phone number is not a row.** It shows inside the Config block and
 * nowhere else, so the panel does not say the same fact twice in two shapes.
 *
 * **The labelled rows come from the catalog and the raw block comes from the
 * record**, and both are drawn because they answer different questions. A row
 * says what a value *is* — "Retell agent ID" — in the registry's own words.
 * The block says what egma actually stored. A key from a newer server has no
 * label in this browser, so it is listed by its own name and loses nothing
 * while clients and servers roll forward separately.
 *
 * **A credential is never here.** A read answers whether one is present and a
 * hint of which it is; the hint is drawn as its last characters and the secret
 * is not in the answer at all.
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
      return value === undefined || field.key === PHONE_NUMBER
        ? []
        : [{ label: field.label, value }];
    }) ?? []),
    ...Object.entries(connection.config)
      .filter(([key]) => !known.has(key) && key !== PHONE_NUMBER)
      .map(([key, value]) => ({ label: key, value })),
  ];

  return (
    <>
      <ReadRow label="Name">{connection.name}</ReadRow>
      <ReadRow label="Access">
        {option?.accessVariantLabel ?? connection.accessVariant}
      </ReadRow>
      <ReadRow label="Modality">{modalityLabel(connection.modality)}</ReadRow>
      {rows.map((row) => (
        <ReadRow key={row.label} label={row.label} mono>
          {row.value}
        </ReadRow>
      ))}
      {connection.credentialsHint === null ? null : (
        <ReadRow label="Credentials" mono>
          {`…${connection.credentialsHint}`}
        </ReadRow>
      )}
      <div className="flex min-w-0 flex-col gap-2">
        <p className="m-0 text-sm text-faint">Config</p>
        <pre className="m-0 overflow-x-auto border border-border bg-surface-soft p-3 font-mono text-sm text-muted-foreground">
          {JSON.stringify(connection.config)}
        </pre>
      </div>
      <ReadRow label="Created">{asListInstant(connection.createdAt)}</ReadRow>
    </>
  );
}

/**
 * The one config key that has no row of its own.
 *
 * A phone connection is the number, so the number was the row *and* the whole
 * of the Config block under it — the same fact drawn twice, one line apart.
 * The boards keep it in the block, which is the place that says what Egma
 * actually stored.
 */
const PHONE_NUMBER = "phoneNumber";
