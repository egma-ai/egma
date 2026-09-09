"use client";

import { useParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import {
  deleteProviderKey,
  listProviderKeys,
  putProviderKey,
  type ProviderKeyEntry,
} from "@egma/platform-api/client";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
import {
  platformAnswer,
  platformClient,
} from "../../../../../lib/platform-client.ts";
import { REPLAY_PRIVATE } from "../../../../../lib/replay-privacy.ts";
import { DataTable, type Column } from "../../../../../ui/data-table.tsx";
import { useDraftNavigation } from "../../../../../ui/draft-navigation.tsx";
import { Field, Help, Refused } from "../../../../../ui/form.tsx";
import { Failure, Loading } from "../../../../../ui/page-state.tsx";
import { ListInstant } from "../../../../../ui/relative-time.tsx";
import {
  useOrganizationRead,
  useUnsavedChanges,
} from "../../../../../ui/settings-read.ts";
import { SettingsPageShell, useSettingsRouteShell } from "../route-shell.tsx";

export default function ProviderApiKeysSettingsPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const sharedShell = useSettingsRouteShell();
  const body = <ProviderApiKeys projectId={projectId} />;
  return sharedShell ? body : <SettingsPageShell section="provider-api-keys">{body}</SettingsPageShell>;
}

function ProviderApiKeys({ projectId }: { readonly projectId: string }) {
  const { answer, reload, refresh } = useOrganizationRead(() =>
    platformAnswer(listProviderKeys({ client: platformClient })),
  );
  const [editing, setEditing] = useState<ProviderKeyEntry | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const opener = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (answer?.status === "signed-out") window.location.replace("/sign-in");
  }, [answer]);

  const columns: readonly Column<ProviderKeyEntry>[] = [
    {
      key: "provider",
      header: "Provider",
      primary: true,
      cell: (entry) => entry.label,
    },
    {
      key: "key",
      header: "Organization key",
      cell: (entry) =>
        entry.credential === null ? (
          "No key added"
        ) : (
          <span {...REPLAY_PRIVATE} className="font-mono">
            {entry.credential.hint}
          </span>
        ),
    },
    {
      key: "updated",
      header: "Updated",
      cell: (entry) =>
        entry.credential === null ? (
          "—"
        ) : (
          <ListInstant instant={entry.credential.updatedAt} />
        ),
    },
    ...(answer?.status === "ready" && answer.value.mayManageProviderKeys
      ? [
          {
            key: "actions",
            header: "Actions",
            action: true,
            cell: (entry: ProviderKeyEntry) => (
              <div className="flex justify-end px-(--row-padding-x) stacked:px-0">
                <Button
                  type="button"
                  variant="secondary"
                  onClick={(event) => {
                    opener.current = event.currentTarget;
                    setSaved(null);
                    setEditing(entry);
                  }}
                  aria-label={`${entry.credential === null ? "Add" : "Manage"} ${entry.label} key`}
                >
                  {entry.credential === null ? "Add key" : "Manage key"}
                </Button>
              </div>
            ),
          },
        ]
      : []),
  ];

  return (
    <>
          {saved === null ? null : (
            <p className="m-0 text-sm" role="status">
              {saved}
            </p>
          )}
          {answer === null ? (
            <Loading what="provider keys" />
          ) : answer.status !== "ready" ? (
            <Failure
              message={
                answer.status === "signed-out"
                  ? "Your session has ended. Sign in and try again."
                  : answer.refusal.message
              }
              onRetry={reload}
            />
          ) : (
            <>
              <DataTable
                label="Provider API keys"
                columns={columns}
                rows={answer.value.providers}
                keyOf={(entry) => entry.provider}
              />
              {answer.value.mayManageProviderKeys ? null : (
                <Help>
                  Ask an organization admin to add, replace, or remove provider
                  keys.
                </Help>
              )}
            </>
          )}
      {editing === null ? null : (
        <ProviderKeyEditor
          entry={editing}
          returnFocusTo={opener.current}
          onClose={() => setEditing(null)}
          onConflict={refresh}
          onSaved={(message) => {
            setSaved(message);
            refresh();
          }}
        />
      )}
    </>
  );
}

