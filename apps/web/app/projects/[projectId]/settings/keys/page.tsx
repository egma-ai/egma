"use client";

import { EyeOffIcon } from "lucide-react";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import { createApiKey, listApiKeys, revokeApiKey } from "@egma/platform-api/client";

import type { Refusal } from "../../../../../lib/api.ts";
import { roleOf, type Project } from "../../../../../lib/me.ts";
import { platformAnswer, platformClient } from "../../../../../lib/platform-client.ts";
import {
  keysOwnedBy,
  rowsIn,
  scopeOf,
  type ApiKey,
  type ApiKeyList,
  type ListedApiKey,
  type MintedApiKey,
} from "../../../../../lib/settings.ts";
import { Button } from "@/components/ui/button";
import { Card, CardFooter } from "@/components/ui/card";
import { DialogFooter } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";

import { DataTable, type Column } from "../../../../../ui/data-table.tsx";
import { Dialog } from "../../../../../ui/dialog.tsx";
import {
  Field,
  Form,
  FormActions,
  FormRow,
  Help,
  Refused,
} from "../../../../../ui/form.tsx";
import { Empty, Failure, Loading } from "../../../../../ui/page-state.tsx";
import {
  ListInstant,
} from "../../../../../ui/relative-time.tsx";
import { Section } from "../../../../../ui/section.tsx";
import { SettingsLayout } from "../../../../../ui/settings-nav.tsx";
import {
  useOrganizationRead,
  useUnsavedChanges,
} from "../../../../../ui/settings-read.ts";
import {
  AppShell,
  PageBody,
  PageHeader,
  ProductPage,
  useShellSession,
} from "../../../../../ui/shell.tsx";

/**
 * The keys a terminal authenticates with.
 *
 * **A secret exists once.** It is in the answer to the request that minted it
 * and nowhere else — not in a row, not behind a reveal control, not in any
 * route. So the page shows it once, says so plainly, and what remains
 * afterwards is a prefix, four characters, and who minted it.
 *
 * **This is the one page where a viewer's controls stay live.** Every other
 * mutation in the product is an admin's or a member's and is shown disabled to
 * a viewer; here, creating and revoking *your own* key is something every role
 * does, because `egma login` mints one as its last step and a credential you
 * cannot list or revoke is a credential you cannot rotate. An admin
 * additionally sees and can revoke everybody else's, which is what responding
 * to a leak requires. Neither of those splits is enforced here — the server
 * filters the list and refuses the write.
 *
 * Keys belong to the organization even when they are scoped to one project, so
 * the note under the heading says so and every row states its scope.
 */
export default function ApiKeysSettingsPage() {
  const { projectId } = useParams<{ projectId: string }>();
  return (
    <AppShell>
      <ApiKeys projectId={projectId} />
    </AppShell>
  );
}

const WHOLE_ORGANIZATION = "";

/**
 * The lane a row's own controls stand in.
 *
 * The shared table draws the trailing cell as the boards do — a fixed 48px slot
 * with no side padding, so that every ⋮ in the product lines up in one column
 * down the table (`78X-0`). A cell holding a named button rather than a ⋮ is
 * wider than the slot and grows it, and with no padding of its own the button
 * then sits against the panel's own hairline. This puts the row's padding back
 * inside the cell, where the width is the caller's problem rather than the
 * table's.
 */
const ROW_ACTIONS = "flex items-center justify-end gap-2 px-4";

/**
 * The only copy of a newly minted secret.
 *
 * This component sits above the key-list read rather than inside it. A refresh
 * or a failed list read therefore cannot take the secret off screen before the
 * person who created it has copied and dismissed it.
 */
function ApiKeyReceipt({
  keyValue,
  onDismiss,
}: {
  readonly keyValue: MintedApiKey;
  readonly onDismiss: () => void;
}) {
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">(
    "idle",
  );

  async function copy(): Promise<void> {
    try {
      if (navigator.clipboard === undefined) {
        throw new Error("clipboard unavailable");
      }
      await navigator.clipboard.writeText(keyValue.secret);
      setCopyState("copied");
    } catch {
      setCopyState("failed");
    }
  }

  return (
    <Section title="Copy your new key">
      <Card className="gap-4">
        <div className="flex flex-col gap-3">
          <div className="flex items-start justify-between gap-4">
            <p className="m-0 max-w-[72ch] text-sm text-muted-foreground" role="status">
              <strong className="font-medium text-foreground">
                Here is your key. Copy it now.
              </strong>{" "}
              Egma will not show it again, and cannot: only its hash was kept.
            </p>
            {/*
             * That this is the only time, said at the head of the panel rather
             * than only inside the sentence — which is what `2BO-0` draws. The
             * word carries the meaning and the icon carries it again for
             * anybody reading without colour: "state is not communicated by
             * colour alone".
             */}
            <span className="inline-flex flex-none items-center gap-2 text-sm text-(--bad)">
              <EyeOffIcon aria-hidden="true" className="size-4" strokeWidth={1.75} />
              Shown once
            </span>
          </div>
          {/*
           * The secret on its own contained surface, in the mono face, wrapped
           * rather than clipped (`7D6-0`). A key that ran off the edge of its
           * line would be a key somebody copied half of.
           */}
          <code className="block rounded-input border border-border bg-surface-soft p-3 font-mono text-sm break-all text-foreground">
            {keyValue.secret}
          </code>
        </div>
        <CardFooter>
          <Button type="button" onClick={() => void copy()}>
            Copy key
          </Button>
          <Button type="button" variant="secondary" onClick={onDismiss}>
            Dismiss
          </Button>
        </CardFooter>
        {copyState === "copied" ? <Help>Copied.</Help> : null}
        {copyState === "failed" ? (
          <Refused message="Egma could not copy the key. Select it above and copy it before you dismiss this message." />
        ) : null}
      </Card>
    </Section>
  );
}

