"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";

import {
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
} from "@/components/ui/sidebar";

import { readJson } from "../lib/api.ts";
import { organizationOf, roleOf, type Me, type Project } from "../lib/me.ts";
import {
  activeSectionIn,
  navigationFor,
  type SectionId,
} from "../lib/navigation.ts";
import { projectIdIn } from "../lib/project-context.ts";
import { canAuthor, VIEW_ONLY, type Role } from "../lib/roles.ts";
import { Badge } from "./controls.tsx";
import { Dialog } from "./dialog.tsx";
import { DraftNavigationProvider } from "./draft-navigation.tsx";
import { Menu, MenuDivider, MenuItem, MenuLabel } from "./menu.tsx";
import {
  PageNavigation,
  type PageNavigationItems,
} from "./page-navigation.tsx";
import { ProjectSelector } from "./project-selector.tsx";
import { settingsPath } from "./settings-nav.tsx";
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
 * **There is no fallback left, and this paragraph used to describe one.** While
 * pages were being converted to explicit project context the selector fell back
 * to the first project so that it had something to say; that half of the
 * expand-contract change is finished, and both fallbacks — this shell's and the
 * selector's own — are gone. An address inside no project draws no product
 * navigation and says **No project**, which is the honest answer.
 */

export type Session = {
  readonly me: Me | null;
  /** Whether the session read has settled, however it settled. */
  readonly settled: boolean;
  /** Re-read changed organization or project context without clearing it. */
  readonly refresh: () => Promise<void>;
  /** Add a project returned by a successful create before navigating into it. */
  readonly includeProject: (project: Project) => void;
};

/**
 * Who is signed in, read once for one continuous visit to the product.
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
  const mounted = useRef(false);
  const request = useRef(0);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const refresh = useCallback(async () => {
    const thisRequest = request.current + 1;
    request.current = thisRequest;
    const answer = await readJson<Me>("/api/me");
    if (!mounted.current || request.current !== thisRequest) return;

    if (answer.status === "ready") setMe(answer.value);
    if (answer.status === "signed-out") setMe(null);
    setSettled(true);
  }, []);
  const includeProject = useCallback((project: Project) => {
    setMe((current) => {
      if (current === null) return current;
      const projects = current.projects.some((one) => one.id === project.id)
        ? current.projects.map((one) =>
            one.id === project.id ? project : one,
          )
        : [...current.projects, project];
      return { ...current, projects };
    });
  }, []);

  useEffect(() => {
    if (initial === undefined) void refresh();
  }, [initial, refresh]);

  return { me, settled, refresh, includeProject };
}

/**
 * The session, offered to everything drawn inside the shell.
 *
 * A page needs the role to decide which controls are worth showing and needs
 * the projects to say where it is. Both are already in flight for the
 * navigation, so a page reads them from here rather than asking `/api/me`
 * again — one stable answer for the shell and every page below it.
 */
const EMPTY_SESSION: Session = {
  me: null,
  settled: false,
  refresh: async () => {},
  includeProject: () => {},
};
const SessionContext = createContext<Session | null>(null);

export function useShellSession(): Session {
  return useContext(SessionContext) ?? EMPTY_SESSION;
}

/**
 * Keep one signed-in frame mounted while any product page changes below it.
 *
 * Access, invitation and device pages use their own composition and must not
 * fetch a signed-in session. Every route that already draws AppShell is listed
 * here, including the projectless forwarding and creation pages. Keeping this
 * boundary in the root layout means moving between those route families does
 * not remount the shell or flash empty organization, project and account text.
 */
export function ProductShellBoundary({ children }: { readonly children: ReactNode }) {
  const pathname = usePathname() ?? "/";
  const usesProductShell =
    pathname === "/" ||
    pathname === "/members" ||
    pathname === "/new-project" ||
    pathname === "/projects" ||
    pathname.startsWith("/projects/") ||
    pathname === "/runs" ||
    pathname.startsWith("/runs/") ||
    pathname === "/traces" ||
    pathname.startsWith("/traces/");

  return usesProductShell ? <AppShell>{children}</AppShell> : <>{children}</>;
}

