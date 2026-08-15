"use client";

import { useParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";

import { readJson, writeJson, type Refusal } from "../../../../../lib/api.ts";
import { roleOf } from "../../../../../lib/me.ts";
import {
  ASSIGNABLE_ROLES,
  INVITATIONS_PATH,
  MEMBERS_PATH,
  memberActionPath,
  rowsIn,
  type Invitation,
  type InvitationList,
  type Member,
  type Roster,
} from "../../../../../lib/settings.ts";
import {
  Badge,
  Button,
  Choice,
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
import { useOrganizationRead } from "../../../../../ui/settings-read.ts";
import {
  AppShell,
  PageBody,
  PageHeader,
  ProductPage,
  useShellSession,
} from "../../../../../ui/shell.tsx";

/**
 * Who is in this organization, and the four things an admin may do about it.
 *
 * **Membership is the organization's and not a project's.** The selector stays
 * on screen throughout Settings, so the note under the heading says that
 * plainly: inviting somebody lets them into every project, and changing a role
 * changes it everywhere.
 *
 * **Inviting never depends on email.** With a transport configured the message
 * is posted; with none, the link comes straight back here and whoever created
 * it passes it on. A self-hosted install is pleasant right up until the second
 * person, and requiring SMTP is where that stops.
 *
 * Everybody may read the list — a member who cannot see their colleagues cannot
 * work out who to ask for anything — and the controls that change it are
 * genuinely disabled for anybody but an admin rather than hidden. The server
 * refuses their write either way, which is where the boundary is.
 */

type Tab = "people" | "invitations";

export default function PeopleSettingsPage() {
  const { projectId } = useParams<{ projectId: string }>();
  return (
    <AppShell>
      <PeopleSettings projectId={projectId} />
    </AppShell>
  );
}

function PeopleSettings({ projectId }: { readonly projectId: string }) {
  const { me } = useShellSession();
  const role = me === null ? null : roleOf(me);

  const { answer, reload } = useOrganizationRead<Roster>(MEMBERS_PATH);
  const settled = answer?.status === "ready" ? answer.value : null;
  const mayManage = settled?.may_manage_members === true;

  const [tab, setTab] = useState<Tab>("people");
  const [invitations, setInvitations] = useState<readonly Invitation[]>([]);
  const [refused, setRefused] = useState<Refusal | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState<{
    readonly action: "remove" | "deactivate";
    readonly member: Member;
  } | null>(null);

  /** The tab lives in the address, so Back works and a link can name one. */
  useEffect(() => {
    const readTab = () => {
      const chosen = new URLSearchParams(globalThis.location.search).get("tab");
      setTab(chosen === "invitations" ? "invitations" : "people");
    };
    readTab();
    globalThis.addEventListener("popstate", readTab);
    return () => globalThis.removeEventListener("popstate", readTab);
  }, []);

  useEffect(() => {
    if (answer?.status === "signed-out") window.location.replace("/sign-in");
  }, [answer]);

  /**
   * The outstanding invitations, which only an admin may read — so only an
   * admin asks. A refusal here is not shown: it is the expected answer for
   * everybody else, and the tab it would appear under is not offered to them.
   */
  const refreshInvitations = useCallback(async (): Promise<void> => {
    if (!mayManage) return;
    const listed = await readJson<InvitationList>(INVITATIONS_PATH);
    if (listed.status === "ready") setInvitations(rowsIn(listed.value.invitations));
  }, [mayManage]);

  useEffect(() => {
    void refreshInvitations();
  }, [refreshInvitations]);

  function showTab(next: Tab): void {
    const address = new URL(globalThis.location.href);
    if (next === "people") address.searchParams.delete("tab");
    else address.searchParams.set("tab", next);
    globalThis.history.pushState(null, "", `${address.pathname}${address.search}`);
    setTab(next);
  }

  async function act(path: string, body: Record<string, unknown>): Promise<void> {
    setRefused(null);
    setBusy(true);
    const written = await writeJson<unknown>(path, { method: "POST", body });
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

  const shownTab: Tab = mayManage ? tab : "people";

  if (answer === null) {
    return (
      <ProductPage>
        <PageHeader eyebrow="Settings" title="People" />
        <PageBody>
          <SettingsNav projectId={projectId} current="people" />
          <Loading what="this organization's people" />
        </PageBody>
      </ProductPage>
    );
  }

  if (answer.status !== "ready") {
    return (
      <ProductPage>
        <PageHeader eyebrow="Settings" title="People" />
        <PageBody>
          <SettingsNav projectId={projectId} current="people" />
          <Failure
            message={
              answer.status === "signed-out"
                ? "Your session has ended. Sign in and try again."
                : answer.refusal.message
            }
            onRetry={reload}
          />
        </PageBody>
      </ProductPage>
    );
  }

  const members = rowsIn(answer.value.members);

  const columns: readonly Column<Member>[] = [
    {
      key: "email",
      header: "Person",
      primary: true,
      cell: (member) => member.email,
    },
    {
      key: "role",
      header: "Role",
      cell: (member) =>
        mayManage ? (
          <Select
            id={`role-${member.user_id}`}
            label={`${member.email} role`}
            value={member.role}
            disabled={busy}
            options={ASSIGNABLE_ROLES.map((one) => ({ value: one, label: one }))}
            onChange={(next) =>
              void act(memberActionPath(member.user_id, "role"), { role: next })
            }
          />
        ) : (
          member.role
        ),
    },
    {
      key: "standing",
      header: "Standing",
      cell: (member) =>
        member.deactivated_at === null ? (
          <Badge tone="good">Active</Badge>
        ) : (
          <Badge tone="warn">Deactivated</Badge>
        ),
    },
    {
      key: "actions",
      header: "Actions",
      cell: (member) => (
        <>
          <Button
            disabled={!mayManage || busy}
            why={
              mayManage || role === null
                ? undefined
                : `Your ${role} role cannot manage members. Ask an organization admin.`
            }
            onClick={() => setConfirming({ action: "deactivate", member })}
          >
            Deactivate
          </Button>{" "}
          <Button
            disabled={!mayManage || busy}
            onClick={() => setConfirming({ action: "remove", member })}
          >
            Remove
          </Button>
        </>
      ),
    },
  ];

  return (
    <ProductPage>
      <PageHeader
        eyebrow="Settings"
        title="People"
        lead="Everybody in this organization, and what each of them may do."
      />
      <PageBody>
        <SettingsNav projectId={projectId} current="people" />
        <ScopeNote>
          Membership belongs to the whole organization. Somebody invited here
          can work in every project, and a role changed here changes it
          everywhere.
        </ScopeNote>

        {refused === null ? null : <Refused message={refused.message} />}

        {mayManage ? (
          <Choice
            label="Which list to show"
            value={shownTab}
            options={[
              { value: "people", label: "People" },
              { value: "invitations", label: "Invitations" },
            ]}
            onChange={showTab}
          />
        ) : null}

        {shownTab === "people" ? (
          <Section title="People">
            {members.length === 0 ? (
              <Empty title="Nobody is here yet." />
            ) : (
              <DataTable
                label="Members"
                columns={columns}
                rows={members}
                keyOf={(member) => member.user_id}
              />
            )}
          </Section>
        ) : (
          <Invitations
            invitations={invitations}
            busy={busy}
            onSent={() => void refreshInvitations()}
            onRefused={setRefused}
            onBusy={setBusy}
          />
        )}
      </PageBody>

      {confirming === null ? null : (
        <Dialog
          title={
            confirming.action === "remove"
              ? "Remove this person?"
              : "Deactivate this person?"
          }
          onClose={() => setConfirming(null)}
        >
          <p>
            {confirming.member.email}{" "}
            {confirming.action === "remove"
              ? "will lose membership in this organization. Everything they authored stays where it is, with their name on it."
              : "will no longer be able to use this organization, and every key they minted stops working on the next request."}
          </p>
          <Button onClick={() => setConfirming(null)}>Cancel</Button>{" "}
          <Button
            weight="strong"
            disabled={busy}
            onClick={() => {
              const chosen = confirming;
              setConfirming(null);
              void act(
                memberActionPath(chosen.member.user_id, chosen.action),
                {},
              );
            }}
          >
            {confirming.action === "remove" ? "Remove" : "Deactivate"}
          </Button>
        </Dialog>
      )}
    </ProductPage>
  );
}

/**
 * Asking somebody to join, and the link that comes back when there was nowhere
 * to post it.
 *
 * **The link is the whole promise of this page on a self-hosted install.** A
 * form that quietly dropped it would leave somebody with an invitation that
 * exists and cannot be delivered, which is worse than a refusal.
 */
function Invitations({
  invitations,
  busy,
  onSent,
  onRefused,
  onBusy,
}: {
  readonly invitations: readonly Invitation[];
  readonly busy: boolean;
  readonly onSent: () => void;
  readonly onRefused: (refusal: Refusal | null) => void;
  readonly onBusy: (busy: boolean) => void;
}) {
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<string>("admin");
  const [link, setLink] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  async function invite(): Promise<void> {
    if (busy || email.trim() === "") return;
    onRefused(null);
    setLink(null);
    setNote(null);
    onBusy(true);

    const written = await writeJson<{
      readonly email: string;
      readonly delivered: boolean;
      readonly accept_url?: string;
    }>(INVITATIONS_PATH, {
      method: "POST",
      body: { email: email.trim(), role },
    });

    onBusy(false);
    if (written.status === "signed-out") {
      window.location.replace("/sign-in");
      return;
    }
    if (written.status !== "ready") {
      onRefused(written.refusal);
      return;
    }

    setEmail("");
    if (written.value.delivered) {
      setNote(`An invitation is on its way to ${written.value.email}.`);
    } else {
      setLink(written.value.accept_url ?? null);
    }
    onSent();
  }

  return (
    <Section
      title="Invite somebody"
      lead="If no mail transport is configured, egma gives you a one-time link to send yourself."
    >
      {note === null ? null : <Help>{note}</Help>}
      {link === null ? null : (
        <p>
          <strong>Here is the link.</strong> It works once, for the person named
          above. {link}
        </p>
      )}

      <Form onSubmit={() => void invite()}>
        <FormRow>
          <Field label="Email" htmlFor="invite-email">
            <TextInput
              id="invite-email"
              value={email}
              disabled={busy}
              onChange={setEmail}
            />
          </Field>
          <Field label="Role" htmlFor="invite-role">
            <Select
              id="invite-role"
              value={role}
              disabled={busy}
              options={ASSIGNABLE_ROLES.map((one) => ({
                value: one,
                label: one,
              }))}
              onChange={setRole}
            />
          </Field>
        </FormRow>
        <FormActions>
          <Button
            weight="strong"
            type="submit"
            disabled={busy || email.trim() === ""}
          >
            {busy ? "Inviting…" : "Send invitation"}
          </Button>
        </FormActions>
      </Form>

      <h3>Waiting to be accepted</h3>
      {invitations.length === 0 ? (
        <p>No invitations are waiting.</p>
      ) : (
        <ul>
          {invitations.map((invitation) => (
            <li key={invitation.id}>
              {invitation.email} · {invitation.role} · expires{" "}
              {new Date(invitation.expires_at).toLocaleDateString()}
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}
