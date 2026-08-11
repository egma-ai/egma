"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { AppShell, Field, Notice, PageHeader, ProductPage, ProductStatePage, StatePage, styles } from "../ui.tsx";

type Member = {
  user_id: string;
  email: string;
  role: string;
  deactivated_at: string | null;
};

type Invitation = { id: string; email: string; role: string; expires_at: string };

type Roster = { members: Member[]; may_manage_members: boolean };
type SettingsTab = "people" | "invitations";

const ROLES = ["admin", "member", "viewer"] as const;

function isRoster(value: unknown): value is Roster {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<Roster>;
  return Array.isArray(candidate.members) && typeof candidate.may_manage_members === "boolean";
}

export default function MembersPage() {
  const [tab, setTab] = useState<SettingsTab>("people");
  const [roster, setRoster] = useState<Roster | null>(null);
  const [signedOut, setSignedOut] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [invitations, setInvitations] = useState<Invitation[]>([]);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<string>("admin");
  const [link, setLink] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmation, setConfirmation] = useState<{
    action: "deactivate" | "remove";
    member: Member;
  } | null>(null);
  const confirmationDialog = useRef<HTMLDialogElement>(null);
  const cancelConfirmation = useRef<HTMLButtonElement>(null);
  const confirmationOpener = useRef<HTMLButtonElement | null>(null);

  const load = useCallback(async (): Promise<void> => {
    const listed = await fetch("/api/members");
    if (listed.status === 401) {
      setSignedOut(true);
      return;
    }
    if (!listed.ok) throw new Error("members could not be loaded");
    const body: unknown = await listed.json();
    if (!isRoster(body)) throw new Error("members returned an invalid response");
    setLoadFailed(false);
    setRoster(body);

    // Only an admin may read the outstanding ones, so only an admin asks.
    if (!body.may_manage_members) return;
    const pending = await fetch("/api/invitations");
    if (pending.ok) {
      setInvitations(
        ((await pending.json()) as { invitations: Invitation[] }).invitations,
      );
    }
  }, []);

  const refresh = useCallback(async (): Promise<void> => {
    try {
      await load();
    } catch {
      setLoadFailed(true);
      setProblem("egma could not be reached. Is the API running?");
    }
  }, [load]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    const readTab = () => {
      const selected = new URLSearchParams(globalThis.location.search).get("tab");
      setTab(selected === "invitations" ? "invitations" : "people");
    };
    readTab();
    globalThis.addEventListener("popstate", readTab);
    return () => globalThis.removeEventListener("popstate", readTab);
  }, []);

  useEffect(() => {
    if (confirmation === null) return;
    const dialog = confirmationDialog.current;
    dialog?.showModal();
    cancelConfirmation.current?.focus();
    return () => {
      if (dialog?.open === true) dialog.close();
      confirmationOpener.current?.focus();
    };
  }, [confirmation]);

  function askForConfirmation(
    action: "deactivate" | "remove",
    member: Member,
    opener: HTMLButtonElement,
  ): void {
    confirmationOpener.current = opener;
    setConfirmation({ action, member });
  }

  function showTab(next: SettingsTab): void {
    const address = new URL(globalThis.location.href);
    if (next === "people") address.searchParams.delete("tab");
    else address.searchParams.set("tab", next);
    globalThis.history.pushState(null, "", `${address.pathname}${address.search}`);
    setTab(next);
  }

  async function send(
    path: string,
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown> | null> {
    setProblem(null);
    setBusy(true);
    try {
      const response = await fetch(path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const said = (await response.json().catch(() => ({}))) as {
        message?: string;
      };
      if (!response.ok) {
        setProblem(said.message ?? "that did not work");
        return null;
      }
      return said as Record<string, unknown>;
    } catch {
      setProblem("egma could not be reached. Is the API running?");
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function invite(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setLink(null);
    setNote(null);

    const created = await send("/api/invitations", { email, role });
    if (created === null) return;

    setEmail("");
    // With a mail transport configured the link went to the person it names.
    // With none it comes back here, and this is where it is handed over.
    if (created.delivered === true) {
      setNote(`An invitation is on its way to ${String(created.email)}.`);
    } else {
      setLink(String(created.accept_url));
    }
    await refresh();
  }

  if (signedOut) {
    return (
      <StatePage title="Sign in first" lead="This page is about your organization.">
        <p className={styles.linkLine}>
          <a href="/sign-in">Sign in</a> · <a href="/signup">Set up egma</a>
        </p>
      </StatePage>
    );
  }

  if (loadFailed && roster === null) {
    return (
      <ProductStatePage eyebrow="Organization" title="Organization settings could not be loaded" lead="Egma could not reach the organization right now.">
        <button
          className={styles.button}
          type="button"
          onClick={() => {
            setLoadFailed(false);
            setProblem(null);
            void refresh();
          }}
        >
          Try again
        </button>
      </ProductStatePage>
    );
  }

  if (roster === null) return <ProductStatePage eyebrow="Organization" title="Organization settings" lead="Reading this organization’s members and invitations." />;

  const shownTab = roster.may_manage_members ? tab : "people";

  return (
    <AppShell>
      <ProductPage>
        <PageHeader eyebrow="Organization" title="Organization settings" lead="Manage people and invitations for this organization." />
        {problem === null ? null : <Notice tone="error">{problem}</Notice>}

        <div className={styles.settingsTabs} role="tablist" aria-label="Organization settings">
          <button className={shownTab === "people" ? styles.settingsTabActive : undefined} type="button" role="tab" aria-selected={shownTab === "people"} onClick={() => showTab("people")}>People</button>
          {roster.may_manage_members ? <button className={shownTab === "invitations" ? styles.settingsTabActive : undefined} type="button" role="tab" aria-selected={shownTab === "invitations"} onClick={() => showTab("invitations")}>Invitations</button> : null}
        </div>

        {shownTab === "people" ? (
          <section className={styles.settingsPanel} aria-labelledby="people-title">
            <div className={styles.settingsPanelHeader}>
              <h2 id="people-title">People</h2>
              <p>Everybody in your organization.</p>
            </div>
            <div className={styles.peopleList} aria-label="Members">
              {roster.members.map((member) => (
                <article className={styles.personRow} key={member.user_id}>
                  <div className={styles.personIdentity}>
                    <strong>{member.email}</strong>
                    <span>{member.deactivated_at === null ? member.role : `${member.role} · deactivated`}</span>
                  </div>
                  {roster.may_manage_members ? (
                    <div className={styles.personActions}>
                      <select
                        aria-label={`${member.email} role`}
                        value={member.role}
                        disabled={busy}
                        onChange={(event) => {
                          void send(`/api/members/${member.user_id}/role`, { role: event.target.value }).then(refresh);
                        }}
                      >
                        {ROLES.map((one) => <option key={one} value={one}>{one}</option>)}
                      </select>
                      <button type="button" disabled={busy} onClick={(event) => askForConfirmation("deactivate", member, event.currentTarget)}>Deactivate</button>
                      <button className={styles.destructive} type="button" aria-label="Remove" title="Remove member" disabled={busy} onClick={(event) => askForConfirmation("remove", member, event.currentTarget)}>
                        <svg aria-hidden="true" viewBox="0 0 24 24"><path d="M4 7h16M9 7V4h6v3m3 0-1 13H7L6 7m4 4v5m4-5v5" /></svg>
                      </button>
                    </div>
                  ) : <strong>{member.role}</strong>}
                </article>
              ))}
            </div>
          </section>
        ) : null}

        {roster.may_manage_members && shownTab === "invitations" ? (
          <section className={`${styles.settingsPanel} ${styles.managementGrid}`} aria-labelledby="invite-title">
            <div className={styles.managementIntro}>
              <h2 id="invite-title">Invite somebody</h2>
              <p>If no mail transport is configured, Egma gives you a one-time link to send yourself.</p>

              {note === null ? null : <Notice tone="success">{note}</Notice>}
              {link === null ? null : <div className={styles.invitationLink}><strong>Here is the link.</strong><br />It works once, for the person named above.<br />{link}</div>}

              <form className={styles.form} onSubmit={invite}>
                <Field label="Email" htmlFor="invite-email">
                  <input className={styles.input} id="invite-email" name="email" type="email" required value={email} onChange={(event) => setEmail(event.target.value)} />
                </Field>
                <Field label="Role" htmlFor="invite-role">
                  <select className={styles.select} id="invite-role" value={role} onChange={(event) => setRole(event.target.value)}>
                    {ROLES.map((one) => <option key={one} value={one}>{one}</option>)}
                  </select>
                </Field>
                <button className={styles.button} type="submit" disabled={busy}>{busy ? "Inviting…" : "Send invitation"}</button>
              </form>
            </div>

            <div className={styles.pendingList}>
              <h3>Waiting to be accepted</h3>
              {invitations.length === 0 ? <p className={styles.muted}>No invitations are waiting.</p> : invitations.map((invitation) => <div className={styles.pendingRow} key={invitation.id}><span>{invitation.email}</span><strong>{invitation.role}</strong></div>)}
            </div>
          </section>
        ) : null}
      </ProductPage>

      {confirmation === null ? null : (
        <dialog
          ref={confirmationDialog}
          className={styles.dialog}
          aria-labelledby="member-confirm-title"
          aria-describedby="member-confirm-description"
          onCancel={() => setConfirmation(null)}
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setConfirmation(null);
          }}
        >
          <h2 id="member-confirm-title">{confirmation.action === "remove" ? "Remove this person?" : "Deactivate this person?"}</h2>
          <p id="member-confirm-description">{confirmation.member.email} {confirmation.action === "remove" ? "will lose membership in this organization." : "will no longer be able to use this organization."}</p>
          <div className={styles.buttonRow}>
            <button ref={cancelConfirmation} className={styles.buttonSecondary} type="button" onClick={() => setConfirmation(null)}>Cancel</button>
            <button
              className={styles.buttonDanger}
              type="button"
              disabled={busy}
              onClick={() => {
                const chosen = confirmation;
                setConfirmation(null);
                void send(`/api/members/${chosen.member.user_id}/${chosen.action}`, {}).then(refresh);
              }}
            >
              {confirmation.action === "remove" ? "Remove" : "Deactivate"}
            </button>
          </div>
        </dialog>
      )}
    </AppShell>
  );
}
