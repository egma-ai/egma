"use client";

import Image from "next/image";
import { useCallback, useEffect, useState, type ReactNode } from "react";

import styles from "./shells.module.css";

/**
 * PROTOTYPE ONLY: three application shells, switchable with `?shell=`, using
 * the same four real Egma page shapes. Variant C remains the brand direction;
 * this prototype answers only how the signed-in product should be framed.
 */

type Shell = "A" | "B" | "C";
type Screen = "home" | "transcripts" | "transcript" | "people";
type Theme = "light" | "dark";

const SHELLS: readonly Shell[] = ["A", "B", "C"];
const SHELL_NAMES: Record<Shell, string> = {
  A: "Context sidebar",
  B: "Top navigation",
  C: "Compact sidebar",
};
const SCREENS: readonly { id: Screen; label: string }[] = [
  { id: "home", label: "Home" },
  { id: "transcripts", label: "Transcripts" },
  { id: "transcript", label: "Transcript" },
  { id: "people", label: "People" },
];

const TRANSCRIPTS = [
  {
    id: "tr_01",
    when: "Today, 10:42",
    agent: "Suncrest receptionist",
    opening: "I need to move my cleaning to next Tuesday.",
    duration: "3m 18s",
    result: "Passed",
  },
  {
    id: "tr_02",
    when: "Today, 09:17",
    agent: "Patient intake",
    opening: "Do you take Horizon Gold insurance?",
    duration: "1m 44s",
    result: "Review",
  },
  {
    id: "tr_03",
    when: "Yesterday, 16:05",
    agent: "Suncrest receptionist",
    opening: "Can I book with Dr. Patel tomorrow afternoon?",
    duration: "2m 06s",
    result: "Failed",
  },
  {
    id: "tr_04",
    when: "Yesterday, 13:22",
    agent: "Renewals assistant",
    opening: "Why did the price of my plan change?",
    duration: "4m 51s",
    result: "Passed",
  },
] as const;

const EXCHANGE = [
  {
    speaker: "Human",
    time: "00:04",
    text: "Hi, I need to move my cleaning to next Tuesday.",
    meta: "speech · 3.8s",
  },
  {
    speaker: "Agent",
    time: "00:11",
    text: "I can help with that. What name is the appointment under?",
    meta: "model 420ms · speech 4.2s",
  },
  {
    speaker: "Human",
    time: "00:19",
    text: "Nora Bennett. It is currently booked for Friday at ten.",
    meta: "speech · 4.6s",
  },
  {
    speaker: "Agent",
    time: "00:28",
    text: "I found it. Dr. Patel has Tuesday at 9:30 or 2:00. Which works better?",
    meta: "find appointment · availability · model 510ms",
  },
] as const;

const PEOPLE = [
  { name: "Nischal Jain", email: "nischal@egma.ai", role: "Admin" },
  { name: "Maya Chen", email: "maya@egma.ai", role: "Member" },
  { name: "Sam Rivera", email: "sam@egma.ai", role: "Viewer" },
] as const;

