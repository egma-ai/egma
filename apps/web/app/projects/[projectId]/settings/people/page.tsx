"use client";

import { useParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  changeMemberRole,
  createInvitation,
  deactivateMember,
  listInvitations,
  listMembers,
  removeMember,
} from "@egma/platform-api/client";

import type { Answer, Refusal } from "../../../../../lib/api.ts";
import { roleOf } from "../../../../../lib/me.ts";
import { platformAnswer, platformClient } from "../../../../../lib/platform-client.ts";
import {
  ASSIGNABLE_ROLES,
  rowsIn,
  standingOf,
  type Invitation,
  type InvitationList,
  type Member,
  type Roster,
} from "../../../../../lib/settings.ts";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { DialogFooter } from "@/components/ui/dialog";
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
  ListInstant,
} from "../../../../../ui/relative-time.tsx";
import { Section } from "../../../../../ui/section.tsx";
import { SettingsTabs } from "../../../../../ui/settings-nav.tsx";
import {
  currentDraftState,
  useOrganizationRead,
  useUnsavedChanges,
} from "../../../../../ui/settings-read.ts";
import { useShellSession } from "../../../../../ui/shell.tsx";

/**
 * Membership and invitations apply to the organization. Without email
 * transport, show the returned invitation link for manual sharing. Disable
 * admin actions for other roles; the server still enforces permission.
 */

type Tab = "people" | "invitations";

/**
 * Use max-content grid tracks to keep named actions side by side, with any
 * disabled-action reason spanning a second row. w-0 min-w-full lets the reason
 * wrap without widening the button tracks. Remove cell padding in stacked
 * layout because the row already supplies it.
 */
const ROW_ACTIONS = [
  "grid grid-cols-[max-content_max-content] items-center gap-2",
  "px-(--row-padding-x) stacked:px-0",
  "[&>span]:col-span-2 [&>span]:row-start-2 [&>span]:text-left",
  "[&>span]:w-0 [&>span]:min-w-full [&>span]:whitespace-normal",
].join(" ");

/** The same lane, for a row that offers one control and no reason. */
const ROW_ACTION =
  "flex items-center justify-end gap-2 px-(--row-padding-x) stacked:px-0";

export default function PeopleSettingsPage() {
  const { projectId } = useParams<{ projectId: string }>();
  return <PeopleSettings projectId={projectId} />;
}

