"use client";

import Image from "next/image";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import styles from "./prototype.module.css";

type Variant = "A" | "B" | "C";
type PrototypeScreen = "sign-in" | "transcripts" | "transcript";
type Theme = "dark" | "light";

// Locked prototype decision: C — Trust gate.
const LOCKED_VARIANT: Variant = "C";
const SCREENS: readonly { id: PrototypeScreen; label: string }[] = [
  { id: "sign-in", label: "Sign in" },
  { id: "transcripts", label: "Transcripts" },
  { id: "transcript", label: "Transcript" },
];

const VARIANT_NAMES: Record<Variant, string> = {
  A: "Conversation turns",
  B: "Tool trace",
  C: "Trust gate",
};

const PARTICLE_STORIES: Record<
  Variant,
  { eyebrow: string; statement: string; labels: readonly [string, string, string] }
> = {
  A: {
    eyebrow: "CONVERSATION TRACE",
    statement: "Every turn between human and agent becomes a path you can inspect.",
    labels: ["HUMAN", "6 TURNS", "AGENT"],
  },
  B: {
    eyebrow: "TOOL TRACE",
    statement: "Every tool call leaves, returns, and records a result.",
    labels: ["AGENT", "CALL / RETURN", "TOOLS"],
  },
  C: {
    eyebrow: "TRUST GATE",
    statement: "Raw behavior passes checks before it earns trust.",
    labels: ["OBSERVE", "TEST", "TRUST"],
  },
};

const TRANSCRIPTS = [
  {
    id: "tr_01",
    when: "Today, 10:42",
    agent: "Suncrest receptionist",
    opening: "I need to move my cleaning to next Tuesday.",
    duration: "3m 18s",
    turns: "12",
    tools: "3",
    result: "Passed",
    tone: "good",
  },
  {
    id: "tr_02",
    when: "Today, 09:17",
    agent: "Patient intake",
    opening: "Do you take Horizon Gold insurance?",
    duration: "1m 44s",
    turns: "8",
    tools: "1",
    result: "Review",
    tone: "warn",
  },
  {
    id: "tr_03",
    when: "Yesterday, 16:05",
    agent: "Suncrest receptionist",
    opening: "Can I book with Dr. Patel tomorrow afternoon?",
    duration: "2m 06s",
    turns: "10",
    tools: "2",
    result: "Failed",
    tone: "bad",
  },
  {
    id: "tr_04",
    when: "Yesterday, 13:22",
    agent: "Renewals assistant",
    opening: "Why did the price of my plan change?",
    duration: "4m 51s",
    turns: "18",
    tools: "4",
    result: "Passed",
    tone: "good",
  },
] as const;

const EXCHANGE = [
  {
    speaker: "human",
    time: "00:04",
    text: "Hi, I need to move my cleaning to next Tuesday.",
    meta: "speech · 3.8s",
  },
  {
    speaker: "agent",
    time: "00:11",
    text: "I can help with that. What name is the appointment under?",
    meta: "model 420ms · speech 4.2s",
  },
  {
    speaker: "human",
    time: "00:19",
    text: "Nora Bennett. It is currently booked for Friday at ten.",
    meta: "speech · 4.6s",
  },
  {
    speaker: "agent",
    time: "00:28",
    text: "I found it. Dr. Patel has Tuesday at 9:30 or 2:00. Which works better?",
    meta: "find appointment · availability · model 510ms",
  },
  {
    speaker: "human",
    time: "00:41",
    text: "Two o’clock, please.",
    meta: "speech · 1.7s",
  },
  {
    speaker: "agent",
    time: "00:47",
    text: "Done. Your cleaning is now Tuesday at 2:00 PM with Dr. Patel.",
    meta: "reschedule appointment · model 390ms · speech 5.1s",
  },
] as const;