export function ShellPrototype() {
  const [shell, setShell] = useState<Shell>("A");
  const [screen, setScreen] = useState<Screen>("home");
  const [theme, setTheme] = useState<Theme>("light");

  const writeQuery = useCallback(
    (nextShell: Shell, nextScreen: Screen, nextTheme: Theme): void => {
      const query = new URLSearchParams(globalThis.location.search);
      query.set("variant", "C");
      query.set("shell", nextShell);
      query.set("screen", nextScreen);
      query.set("theme", nextTheme);
      globalThis.history.replaceState(null, "", `?${query.toString()}`);
    },
    [],
  );

  useEffect(() => {
    const query = new URLSearchParams(globalThis.location.search);
    const askedShell = query.get("shell");
    const askedScreen = query.get("screen");
    const askedTheme = query.get("theme");
    const nextShell = SHELLS.includes(askedShell as Shell)
      ? (askedShell as Shell)
      : "A";
    const nextScreen = SCREENS.some((one) => one.id === askedScreen)
      ? (askedScreen as Screen)
      : "home";
    const nextTheme = askedTheme === "dark" ? "dark" : "light";
    setShell(nextShell);
    setScreen(nextScreen);
    setTheme(nextTheme);
    writeQuery(nextShell, nextScreen, nextTheme);
  }, [writeQuery]);

  const chooseShell = useCallback(
    (next: Shell): void => {
      setShell(next);
      writeQuery(next, screen, theme);
    },
    [screen, theme, writeQuery],
  );

  function chooseScreen(next: Screen): void {
    setScreen(next);
    writeQuery(shell, next, theme);
  }

  function chooseTheme(next: Theme): void {
    setTheme(next);
    writeQuery(shell, screen, next);
  }

  const cycle = useCallback(
    (by: -1 | 1): void => {
      const at = SHELLS.indexOf(shell);
      chooseShell(SHELLS[(at + by + SHELLS.length) % SHELLS.length] ?? "A");
    },
    [chooseShell, shell],
  );

  useEffect(() => {
    function onKey(event: KeyboardEvent): void {
      const target = event.target as HTMLElement | null;
      if (
        target?.matches("input, textarea, select, button, [contenteditable='true']")
      ) {
        return;
      }
      if (event.key === "ArrowLeft") cycle(-1);
      if (event.key === "ArrowRight") cycle(1);
    }
    globalThis.addEventListener("keydown", onKey);
    return () => globalThis.removeEventListener("keydown", onKey);
  }, [cycle]);

  return (
    <div className={`${styles.prototype} ${styles[theme]}`}>
      <ShellFrame
        shell={shell}
        screen={screen}
        theme={theme}
        onScreen={chooseScreen}
        onTheme={chooseTheme}
      >
        <ScreenContent screen={screen} onScreen={chooseScreen} />
      </ShellFrame>
      <PrototypeControls
        shell={shell}
        screen={screen}
        onBack={() => cycle(-1)}
        onNext={() => cycle(1)}
        onScreen={chooseScreen}
      />
    </div>
  );
}

function Brand() {
  return (
    <Image
      className={styles.logo}
      src="/prototype/egma-logo.png"
      alt="egma"
      width={146}
      height={31}
      priority
    />
  );
}

function ThemeButton({
  theme,
  onTheme,
}: {
  theme: Theme;
  onTheme: (theme: Theme) => void;
}) {
  return (
    <button
      className={styles.iconButton}
      type="button"
      aria-label={`Use ${theme === "light" ? "dark" : "light"} theme`}
      onClick={() => onTheme(theme === "light" ? "dark" : "light")}
    >
      <span aria-hidden="true">{theme === "light" ? "◐" : "◑"}</span>
    </button>
  );
}

function Nav({
  active,
  onScreen,
  compact = false,
}: {
  active: Screen;
  onScreen: (screen: Screen) => void;
  compact?: boolean;
}) {
  const items: readonly { id: Screen; label: string; index: string }[] = [
    { id: "home", label: "Home", index: "01" },
    { id: "transcripts", label: "Transcripts", index: "02" },
    { id: "people", label: "People", index: "03" },
  ];
  return (
    <nav className={compact ? styles.compactNav : styles.nav} aria-label="Main">
      {items.map((item) => {
        const selected =
          active === item.id ||
          (item.id === "transcripts" && active === "transcript");
        return (
          <button
            key={item.id}
            type="button"
            className={selected ? styles.activeNav : undefined}
            aria-current={selected ? "page" : undefined}
            onClick={() => onScreen(item.id)}
          >
            {compact ? <span>{item.index}</span> : null}
            {item.label}
          </button>
        );
      })}
    </nav>
  );
}

