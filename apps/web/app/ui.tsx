"use client";

import Image from "next/image";
import { useEffect, useState, type ReactNode } from "react";

import type { Me } from "../lib/me.ts";
import {
  nextTheme,
  PRODUCT_NAVIGATION,
  THEME_STORAGE_KEY,
  themeFromStored,
  type ProductSection,
  type Theme,
} from "../lib/presentation.ts";
import { TrustGate } from "./trust-gate.tsx";
import styles from "./ui.module.css";

export { styles };

export type AppSection = ProductSection;

const THEME_CHANGE_EVENT = "egma:theme-change";

export function Brand() {
  return (
    <Image
      className={styles.brand}
      src="/brand/egma-logo.png"
      alt="egma"
      width={146}
      height={31}
      priority
    />
  );
}

export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>("light");

  useEffect(() => {
    const readTheme = () => {
      setTheme(themeFromStored(document.documentElement.dataset.theme ?? null));
    };
    readTheme();
    window.addEventListener(THEME_CHANGE_EVENT, readTheme);
    return () => window.removeEventListener(THEME_CHANGE_EVENT, readTheme);
  }, []);

  function toggle(): void {
    const next = nextTheme(theme);
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem(THEME_STORAGE_KEY, next);
    } catch {
      // Theme still changes for this page when storage is unavailable.
    }
    window.dispatchEvent(new Event(THEME_CHANGE_EVENT));
  }

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

export function AppShell({
  active,
  initialMe,
  children,
}: {
  active: AppSection;
  initialMe?: Me;
  children: ReactNode;
}) {
  const [me, setMe] = useState<Me | null>(initialMe ?? null);
  const [contextState, setContextState] = useState<"loading" | "ready" | "unavailable">(initialMe === undefined ? "loading" : "ready");

  useEffect(() => {
    if (initialMe !== undefined) return undefined;
    let current = true;
    void fetch("/api/me")
      .then(async (response) => {
        if (!current) return;
        if (!response.ok) {
          setContextState("unavailable");
          return;
        }
        setMe((await response.json()) as Me);
        setContextState("ready");
      })
      .catch(() => {
        if (current) setContextState("unavailable");
      });
    return () => {
      current = false;
    };
  }, [initialMe]);

  const organization = me?.organizations[0];
  const project = me?.projects[0];
  const initial = me?.user.email.trim().slice(0, 1).toUpperCase() || "E";
  const projectLabel = contextState === "loading"
    ? "Loading project"
    : contextState === "unavailable"
      ? "Project unavailable"
      : project?.name === undefined
        ? "No project"
        : `${project.name} project`;

  return (
    <div className={styles.appShell}>
      <aside className={styles.sidebar}>
        <a href="/" aria-label="Egma home"><Brand /></a>
        <div className={styles.sidebarContext}>
          <span>Organization</span>
          <strong>{organization?.name ?? (contextState === "unavailable" ? "Organization unavailable" : "Egma")}</strong>
          <small>{projectLabel}</small>
        </div>
        <nav className={styles.navigation} aria-label="Main navigation">
          {PRODUCT_NAVIGATION.map((item) => <a key={item.id} className={active === item.id ? styles.navigationActive : undefined} aria-current={active === item.id ? "page" : undefined} href={item.href}>{item.label}</a>)}
        </nav>
        <div className={styles.sidebarFooter}>
          <div className={styles.accountLine}>
            <span className={styles.avatar}>{initial}</span>
            <span className={styles.accountEmail}>{me?.user.email ?? (contextState === "unavailable" ? "Account unavailable" : "Loading…")}</span>
            <ThemeToggle />
          </div>
        </div>
      </aside>
      <div className={styles.appBody}>
        <header className={styles.mobileHeader}>
          <a href="/" aria-label="Egma home"><Brand /></a>
          <ThemeToggle />
        </header>
        <nav className={styles.mobileNavigation} aria-label="Main navigation">
          {PRODUCT_NAVIGATION.map((item) => <a key={item.id} className={active === item.id ? styles.navigationActive : undefined} aria-current={active === item.id ? "page" : undefined} href={item.href}>{item.label}</a>)}
        </nav>
        {children}
      </div>
    </div>
  );
}

export function ProductPage({
  children,
  wide = false,
}: {
  children: ReactNode;
  wide?: boolean;
}) {
  return <main className={`${styles.productPage} ${wide ? styles.productPageWide : ""}`}>{children}</main>;
}

export function PageHeader({
  eyebrow,
  title,
  lead,
  action,
}: {
  eyebrow?: string;
  title: string;
  lead?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <header className={styles.pageHeader}>
      <div>
        {eyebrow === undefined ? null : <p className={styles.eyebrow}>{eyebrow}</p>}
        <h1>{title}</h1>
        {lead === undefined ? null : <div className={styles.pageLead}>{lead}</div>}
      </div>
      {action === undefined ? null : <div className={styles.pageAction}>{action}</div>}
    </header>
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