function ProviderKeyEditor({
  entry,
  returnFocusTo,
  onClose,
  onConflict,
  onSaved,
}: {
  readonly entry: ProviderKeyEntry;
  readonly returnFocusTo: HTMLElement | null;
  readonly onClose: () => void;
  readonly onConflict: () => void;
  readonly onSaved: (message: string) => void;
}) {
  const navigation = useDraftNavigation();
  const [key, setKey] = useState("");
  const [open, setOpen] = useState(true);
  const [busy, setBusy] = useState(false);
  const [refused, setRefused] = useState<string | null>(null);
  const [confirmingRemove, setConfirmingRemove] = useState(false);
  const removeButton = useRef<HTMLButtonElement | null>(null);
  useUnsavedChanges(key !== "", busy);

  function close(): void {
    navigation.request(() => setOpen(false));
  }

  async function save(): Promise<void> {
    if (busy || key.trim().length < 8) return;
    setBusy(true);
    setRefused(null);
    const result = await platformAnswer(
      putProviderKey(
        {
          provider: entry.provider,
          key: key.trim(),
          expectedRevision: entry.credential?.revision ?? null,
        },
        { client: platformClient },
      ),
    );
    setBusy(false);
    if (result.status === "signed-out") {
      window.location.replace("/sign-in");
      return;
    }
    if (result.status !== "ready") {
      if (result.refusal.error === "identity_conflict") onConflict();
      setRefused(result.refusal.message);
      return;
    }
    setKey("");
    onSaved(`${entry.label} key saved.`);
    setOpen(false);
  }

  async function remove(): Promise<void> {
    if (busy || entry.credential === null) return;
    setBusy(true);
    setRefused(null);
    const result = await platformAnswer(
      deleteProviderKey(
        {
          provider: entry.provider,
          expectedRevision: entry.credential.revision,
        },
        { client: platformClient },
      ),
    );
    setBusy(false);
    if (result.status === "signed-out") {
      window.location.replace("/sign-in");
      return;
    }
    if (result.status !== "ready") {
      if (result.refusal.error === "identity_conflict") onConflict();
      setRefused(result.refusal.message);
      return;
    }
    setKey("");
    setConfirmingRemove(false);
    onSaved(`${entry.label} key removed.`);
    setOpen(false);
  }

  return (
    <Sheet
      open={open}
      onOpenChange={(next) => {
        if (!next) close();
      }}
    >
      <SheetContent
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          returnFocusTo?.focus();
          onClose();
        }}
      >
        <SheetHeader>
          <SheetTitle>{entry.label} API key</SheetTitle>
          <SheetDescription>
            {entry.credential === null
              ? "Add a key from your provider account."
              : "Replace or remove this organization’s key."}
          </SheetDescription>
        </SheetHeader>
        <SheetBody>
          <form
            id="provider-key-form"
            onSubmit={(event) => {
              event.preventDefault();
              void save();
            }}
            className="flex flex-col gap-4"
          >
            {entry.credential === null ? null : (
              <p className="m-0 text-sm text-muted-foreground">
                Current key:{" "}
                <span {...REPLAY_PRIVATE} className="font-mono">
                  {entry.credential.hint}
                </span>
              </p>
            )}
            <Field
              label={`${entry.credential === null ? "API key" : "New API key"}*`}
              htmlFor="provider-api-key"
            >
              <Input
                {...REPLAY_PRIVATE}
                id="provider-api-key"
                type="password"
                autoComplete="new-password"
                autoCapitalize="none"
                spellCheck={false}
                required
                aria-required="true"
                minLength={8}
                maxLength={4096}
                disabled={busy}
                value={key}
                onChange={(event) => {
                  setKey(event.target.value);
                  setRefused(null);
                }}
              />
            </Field>
            <Help>
              New work uses the saved key. Calls already in progress keep the
              key they started with.
            </Help>
            {refused === null || confirmingRemove ? null : (
              <Refused message={refused} />
            )}
          </form>
        </SheetBody>
        <SheetFooter
          secondary={
            <Button
              type="button"
              size="lg"
              variant="secondary"
              disabled={busy}
              onClick={close}
            >
              Cancel
            </Button>
          }
          destructive={
            entry.credential === null ? undefined : (
              <Button
                ref={removeButton}
                type="button"
                variant="ghost"
                className="text-(--bad)"
                disabled={busy || key !== ""}
                onClick={() => {
                  setRefused(null);
                  setConfirmingRemove(true);
                }}
              >
                Remove key
              </Button>
            )
          }
        >
          <Button
            form="provider-key-form"
            type="submit"
            size="lg"
            busy={busy}
            disabled={key.trim().length < 8}
          >
            Save key
          </Button>
        </SheetFooter>
        <Dialog
          open={confirmingRemove}
          onOpenChange={(next) => {
            if (!busy) setConfirmingRemove(next);
          }}
        >
          <DialogContent
            showCloseButton={!busy}
            onCloseAutoFocus={(event) => {
              event.preventDefault();
              if (removeButton.current?.isConnected)
                removeButton.current.focus();
            }}
          >
            <DialogHeader>
              <DialogTitle>Remove {entry.label} API key?</DialogTitle>
            </DialogHeader>
            <DialogDescription>
              New work will use the default {entry.label} key. On Egma Cloud, it
              will use your inference balance. Calls already in progress will
              keep their current key.
            </DialogDescription>
            {refused === null ? null : <Refused message={refused} />}
            <DialogFooter>
              <Button
                type="button"
                size="lg"
                variant="destructive"
                busy={busy}
                onClick={() => void remove()}
              >
                Remove key
              </Button>
              <Button
                type="button"
                size="lg"
                variant="secondary"
                disabled={busy}
                onClick={() => setConfirmingRemove(false)}
              >
                Cancel
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </SheetContent>
    </Sheet>
  );
}