function ShellFrame({
  shell,
  screen,
  theme,
  onScreen,
  onTheme,
  children,
}: {
  shell: Shell;
  screen: Screen;
  theme: Theme;
  onScreen: (screen: Screen) => void;
  onTheme: (theme: Theme) => void;
  children: ReactNode;
}) {
  if (shell === "A") {
    return (
      <div className={styles.shellA}>
        <aside className={styles.contextSidebar}>
          <Brand />
          <div className={styles.contextBlock}>
            <span>Organization</span>
            <strong>Suncrest Dental</strong>
            <small>Default project</small>
          </div>
          <Nav active={screen} onScreen={onScreen} />
          <div className={styles.sidebarFooter}>
            <span className={styles.health}>● System healthy</span>
            <div className={styles.userLine}>
              <span className={styles.avatar}>NJ</span>
              <span>Nischal</span>
              <ThemeButton theme={theme} onTheme={onTheme} />
            </div>
          </div>
        </aside>
        <div className={styles.shellBody}>
          <header className={styles.mobileHeader}>
            <Brand />
            <ThemeButton theme={theme} onTheme={onTheme} />
          </header>
          <div className={styles.mobileNav}>
            <Nav active={screen} onScreen={onScreen} />
          </div>
          {children}
        </div>
      </div>
    );
  }

  if (shell === "B") {
    return (
      <div className={styles.shellB}>
        <header className={styles.topBar}>
          <Brand />
          <Nav active={screen} onScreen={onScreen} />
          <div className={styles.topContext}>
            <span>Suncrest Dental</span>
            <span className={styles.projectPill}>Default</span>
            <ThemeButton theme={theme} onTheme={onTheme} />
            <span className={styles.avatar}>NJ</span>
          </div>
        </header>
        <div className={styles.topMobileNav}>
          <Nav active={screen} onScreen={onScreen} />
        </div>
        {children}
      </div>
    );
  }

  return (
    <div className={styles.shellC}>
      <aside className={styles.compactSidebar}>
        <Brand />
        <Nav active={screen} onScreen={onScreen} compact />
        <div className={styles.compactFooter}>
          <ThemeButton theme={theme} onTheme={onTheme} />
          <span className={styles.avatar}>NJ</span>
        </div>
      </aside>
      <div className={styles.shellBody}>
        <header className={styles.contextHeader}>
          <div>
            <span>Suncrest Dental</span>
            <strong>Default project</strong>
          </div>
          <span className={styles.health}>● System healthy</span>
        </header>
        <header className={styles.mobileHeader}>
          <Brand />
          <ThemeButton theme={theme} onTheme={onTheme} />
        </header>
        {children}
        <div className={styles.bottomMobileNav}>
          <Nav active={screen} onScreen={onScreen} compact />
        </div>
      </div>
    </div>
  );
}

function ScreenContent({
  screen,
  onScreen,
}: {
  screen: Screen;
  onScreen: (screen: Screen) => void;
}) {
  if (screen === "home") return <HomeScreen onScreen={onScreen} />;
  if (screen === "transcripts") return <TranscriptsScreen onScreen={onScreen} />;
  if (screen === "transcript") return <TranscriptScreen onScreen={onScreen} />;
  return <PeopleScreen />;
}

function Page({ children, wide = false }: { children: ReactNode; wide?: boolean }) {
  return <main className={`${styles.page} ${wide ? styles.pageWide : ""}`}>{children}</main>;
}

function Eyebrow({ children }: { children: ReactNode }) {
  return <p className={styles.eyebrow}>{children}</p>;
}

function HomeScreen({ onScreen }: { onScreen: (screen: Screen) => void }) {
  return (
    <Page>
      <header className={styles.hero}>
        <Eyebrow>Default project</Eyebrow>
        <h1>Trust starts with what happened.</h1>
        <p>Read the real exchange before you decide what your agent can do next.</p>
      </header>

      <section className={styles.homeGrid}>
        <button type="button" onClick={() => onScreen("transcripts")}>
          <span className={styles.cardIndex}>01 / PRIMARY</span>
          <strong>Read recent transcripts</strong>
          <p>Inspect each exchange, its tools, timing, and errors.</p>
          <span className={styles.arrow}>→</span>
        </button>
        <button type="button" onClick={() => onScreen("people")}>
          <span className={styles.cardIndex}>02 / ORGANIZATION</span>
          <strong>Manage your people</strong>
          <p>Invite a teammate or review who can change this organization.</p>
          <span className={styles.arrow}>→</span>
        </button>
      </section>

      <section className={styles.contextFacts} aria-label="Current context">
        <div><span>Organization</span><strong>Suncrest Dental</strong></div>
        <div><span>Project</span><strong>Default</strong></div>
        <div><span>Your role</span><strong>Admin</strong></div>
      </section>
    </Page>
  );
}