const NAVIGATION_ICON_PATHS: Record<SectionId, readonly string[]> = {
  agents: [
    "M10 9.5a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z",
    "M4.5 16.5c.55-3 2.4-4.5 5.5-4.5s4.95 1.5 5.5 4.5",
  ],
  tests: ["M5 3.5h10v13H5z", "M7.5 7h5", "M7.5 10h5", "M7.5 13h3"],
  runs: ["m6.5 4.5 8 5.5-8 5.5z"],
  // A live line: what production is doing, read left to right.
  monitoring: ["M3 12.5h3l2.5-6 3 9 2.5-5h3"],
  personas: [
    "M7.5 9a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5Z",
    "M3.5 16c.45-2.75 1.8-4.1 4-4.1 2.15 0 3.55 1.35 4 4.1",
    "M13 5.1a2.2 2.2 0 0 1 0 4.2",
    "M13.5 11.8c1.75.2 2.75 1.6 3 4.2",
  ],
  graders: [
    "m10 3 2.05 4.15 4.58.67-3.32 3.22.78 4.55L10 12.9l-4.1 2.15.78-4.55-3.32-3.22 4.58-.67z",
  ],
  settings: ["M4 5h12", "M4 10h12", "M4 15h12", "M7 3v4", "M13 8v4", "M8.5 13v4"],
};

/** Small line symbols make the stable product areas easier to scan. */
function NavigationIcon({ section }: { readonly section: SectionId }) {
  return (
    <svg
      className={styles.navIcon}
      aria-hidden="true"
      focusable="false"
      viewBox="0 0 20 20"
    >
      {NAVIGATION_ICON_PATHS[section].map((path) => <path d={path} key={path} />)}
    </svg>
  );
}

/**
 * The three groups, drawn once for wherever the bar is being shown.
 *
 * **One navigation model.** The docked bar and the mobile drawer render this
 * same component, so the drawer cannot drift into a second, shorter list of
 * where a person may go. The drawer passes `onNavigate` and the bar does not,
 * which is the only difference between them: a drawer closes behind the choice
 * it was opened to make.
 *
 * Where an item is lit still comes from the address, never from which group it
 * happens to be in.
 */
function Navigation({
  projectId,
  pathname,
  onNavigate,
}: {
  readonly projectId: string;
  readonly pathname: string;
  readonly onNavigate?: () => void;
}) {
  const groups = navigationFor(projectId);
  const active = activeSectionIn(pathname);

  return (
    <SidebarProvider onNavigate={onNavigate}>
      <SidebarContent asChild>
        <nav aria-label="Product navigation">
          {groups.map((group) => (
            <SidebarGroup key={group.id}>
              <SidebarGroupLabel>{group.label}</SidebarGroupLabel>
              <SidebarMenu>
                {group.items.map((link) => (
                  <SidebarMenuItem key={link.id}>
                    <SidebarMenuButton asChild isActive={active === link.id}>
                      <Link href={link.href}>
                        <NavigationIcon section={link.id} />
                        {link.label}
                      </Link>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                ))}
              </SidebarMenu>
            </SidebarGroup>
          ))}
        </nav>
      </SidebarContent>
    </SidebarProvider>
  );
}

/**
 * Who is signed in, and — while nobody has answered that yet — the fact that
 * nobody has answered it yet.
 *
 * **Three states, because there are three.** A session read that is still in
 * flight is not the same as one that came back with nothing, and neither is the
 * same as somebody. Collapsing the first two into "Signed in" tells a person
 * something egma does not know.
 */
