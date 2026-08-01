"use client";

import { useCallback, useEffect, useState } from "react";

import { Card, styles } from "../ui.tsx";

/**
 * Who is in your organization, and the one page an admin needs in order to add
 * somebody to it.
 *
 * It exists for a reason worth stating, because the dashboard is deliberately
 * not built: **without it, inviting a colleague would be an API call.** The
 * whole point of this part of the product is that a self-hoster with no SMTP can
 * add a second person, and "post this JSON" is not adding a second person. So
 * the page is the smallest thing that makes it real — a list, four actions, and
 * somewhere for the link to appear when there is nowhere to post it.
 *
 * There is no navigation shell and no styling system here, for the same reason
 * the login pages have none. Whatever the dashboard needs later is the
 * dashboard's decision.
 */

type Member = {
  user_id: string;
  email: string;
  role: string;
  deactivated_at: string | null;
};

type Invitation = { id: string; email: string; role: string; expires_at: string };

type Roster = { members: Member[]; may_manage_members: boolean };

const ROLES = ["admin", "member", "viewer"] as const;

export default function MembersPage() {
  const [roster, setRoster] = useState<Roster | null>(null);
  const [signedOut, setSignedOut] = useState(false);
  const [invitations, setInvitations] = useState<Invitation[]>([]);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<string>("admin");
  const [link, setLink] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async (): Promise<void> => {
    const listed = await fetch("/api/members");
    if (listed.status === 401) {
      setSignedOut(true);
      return;
    }
    const body = (await listed.json()) as Roster;
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

  useEffect(() => {
    void load().catch(() => {
      setProblem("egma could not be reached. Is the API running?");
    });
  }, [load]);

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
    await load();
  }

  if (signedOut) {
    return (
      <Card title="Sign in first" lead="This page is about your organization.">
        <p style={styles.aside}>
          <a href="/sign-in">Sign in</a> · <a href="/signup">Set up egma</a>
        </p>
      </Card>
    );
  }

  if (roster === null) return <Card title="egma">Loading…</Card>;

  return (
    <Card title="People" lead="Everybody in your organization.">
      {problem === null ? null : <p style={styles.problem}>{problem}</p>}

      {roster.members.map((member) => (
        <div key={member.user_id} style={styles.definition}>
          <span>
            {member.email}
            {member.deactivated_at === null ? null : (
              <span style={styles.hint}>deactivated</span>
            )}
          </span>

          {roster.may_manage_members ? (
            <span style={{ display: "flex", gap: "0.5rem" }}>
              <select
                value={member.role}
                disabled={busy}
                style={{ fontFamily: "inherit" }}
                onChange={(event) => {
                  void send(`/api/members/${member.user_id}/role`, {
                    role: event.target.value,
                  }).then(load);
                }}
              >
                {ROLES.map((one) => (
                  <option key={one} value={one}>
                    {one}
                  </option>
                ))}
              </select>
              <button
                type="button"
                disabled={busy}
                style={{ fontFamily: "inherit" }}
                onClick={() => {
                  void send(
                    `/api/members/${member.user_id}/deactivate`,
                    {},
                  ).then(load);
                }}
              >
                Deactivate
              </button>
              <button
                type="button"
                disabled={busy}
                style={{ fontFamily: "inherit" }}
                onClick={() => {
                  void send(`/api/members/${member.user_id}/remove`, {}).then(
                    load,
                  );
                }}
              >
                Remove
              </button>
            </span>
          ) : (
            <strong>{member.role}</strong>
          )}
        </div>
      ))}

      {roster.may_manage_members ? (
        <>
          <h2 style={{ ...styles.title, fontSize: "1rem", marginTop: "2rem" }}>
            Invite somebody
          </h2>

          <form onSubmit={invite}>
            <div style={styles.field}>
              <label style={styles.label} htmlFor="invite-email">
                Email
                <span style={styles.hint}>
                  If no mail transport is configured, the link appears here for
                  you to pass on.
                </span>
              </label>
              <input
                style={styles.input}
                id="invite-email"
                name="email"
                type="email"
                required
                value={email}
                onChange={(event) => setEmail(event.target.value)}
              />
            </div>

            <div style={styles.field}>
              <label style={styles.label} htmlFor="invite-role">
                Role
              </label>
              <select
                style={{ ...styles.input, fontFamily: "inherit" }}
                id="invite-role"
                value={role}
                onChange={(event) => setRole(event.target.value)}
              >
                {ROLES.map((one) => (
                  <option key={one} value={one}>
                    {one}
                  </option>
                ))}
              </select>
            </div>

            <button style={styles.button} type="submit" disabled={busy}>
              {busy ? "Inviting…" : "Send invitation"}
            </button>
          </form>

          {note === null ? null : <p style={styles.aside}>{note}</p>}

          {link === null ? null : (
            <div style={{ ...styles.aside, wordBreak: "break-all" }}>
              <strong>Here is the link.</strong> Nothing was emailed, because no
              mail transport is configured. Send it however you like — it works
              once.
              <p>
                <code>{link}</code>
              </p>
            </div>
          )}

          {invitations.length === 0 ? null : (
            <>
              <h2
                style={{ ...styles.title, fontSize: "1rem", marginTop: "2rem" }}
              >
                Waiting to be accepted
              </h2>
              {invitations.map((invitation) => (
                <div key={invitation.id} style={styles.definition}>
                  <span>{invitation.email}</span>
                  <strong>{invitation.role}</strong>
                </div>
              ))}
            </>
          )}
        </>
      ) : null}

      <p style={styles.aside}>
        <a href="/">Back</a>
      </p>
    </Card>
  );
}