export function DesignSystemPrototype() {
  const [screen, setScreen] = useState<PrototypeScreen>("sign-in");
  const [theme, setTheme] = useState<Theme>("light");
  const variant = LOCKED_VARIANT;

  useEffect(() => {
    const query = new URLSearchParams(globalThis.location.search);
    const askedScreen = query.get("screen");
    let nextScreen: PrototypeScreen = "sign-in";
    if (
      askedScreen === "sign-in" ||
      askedScreen === "transcripts" ||
      askedScreen === "transcript"
    ) {
      nextScreen = askedScreen;
    }
    setScreen(nextScreen);
    query.set("variant", LOCKED_VARIANT);
    query.set("screen", nextScreen);
    globalThis.history.replaceState(null, "", `?${query.toString()}`);
  }, []);

  function remember(nextScreen: PrototypeScreen): void {
    setScreen(nextScreen);
    const query = new URLSearchParams(globalThis.location.search);
    query.set("variant", LOCKED_VARIANT);
    query.set("screen", nextScreen);
    globalThis.history.replaceState(null, "", `?${query.toString()}`);
  }

  const direction = (
    <SignalVariant
      variant={variant}
      screen={screen}
      theme={theme}
      setTheme={setTheme}
    />
  );

  return (
    <div className={`${styles.prototype} ${styles[theme]}`}>
      {direction}
      <PrototypeSwitcher
        screen={screen}
        onScreen={remember}
      />
    </div>
  );
}

function SignalVariant({
  variant,
  screen,
  theme,
  setTheme,
}: VariantProps & { variant: Variant }) {
  const story = PARTICLE_STORIES[variant];

  if (screen === "sign-in") {
    return (
      <div className={styles.signalAuth}>
        <ParticlePanel variant={variant}>
          <Brand />
          <div className={styles.particleLegend} aria-hidden="true">
            {story.labels.map((label) => <span key={label}>{label}</span>)}
          </div>
          <div className={styles.visualStatement}>
            <Eyebrow>{story.eyebrow}</Eyebrow>
            <p>{story.statement}</p>
          </div>
        </ParticlePanel>
        <section className={styles.signalFormPanel}>
          <ThemeButton theme={theme} setTheme={setTheme} />
          <SignInForm heading="Trust starts with what happened." />
        </section>
      </div>
    );
  }

  return (
    <div className={styles.signalApp}>
      <SignalRail active={screen} />
      <main className={styles.signalMain}>
        <TopActions theme={theme} setTheme={setTheme} />
        {screen === "transcripts" ? (
          <>
            <div className={styles.signalHero}>
              <div>
                <Eyebrow>DEFAULT PROJECT</Eyebrow>
                <h1>Transcripts</h1>
                <p>What your agents did, newest first.</p>
              </div>
              <div className={styles.signalMiniField}>
                <TraceField variant={variant} />
                <span>14 exchanges today · 92% passed</span>
              </div>
            </div>
            <TranscriptTable mode="signal" />
          </>
        ) : (
          <SignalTranscript />
        )}
      </main>
    </div>
  );
}

function LedgerVariant({
  screen,
  theme,
  setTheme,
}: VariantProps) {
  return (
    <div className={styles.ledger}>
      <header className={styles.ledgerHeader}>
        <Brand />
        <LedgerNav active={screen} />
        <ThemeButton theme={theme} setTheme={setTheme} />
      </header>
      {screen === "sign-in" ? (
        <main className={styles.ledgerAuth}>
          <div className={styles.ledgerIntro}>
            <Eyebrow>EGMA / ACCESS</Eyebrow>
            <h1>Inspect the evidence.<br />Ship with confidence.</h1>
            <p>
              A precise record of every turn, tool, delay, and failure in your
              voice agents.
            </p>
          </div>
          <div className={styles.ledgerStrip}>
            <TraceField variant="B" />
            <div className={styles.ledgerScale}>
              <span>HUMAN</span><span>AGENT</span><span>TOOLS</span><span>VERDICT</span>
            </div>
          </div>
          <div className={styles.ledgerFormWrap}>
            <SignInForm heading="Sign in" />
          </div>
        </main>
      ) : screen === "transcripts" ? (
        <main className={styles.ledgerMain}>
          <PageHeading
            eyebrow="PROJECT / DEFAULT / LIVE RECORD"
            title="Transcripts"
            lead="All recorded exchanges in the selected window."
          />
          <LedgerSummary />
          <TranscriptTable mode="ledger" />
        </main>
      ) : (
        <main className={styles.ledgerMain}>
          <LedgerTranscript />
        </main>
      )}
    </div>
  );
}

