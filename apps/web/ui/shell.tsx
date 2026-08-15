"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";

import { readJson } from "../lib/api.ts";
import { organizationOf, roleOf, type Me, type Project } from "../lib/me.ts";
import { activeSectionIn, navigationFor } from "../lib/navigation.ts";
import { projectIdIn, projectLanding } from "../lib/project-context.ts";
import { canAuthor, VIEW_ONLY, type Role } from "../lib/roles.ts";
import { Badge } from "./controls.tsx";
import { Dialog } from "./dialog.tsx";
import { Menu, MenuDivider, MenuItem, MenuLabel } from "./menu.tsx";
import { ProjectSelector } from "./project-selector.tsx";
import styles from "./system.module.css";
import { useTheme } from "./theme.tsx";

/**
 * The frame every signed-in product page is drawn inside.
 *
 * **Compact, because the product is the data.** A narrow sidebar, a page title
 * that is a label rather than a headline, and controls that sit in a toolbar
 * instead of becoming one. Every measurement is a token in `tokens.css`, so
 * the hands-on tuning pass at the end of this effort is an edit to that file
 * rather than an edit to every page.
 *
 * **Where you are comes from the address.** The project is read out of the
 * path, the navigation item is read out of the path, and nothing here keeps a
 * chosen project of its own. Two tabs on two projects are therefore two
 * ordinary tabs.
 *
 * A page that has not been converted to explicit project context yet still
 * renders inside this shell, and the selector falls back to the first project
 * so that it has something to say. That fallback is the expand half of the
 * project-context change and it goes away with the last unconverted page.
 */

const BRAND_MARK = "/brand/egma-logo.png";

export type Session = {
  readonly me: Me | null;
  /** Whether the session read has settled, however it settled. */
  readonly settled: boolean;
};

/**
 * Who is signed in, read once per page.
 *
 * A failure is quiet on purpose: the shell keeps its navigation and its
 * account controls while a product request is in flight or has failed, because
 * replacing the whole application with an access page every time a read is slow
 * is worse than showing a shell with one thing missing from it. Only an
 * explicit 401 means the session is gone, and the pages that care say so.
 */
export function useSession(initial?: Me): Session {
  const [me, setMe] = useState<Me | null>(initial ?? null);
  const [settled, setSettled] = useState(initial !== undefined);

  useEffect(() => {
    if (initial !== undefined) return undefined;
    let current = true;

    void readJson<Me>("/api/me").then((answer) => {
      if (!current) return;
      if (answer.status === "ready") setMe(answer.value);
      setSettled(true);
    });

    return () => {
      current = false;
    };
  }, [initial]);

  return { me, settled };
}

/**
 * The session, offered to everything drawn inside the shell.
 *
 * A page needs the role to decide which controls are worth showing and needs
 * the projects to say where it is. Both are already in flight for the
 * navigation, so a page reads them from here rather than asking `/api/me`
 * again — one read per page, and one answer everything on it agrees with.
 */
const SessionContext = createContext<Session>({ me: null, settled: false });

export function useShellSession(): Session {
  return useContext(SessionContext);
}

function Mark() {
  return (
    <Image className={styles.mark} src={BRAND_MARK} alt="egma" width={146} height={31} priority />
  );
}

function Navigation({
  projectId,
  pathname,
  onNavigate,
}: {
  readonly projectId: string;
  readonly pathname: string;
  readonly onNavigate?: () => void;
}) {
  const { primary, secondary } = navigationFor(projectId);
  const active = activeSectionIn(pathname);

  const group = (links: ReturnType<typeof navigationFor>["primary"], label?: string) => (
    <div className={styles.navGroup}>
      {label === undefined ? null : <p className={styles.navLabel}>{label}</p>}
      {links.map((link) => (
        <Link
          key={link.id}
          className={`${styles.navItem} ${active === link.id ? styles.navItemActive : ""}`}
          href={link.href}
          aria-current={active === link.id ? "page" : undefined}
          onClick={onNavigate}
        >
          {link.label}
        </Link>
      ))}
    </div>
  );

  return (
    <nav className={styles.nav} aria-label="Product navigation">
      {group(primary)}
      {group(secondary, "Library")}
    </nav>
  );
}

function AccountMenu({
  me,
  role,
  placement,
}: {
  readonly me: Me | null;
  readonly role: Role;
  readonly placement: "above" | "below";
}) {
  const [signingOut, setSigningOut] = useState(false);
  const email = me?.user.email ?? "";
  const initial = email.trim().slice(0, 1).toUpperCase() || "E";

  async function signOut(): Promise<void> {
    setSigningOut(true);
    try {
      await fetch("/api/sign-out", { method: "POST" });
    } catch {
      // Leave either way, so this shell never keeps showing a stale session.
    }
    window.location.assign("/sign-in");
  }

  return (
    <Menu
      label={`Account ${email}. Open the account menu`}
      triggerClassName={styles.account}
      openClassName={styles.accountOpen}
      placement={placement}
      trigger={
        <>
          <span className={styles.avatar} aria-hidden="true">
            {initial}
          </span>
          <span className={styles.accountText}>
            <span className={styles.accountEmail}>{email || "Signed in"}</span>
            <span className={styles.accountRole}>
              {canAuthor(role) ? role : VIEW_ONLY}
            </span>
          </span>
        </>
      }
    >
      {() => (
        <>
          <MenuLabel>{email}</MenuLabel>
          <MenuItem href="/members">Organization settings</MenuItem>
          <MenuDivider />
          <ThemeItem />
          <MenuItem disabled={signingOut} onClick={() => void signOut()}>
            {signingOut ? "Signing out…" : "Sign out"}
          </MenuItem>
        </>
      )}
    </Menu>
  );
}

