"use client";

import { useEffect, useState } from "react";

import { pickers, type Me } from "../lib/me.ts";
import { LIST } from "../lib/transcript-copy.ts";
import { Card, styles } from "./ui.tsx";

/**
 * Where you are.
 *
 * This is the whole of the interface after signing up, and it exists to show
 * one thing: that somebody landed in an organization and a project without
 * being asked to make either. The dashboard is a separate effort — it reads run
 * data out of a store that does not exist yet.
 *
 * The pickers follow the cardinality rule: a level with one thing in it is not
 * a choice, so it is not shown. Somebody running egma for themselves therefore
 * sees no organization picker and no project picker, and never learns there
 * could have been either.
 */

type State =
  | { status: "loading" }
  | { status: "signed-out" }
  | { status: "signed-in"; me: Me };

export default function Home() {
  const [state, setState] = useState<State>({ status: "loading" });

  useEffect(() => {
    let current = true;
    void fetch("/api/me")
      .then(async (response) => {
        if (!current) return;
        if (!response.ok) {
          setState({ status: "signed-out" });
          return;
        }
        setState({
          status: "signed-in",
          me: (await response.json()) as Me,
        });
      })
      .catch(() => {
        if (current) setState({ status: "signed-out" });
      });
    return () => {
      current = false;
    };
  }, []);

  /**
   * The one control a signed-in person needs that is not a link. The API ends
   * the session where it is kept; reloading is what makes this page stop showing
   * somebody as signed in, and it happens whether or not the call was answered
   * — a person who clicked sign out is not left looking at their own email
   * address because the API was unreachable.
   */
  async function signOut(): Promise<void> {
    try {
      await fetch("/api/sign-out", { method: "POST" });
    } catch {
      // Nothing to say. The reload below is the whole of what this page can do.
    }
    window.location.assign("/");
  }

  if (state.status === "loading") return <Card title="egma">Loading…</Card>;

  if (state.status === "signed-out") {
    return (
      <Card title="egma" lead="Trust the voice agent you ship to production.">
        <p style={styles.aside}>
          <a href="/signup">Set up egma</a> · <a href="/sign-in">Sign in</a>
        </p>
      </Card>
    );
  }

  const { me } = state;
  const visible = pickers(me);
  const organization = me.organizations[0];
  const project = me.projects[0];

  return (
    <Card title="You are set up" lead={me.user.email}>
      {visible.organization ? (
        <Choice label="Organization" of={me.organizations} />
      ) : (
        <Fact label="Organization" value={organization?.name ?? "—"} />
      )}

      {visible.project ? (
        <Choice label="Project" of={me.projects} />
      ) : (
        <Fact label="Project" value={project?.name ?? "—"} />
      )}

      <Fact label="Your role" value={organization?.role ?? "—"} />

      <p style={styles.aside}>
        <a href="/traces">{LIST.navigation}</a> — read what your agents did,
        turn by turn.
      </p>

      <p style={styles.aside}>
        <a href="/members">People</a> — invite a colleague, or change what
        somebody may do.
      </p>

      <p style={styles.aside}>
        Nothing else is built yet. Everything a test needs — agents,
        connections, personas, graders — arrives with the effort that can
        run one.
      </p>

      <p style={styles.aside}>
        <button
          type="button"
          style={{ fontFamily: "inherit" }}
          onClick={() => {
            void signOut();
          }}
        >
          Sign out
        </button>
      </p>
    </Card>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div style={styles.definition}>
      <span style={{ color: "#666" }}>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function Choice({
  label,
  of,
}: {
  label: string;
  of: readonly { id: string; name: string }[];
}) {
  return (
    <div style={{ ...styles.definition, alignItems: "center" }}>
      <label style={{ color: "#666" }} htmlFor={`pick-${label}`}>
        {label}
      </label>
      <select id={`pick-${label}`} style={{ fontFamily: "inherit" }}>
        {of.map((one) => (
          <option key={one.id} value={one.id}>
            {one.name}
          </option>
        ))}
      </select>
    </div>
  );
}