function TranscriptsScreen({ onScreen }: { onScreen: (screen: Screen) => void }) {
  return (
    <Page wide>
      <header className={styles.pageHeader}>
        <div>
          <Eyebrow>Default project</Eyebrow>
          <h1>Transcripts</h1>
          <p>What your agents did, newest first.</p>
        </div>
        <label className={styles.selectLabel}>
          <span>Window</span>
          <select defaultValue="24h">
            <option value="1h">Last hour</option>
            <option value="24h">Last 24 hours</option>
            <option value="7d">Last 7 days</option>
          </select>
        </label>
      </header>

      <section className={styles.listSection}>
        <div className={styles.listMeta}>
          <span>Showing 4 recent transcripts</span>
          <span>Newest first</span>
        </div>
        <div className={styles.tableWrap}>
          <table>
            <thead><tr><th>Started</th><th>Agent</th><th>First human line</th><th>Duration</th><th>Result</th></tr></thead>
            <tbody>
              {TRANSCRIPTS.map((row) => (
                <tr key={row.id}>
                  <td><button type="button" className={styles.textLink} onClick={() => onScreen("transcript")}>{row.when}</button></td>
                  <td>{row.agent}</td><td>{row.opening}</td><td>{row.duration}</td>
                  <td><Status value={row.result} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className={styles.mobileRows}>
          {TRANSCRIPTS.map((row) => (
            <button key={row.id} type="button" onClick={() => onScreen("transcript")}>
              <span>{row.when}<Status value={row.result} /></span>
              <strong>{row.agent}</strong><p>{row.opening}</p><small>{row.duration}</small>
            </button>
          ))}
        </div>
      </section>
    </Page>
  );
}

function Status({ value }: { value: string }) {
  return <span className={`${styles.status} ${styles[value.toLowerCase()]}`}>{value}</span>;
}

function TranscriptScreen({ onScreen }: { onScreen: (screen: Screen) => void }) {
  return (
    <Page>
      <button type="button" className={styles.backLink} onClick={() => onScreen("transcripts")}>← All transcripts</button>
      <header className={styles.detailHeader}>
        <div><Eyebrow>Passed / Production</Eyebrow><h1>Suncrest receptionist</h1><p>Today, 10:42 · 3m 18s</p></div>
        <Status value="Passed" />
      </header>
      <section className={styles.detailFacts} aria-label="Transcript facts">
        <div><span>Turns</span><strong>12</strong></div>
        <div><span>Tools</span><strong>3</strong></div>
        <div><span>Errors</span><strong>0</strong></div>
        <div><span>Source</span><strong>Retell</strong></div>
      </section>
      <section className={styles.exchange}>
        <h2>The exchange</h2>
        {EXCHANGE.map((turn, index) => (
          <details key={`${turn.time}-${turn.speaker}`} open={index === 1}>
            <summary>
              <span className={styles.speaker}>{turn.speaker}</span>
              <span className={styles.turnText}>{turn.text}</span>
              <span className={styles.plus}>+</span>
            </summary>
            <p>{turn.time} · {turn.meta}</p>
          </details>
        ))}
      </section>
    </Page>
  );
}

function PeopleScreen() {
  return (
    <Page>
      <header className={styles.pageHeader}>
        <div><Eyebrow>Organization</Eyebrow><h1>People</h1><p>Everybody in Suncrest Dental.</p></div>
        <button className={styles.primaryButton} type="button">Invite somebody</button>
      </header>
      <section className={styles.peopleList}>
        {PEOPLE.map((person) => (
          <article key={person.email}>
            <span className={styles.personInitial}>{person.name.slice(0, 1)}</span>
            <div><strong>{person.name}</strong><p>{person.email}</p></div>
            <select aria-label={`${person.name}'s role`} defaultValue={person.role.toLowerCase()}>
              <option value="admin">Admin</option><option value="member">Member</option><option value="viewer">Viewer</option>
            </select>
            <button className={styles.moreButton} type="button" aria-label={`More actions for ${person.name}`}>•••</button>
          </article>
        ))}
      </section>
      <section className={styles.invitePanel}>
        <div><Eyebrow>Invite</Eyebrow><h2>Add somebody to this organization</h2><p>If email is not configured, Egma gives you a one-time link to send yourself.</p></div>
        <form onSubmit={(event) => event.preventDefault()}>
          <label><span>Email</span><input type="email" placeholder="name@company.com" /></label>
          <label><span>Role</span><select defaultValue="member"><option value="admin">Admin</option><option value="member">Member</option><option value="viewer">Viewer</option></select></label>
          <button className={styles.primaryButton} type="submit">Send invitation</button>
        </form>
      </section>
    </Page>
  );
}

function PrototypeControls({
  shell,
  screen,
  onBack,
  onNext,
  onScreen,
}: {
  shell: Shell;
  screen: Screen;
  onBack: () => void;
  onNext: () => void;
  onScreen: (screen: Screen) => void;
}) {
  return (
    <div className={styles.prototypeControls} aria-label="Prototype controls">
      <button type="button" onClick={onBack} aria-label="Previous shell">←</button>
      <strong>{shell} — {SHELL_NAMES[shell]}</strong>
      <div className={styles.screenTabs}>
        {SCREENS.map((one) => (
          <button key={one.id} type="button" className={screen === one.id ? styles.selectedTab : undefined} onClick={() => onScreen(one.id)}>{one.label}</button>
        ))}
      </div>
      <button type="button" onClick={onNext} aria-label="Next shell">→</button>
    </div>
  );
}
