"use client";

import { useParams } from "next/navigation";
import { useEffect, useState } from "react";

import { writeJson, type Refusal } from "../../../../../lib/api.ts";
import { roleOf, type Project } from "../../../../../lib/me.ts";
import {
  API_KEYS_PATH,
  keysOwnedBy,
  revokeApiKeyPath,
  rowsIn,
  scopeOf,
  type ApiKey,
  type ApiKeyList,
  type MintedApiKey,
} from "../../../../../lib/settings.ts";
import {
  Badge,
  Button,
  Field,
  Form,
  FormActions,
  FormRow,
  Help,
  Refused,
  Section,
  Select,
  TextInput,
} from "../../../../../ui/controls.tsx";
import { DataTable, type Column } from "../../../../../ui/data-table.tsx";
import { Dialog } from "../../../../../ui/dialog.tsx";
import { Empty, Failure, Loading } from "../../../../../ui/page-state.tsx";
import { ScopeNote, SettingsNav } from "../../../../../ui/settings-nav.tsx";
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
      <p role="status">
        <strong>Here is your key. Copy it now.</strong> Egma will not show it
        again, and cannot: only its hash was kept. <code>{keyValue.secret}</code>
      </p>
      <Button weight="strong" onClick={() => void copy()}>
        Copy key
      </Button>{" "}
      <Button onClick={onDismiss}>Dismiss</Button>
      {copyState === "copied" ? <Help>Copied.</Help> : null}
      {copyState === "failed" ? (
        <Refused message="Egma could not copy the key. Select it above and copy it before you dismiss this message." />
      ) : null}
    </Section>
  );
}

function ApiKeys({ projectId }: { readonly projectId: string }) {
  const { me } = useShellSession();
  const role = me === null ? null : roleOf(me);
  const projects: readonly Project[] = me?.projects ?? [];

  const { answer, reload } = useOrganizationRead<ApiKeyList>(API_KEYS_PATH);

  const [name, setName] = useState("");
  const [scope, setScope] = useState<string>(projectId);
  const [minted, setMinted] = useState<MintedApiKey | null>(null);
  const [confirmingRevoke, setConfirmingRevoke] = useState<ApiKey | null>(null);
  const [busy, setBusy] = useState(false);
  const [refused, setRefused] = useState<Refusal | null>(null);
  useUnsavedChanges(
    busy || minted !== null || name.trim() !== "" || scope !== projectId,
  );

  useEffect(() => {
    if (answer?.status === "signed-out") window.location.replace("/sign-in");
  }, [answer]);

  async function mint(): Promise<void> {
    if (busy || minted !== null) return;
    setRefused(null);
    setBusy(true);

    const written = await writeJson<MintedApiKey>(API_KEYS_PATH, {
      method: "POST",
      body: {
        name: name.trim(),
        ...(scope === WHOLE_ORGANIZATION ? {} : { project_id: scope }),
      },
    });

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
    const written = await writeJson<ApiKey>(revokeApiKeyPath(key.id), {
      method: "POST",
      body: {},
    });
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

  function columns(mine: boolean): readonly Column<ApiKey>[] {
    return [
      {
        key: "name",
        header: "Name",
        primary: true,
        cell: (key) => key.name ?? "Unnamed key",
      },
      { key: "looks_like", header: "Key", mono: true, cell: (key) => key.looks_like },
      { key: "scope", header: "Scope", cell: (key) => scopeOf(key, projects) },
      ...(mine
        ? []
        : [
            {
              key: "owner",
              header: "Owner",
              mono: true,
              cell: (key: ApiKey) => key.created_by_user_id,
            },
          ]),
      {
        key: "used",
        header: "Last used",
        cell: (key) =>
          key.last_used_at === null
            ? "Never"
            : new Date(key.last_used_at).toLocaleDateString(),
      },
      {
        key: "standing",
        header: "Standing",
        cell: (key) =>
          key.revoked_at === null ? (
            <Button disabled={busy} onClick={() => setConfirmingRevoke(key)}>
              Revoke
            </Button>
          ) : (
            <Badge tone="warn">Revoked</Badge>
          ),
      },
    ];
  }

  const { mine, others } = keysOwnedBy(
    rowsIn(answer?.status === "ready" ? answer.value.keys : undefined),
    me?.user.id,
  );

  return (
    <ProductPage>
      <PageHeader
        eyebrow="Settings"
        title="API keys"
        lead="What a terminal or a script authenticates to egma with."
      />
      <PageBody>
        <SettingsNav projectId={projectId} current="keys" />
        <ScopeNote>
          Keys belong to the organization. A key can be scoped to one project or
          to the whole organization, and every row below says which.
        </ScopeNote>

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
                  <Field
                    label="Name"
                    htmlFor="key-name"
                    hint="Optional. What this key is for, so a key nobody needs is recognisable later."
                  >
                    <TextInput
                      id="key-name"
                      value={name}
                      disabled={busy}
                      onChange={setName}
                    />
                  </Field>
                  <Field
                    label="Scope"
                    htmlFor="key-scope"
                    hint="A project-scoped key reaches that project only. It cannot be widened later."
                  >
                    <Select
                      id="key-scope"
                      value={scope}
                      disabled={busy}
                      options={[
                        ...projects.map((project) => ({
                          value: project.id,
                          label: `Project · ${project.name}`,
                        })),
                        {
                          value: WHOLE_ORGANIZATION,
                          label: "Whole organization",
                        },
                      ]}
                      onChange={setScope}
                    />
                  </Field>
                </FormRow>
                <FormActions>
                  <Button
                    weight="strong"
                    type="submit"
                    disabled={busy || minted !== null}
                    why={
                      minted === null
                        ? undefined
                        : "Copy and dismiss the key above before you create another one."
                    }
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
                  columns={columns(true)}
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
                title="Everybody else's keys"
                lead="An admin sees every key in the organization, so responding to a leak never depends on who created one."
              >
                <DataTable
                  label="Other people's API keys"
                  columns={columns(false)}
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
      </PageBody>

      {confirmingRevoke === null ? null : (
        <Dialog
          title={`Revoke API key “${confirmingRevoke.name ?? confirmingRevoke.looks_like}”?`}
          onClose={() => setConfirmingRevoke(null)}
        >
          {(dismiss) => (
            <>
              <p>
                {confirmingRevoke.name ?? "This key"} will stop working on its next
                request. This action cannot be undone.
              </p>
              <Button onClick={dismiss}>Cancel</Button>{" "}
              <Button
                weight="strong"
                disabled={busy}
                onClick={() => {
                  const key = confirmingRevoke;
                  setConfirmingRevoke(null);
                  void revoke(key);
                }}
              >
                Revoke key
              </Button>
            </>
          )}
        </Dialog>
      )}
    </ProductPage>
  );
}
