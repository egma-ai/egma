"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { pickers, type Me } from "../lib/me.ts";
import { LIST } from "../lib/transcript-copy.ts";
import { AppShell, ProductPage, StatePage, styles } from "./ui.tsx";

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

  if (state.status === "loading") return <StatePage title="Loading egma" lead="Finding your organization and project." />;

  if (state.status === "signed-out") {
    return (
      <StatePage title="Trust the voice agent you ship to production." lead="Read what happened. Test what matters. Ship what you trust.">
        <p className={styles.linkLine}>
          <Link href="/signup">Set up egma</Link> · <Link href="/sign-in">Sign in</Link>
        </p>
      </StatePage>
    );
  }

  const { me } = state;
  const visible = pickers(me);
  const organization = me.organizations[0];
  const project = me.projects[0];

  return (
    <AppShell active="home" initialMe={me}>
      <ProductPage>
        <section className={styles.homeHero}>
          <p className={styles.eyebrow}>{project?.name ?? "Default"} project</p>
          <h1>Trust starts with what happened.</h1>
          <p>Read the real exchange before you decide what your agent can do next.</p>
        </section>

        <section className={styles.homeLinks}>
          <Link aria-label="Open exchange history" className={styles.homeLink} href="/traces">
            <small>01 / PRIMARY</small><strong>{LIST.navigation}</strong>
            <p>Inspect each exchange, its tools, timing, and errors.</p><i>→</i>
          </Link>
          <Link className={styles.homeLink} href="/members">
            <small>02 / ORGANIZATION</small><strong>Manage your people</strong>
            <p>Invite a teammate or review who can change this organization.</p><i>→</i>
          </Link>
        </section>

        <section className={styles.contextFacts} aria-label="Current context">
          {visible.organization ? <Choice label="Organization" of={me.organizations} /> : <Fact label="Organization" value={organization?.name ?? "—"} />}
          {visible.project ? <Choice label="Project" of={me.projects} /> : <Fact label="Project" value={project?.name ?? "—"} />}
          <Fact label="Your role" value={organization?.role ?? "—"} />
        </section>
      </ProductPage>
    </AppShell>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className={styles.contextFact}>
      <span>{label}</span>
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
    <div className={styles.contextFact}>
      <label htmlFor={`pick-${label}`}><span>{label}</span></label>
      <select className={styles.select} id={`pick-${label}`}>
        {of.map((one) => (
          <option key={one.id} value={one.id}>
            {one.name}
          </option>
        ))}
      </select>
    </div>
  );
}
