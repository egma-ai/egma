"use client";

import { useParams } from "next/navigation";
import { useCallback, useEffect, useId, useRef, useState } from "react";

import {
  readJson,
  writeJson,
  type Answer,
  type Refusal,
} from "../../../../../lib/api.ts";
import { roleOf } from "../../../../../lib/me.ts";
import {
  ASSIGNABLE_ROLES,
  INVITATIONS_PATH,
  MEMBERS_PATH,
  memberActionPath,
  rowsIn,
  standingOf,
  type Invitation,
  type InvitationList,
  type Member,
  type Roster,
} from "../../../../../lib/settings.ts";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";

import { DataTable, type Column } from "../../../../../ui/data-table.tsx";
import { Dialog } from "../../../../../ui/dialog.tsx";
import { useDraftNavigation } from "../../../../../ui/draft-navigation.tsx";
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
  RelativeInstant,
  useMinuteClock,
} from "../../../../../ui/relative-time.tsx";
import { Section } from "../../../../../ui/section.tsx";
import {
  SettingsLayout,
  SettingsTabs,
  settingsPath,
} from "../../../../../ui/settings-nav.tsx";
import {
  currentDraftState,
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
 * Who is in this organization, and the four things an admin may do about it.
 *
 * **Membership is the organization's and not a project's.** The grouped local
 * navigation says that once; this page can focus on people and invitations.
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

  /* Why the membership controls are not available, for whoever asks. */
  const whyNotManage = useId();
  const [tab, setTab] = useState<Tab>("people");
  const tabRef = useRef<Tab>("people");
  const [invitations, setInvitations] =
    useState<Answer<InvitationList> | null>(null);
  const [refused, setRefused] = useState<Refusal | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState<{
    readonly action: "remove" | "deactivate";
    readonly member: Member;
  } | null>(null);
  const draftNavigation = useDraftNavigation();

  /** The tab lives in the address, so Back works and a link can name one. */
  useEffect(() => {
    const pagePathname = new URL(globalThis.location.href).pathname;
    const tabInAddress = (address: URL): Tab => {
      const chosen = address.searchParams.get("tab");
      return chosen === "invitations" ? "invitations" : "people";
    };
    const writeTabAddress = (next: Tab) => {
      const address = new URL(globalThis.location.href);
      if (next === "people") address.searchParams.delete("tab");
      else address.searchParams.set("tab", next);
      globalThis.history.pushState(
        null,
        "",
        `${address.pathname}${address.search}`,
      );
    };
    const readTab = () => {
      const address = new URL(globalThis.location.href);
      // A Back action can already be on another product route when popstate
      // reaches this page. That route belongs to the shared router. Never add
      // a People-tab query to it from a page that is about to unmount.
      if (address.pathname !== pagePathname) return;
      const next = tabInAddress(address);
      const current = tabRef.current;
      if (next === current) return;

      const show = (writeAddress: boolean) => {
        if (writeAddress) writeTabAddress(next);
        tabRef.current = next;
        setTab(next);
      };
      if (currentDraftState() === "unchanged") {
        show(false);
        return;
      }

      // Browser Back changes the address before popstate and provides no
      // cancellable event. Restore the tab whose draft is still on screen,
      // then make the requested tab current only after the shared dialog is
      // accepted. This is necessarily after-the-fact protection, unlike links
      // and router controls, which the shell stops before navigation.
      writeTabAddress(current);
      draftNavigation.request(() => show(true));
    };
    const initial = tabInAddress(new URL(globalThis.location.href));
    tabRef.current = initial;
    setTab(initial);
    globalThis.addEventListener("popstate", readTab);
    return () => globalThis.removeEventListener("popstate", readTab);
  }, [draftNavigation]);

  useEffect(() => {
    if (answer?.status === "signed-out") window.location.replace("/sign-in");
  }, [answer]);

  /**
   * The outstanding invitations, which only an admin may read — so only an
   * admin asks. The tab is not offered to everybody else. For an admin, an
   * in-flight or refused read stays exactly that instead of becoming a false
   * statement that there are no invitations.
   */
  const refreshInvitations = useCallback(async (): Promise<void> => {
    if (!mayManage) return;
    setInvitations(null);
    const listed = await readJson<InvitationList>(INVITATIONS_PATH);
    setInvitations(listed);
    if (listed.status === "signed-out") window.location.replace("/sign-in");
  }, [mayManage]);

  useEffect(() => {
    void refreshInvitations();
  }, [refreshInvitations]);

  function showTab(next: Tab): void {
    if (next === tabRef.current) return;
    draftNavigation.request(() => {
      const address = new URL(globalThis.location.href);
      if (next === "people") address.searchParams.delete("tab");
      else address.searchParams.set("tab", next);
      globalThis.history.pushState(null, "", `${address.pathname}${address.search}`);
      tabRef.current = next;
      setTab(next);
    });
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
  /** Said only to somebody the server would refuse, and only once it has said so. */
  const whyNot =
    mayManage || role === null
      ? undefined
      : `Your ${role} role cannot manage members. Ask an organization admin.`;

  if (answer === null) {
    return (
      <ProductPage viewport>
        <PageHeader
          eyebrow="Settings"
          title="People"
          breadcrumbs={[
            { label: "Settings", href: settingsPath(projectId) },
            { label: "People" },
          ]}
        />
        <PageBody>
          <SettingsLayout projectId={projectId} current="people">
            <Loading what="this organization's people" />
          </SettingsLayout>
        </PageBody>
      </ProductPage>
    );
  }

  if (answer.status !== "ready") {
    return (
      <ProductPage viewport>
        <PageHeader
          eyebrow="Settings"
          title="People"
          breadcrumbs={[
            { label: "Settings", href: settingsPath(projectId) },
            { label: "People" },
          ]}
        />
        <PageBody>
          <SettingsLayout projectId={projectId} current="people">
            <Failure
              message={
                answer.status === "signed-out"
                  ? "Your session has ended. Sign in and try again."
                  : answer.refusal.message
              }
              onRetry={reload}
            />
          </SettingsLayout>
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
            aria-label={`${member.email} role`}
            value={member.role}
            disabled={busy}
            onChange={(event) =>
              void act(memberActionPath(member.user_id, "role"), {
                role: event.target.value,
              })
            }
          >
            {ASSIGNABLE_ROLES.map((one) => (
              <option key={one} value={one}>
                {one}
              </option>
            ))}
          </Select>
        ) : (
          member.role
        ),
    },
    {
      key: "standing",
      header: "Standing",
      cell: (member) =>
        member.deactivated_at === null ? (
          <Badge variant="success">Active</Badge>
        ) : (
          <Badge variant="warning">Deactivated</Badge>
        ),
    },
    {
      key: "actions",
      header: "Actions",
      cell: (member) => (
        <>
          <Button
            type="button"
            variant="secondary"
            disabled={!mayManage || busy}
            title={whyNot}
            aria-describedby={
              whyNot === undefined
                ? undefined
                : `${whyNotManage}-${member.user_id}`
            }
            onClick={() => setConfirming({ action: "deactivate", member })}
          >
            Deactivate
          </Button>
          {whyNot === undefined ? null : (
            <span
              className="max-w-[56ch] text-sm leading-(--line-normal) text-muted-foreground"
              id={`${whyNotManage}-${member.user_id}`}
            >
              {whyNot}
            </span>
          )}{" "}
          <Button
            type="button"
            variant="secondary"
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
    <ProductPage viewport>
      <PageHeader
        eyebrow="Settings"
        title="People"
        breadcrumbs={[
          { label: "Settings", href: settingsPath(projectId) },
          { label: "People" },
        ]}
        lead="Everybody in this organization, and what each of them may do."
      />
      <PageBody>
        <SettingsLayout projectId={projectId} current="people">
          {refused === null ? null : <Refused message={refused.message} />}

          {mayManage ? (
            <SettingsTabs
              id="people-view"
              label="People views"
              value={shownTab}
              options={[
                { value: "people", label: "People" },
                { value: "invitations", label: "Invitations" },
              ]}
              onChange={showTab}
            />
          ) : null}

          {shownTab === "people" ? (
            <div
              id="people-view-people-panel"
              role={mayManage ? "tabpanel" : undefined}
              aria-labelledby={mayManage ? "people-view-people-tab" : undefined}
            >
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
            </div>
          ) : (
            <div
              id="people-view-invitations-panel"
              role="tabpanel"
              aria-labelledby="people-view-invitations-tab"
            >
              <Invitations
                invitations={invitations}
                busy={busy}
                onSent={() => void refreshInvitations()}
                onRetry={() => void refreshInvitations()}
                onRefused={setRefused}
                onBusy={setBusy}
              />
            </div>
          )}
        </SettingsLayout>
      </PageBody>

      {confirming === null ? null : (
        <Dialog
          title={
            confirming.action === "remove"
              ? `Remove ${confirming.member.email}?`
              : `Deactivate ${confirming.member.email}?`
          }
          onClose={() => setConfirming(null)}
        >
          {(dismiss) => (
            <>
              <p>
                {confirming.member.email}{" "}
                {confirming.action === "remove"
                  ? "will lose membership in this organization. Everything they authored stays where it is, with their name on it."
                  : "will no longer be able to use this organization, and every key they minted stops working on the next request."}
              </p>
              <Button type="button" variant="secondary" onClick={dismiss}>
                Cancel
              </Button>{" "}
              <Button
                type="button"
                variant="destructive"
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
            </>
          )}
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
 *
 * **An invitation whose day has passed is drawn as its own thing.** The list
 * route answers with everything nobody has accepted, expired ones included, so
 * a single "waiting to be accepted" list says something untrue about half of
 * what is in it — and somebody reading it waits for a person who can no longer
 * accept. The standing is said in words on the row, and the only thing to do
 * about a dead invitation, sending another, is the only control it carries.
 */
function Invitations({
  invitations,
  busy,
  onSent,
  onRetry,
  onRefused,
  onBusy,
}: {
  readonly invitations: Answer<InvitationList> | null;
  readonly busy: boolean;
  readonly onSent: () => void;
  readonly onRetry: () => void;
  readonly onRefused: (refusal: Refusal | null) => void;
  readonly onBusy: (busy: boolean) => void;
}) {
  const now = useMinuteClock();
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<string>("viewer");
  const [link, setLink] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  useUnsavedChanges(email.trim() !== "" || link !== null, busy);

  /**
   * One invitation asked for, whether the form asked for it or a dead row did.
   *
   * Both go through here so that sending again hands back the link on an
   * install with no mail transport, exactly as the form does. A second path
   * that dropped it would be the failure this page exists to avoid, arriving
   * by the back door.
   */
  async function send(toEmail: string, atRole: string): Promise<boolean> {
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
      body: { email: toEmail, role: atRole },
    });

    onBusy(false);
    if (written.status === "signed-out") {
      window.location.replace("/sign-in");
      return false;
    }
    if (written.status !== "ready") {
      onRefused(written.refusal);
      return false;
    }

    if (written.value.delivered) {
      setNote(`An invitation is on its way to ${written.value.email}.`);
    } else {
      setLink(written.value.accept_url ?? null);
    }
    onSent();
    return true;
  }

  async function invite(): Promise<void> {
    if (busy || email.trim() === "") return;
    if (await send(email.trim(), role)) setEmail("");
  }

  const columns: readonly Column<Invitation>[] = [
    {
      key: "email",
      header: "Person",
      primary: true,
      cell: (invitation) => invitation.email,
    },
    {
      key: "role",
      header: "Role",
      cell: (invitation) => invitation.role,
    },
    {
      key: "standing",
      header: "Standing",
      cell: (invitation) =>
        standingOf(invitation) === "expired" ? (
          <Badge variant="warning">Expired</Badge>
        ) : (
          <Badge>Pending</Badge>
        ),
    },
    {
      key: "expiry",
      header: "Expiry",
      mono: true,
      cell: (invitation) => (
        <RelativeInstant instant={invitation.expires_at} now={now} />
      ),
    },
    {
      key: "actions",
      header: "Actions",
      // Nothing on a pending row: waiting is what it is for. An expired one
      // cannot be waited on, so the one thing left to do about it is here.
      cell: (invitation) =>
        standingOf(invitation) === "expired" ? (
          <Button
            type="button"
            variant="secondary"
            disabled={busy}
            onClick={() => void send(invitation.email, invitation.role)}
          >
            Send again
          </Button>
        ) : null,
    },
  ];
  const invitationRows =
    invitations?.status === "ready"
      ? rowsIn(invitations.value.invitations)
      : [];

  return (
    <>
      <Section
        title="Invite somebody"
        lead="If no mail transport is configured, Egma gives you a one-time link to send yourself."
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
              <Input
                id="invite-email"
                value={email}
                autoComplete="off"
                spellCheck={false}
                disabled={busy}
                onChange={(event) => setEmail(event.target.value)}
              />
            </Field>
            <Field label="Role" htmlFor="invite-role">
              <Select
                id="invite-role"
                value={role}
                disabled={busy}
                onChange={(event) => setRole(event.target.value)}
              >
                {ASSIGNABLE_ROLES.map((one) => (
                  <option key={one} value={one}>
                    {one}
                  </option>
                ))}
              </Select>
            </Field>
          </FormRow>
          <FormActions>
            <Button type="submit" disabled={busy || email.trim() === ""}>
              {busy ? "Inviting…" : "Send invitation"}
            </Button>
          </FormActions>
        </Form>
      </Section>

      <Section
        title="Invitations sent"
        lead="Nobody has accepted these yet. An expired one cannot be accepted at all — send another."
      >
        {invitations === null ? (
          <Loading what="outstanding invitations" />
        ) : invitations.status !== "ready" ? (
          <Failure
            title="Egma could not list this organization's invitations."
            message={
              invitations.status === "signed-out"
                ? "Your session has ended. Sign in and try again."
                : invitations.refusal.message
            }
            onRetry={onRetry}
          />
        ) : invitationRows.length === 0 ? (
          <Empty title="No invitations are outstanding." />
        ) : (
          <DataTable
            label="Invitations"
            columns={columns}
            rows={invitationRows}
            keyOf={(invitation) => invitation.id}
          />
        )}
      </Section>
    </>
  );
}