function PeopleSettings({ projectId }: { readonly projectId: string }) {
  const { me } = useShellSession();
  const role = me === null ? null : roleOf(me);

  const { answer, reload } = useOrganizationRead<Roster>(() =>
    platformAnswer(listMembers({ client: platformClient })),
  );
  const settled = answer?.status === "ready" ? answer.value : null;
  const mayManage = settled?.mayManageMembers === true;

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
    const listed = await platformAnswer(
      listInvitations({ client: platformClient }),
    );
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

  async function act(
    action: "role" | "remove" | "deactivate",
    member: Member,
    nextRole?: (typeof ASSIGNABLE_ROLES)[number],
  ): Promise<void> {
    setRefused(null);
    setBusy(true);
    const written =
      action === "role"
        ? await platformAnswer(
            changeMemberRole(
              { userId: member.userId, role: nextRole ?? member.role },
              { client: platformClient },
            ),
          )
        : action === "remove"
          ? await platformAnswer(
              removeMember(
                { userId: member.userId },
                { client: platformClient },
              ),
            )
          : await platformAnswer(
              deactivateMember(
                { userId: member.userId },
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
    reload();
  }

  const shownTab: Tab = mayManage ? tab : "people";
  /** Said only to somebody the server would refuse, and only once it has said so. */
  const whyNot =
    mayManage || role === null
      ? undefined
      : `Your ${role} role cannot manage members. Ask an organization admin.`;

  if (answer === null) {
    return <Loading what="this organization's people" />;
  }

  if (answer.status !== "ready") {
    return (
      <Failure
              message={
                answer.status === "signed-out"
                  ? "Your session has ended. Sign in and try again."
                  : answer.refusal.message
              }
              onRetry={reload}
      />
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
            /*
              The row's height, and the table's type step. The 36px is
              `Select`'s own `default` now rather than a class list this page
              kept: a form control is 44px, a control inside a 52px row is 36,
              and the coarse-pointer target comes back in the primitive.
            */
            size="default"
            className="w-auto text-sm"
            id={`role-${member.userId}`}
            aria-label={`${member.email} role`}
            value={member.role}
            disabled={busy}
            onChange={(event) =>
              void act(
                "role",
                member,
                event.target.value as (typeof ASSIGNABLE_ROLES)[number],
              )
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
        member.deactivatedAt === null ? (
          <Badge variant="success">Active</Badge>
        ) : (
          <Badge variant="warning">Deactivated</Badge>
        ),
    },
    {
      key: "actions",
      header: "Actions",
      /* Mark the cell as an action so table overflow rules do not clip its focus ring. */
      action: true,
      cell: (member) => (
        <div className={ROW_ACTIONS}>
          <Button
            type="button"
            variant="secondary"
            disabled={!mayManage}
            busy={busy}
            {...(whyNot === undefined ? {} : { why: whyNot })}
            onClick={() => setConfirming({ action: "deactivate", member })}
          >
            Deactivate
          </Button>
          <Button
            type="button"
            variant="secondary"
            disabled={!mayManage || busy}
            onClick={() => setConfirming({ action: "remove", member })}
          >
            Remove
          </Button>
        </div>
      ),
    },
  ];

  return (
    <>
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
              {/*
                * No heading over this table. The tab above it says "People",
                * the title bar says "People", and a third one in the largest
                * type on the page said it a third time. The Invitations panel
                * keeps its two headings, because it holds two different things
                * and the headings are what tell them apart.
                */}
              {members.length === 0 ? (
                <Empty title="Nobody is here yet." />
              ) : (
                <DataTable
                  label="Members"
                  columns={columns}
                  rows={members}
                  keyOf={(member) => member.userId}
                />
              )}
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
              <p className="m-0 max-w-[62ch] text-sm text-muted-foreground">
                {confirming.member.email}{" "}
                {confirming.action === "remove"
                  ? "will lose membership in this organization. Everything they authored stays where it is, with their name on it."
                  : "will no longer be able to use this organization, and every key they minted stops working on the next request."}
              </p>
              {/* The answer leads and the way out follows it (`BK9-0`). */}
              <DialogFooter>
                <Button
                  type="button"
                  size="lg"
                  variant="destructive"
                  disabled={busy}
                  onClick={() => {
                    const chosen = confirming;
                    setConfirming(null);
                    void act(chosen.action, chosen.member);
                  }}
                >
                  {confirming.action === "remove" ? "Remove" : "Deactivate"}
                </Button>
                <Button type="button" size="lg" variant="secondary" onClick={dismiss}>
                  Cancel
                </Button>
              </DialogFooter>
            </>
          )}
        </Dialog>
      )}
    </>
  );
}

/**
 * Keep returned invitation links visible when email is unavailable. Distinguish
 * expired invitations from pending ones and offer resend for expired links.
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

    const written = await platformAnswer(
      createInvitation(
        {
          email: toEmail,
          role: atRole as (typeof ASSIGNABLE_ROLES)[number],
        },
        { client: platformClient },
      ),
    );

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
      setLink(written.value.acceptUrl ?? null);
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
      cell: (invitation) => <ListInstant instant={invitation.expiresAt} />,
    },
    {
      key: "actions",
      header: "Actions",
      /* A row control, for the reason written on the column above. */
      action: true,
      // Nothing on a pending row: waiting is what it is for. An expired one
      // cannot be waited on, so the one thing left to do about it is here.
      cell: (invitation) =>
        standingOf(invitation) === "expired" ? (
          <div className={ROW_ACTION}>
            <Button
              type="button"
              variant="secondary"
              disabled={busy}
              onClick={() => void send(invitation.email, invitation.role)}
            >
              Send again
            </Button>
          </div>
        ) : null,
    },
  ];
  const invitationRows =
    invitations?.status === "ready"
      ? rowsIn(invitations.value.invitations)
      : [];

  return (
    <>
      <Section title="Invite team members">
        {note === null ? null : <Help>{note}</Help>}
        {/*
         * The link, on the same contained surface a new API key gets, and
         * still plain text inside `main`. It is the whole promise of this page
         * on an install with no mail transport: the person who created the
         * invitation is the one who has to deliver it, so it has to be
         * readable and selectable rather than tucked into a sentence and
         * clipped by the width of one.
         */}
        {link === null ? null : (
          <Card className="gap-3">
            <p className="m-0 max-w-[72ch] text-sm text-muted-foreground">
              <strong className="font-medium text-foreground">
                Here is the link.
              </strong>{" "}
              It works once, for the person named above.
            </p>
            <code className="block rounded-input border border-border bg-surface-soft p-3 font-mono text-sm break-all text-foreground">
              {link}
            </code>
          </Card>
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
