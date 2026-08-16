"use client";

import Image from "next/image";
import type { ReactNode } from "react";

import { useTheme } from "../ui/theme.tsx";
import { TrustGate } from "./trust-gate.tsx";
import styles from "./ui.module.css";

export { styles };

/**
 * The access pages' own shell, and nothing else.
 *
 * Signing in, signing up, accepting an invitation and authorizing a terminal
 * are not product pages: nobody has a project yet, there is nothing to navigate
 * between, and the page is the whole of what somebody is doing. They keep the
 * wide, unhurried composition here.
 *
 * **Everything a signed-in product page is drawn inside lives in `ui/`** — the
 * compact shell, the selector, the navigation, the page states, the lists and
 * the controls. This file re-exports the four pieces that pages already name so
 * that a page composes its own subject and never its own frame.
 */
export {
  AppShell,
  PageBody,
  PageHeader,
  ProductPage,
  ProductStatePage,
} from "../ui/shell.tsx";

export function Brand() {
  return (
    <Image
      className={styles.brand}
      src="/brand/egma-wordmark.svg"
      alt="Egma"
      width={151}
      height={41}
      priority
    />
  );
}

export function ThemeToggle() {
  const { theme, toggle } = useTheme();

  return (
    <button
      className={styles.themeToggle}
      type="button"
      aria-label={`Use ${theme === "light" ? "dark" : "light"} theme`}
      onClick={toggle}
    >
      <span aria-hidden="true">{theme === "light" ? "◐" : "◑"}</span>
    </button>
  );
}

export function AuthShell({
  eyebrow,
  title,
  lead,
  animated = false,
  children,
}: {
  eyebrow?: string;
  title: string;
  lead?: ReactNode;
  animated?: boolean;
  children: ReactNode;
}) {
  return (
    <main className={`${styles.authShell} ${animated ? styles.authAnimated : styles.authStatic}`}>
      <aside className={styles.authBrandPanel}>
        {animated ? <TrustGate /> : null}
        <div className={styles.authBrandOverlay}>
          <Brand />
          <div className={styles.authStatement}>
            <p className={styles.eyebrow}>{animated ? "Trust gate" : "Voice agent reliability"}</p>
            <p>{animated ? "Raw behavior passes checks before it earns trust." : "Trust the voice agent you ship to production."}</p>
          </div>
        </div>
      </aside>
      <section className={styles.authContent}>
        <div className={styles.authTheme}><ThemeToggle /></div>
        <div className={styles.authCard}>
          {eyebrow === undefined ? null : <p className={styles.eyebrow}>{eyebrow}</p>}
          <h1>{title}</h1>
          {lead === undefined ? null : <div className={styles.authLead}>{lead}</div>}
          {children}
        </div>
      </section>
    </main>
  );
}

export function StatePage({
  title,
  lead,
  children,
}: {
  title: string;
  lead?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <AuthShell title={title} lead={lead}>
      {children}
    </AuthShell>
  );
}

export function Field({
  label,
  hint,
  htmlFor,
  children,
}: {
  label: string;
  hint?: ReactNode;
  htmlFor: string;
  children: ReactNode;
}) {
  return (
    <div className={styles.field}>
      <label htmlFor={htmlFor}>{label}{hint === undefined ? null : <span>{hint}</span>}</label>
      {children}
    </div>
  );
}

export function Notice({
  tone = "neutral",
  children,
}: {
  tone?: "neutral" | "error" | "success";
  children: ReactNode;
}) {
  const toneClass = tone === "neutral" ? "" : styles[`notice-${tone}`];
  const role = tone === "error" ? "alert" : tone === "success" ? "status" : undefined;
  return <div className={`${styles.notice} ${toneClass}`} role={role}>{children}</div>;
}