function StageVariant({
  screen,
  theme,
  setTheme,
}: VariantProps) {
  return (
    <div className={styles.stage}>
      <div className={styles.stageField}><TraceField variant="C" /></div>
      <header className={styles.stageHeader}>
        <Brand />
        <div className={styles.stageNav}>
          {screen === "sign-in" ? "ACCESS" : screen === "transcripts" ? "INDEX" : "EXCHANGE"}
        </div>
        <ThemeButton theme={theme} setTheme={setTheme} />
      </header>
      {screen === "sign-in" ? (
        <main className={styles.stageAuth}>
          <div className={styles.stageClaim}>
            <Eyebrow>OBSERVE / TEST / TRUST</Eyebrow>
            <h1>The voice agent<br />does not get the last word.</h1>
          </div>
          <div className={styles.stagePaper}>
            <SignInForm heading="Enter Egma" />
          </div>
        </main>
      ) : screen === "transcripts" ? (
        <main className={styles.stageMain}>
          <div className={styles.stageTitle}>
            <Eyebrow>DEFAULT PROJECT / LAST 24 HOURS</Eyebrow>
            <h1>Four exchanges need your attention.</h1>
          </div>
          <StageTranscriptCards />
        </main>
      ) : (
        <main className={styles.stageMain}>
          <StageTranscript />
        </main>
      )}
    </div>
  );
}

type VariantProps = {
  screen: PrototypeScreen;
  theme: Theme;
  setTheme: (theme: Theme) => void;
};

function Brand() {
  return (
    <div className={styles.brand}>
      <Image
        className={styles.brandLogo}
        src="/prototype/egma-logo.png"
        width={1368}
        height={379}
        alt="Egma"
        priority
      />
    </div>
  );
}

function Eyebrow({ children }: { children: ReactNode }) {
  return <div className={styles.eyebrow}>{children}</div>;
}

function SignInForm({ heading }: { heading: string }) {
  return (
    <div className={styles.signIn}>
      <Eyebrow>WELCOME BACK</Eyebrow>
      <h2>{heading}</h2>
      <p>Sign in to continue to your organization.</p>
      <form onSubmit={(event) => event.preventDefault()}>
        <label htmlFor="prototype-email">
          <span>Email</span>
          <input id="prototype-email" type="email" placeholder="you@company.com" />
        </label>
        <label htmlFor="prototype-password">
          <span>Password</span>
          <input id="prototype-password" type="password" placeholder="••••••••" />
        </label>
        <button type="submit">Sign in</button>
        <small><kbd>⌘</kbd><kbd>↵</kbd> to submit</small>
      </form>
      <p className={styles.formFoot}>No account yet? <a href="#setup">Set up egma</a></p>
    </div>
  );
}

