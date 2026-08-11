"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
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

function useTheme() {
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

  return { theme, toggle };
}

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

export function AppShell({
  active,
  initialMe,
  children,
}: {
  active?: AppSection;
  initialMe?: Me;
  children: ReactNode;
}) {
  const pathname = usePathname();
  const [me, setMe] = useState<Me | null>(initialMe ?? null);
  const [signingOut, setSigningOut] = useState(false);

  useEffect(() => {
    if (initialMe !== undefined) return undefined;
    let current = true;
    void fetch("/api/me")
      .then(async (response) => {
        if (!current) return;
        if (!response.ok) return;
        setMe((await response.json()) as Me);
      })
      .catch(() => undefined);
    return () => {
      current = false;
    };
  }, [initialMe]);

  useEffect(() => {
    window.scrollTo({ top: 0, left: 0, behavior: "auto" });
  }, [pathname]);

  const initial = me?.user.email.trim().slice(0, 1).toUpperCase() || "E";

  async function signOut(): Promise<void> {
    setSigningOut(true);
    try {
      await fetch("/api/sign-out", { method: "POST" });
    } catch {
      // Reload either way so this shell never keeps showing a stale session.
    }
    window.location.assign("/sign-in");
  }

  return (
    <div className={styles.appShell}>
      <aside className={styles.sidebar}>
        <div className={styles.sidebarTop}>
          <Link href="/traces" aria-label="Egma transcripts"><Brand /></Link>
        </div>
        <nav className={styles.navigation} aria-label="Main navigation">
          {PRODUCT_NAVIGATION.map((item) => <Link key={item.id} className={active === item.id ? styles.navigationActive : undefined} aria-current={active === item.id ? "page" : undefined} href={item.href}>{item.label}</Link>)}
        </nav>
        <div className={styles.sidebarFooter}>
          <AccountMenu initial={initial} signingOut={signingOut} onSignOut={() => void signOut()} />
        </div>
      </aside>
      <div className={styles.appBody}>
        <header className={styles.mobileHeader}>
          <span className={styles.mobileBrand}>
            <Link href="/traces" aria-label="Egma transcripts"><Brand /></Link>
          </span>
          <span className={styles.mobileActions}><AccountMenu initial={initial} signingOut={signingOut} onSignOut={() => void signOut()} /></span>
        </header>
        <nav className={styles.mobileNavigation} aria-label="Main navigation">
          {PRODUCT_NAVIGATION.map((item) => <Link key={item.id} className={active === item.id ? styles.navigationActive : undefined} aria-current={active === item.id ? "page" : undefined} href={item.href}>{item.label}</Link>)}
        </nav>
        {children}
      </div>
    </div>
  );
}

function AccountMenu({
  initial,
  signingOut,
  onSignOut,
}: {
  initial: string;
  signingOut: boolean;
  onSignOut: () => void;
}) {
  return (
    <details className={styles.accountMenu}>
      <summary className={styles.accountCard} aria-label="Open settings menu">
        <span className={styles.avatar}>{initial}</span>
        <span className={styles.accountCardLabel}>Settings</span>
        <svg className={styles.accountChevron} aria-hidden="true" viewBox="0 0 12 12">
          <path d="M3.25 7.25 6 4.5l2.75 2.75" />
        </svg>
      </summary>
      <div className={styles.accountMenuPanel}>
        <Link className={styles.accountMenuItem} href="/members">Organization settings</Link>
        <ThemeMenuToggle />
        <button className={styles.accountMenuItem} type="button" disabled={signingOut} onClick={onSignOut}>
          {signingOut ? "Signing out…" : "Sign out"}
        </button>
      </div>
    </details>
  );
}

function ThemeMenuToggle() {
  const { theme, toggle } = useTheme();
  const dark = theme === "dark";

  return (
    <button
      className={`${styles.accountMenuItem} ${styles.themeMenuItem}`}
      type="button"
      role="switch"
      aria-checked={dark}
      onClick={toggle}
    >
      <span>Dark theme</span>
      <span className={styles.themeSwitch} aria-hidden="true">
        <span className={styles.themeSwitchThumb} />
      </span>
    </button>
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

/**
 * A request state inside the signed-in product.
 *
 * Access pages and product pages deliberately use different compositions. A
 * slow product request must not make the sidebar, navigation and account menu
 * disappear while the browser waits for data.
 */
export function ProductStatePage({
  active,
  eyebrow,
  title,
  lead,
  children,
}: {
  active?: AppSection;
  eyebrow?: string;
  title: string;
  lead?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <AppShell active={active}>
      <ProductPage>
        <PageHeader eyebrow={eyebrow} title={title} lead={lead} />
        {children === undefined ? null : <div className={styles.productStateBody}>{children}</div>}
      </ProductPage>
    </AppShell>
  );
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
