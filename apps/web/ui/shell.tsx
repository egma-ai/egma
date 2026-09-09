"use client";

import {
  BotIcon,
  ClipboardCheckIcon,
  ChevronsUpDownIcon,
  MessageSquareTextIcon,
  PlayIcon,
  ScaleIcon,
  SlidersHorizontalIcon,
  UsersIcon,
  type LucideIcon,
} from "lucide-react";
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

import { Badge } from "@/components/ui/badge";
import { SheetHost } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { Toaster } from "@/components/ui/sonner";
import { cn } from "@/lib/utils";
import {
  SidebarBrand,
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

import {
  organizationOf,
  readSession,
  roleOf,
  type Me,
  type Organization,
  type Project,
} from "../lib/me.ts";
import {
  activeSectionIn,
  navigationFor,
  type SectionId,
} from "../lib/navigation.ts";
import { projectIdIn } from "../lib/project-context.ts";
import { canAuthor, VIEW_ONLY, type Role } from "../lib/roles.ts";
import { Dialog } from "./dialog.tsx";
import { DraftNavigationProvider } from "./draft-navigation.tsx";
import { MENU_ITEM, Menu, MenuDivider, MenuItem, MenuLabel } from "./menu.tsx";
import { PageNavigation, type PageNavigationItems } from "./page-navigation.tsx";
import { ProjectSelector } from "./project-selector.tsx";
import { Toolbar } from "./section.tsx";
import { SessionLoading } from "./session-loading.tsx";
import { settingsPath } from "./settings-nav.tsx";
import { useTheme } from "./theme.tsx";

/**
 * Shared signed-in frame using theme dimensions. Derive project and current
 * navigation from the URL; an address without a project shows no project
 * navigation rather than selecting a fallback.
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
    /*
     * Bounded, and `settled` below is why. A read that never answers used to
     * leave a shell with empty slots in it; it now leaves a cover with the
     * document behind it inert, so a server that accepts the connection and
     * then says nothing would freeze the page rather than degrade it. The
     * deadline turns that into an ordinary failure, and this line runs.
     */
    const answer = await readSession();
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
 * here, including the projectless creation page. Keeping this
 * boundary in the root layout means moving between those route families does
 * not remount the shell or flash empty organization, project and account text.
 */
export function ProductShellBoundary({ children }: { readonly children: ReactNode }) {
  const pathname = usePathname() ?? "/";
  const usesProductShell =
    pathname === "/" ||
    pathname === "/new-project" ||
    pathname.startsWith("/projects/");

  return usesProductShell ? <AppShell>{children}</AppShell> : <>{children}</>;
}

/**
 * Use one icon set for product navigation, keeping product icons distinct
 * from the Egma logo.
 */
const NAVIGATION_ICONS: Record<SectionId, LucideIcon> = {
  agents: BotIcon,
  tests: ClipboardCheckIcon,
  runs: PlayIcon,
  monitoring: MessageSquareTextIcon,
  personas: UsersIcon,
  graders: ScaleIcon,
  settings: SlidersHorizontalIcon,
};

/**
 * Small line symbols make the stable product areas easier to scan.
 *
 * 16px and stroke 1.75 on every one of them. The size is the row's, the weight
 * is lighter than lucide's own 2 because the bar is quiet type and a heavier
 * line would make the symbol the loudest thing in the row.
 */
function NavigationIcon({ section }: { readonly section: SectionId }) {
  const Icon = NAVIGATION_ICONS[section];

  return (
    <Icon className="size-4 flex-none" aria-hidden="true" strokeWidth={1.75} />
  );
}

/**
 * Render the same navigation groups in the sidebar and mobile drawer. The
 * drawer closes through onNavigate; active state comes from the URL.
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
      {/*
       * Pad sidebar blocks separately so the organization divider spans the full
       * width. Row inset plus row padding align icons with project text and group labels.
       */}
      <SidebarContent className="px-2" asChild>
        <nav aria-label="Product navigation">
          {groups.map((group) => (
            <SidebarGroup key={group.id} labelled={group.label !== null}>
              {group.label === null ? null : (
                <SidebarGroupLabel>{group.label}</SidebarGroupLabel>
              )}
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
 * Show the session's organization name without inventing billing or switcher
 * state. Keep its mark separate from the interactive trigger.
 */
function OrganizationMenu({
  organization,
  settled,
}: {
  readonly organization: Organization | undefined;
  readonly settled: boolean;
}) {
  const mark = (
    /* eslint-disable-next-line @next/next/no-img-element */
    <img
      className="size-(--sidebar-mark-size) flex-none [[data-theme=dark]_&]:invert"
      src="/brand/egma-mark-light.svg"
      alt="Egma"
      width={32}
      height={32}
    />
  );

  if (organization === undefined) {
    return (
      <>
        {mark}
        <div
          className="flex min-h-(--control-lg) min-w-0 flex-1 items-center px-2"
          data-slot="organization-status"
        >
          {/*
           * Use a placeholder for the organization name while unresolved. SessionLoading
           * owns the application-wide waiting message.
           */}
          {settled ? (
            <span className="min-w-0 overflow-hidden text-sm text-ellipsis whitespace-nowrap text-muted-foreground">
              No organization
            </span>
          ) : (
            <Skeleton className="h-3 w-28" />
          )}
        </div>
      </>
    );
  }

  const initial = organization.name.trim().slice(0, 1).toUpperCase() || "E";

  return (
    <>
      {mark}
      <Menu
        label={`Open organization menu for ${organization.name}`}
        triggerClassName={cn(
          "flex min-h-(--control-lg) w-full min-w-0 items-center gap-1 px-2",
          "cursor-pointer rounded-input border border-transparent bg-transparent text-left",
          "transition-transform duration-(--duration-press) ease-out",
          "pointer-hover:border-border pointer-hover:bg-surface-soft",
          "[&:active:not(:focus-visible)]:scale-97",
          "motion-reduce:transition-none",
          "motion-reduce:[&:active:not(:focus-visible)]:scale-100",
        )}
        openClassName="border-border bg-surface-soft"
        placement="below-start"
        panelRole="dialog"
        panelClassName="w-[280px] p-3"
        trigger={
          <>
            <span
              className="min-w-0 flex-1 overflow-hidden text-sm font-medium text-ellipsis whitespace-nowrap text-foreground"
              data-slot="organization-name"
            >
              {organization.name}
            </span>
            <ChevronsUpDownIcon
              className="size-3 flex-none text-faint"
              aria-hidden="true"
              strokeWidth={1.75}
            />
          </>
        }
      >
        {() => (
          <div className="flex min-w-0 items-center gap-3 p-2" data-slot="organization-summary">
            <span
              className="grid size-10 flex-none place-items-center rounded-none border border-border bg-surface-soft text-sm text-muted-foreground"
              aria-hidden="true"
            >
              {initial}
            </span>
            <span className="min-w-0">
              {/*
               * The project control's own label, on the row above the name it
               * names. Same step, same faint colour, same sentence case: two
               * controls one under the other, each saying what its name is.
               */}
              <span className="block overflow-hidden text-2xs leading-(--line-normal) text-ellipsis whitespace-nowrap text-faint">
                Organization
              </span>
              <span className="block overflow-hidden text-sm font-medium text-ellipsis whitespace-nowrap text-foreground">
                {organization.name}
              </span>
            </span>
          </div>
        )}
      </Menu>
    </>
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
  compact = false,
  settingsHref,
}: {
  readonly me: Me | null;
  readonly settled: boolean;
  /** Null until the session read says. Never guessed. */
  readonly role: Role | null;
  readonly placement: "below-end" | "right-end";
  /**
   * Compact account variant for the mobile bar: render the avatar without the
   * desktop text block.
   */
  readonly compact?: boolean;
  /**
   * The Settings destination, or nothing until the session has loaded
   * successfully.
   *
   * Settings lives inside the product shell so the project selector stays on
   * screen throughout it, which means every Settings address names a project —
   * including the pages whose subject is the whole organization.
   */
  readonly settingsHref: string | null;
}) {
  const [signingOut, setSigningOut] = useState(false);
  const email = me?.user.email ?? "";
  /**
   * Name this control by account state while the visual slot uses a placeholder
   * until the account label is available.
   */
  const standing = me !== null ? email : settled ? "Session unavailable" : "Loading account";
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
    <>
      {/*
       * Signing out is a document load away from the sign-in page, and until
       * this cover existed the whole of it was a menu item that said
       * "Signing out…" behind a shell still showing the session being ended.
       * It is the entrance's own screen, so the two ends of a visit look alike.
       */}
      {signingOut ? <SessionLoading label="Signing out" /> : null}
      <Menu
        label={`Account ${standing}. Open the account menu`}
        triggerClassName={cn(
          "grid w-full min-w-0 items-center gap-3",
          /*
           * Subtract the reserved border from trigger padding so the avatar aligns
           * with borderless navigation icons without shifting on hover.
           */
          "grid-cols-[var(--control-md)_minmax(0,1fr)] min-h-(--control-lg) py-1",
          "px-[calc(var(--space-2)-1px)]",
          "cursor-pointer rounded-input border border-transparent bg-transparent text-left",
          "transition-transform duration-(--duration-press) ease-out",
          "pointer-coarse:min-h-(--tap-target)",
          "pointer-hover:border-border pointer-hover:bg-surface",
          "[&:active:not(:focus-visible)]:scale-97",
          "motion-reduce:transition-none",
          "motion-reduce:[&:active:not(:focus-visible)]:scale-100",
          compact && "w-(--tap-target) min-h-(--tap-target) grid-cols-[var(--tap-target)] p-0",
        )}
        openClassName="border-border bg-surface"
        placement={placement}
        trigger={
          <>
            <span
              className={cn(
                "grid size-(--control-md) flex-none place-items-center",
                "rounded-none border border-border bg-surface-soft text-sm",
                compact && "size-(--tap-target)",
              )}
              data-slot="account-avatar"
              aria-hidden="true"
            >
              {initial}
            </span>
            {compact ? null : (
              <span className="min-w-0">
                {me === null && !settled ? (
                  <Skeleton className="h-3 w-24" />
                ) : (
                  <span className="block overflow-hidden text-sm text-ellipsis whitespace-nowrap">
                    {standing}
                  </span>
                )}
                {role === null ? null : (
                  /* 12px: the micro label the boards give the role line (`720-0`). */
                  <span className="block text-2xs tracking-(--tracking-label) text-faint uppercase">
                    {canAuthor(role) ? role : VIEW_ONLY}
                  </span>
                )}
              </span>
            )}
          </>
        }
      >
        {(close) => (
          <>
            <MenuLabel>{standing}</MenuLabel>
            <MenuItem
              {...(settingsHref === null ? { disabled: true } : { href: settingsHref })}
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
    </>
  );
}

function ThemeItem() {
  const { theme, toggle } = useTheme();
  const dark = theme === "dark";

  return (
    <button
      className={cn(MENU_ITEM, "group/theme justify-between")}
      type="button"
      role="switch"
      aria-checked={dark}
      data-menu-item=""
      onClick={toggle}
    >
      <span>Dark theme</span>
      <span
        className={cn(
          "relative block h-[15px] w-[26px] flex-none",
          "rounded-chip border border-border-strong bg-surface-soft",
          "group-aria-checked/theme:border-foreground group-aria-checked/theme:bg-foreground",
        )}
        aria-hidden="true"
      >
        <span
          className={cn(
            /* Square, like everything else: a switch is a component. */
            "absolute top-0.5 left-0.5 block size-[9px] bg-muted-foreground",
            "transition-transform duration-(--duration-press) ease-out",
            "group-aria-checked/theme:translate-x-[11px] group-aria-checked/theme:bg-background",
            /* Keyboard activation is immediate: the thumb is already there. */
            "group-focus-visible/theme:transition-none",
            "motion-reduce:transition-none",
          )}
        />
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
   * Show project navigation only for a project named in the URL. /new-project
   * keeps the selector available without inventing a current project.
   */
  const shown = projectIdIn(pathname);
  const settingsHref =
    me === null
      ? null
      : shown !== null
        ? settingsPath(shown, "organization")
        : projects[0] === undefined
          ? "/new-project"
          : settingsPath(projects[0].id, "organization");
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

  /**
   * Cover cold product loads until session resolution. The root entrance owns
   * its own cover because it must remain covered through the subsequent redirect.
   */
  const unresolved = !session.settled && pathname !== "/";

  return (
    <SessionContext.Provider value={session}>
    <DraftNavigationProvider>
    {unresolved ? <SessionLoading label="Opening Egma" /> : null}
    <div
      className={cn(
        "grid min-h-svh bg-background",
        "grid-cols-[var(--sidebar-width)_minmax(0,1fr)]",
        /*
         * The one layout breakpoint in the shell. It cannot be a theme value —
         * a custom property does not exist when a media query is evaluated — so
         * it is the same constant everywhere it is written: 900px, where the
         * sidebar gives way to a top bar and a drawer.
         */
        "max-[900px]:grid-cols-[minmax(0,1fr)]",
      )}
    >
      {/*
       * The `<aside>` stays the shell's own: it is a column of the grid above
       * and it is what the one layout breakpoint hides, so its class keeps
       * living beside the breakpoint that reads it. Everything inside it is on
       * the sidebar primitives — the switcher topmost in the header slot, the
       * groups in the content, the account control in the footer slot.
       */}
      <aside
        className={cn(
          "sticky top-0 z-20 flex h-svh flex-col gap-5 overflow-visible pb-4",
          "border-r border-border bg-surface",
          "max-[900px]:hidden",
        )}
      >
        {/* Organization context owns the top bar; project context stays below. */}
        <SidebarBrand className="gap-2 [&>[data-slot=menu]]:min-w-0 [&>[data-slot=menu]]:flex-1">
          <OrganizationMenu organization={organization} settled={session.settled} />
        </SidebarBrand>
        <SidebarHeader className="px-4">{selector(false)}</SidebarHeader>
        {shown === null ? null : <Navigation projectId={shown} pathname={pathname} />}
        {/*
         * 8px, the navigation column's inset, so the account plate is the same
         * 208px block as a nav row and stands 8px off both edges of the bar.
         * The avatar rides the 16px lane from inside it — see `AccountMenu`,
         * which pays for its own hairline.
         */}
        <SidebarFooter className="px-2">
          {role !== null && !canAuthor(role) ? (
            /*
             * The chip has no plate to sit inside, so it takes the 8px back as
             * a margin and starts on the lane with everything else.
             */
            <Badge className="mx-2" title="Your role can read, not author">
              {VIEW_ONLY}
            </Badge>
          ) : null}
          <AccountMenu
            me={me}
            settled={session.settled}
            role={role}
            placement="right-end"
            settingsHref={settingsHref}
          />
        </SidebarFooter>
      </aside>

      <div className="flex min-w-0 flex-col bg-background">
        <header
          className={cn(
            "sticky top-0 z-20 hidden h-(--topbar-height) items-center gap-3 px-4",
            "border-b border-border backdrop-blur-[12px]",
            /*
             * Nearly the raised surface, so what scrolls under the bar is felt
             * rather than read. Written here because it is one derived value
             * used in one place, and the theme holds no key for it.
             */
            "bg-[color-mix(in_srgb,var(--surface)_94%,transparent)]",
            "max-[900px]:flex",
          )}
        >
          {shown === null ? null : (
            <button
              className={cn(
                "grid size-(--control-md) flex-none cursor-pointer place-items-center p-0",
                "rounded-button border border-border bg-surface text-sm text-foreground",
                "transition-transform duration-(--duration-press) ease-out",
                "pointer-coarse:size-(--tap-target)",
                "pointer-hover:border-border-strong pointer-hover:bg-surface-soft",
                "[&:active:not(:focus-visible)]:scale-97",
                "motion-reduce:transition-none",
                "motion-reduce:[&:active:not(:focus-visible)]:scale-100",
              )}
              type="button"
              aria-label="Open product navigation"
              aria-expanded={drawer}
              onClick={() => setDrawer(true)}
            >
              <span aria-hidden="true">☰</span>
            </button>
          )}
          {selector(true)}
          <span className="flex-1" />
          {role !== null && !canAuthor(role) ? <Badge>{VIEW_ONLY}</Badge> : null}
          <AccountMenu
            me={me}
            settled={session.settled}
            role={role}
            placement="below-end"
            compact
            settingsHref={settingsHref}
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
    <Toaster position="top-right" closeButton />
    </DraftNavigationProvider>
    </SessionContext.Provider>
  );
}

/**
 * Share one centered, capped content frame across the title, toolbar, and body.
 * The wide option changes the maximum through --page-content-max. Provide a
 * sheet portal host inside main for product forms.
 */
export function ProductPage({
  wide = false,
  viewport = false,
  desktopViewport = false,
  children,
}: {
  readonly wide?: boolean;
  /** Keep the page header fixed and let its body own the available scroll. */
  readonly viewport?: boolean;
  /** Use the viewport layout on desktop while mobile stays in document flow. */
  readonly desktopViewport?: boolean;
  readonly children: ReactNode;
}) {
  return (
    <main
      className={cn(
        "flex w-full min-w-0 flex-col",
        "[--page-content-max:var(--page-max)]",
        wide && "[--page-content-max:var(--page-max-wide)]",
        viewport && [
          "h-svh min-h-0 overflow-hidden",
          "max-[900px]:h-[calc(100svh-var(--topbar-height))]",
          /*
           * Settings is a set of views rather than a long document: the page
           * title stays put and the body owns the remaining height. The rule
           * is on the page because only the page knows it was asked for a
           * viewport. The bottom gutter goes with it — the body scrolls now,
           * and its own last group already ends the page.
           */
          "[&>[data-slot=page-body]]:min-h-0",
          "[&>[data-slot=page-body]]:flex-1",
          "[&>[data-slot=page-body]]:overflow-hidden",
          "[&>[data-slot=page-body]]:pb-0",
        ],
        desktopViewport && [
          "min-[901px]:h-svh min-[901px]:min-h-0 min-[901px]:overflow-hidden",
          "min-[901px]:[&>[data-slot=page-body]]:min-h-0",
          "min-[901px]:[&>[data-slot=page-body]]:flex-1",
          "min-[901px]:[&>[data-slot=page-body]]:overflow-hidden",
          "min-[901px]:[&>[data-slot=page-body]]:pb-0",
        ],
      )}
    >
      <SheetHost>{children}</SheetHost>
    </main>
  );
}

/**
 * One horizontal frame for the title, toolbar and page body.
 *
 * It is full-width while the page can keep its standard gutters. Once the
 * content maximum is reached, `mx-auto` divides the spare width between both
 * sides. Keeping this in one component prevents a list action, title and table
 * from drifting onto three different left edges.
 */
function PageContentFrame({
  children,
  className,
  slot,
}: {
  readonly children: ReactNode;
  readonly className?: string;
  readonly slot: string;
}) {
  return (
    <div
      className={cn(
        "mx-auto flex w-full max-w-(--page-content-max) min-w-0",
        className,
      )}
      data-slot={slot}
    >
      {children}
    </div>
  );
}

/**
 * Render the sticky title bar above a separate toolbar, with filters left and
 * actions right. Breadcrumbs include the current h1; otherwise render title.
 * Keep the final breadcrumb and title consistent. Lead and eyebrow belong
 * below the bar.
 * A display:contents header groups title and controls semantically while
 * allowing both rows to participate in the page layout.
 */
export function PageHeader({
  eyebrow,
  title,
  lead,
  action,
  topbarAction,
  toolbar,
  breadcrumbs,
}: {
  readonly eyebrow?: string;
  readonly title: string;
  readonly lead?: ReactNode;
  readonly action?: ReactNode;
  /** An exceptional record action aligned with the current breadcrumb. */
  readonly topbarAction?: ReactNode;
  /** What this page filters or searches by, at the left of the toolbar row. */
  readonly toolbar?: ReactNode;
  /** Parent links and the current page, in that order. */
  readonly breadcrumbs?: PageNavigationItems;
}) {
  /*
   * A page that draws a real trail does not also draw the label above it: the
   * breadcrumb already says which section this record is in, and saying it
   * twice is the thing this suppression has always been for.
   */
  const label = breadcrumbs === undefined ? eyebrow : undefined;
  const hasBlock =
    toolbar !== undefined ||
    action !== undefined ||
    lead !== undefined ||
    label !== undefined;

  return (
    /*
     * `peer`, so the body under this header can read whether a toolbar row was
     * drawn. See `PageBody`: the toolbar row carries the gap to whatever comes
     * next, and a body that added its own would double it.
     */
    <header className="peer contents" data-slot="page-header">
      <div
        data-slot="page-topbar"
        className={cn(
          "sticky top-0 z-10 flex min-w-0 flex-none items-center",
          "h-(--topbar-height) border-b border-border bg-background",
          "px-(--page-gutter)",
          /*
           * Under the one layout breakpoint the page has a top bar of its own
           * already — the drawer button, the switcher and the account control
           * — so this stops being a bar and becomes the page's first line.
           */
          "max-[900px]:static max-[900px]:h-auto max-[900px]:flex-wrap",
          "max-[900px]:border-b-0 max-[900px]:px-4 max-[900px]:pt-4",
        )}
      >
        <PageContentFrame className="items-center gap-3" slot="page-topbar-content">
          {breadcrumbs === undefined ? (
            /* A heading carries no size of its own; the class is the size. */
            <h1 className="m-0 min-w-0 flex-1 truncate text-base font-medium">{title}</h1>
          ) : (
            /*
             * Straight through: the trail a page passes already ends with that
             * page, and `PageNavigationItems` is what holds it to that. There
             * is nothing here to rebuild.
             */
            <div className="min-w-0 flex-1">
              <PageNavigation items={breadcrumbs} />
            </div>
          )}
          {topbarAction === undefined ? null : (
            <div className="ml-auto flex flex-none items-center">{topbarAction}</div>
          )}
        </PageContentFrame>
      </div>

      {hasBlock ? (
        <div
          data-slot="page-toolbar"
          className={cn(
            "flex flex-none flex-col px-(--page-gutter) pt-(--page-gutter)",
            "max-[900px]:px-4 max-[900px]:pt-4",
          )}
        >
          <PageContentFrame className="flex-col" slot="page-toolbar-content">
            {label === undefined ? null : (
              <p
                className={cn(
                  "m-0 text-xs tracking-(--tracking-label) text-faint uppercase",
                  lead === undefined ? "" : "mb-1",
                )}
              >
                {label}
              </p>
            )}
            {lead === undefined ? null : (
              <p className="m-0 w-full max-w-[92ch] text-sm text-muted-foreground">
                {lead}
              </p>
            )}
            {(lead !== undefined || label !== undefined) &&
            (toolbar !== undefined || action !== undefined) ? (
              /* The gap to the toolbar row, when the block holds both. */
              <div className="h-4" aria-hidden="true" />
            ) : null}
            {toolbar === undefined && action === undefined ? null : (
              <Toolbar action={action}>{toolbar}</Toolbar>
            )}
          </PageContentFrame>
        </div>
      ) : null}
    </header>
  );
}

/**
 * Use the shared capped content frame. Remove the body's top gutter when the
 * toolbar already supplies separation. flex-1 min-h-0 lets viewport layouts
 * give the remaining height to their content.
 */
export function PageBody({ children }: { readonly children: ReactNode }) {
  return (
    <div
      className={cn(
        "flex min-w-0 flex-col px-(--page-gutter) pt-(--page-gutter) pb-10",
        "peer-has-[[data-slot=toolbar]]:pt-0",
        "max-[900px]:px-4 max-[900px]:pt-4 max-[900px]:pb-8",
        "max-[900px]:peer-has-[[data-slot=toolbar]]:pt-0",
      )}
      data-slot="page-body"
    >
      <PageContentFrame
        className="min-h-0 flex-1 flex-col"
        slot="page-body-content"
      >
        {children}
      </PageContentFrame>
    </div>
  );
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