function ThemeButton({ theme, setTheme }: Pick<VariantProps, "theme" | "setTheme">) {
  return (
    <button
      type="button"
      className={styles.themeButton}
      aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} mode`}
      onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
    >
      {theme === "dark" ? "☼" : "◐"}
    </button>
  );
}

function TopActions({ theme, setTheme }: Pick<VariantProps, "theme" | "setTheme">) {
  return (
    <div className={styles.topActions}>
      <span>Suncrest Dental / Default</span>
      <ThemeButton theme={theme} setTheme={setTheme} />
      <button type="button" className={styles.avatar} aria-label="Open account menu for NJ">NJ</button>
    </div>
  );
}

function SignalRail({ active }: { active: PrototypeScreen }) {
  return (
    <aside className={styles.signalRail}>
      <Brand />
      <nav>
        <a href="#transcripts" className={active === "transcripts" ? styles.active : undefined}>Transcripts</a>
        <a href="#runs">Runs</a><a href="#tests">Tests</a><a href="#agents">Agents</a>
        <span>MANAGE</span>
        <a href="#people">People</a><a href="#keys">Keys</a>
      </nav>
      <div className={styles.railFoot}><span className={styles.liveDot} /> System healthy</div>
    </aside>
  );
}

function LedgerNav({ active }: { active: PrototypeScreen }) {
  return (
    <nav className={styles.ledgerNav}>
      <a href="#transcripts" className={active === "transcripts" ? styles.active : undefined}>TRANSCRIPTS</a>
      <a href="#runs">RUNS</a><a href="#tests">TESTS</a><a href="#people">PEOPLE</a>
    </nav>
  );
}

function PageHeading({ eyebrow, title, lead }: { eyebrow: string; title: string; lead: string }) {
  return (
    <header className={styles.pageHeading}>
      <Eyebrow>{eyebrow}</Eyebrow><h1>{title}</h1><p>{lead}</p>
      <div className={styles.windowControl}>WINDOW <strong>LAST 24 HOURS⌄</strong></div>
    </header>
  );
}

function TranscriptTable({ mode }: { mode: "signal" | "ledger" }) {
  return (
    <section className={`${styles.transcriptTable} ${styles[mode]}`}>
      <div className={styles.tableToolbar}>
        <span>Showing {TRANSCRIPTS.length} recent transcripts</span>
        <button type="button">Filter <b>⌘K</b></button>
      </div>
      <div className={styles.tableScroll}>
        <table>
          <thead><tr><th>Started</th><th>Agent</th><th>First human line</th><th>Duration</th><th>Turns</th><th>Tools</th><th>Verdict</th></tr></thead>
          <tbody>
            {TRANSCRIPTS.map((row) => (
              <tr key={row.id}>
                <td><a href="#transcript">{row.when}</a></td>
                <td>{row.agent}</td><td>{row.opening}</td><td>{row.duration}</td>
                <td>{row.turns}</td><td>{row.tools}</td>
                <td><Status tone={row.tone}>{row.result}</Status></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function Status({ tone, children }: { tone: string; children: ReactNode }) {
  return <span className={`${styles.status} ${styles[tone]}`}><i />{children}</span>;
}

function LedgerSummary() {
  return (
    <section className={styles.ledgerSummary}>
      <div><span>RECORDED</span><strong>148</strong><small>+12% this week</small></div>
      <div><span>PASSED</span><strong>136</strong><small>91.8% of total</small></div>
      <div><span>NEEDS REVIEW</span><strong>09</strong><small>6 tool failures</small></div>
      <div className={styles.summaryField}><TraceField variant="B" /></div>
    </section>
  );
}

function DetailFacts({ compact = false }: { compact?: boolean }) {
  const facts = [
    ["Started", "Today, 10:42:08"], ["Duration", "3m 18s"],
    ["Turns", "12"], ["Tools", "3"], ["Errors", "0"],
    ["Source", "Retell"], ["Environment", "Production"],
  ];
  return (
    <dl className={compact ? styles.compactFacts : styles.detailFacts}>
      {facts.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}
    </dl>
  );
}

function Exchange({ numbered = false }: { numbered?: boolean }) {
  return (
    <section className={styles.exchange}>
      {EXCHANGE.map((turn, index) => (
        <article key={`${turn.time}-${turn.speaker}`} className={styles.turn}>
          {numbered ? <b className={styles.turnNumber}>{String(index + 1).padStart(2, "0")}</b> : null}
          <div className={styles.turnSpeaker}>{turn.speaker}</div>
          <div><p>{turn.text}</p><small>{turn.time} · {turn.meta}</small></div>
          <button type="button" aria-label={`Open ${turn.speaker} turn details`}>＋</button>
        </article>
      ))}
    </section>
  );
}

function SignalTranscript() {
  return (
    <div className={styles.signalDetail}>
      <header><a href="#transcripts">← All transcripts</a><Eyebrow>PASSED / PRODUCTION</Eyebrow><h1>Suncrest receptionist</h1><p>Today, 10:42 · 3m 18s</p></header>
      <aside><div className={styles.detailField}><TraceField variant="A" /></div><DetailFacts /></aside>
      <div className={styles.exchangeColumn}><h2>The exchange</h2><Exchange /></div>
    </div>
  );
}

function LedgerTranscript() {
  return (
    <>
      <PageHeading eyebrow="TRANSCRIPT / TR_01 / PASSED" title="Suncrest receptionist" lead="Today, 10:42 · Production · Retell" />
      <div className={styles.ledgerDetail}>
        <aside><DetailFacts compact /><div className={styles.detailField}><TraceField variant="B" /></div></aside>
        <div><div className={styles.sectionLabel}>THE EXCHANGE / 12 TURNS</div><Exchange numbered /></div>
      </div>
    </>
  );
}

function StageTranscriptCards() {
  return (
    <section className={styles.stageCards}>
      {TRANSCRIPTS.map((row, index) => (
        <article key={row.id} className={index === 0 ? styles.featuredCard : undefined}>
          <div className={styles.cardIndex}>{String(index + 1).padStart(2, "0")}</div>
          <div><Status tone={row.tone}>{row.result}</Status><h2>{row.opening}</h2><p>{row.agent}</p></div>
          <dl><div><dt>WHEN</dt><dd>{row.when}</dd></div><div><dt>LENGTH</dt><dd>{row.duration}</dd></div><div><dt>TOOLS</dt><dd>{row.tools}</dd></div></dl>
          <button type="button">Open ↗</button>
        </article>
      ))}
    </section>
  );
}

function StageTranscript() {
  return (
    <div className={styles.stageDetail}>
      <header><a href="#transcripts">← Index</a><Status tone="good">Passed</Status><h1>“I need to move my cleaning to next Tuesday.”</h1><p>Suncrest receptionist · Today, 10:42</p></header>
      <div className={styles.stageDetailBody}><aside><DetailFacts compact /></aside><Exchange numbered /></div>
    </div>
  );
}

function ParticlePanel({ variant, children }: { variant: Variant; children: ReactNode }) {
  return (
    <aside className={styles.particlePanel}>
      <TraceField variant={variant} />
      <div className={styles.particleOverlay}>{children}</div>
    </aside>
  );
}

type Dot = {
  lane: number;
  phase: number;
  progress: number;
  size: number;
  alpha: number;
  drift: number;
};

function TraceField({ variant }: { variant: Variant }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const seed = useMemo(() => variant.charCodeAt(0) * 997, [variant]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null) return undefined;
    const context = canvas.getContext("2d");
    if (context === null) return undefined;
    const canvasElement = canvas;
    const drawingContext = context;
    let frame = 0;
    let dots: Dot[] = [];
    let width = 0;
    let height = 0;
    let visible = true;
    const reduced = globalThis.matchMedia("(prefers-reduced-motion: reduce)").matches;

    function randomAt(index: number): number {
      const value = Math.sin(seed + index * 12.9898) * 43758.5453;
      return value - Math.floor(value);
    }

    function build(): void {
      const count = Math.min(1100, Math.max(560, Math.floor((width * height) / 900)));
      dots = Array.from({ length: count }, (_, index) => {
        return {
          lane: index % 6,
          phase: randomAt(index + 199) * Math.PI * 2,
          progress: randomAt(index + 99),
          size: 0.5 + randomAt(index + 299) * 1.4,
          alpha: 0.18 + randomAt(index + 399) * 0.62,
          drift: 0.5 + randomAt(index + 499) * 2.2,
        };
      });
    }

    function resize(): void {
      const bounds = canvasElement.getBoundingClientRect();
      const ratio = Math.min(globalThis.devicePixelRatio, 2);
      width = bounds.width;
      height = bounds.height;
      canvasElement.width = Math.max(1, Math.floor(width * ratio));
      canvasElement.height = Math.max(1, Math.floor(height * ratio));
      drawingContext.setTransform(ratio, 0, 0, ratio, 0, 0);
      build();
    }

    function cubic(a: number, b: number, c: number, d: number, t: number): number {
      const inverse = 1 - t;
      return inverse ** 3 * a + 3 * inverse ** 2 * t * b + 3 * inverse * t ** 2 * c + t ** 3 * d;
    }

    function circle(x: number, y: number, radius: number): void {
      drawingContext.beginPath();
      drawingContext.arc(x, y, radius, 0, Math.PI * 2);
      drawingContext.stroke();
    }

    function draw(time: number): void {
      drawingContext.clearRect(0, 0, width, height);
      const ink = getComputedStyle(canvasElement).color;
      drawingContext.fillStyle = ink;
      drawingContext.strokeStyle = ink;
      drawingContext.lineWidth = 1;
      const seconds = reduced ? 0 : time / 1000;

      if (variant === "A") {
        const left = width * 0.17;
        const right = width * 0.83;
        drawingContext.globalAlpha = 0.14;
        for (let lane = 0; lane < 6; lane += 1) {
          const startY = height * (0.27 + lane * 0.074);
          const endY = height * (0.30 + lane * 0.074);
          const bend = (lane % 2 === 0 ? 1 : -1) * height * 0.075;
          drawingContext.beginPath();
          drawingContext.moveTo(left, startY);
          drawingContext.bezierCurveTo(
            width * 0.37,
            startY + bend,
            width * 0.63,
            endY + bend,
            right,
            endY,
          );
          drawingContext.stroke();
          circle(left, startY, 4);
          circle(right, endY, 4);
        }

        for (const dot of dots) {
          const lane = dot.lane;
          const travel = (dot.progress + seconds * (0.028 + dot.drift * 0.004)) % 1;
          const progress = lane % 2 === 0 ? travel : 1 - travel;
          const startY = height * (0.27 + lane * 0.074);
          const endY = height * (0.30 + lane * 0.074);
          const bend = (lane % 2 === 0 ? 1 : -1) * height * 0.075;
          const x = cubic(left, width * 0.37, width * 0.63, right, progress);
          const y = cubic(startY, startY + bend, endY + bend, endY, progress);
          const head = (seconds * 0.16) % 1;
          const distance = Math.min(Math.abs(travel - head), 1 - Math.abs(travel - head));
          const active = Math.max(0, 1 - distance / 0.065);
          drawingContext.globalAlpha = Math.min(0.96, dot.alpha * (0.52 + active * 1.5));
          drawingContext.beginPath();
          drawingContext.arc(x, y + Math.sin(dot.phase + seconds) * 2.5, dot.size * (1 + active), 0, Math.PI * 2);
          drawingContext.fill();
        }
      } else if (variant === "B") {
        const hubX = width * 0.31;
        const hubY = height * 0.47;
        const toolX = width * 0.79;
        const toolNames = ["find booking", "availability", "reschedule", "confirm"];
        drawingContext.globalAlpha = 0.16;
        drawingContext.beginPath();
        drawingContext.moveTo(hubX, height * 0.20);
        drawingContext.lineTo(hubX, height * 0.75);
        drawingContext.stroke();
        circle(hubX, hubY, 10);
        for (let lane = 0; lane < 4; lane += 1) {
          const toolY = height * (0.25 + lane * 0.15);
          drawingContext.beginPath();
          drawingContext.moveTo(hubX, hubY);
          drawingContext.bezierCurveTo(width * 0.46, hubY, width * 0.63, toolY, toolX, toolY);
          drawingContext.stroke();
          circle(toolX, toolY, 9);
        }
        drawingContext.globalAlpha = 0.42;
        drawingContext.font = "10px ui-monospace, SFMono-Regular, Menlo, monospace";
        drawingContext.textAlign = "left";
        toolNames.forEach((name, lane) => {
          drawingContext.fillText(name, toolX + 14, height * (0.25 + lane * 0.15) + 3);
        });

        for (const dot of dots) {
          const lane = dot.lane % 4;
          const cycle = (dot.progress + seconds * (0.036 + dot.drift * 0.004)) % 1;
          const outbound = cycle < 0.58;
          const progress = outbound ? cycle / 0.58 : 1 - (cycle - 0.58) / 0.42;
          const toolY = height * (0.25 + lane * 0.15);
          const x = cubic(hubX, width * 0.46, width * 0.63, toolX, progress);
          const y = cubic(hubY, hubY, toolY, toolY, progress);
          const result = outbound ? 0 : Math.sin(((cycle - 0.58) / 0.42) * Math.PI);
          drawingContext.globalAlpha = Math.min(0.96, dot.alpha * (0.5 + result * 1.2));
          drawingContext.beginPath();
          drawingContext.arc(x, y + Math.sin(dot.phase) * 3, dot.size * (1 + result * 0.7), 0, Math.PI * 2);
          drawingContext.fill();
        }
      } else {
        const centerY = height * 0.47;
        const startX = width * 0.10;
        const endX = width * 0.88;
        const gateProgress = [0.36, 0.61, 0.82];
        drawingContext.globalAlpha = 0.15;
        drawingContext.beginPath();
        drawingContext.moveTo(startX, centerY);
        drawingContext.lineTo(endX, centerY);
        drawingContext.stroke();
        gateProgress.forEach((progress, index) => {
          circle(startX + (endX - startX) * progress, centerY, 34 - index * 6);
        });
        circle(endX, centerY, 7);

        for (const dot of dots) {
          const progress = (dot.progress + seconds * (0.026 + dot.drift * 0.0035)) % 1;
          const x = startX + (endX - startX) * progress;
          const spread = (1 - progress) ** 2.15 * height * 0.27;
          const y = centerY + Math.sin(dot.phase * 1.7 + progress * 7) * spread;
          const gateEnergy = Math.max(
            ...gateProgress.map((gate) => Math.max(0, 1 - Math.abs(progress - gate) / 0.035)),
          );
          const trusted = Math.max(0, (progress - 0.78) / 0.22);
          drawingContext.globalAlpha = Math.min(0.96, dot.alpha * (0.42 + gateEnergy * 1.25 + trusted * 0.5));
          drawingContext.beginPath();
          drawingContext.arc(x, y, dot.size * (1 + gateEnergy * 0.85), 0, Math.PI * 2);
          drawingContext.fill();
        }
      }
      drawingContext.globalAlpha = 1;
      if (visible && !reduced) frame = globalThis.requestAnimationFrame(draw);
    }

    function onVisibility(): void {
      visible = document.visibilityState === "visible";
      if (visible && !reduced) frame = globalThis.requestAnimationFrame(draw);
      else globalThis.cancelAnimationFrame(frame);
    }

    const observer = new ResizeObserver(resize);
    observer.observe(canvasElement);
    document.addEventListener("visibilitychange", onVisibility);
    resize();
    frame = globalThis.requestAnimationFrame(draw);
    return () => {
      observer.disconnect();
      document.removeEventListener("visibilitychange", onVisibility);
      globalThis.cancelAnimationFrame(frame);
    };
  }, [seed, variant]);

  return <canvas ref={canvasRef} className={styles.traceField} aria-hidden="true" />;
}

function PrototypeSwitcher({
  screen,
  onScreen,
}: {
  screen: PrototypeScreen;
  onScreen: (screen: PrototypeScreen) => void;
}) {
  return (
    <div className={styles.prototypeSwitcher}>
      <div className={styles.screenTabs}>
        {SCREENS.map((one) => (
          <button
            key={one.id}
            type="button"
            aria-pressed={screen === one.id}
            className={screen === one.id ? styles.selected : undefined}
            onClick={() => onScreen(one.id)}
          >
            {one.label}
          </button>
        ))}
      </div>
      <div className={styles.variantControls}>
        <span aria-label="Selected particle concept">
          <b>{LOCKED_VARIANT}</b> — {VARIANT_NAMES[LOCKED_VARIANT]} · selected
        </span>
      </div>
    </div>
  );
}