function AccountMenu({
  me,
  settled,
  role,
  placement,
  projectId,
}: {
  readonly me: Me | null;
  readonly settled: boolean;
  /** Null until the session read says. Never guessed. */
  readonly role: Role | null;
  readonly placement: "below-end" | "right-end";
  /**
   * The project Settings is drawn under, or nothing while the session read is
   * still in flight or the organization holds none.
   *
   * Settings lives inside the product shell so the project selector stays on
   * screen throughout it, which means every Settings address names a project —
   * including the pages whose subject is the whole organization. With none to
   * name, the menu falls back to `/members`, which resolves one for itself.
   */
  readonly projectId?: string | null;
}) {
  const [signingOut, setSigningOut] = useState(false);
  const email = me?.user.email ?? "";
  const standing = me !== null ? email : settled ? "Session unavailable" : "Checking your session…";
  const initial = me !== null ? (email.trim().slice(0, 1).toUpperCase() || "E") : "·";

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
      label={`Account ${standing}. Open the account menu`}
      triggerClassName={styles.account}
      openClassName={styles.accountOpen}
      placement={placement}
      trigger={
        <>
          <span className={styles.avatar} aria-hidden="true">
            {initial}
          </span>
          <span className={styles.accountText}>
            <span className={styles.accountEmail}>{standing}</span>
            {role === null ? null : (
              <span className={styles.accountRole}>
                {canAuthor(role) ? role : VIEW_ONLY}
              </span>
            )}
          </span>
        </>
      }
    >
      {(close) => (
        <>
          <MenuLabel>{standing}</MenuLabel>
          <MenuItem
            href={
              projectId == null ? "/members" : settingsPath(projectId, "project")
            }
            onClick={close}
          >
            Settings
          </MenuItem>
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
  const inherited = useContext(SessionContext);

  // The root product boundary owns one persistent shell. Route pages still
  // compose AppShell so they remain honest when rendered in isolation by tests
  // and component proofs. Inside the persistent boundary that
  // second shell must be transparent: mounting it would clear the settled
  // organization, project and account on every page change and ask `/api/me`
  // again before drawing the same context.
  if (inherited !== null) return <>{children}</>;

  return <ShellFrame initialMe={initialMe}>{children}</ShellFrame>;
}

function ShellFrame({
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
  const previousPath = useRef(pathname);

  useEffect(() => {
    window.scrollTo({ top: 0, left: 0, behavior: "auto" });
    setDrawer(false);
  }, [pathname]);

  useEffect(() => {
    const changed = previousPath.current !== pathname;
    previousPath.current = pathname;
    if (changed && session.settled && session.me === null) {
      void session.refresh();
    }
  }, [pathname, session.me, session.refresh, session.settled]);

  const projects: readonly Project[] = me?.projects ?? [];
  /**
   * The project this address names, and **nothing at all when it names none.**
   *
   * There used to be a fallback here — `named ?? projects[0]?.id` — left over
   * from the pages that had not yet been converted to explicit project context.
   * It is gone with the last of them, and it had to go rather than be left
   * harmlessly unused: what it did was draw a project's navigation on an
   * address that is not in that project, so a person with three projects met
   * links into whichever came first in their list, with nothing saying so. The
   * grader screens were the last pages it was standing in for, and they are
   * under `/projects/:projectId/graders` now.
   *
   * Some addresses still name no project on purpose: `/new-project`, the two
   * transcript addresses, the terminal's `/runs/{runId}` address and the kept
   * `/members` address. They do not draw project navigation or a mobile
   * navigation button, because an address that names no project cannot honestly
   * say which project's links it is opening. The selector stays visible, so
   * choosing one remains the way into the project product. Each page still
   * decides its own data scope; the browser transcript read, for example, uses
   * the project carried by the session even though its URL has no project.
   */
  const shown = projectIdIn(pathname);
  /**
   * **Null until the session read answers, and never `viewer` in the meantime.**
   * A cautious default reads as a fact: every admin would be shown the
   * `View only` badge on every page load, and told that their role cannot do
   * things it can. Not knowing is its own answer, and the shell shows no claim
   * at all while it holds.
   */
  const role = me === null ? null : roleOf(me);
  const organization = me === null ? undefined : organizationOf(me);

  const selector = (compact: boolean) => (
    <ProjectSelector
      organization={organization}
      projects={projects}
      projectId={shown}
      mayCreateProject={role === "admin"}
      compact={compact}
    />
  );

  return (
    <SessionContext.Provider value={session}>
    <DraftNavigationProvider>
    <div className={styles.shell}>
      {/*
       * The `<aside>` stays the shell's own: it is a column of the grid above
       * and it is what the one layout breakpoint hides, so its class keeps
       * living beside the breakpoint that reads it. Everything inside it is on
       * the sidebar primitives — the switcher topmost in the header slot, the
       * groups in the content, the account control in the footer slot.
       */}
      <aside className={styles.sidebar}>
        <SidebarHeader>{selector(false)}</SidebarHeader>
        {shown === null ? null : <Navigation projectId={shown} pathname={pathname} />}
        <SidebarFooter>
          {role !== null && !canAuthor(role) ? (
            <Badge title="Your role can read, not author">{VIEW_ONLY}</Badge>
          ) : null}
          <AccountMenu
            me={me}
            settled={session.settled}
            role={role}
            placement="right-end"
            projectId={shown}
          />
        </SidebarFooter>
      </aside>

      <div className={styles.body}>
        <header className={styles.topbar}>
          {shown === null ? null : (
            <button
              className={styles.iconButton}
              type="button"
              aria-label="Open product navigation"
              aria-expanded={drawer}
              onClick={() => setDrawer(true)}
            >
              <span aria-hidden="true">☰</span>
            </button>
          )}
          {selector(true)}
          <span className={styles.topbarSpacer} />
          {role !== null && !canAuthor(role) ? <Badge>{VIEW_ONLY}</Badge> : null}
          <AccountMenu
            me={me}
            settled={session.settled}
            role={role}
            placement="below-end"
            projectId={shown}
          />
        </header>

        {drawer && shown !== null ? (
          <Dialog kind="drawer" title="Navigation" onClose={() => setDrawer(false)}>
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
    </DraftNavigationProvider>
    </SessionContext.Provider>
  );
}

/**
 * The page itself.
 *
 * `wide` is for a page whose subject is wide by nature — a transcript beside
 * the timing of what happened during it, a run beside its simulations. It is a
 * different maximum and not a different layout, so a page asks for room rather
 * than styling itself.
 */
export function ProductPage({
  wide = false,
  viewport = false,
  children,
}: {
  readonly wide?: boolean;
  /** Keep the page header fixed and let its body own the available scroll. */
  readonly viewport?: boolean;
  readonly children: ReactNode;
}) {
  return (
    <main
      className={`${styles.page} ${wide ? styles.pageWide : ""} ${
        viewport ? styles.pageViewport : ""
      }`}
    >
      {children}
    </main>
  );
}

export function PageHeader({
  eyebrow,
  title,
  lead,
  action,
  breadcrumbs,
}: {
  readonly eyebrow?: string;
  readonly title: string;
  readonly lead?: ReactNode;
  readonly action?: ReactNode;
  /** Parent links and the current page, in that order. */
  readonly breadcrumbs?: PageNavigationItems;
}) {
  return (
    <>
      {breadcrumbs === undefined ? null : (
        <PageNavigation items={breadcrumbs} />
      )}
      <header className={styles.pageHeader}>
        <div>
          {eyebrow === undefined || breadcrumbs !== undefined ? null : (
            <p className={styles.eyebrow}>{eyebrow}</p>
          )}
          <h1>{title}</h1>
          {lead === undefined ? null : <p className={styles.pageLead}>{lead}</p>}
        </div>
        {action === undefined ? null : <div className={styles.pageActions}>{action}</div>}
      </header>
    </>
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
  breadcrumbs,
  children,
}: {
  readonly eyebrow?: string;
  readonly title: string;
  readonly lead?: ReactNode;
  readonly breadcrumbs?: PageNavigationItems;
  readonly children?: ReactNode;
}) {
  return (
    <AppShell>
      <ProductPage>
        <PageHeader
          eyebrow={eyebrow}
          title={title}
          lead={lead}
          breadcrumbs={breadcrumbs}
        />
        {children === undefined ? null : <PageBody>{children}</PageBody>}
      </ProductPage>
    </AppShell>
  );
}