function ThemeItem() {
  const { theme, toggle } = useTheme();
  const dark = theme === "dark";

  return (
    <button
      className={`${styles.menuItem} ${styles.themeItem}`}
      type="button"
      role="switch"
      aria-checked={dark}
      data-menu-item=""
      onClick={toggle}
    >
      <span>Dark theme</span>
      <span className={styles.themeSwitch} aria-hidden="true">
        <span className={styles.themeSwitchThumb} />
      </span>
    </button>
  );
}

/**
 * The product frame.
 *
 * It renders whether or not the session read has answered yet. A slow or failed
 * `/api/me` must not make the navigation, the selector and the account menu
 * disappear — a page in that state is indistinguishable from a broken
 * application.
 */
export function AppShell({
  initialMe,
  children,
}: {
  readonly initialMe?: Me;
  readonly children: ReactNode;
}) {
  const pathname = usePathname() ?? "/";
  const session = useSession(initialMe);
  const { me } = session;
  const [drawer, setDrawer] = useState(false);

  useEffect(() => {
    window.scrollTo({ top: 0, left: 0, behavior: "auto" });
    setDrawer(false);
  }, [pathname]);

  const projects: readonly Project[] = me?.projects ?? [];
  const named = projectIdIn(pathname);
  // The fallback, and the only one left: a page that has not been converted to
  // explicit project context still has to draw navigation somewhere.
  const shown = named ?? projects[0]?.id ?? null;
  const role = me === null ? "viewer" : roleOf(me);
  const organization = me === null ? undefined : organizationOf(me);

  const selector = (compact: boolean) => (
    <ProjectSelector
      organization={organization}
      projects={projects}
      projectId={named}
      compact={compact}
    />
  );

  return (
    <SessionContext.Provider value={session}>
    <div className={styles.shell}>
      <aside className={styles.sidebar}>
        <div className={styles.sidebarHead}>
          <Link href={shown === null ? "/" : projectLanding(shown)} aria-label="egma">
            <Mark />
          </Link>
        </div>
        {selector(false)}
        {shown === null ? null : <Navigation projectId={shown} pathname={pathname} />}
        <div className={styles.sidebarFoot}>
          {canAuthor(role) ? null : <Badge title="Your role can read, not author">{VIEW_ONLY}</Badge>}
          <AccountMenu me={me} role={role} placement="above" />
        </div>
      </aside>

      <div className={styles.body}>
        <header className={styles.topbar}>
          <button
            className={styles.iconButton}
            type="button"
            aria-label="Open product navigation"
            aria-expanded={drawer}
            onClick={() => setDrawer(true)}
          >
            <span aria-hidden="true">☰</span>
          </button>
          {selector(true)}
          <span className={styles.topbarSpacer} />
          {canAuthor(role) ? null : <Badge>{VIEW_ONLY}</Badge>}
          <AccountMenu me={me} role={role} placement="below" />
        </header>

        {drawer && shown !== null ? (
          <Dialog title="Navigation" onClose={() => setDrawer(false)}>
            <Navigation
              projectId={shown}
              pathname={pathname}
              onNavigate={() => setDrawer(false)}
            />
          </Dialog>
        ) : null}

        {children}
      </div>
    </div>
    </SessionContext.Provider>
  );
}

export function ProductPage({ children }: { readonly children: ReactNode }) {
  return <main className={styles.page}>{children}</main>;
}

export function PageHeader({
  eyebrow,
  title,
  lead,
  action,
}: {
  readonly eyebrow?: string;
  readonly title: string;
  readonly lead?: ReactNode;
  readonly action?: ReactNode;
}) {
  return (
    <header className={styles.pageHeader}>
      <div>
        {eyebrow === undefined ? null : <p className={styles.eyebrow}>{eyebrow}</p>}
        <h1>{title}</h1>
        {lead === undefined ? null : <p className={styles.pageLead}>{lead}</p>}
      </div>
      {action === undefined ? null : <div className={styles.pageActions}>{action}</div>}
    </header>
  );
}

export function PageBody({ children }: { readonly children: ReactNode }) {
  return <div className={styles.pageBody}>{children}</div>;
}

/**
 * A request state inside the signed-in product.
 *
 * Access pages and product pages deliberately use different compositions. A
 * slow product request must not make the sidebar, navigation, selector and
 * account menu disappear while the browser waits for data.
 */
export function ProductStatePage({
  eyebrow,
  title,
  lead,
  children,
}: {
  readonly eyebrow?: string;
  readonly title: string;
  readonly lead?: ReactNode;
  readonly children?: ReactNode;
}) {
  return (
    <AppShell>
      <ProductPage>
        <PageHeader eyebrow={eyebrow} title={title} lead={lead} />
        {children === undefined ? null : <PageBody>{children}</PageBody>}
      </ProductPage>
    </AppShell>
  );
}