function ApiKeys({ projectId }: { readonly projectId: string }) {
  const { me } = useShellSession();
  const role = me === null ? null : roleOf(me);
  const projects: readonly Project[] = me?.projects ?? [];

  const { answer, reload } = useOrganizationRead<ApiKeyList>(() =>
    platformAnswer(listApiKeys({ client: platformClient })),
  );

  const [name, setName] = useState("");
  const [scope, setScope] = useState<string>(projectId);
  const [minted, setMinted] = useState<MintedApiKey | null>(null);
  const [confirmingRevoke, setConfirmingRevoke] = useState<ApiKey | null>(null);
  const [busy, setBusy] = useState(false);
  const [refused, setRefused] = useState<Refusal | null>(null);
  useUnsavedChanges(
    minted !== null || name.trim() !== "" || scope !== projectId,
    busy,
  );

  useEffect(() => {
    if (answer?.status === "signed-out") window.location.replace("/sign-in");
  }, [answer]);

  async function mint(): Promise<void> {
    if (busy || minted !== null) return;
    setRefused(null);
    setBusy(true);

    const written = await platformAnswer(
      createApiKey(
        {
        name: name.trim(),
          ...(scope === WHOLE_ORGANIZATION ? {} : { projectId: scope }),
        },
        { client: platformClient },
      ),
    );

    setBusy(false);
    if (written.status === "signed-out") {
      window.location.replace("/sign-in");
      return;
    }
    if (written.status !== "ready") {
      setRefused(written.refusal);
      return;
    }
    setName("");
    setMinted(written.value);
    reload();
  }

  async function revoke(key: ApiKey): Promise<void> {
    if (busy) return;
    setRefused(null);
    setBusy(true);
    const written = await platformAnswer(
      revokeApiKey({ apiKeyId: key.id }, { client: platformClient }),
    );
    setBusy(false);
    if (written.status === "signed-out") {
      window.location.replace("/sign-in");
      return;
    }
    if (written.status !== "ready") {
      setRefused(written.refusal);
      return;
    }
    reload();
  }

  function columns(showOwner = false): readonly Column<ListedApiKey>[] {
    const owner: Column<ListedApiKey> = {
      key: "owner",
      header: "Owner",
      cell: (key) => key.createdByEmail?.trim() || "Owner unavailable",
    };

    return [
      {
        key: "name",
        header: "Name",
        primary: true,
        cell: (key) => key.name ?? "Unnamed key",
      },
      ...(showOwner ? [owner] : []),
      { key: "looksLike", header: "Key", mono: true, cell: (key) => key.looksLike },
      { key: "scope", header: "Scope", cell: (key) => scopeOf(key, projects) },
      {
        key: "used",
        header: "Last used",
        cell: (key) =>
          key.lastUsedAt === null ? (
            "Never"
          ) : (
            <ListInstant instant={key.lastUsedAt} />
          ),
      },
      {
        key: "actions",
        header: "Actions",
        /*
         * A row control, said to the table rather than only drawn like one.
         *
         * The shared table keeps an `action` cell at the trailing edge and lets
         * it out of the one-line ellipsis every other cell gets. That second
         * half is why this is here: the ellipsis comes from `overflow: hidden`
         * on the cell, and an outline is clipped by an ancestor's overflow, so a
         * control in an unmarked cell had the Ember focus ring cut off on every
         * side. Other row controls were already marked; these were the same
         * concept drawn two ways.
         */
        action: true,
        cell: (key) => (
          <div className={ROW_ACTIONS}>
            <Button
              type="button"
              variant="secondary"
              disabled={busy}
              onClick={() => setConfirmingRevoke(key)}
            >
              Revoke
            </Button>
          </div>
        ),
      },
    ];
  }

  // Revocation is permanent history for authentication and audit work, but it
  // is not an item somebody can use or act on. Keep that history in the API and
  // remove it only from this normal working list.
  const activeKeys = rowsIn(
    answer?.status === "ready" ? answer.value.keys : undefined,
  ).filter((key) => key.revokedAt === null);
  const { mine, others } = keysOwnedBy(
    activeKeys,
    me?.user.id,
  );

  /*
   * Why creating another key is not available: there is a secret on screen
   * that exists nowhere else, and a second create would draw over it.
   */
  const whyNot =
    minted === null
      ? undefined
      : "Copy and dismiss the key above before you create another one.";

  return (
    <ProductPage viewport>
      <PageHeader
        title="API keys"
        lead="What a terminal or a script authenticates to Egma with."
      />
      <PageBody>
        <SettingsLayout projectId={projectId} current="keys">
          {refused === null ? null : <Refused message={refused.message} />}

          {minted === null ? null : (
            <ApiKeyReceipt keyValue={minted} onDismiss={() => setMinted(null)} />
          )}

          {answer === null ? (
            <Loading what="your keys" />
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
              <Section
                title="Create a key"
                lead="Every role may create, list and revoke their own keys."
              >
                <Form onSubmit={() => void mint()}>
                  <FormRow>
                    <Field label="Name" htmlFor="key-name">
                      <Input
                        id="key-name"
                        value={name}
                        autoComplete="off"
                        spellCheck={false}
                        disabled={busy}
                        onChange={(event) => setName(event.target.value)}
                      />
                    </Field>
                    <Field label="Scope" htmlFor="key-scope">
                      <Select
                        id="key-scope"
                        value={scope}
                        disabled={busy}
                        onChange={(event) => setScope(event.target.value)}
                      >
                        {projects.map((project) => (
                          <option key={project.id} value={project.id}>
                            {`Project · ${project.name}`}
                          </option>
                        ))}
                        <option value={WHOLE_ORGANIZATION}>
                          Whole organization
                        </option>
                      </Select>
                    </Field>
                  </FormRow>
                  <FormActions>
                    <Button
                      type="submit"
                      disabled={minted !== null}
                      busy={busy}
                      {...(whyNot === undefined ? {} : { why: whyNot })}
                    >
                      {busy ? "Creating…" : "Create key"}
                    </Button>
                  </FormActions>
                </Form>
              </Section>

              <Section title="Your keys">
                {mine.length === 0 ? (
                  <Empty
                    title="You have no keys yet."
                    lead="Create one above, or run egma login and let the terminal mint one."
                  />
                ) : (
                  <DataTable
                    label="Your API keys"
                    columns={columns()}
                    rows={mine}
                    keyOf={(key) => key.id}
                  />
                )}
              </Section>

              {/*
                * Everybody else's, which the server answers with only for an admin.
                * The section is absent rather than empty for anybody else, because
                * there is nothing being withheld from them: the read simply does not
                * carry other people's rows, so a heading over nothing would suggest a
                * list they are not being shown.
                */}
              {others.length === 0 ? null : (
                <Section
                  title="Other members’ keys"
                  lead="An admin sees every key in the organization, so responding to a leak never depends on who created one."
                >
                  <DataTable
                    label="Other people's API keys"
                    columns={columns(true)}
                    rows={others}
                    keyOf={(key) => key.id}
                  />
                </Section>
              )}
            </>
          )}

          {role === "viewer" ? (
            <Help>
              Your viewer role cannot change agents, tests, personas or graders —
              and your own keys are the exception, because a credential you cannot
              rotate is one you cannot keep safe.
            </Help>
          ) : null}
        </SettingsLayout>
      </PageBody>

      {confirmingRevoke === null ? null : (
        <Dialog
          title={`Revoke API key “${confirmingRevoke.name ?? confirmingRevoke.looksLike}”?`}
          onClose={() => setConfirmingRevoke(null)}
        >
          {(dismiss) => (
            <>
              <p className="m-0 max-w-[62ch] text-sm text-muted-foreground">
                {confirmingRevoke.name ?? "This key"} will stop working on its next
                request. This action cannot be undone.
              </p>
              {/*
               * The answer leads and the way out follows it, both at the left
               * edge, which is what `BK9-0` draws. Without the footer the two
               * were flex children of the panel's own column and each ran the
               * full width of it, stacked — two blocks where the board has one
               * row.
               */}
              <DialogFooter>
                <Button
                  type="button"
                  size="lg"
                  variant="destructive"
                  disabled={busy}
                  onClick={() => {
                    const key = confirmingRevoke;
                    setConfirmingRevoke(null);
                    void revoke(key);
                  }}
                >
                  Revoke key
                </Button>
                <Button type="button" size="lg" variant="secondary" onClick={dismiss}>
                  Cancel
                </Button>
              </DialogFooter>
            </>
          )}
        </Dialog>
      )}
    </ProductPage>
  );
}
