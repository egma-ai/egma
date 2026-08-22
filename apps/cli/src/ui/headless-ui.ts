/**
 * The wizard with nobody watching.
 *
 * Every gate opens straight away and every line is written as plain text. This
 * is what the offline tests drive, and it is what `--headless` gives a
 * developer who has said in the command itself that they want a run with
 * nobody watching. It is the same flow either way — there is no second code
 * path. Because every gate opens itself, nothing here may ever be reached
 * without that word from the developer: the gate is where consent is given,
 * and this UI answers it on their behalf.
 *
 * A gate carrying a value is different. Consent can be given in advance;
 * knowledge cannot. So an answer nobody supplied is `null`, and the flow takes
 * the branch it takes when a developer has nothing to add.
 */

import { loginLines, type LoginPrompt } from "../platform/login.ts";
import type { RetellAgent, RetellNumber } from "../retell/client.ts";
import {
  keyAskLines,
  NUMBER_ASK_LINE,
  REACH_ASK_LINE,
  REACH_LINES,
  type KeyAsk,
  type Reach,
} from "../retell/connect.ts";
import { simulationLine } from "../run/lines.ts";
import type { RunView } from "../run/view.ts";
import type { SkillPlaces } from "../skills/install.ts";
import type { Detection } from "../wizard/detection.ts";
import type { ExitReport } from "../wizard/exit-line.ts";
import type { TestGate } from "../wizard/gate.ts";
import type { GenerationProgress } from "../wizard/test-generation.ts";
import type { WizardPhase } from "../wizard/wizard-machine.ts";
import {
  GOAL_ASK_LINE,
  GOAL_LINES,
  type AskId,
  type CodingAgentChoice,
  type ConnectionAsk,
  type DrivenAgent,
  type GateId,
  type GoalAsk,
  type PlatformNotice,
  type WizardUI,
} from "./wizard-ui.ts";

export type HeadlessRecord = {
  phase: WizardPhase;
  drivenAgent: DrivenAgent | null;
  codingAgentChoices: CodingAgentChoice[];
  drivenAgentLog: string | null;
  /** Which egma this walk will use, as it was named before the gate. */
  platform: string | null;
  /** What egma worked out for itself before it asked anybody anything. */
  detection: Detection | null;
  logins: LoginPrompt[];
  /** The goal question, as it was put, when it was put at all. */
  goalAsk: GoalAsk | null;
  /** Every time a key was asked for, and what was said about it. */
  keyAsks: KeyAsk[];
  /** The agents a choice was offered between, when one was. */
  agentChoices: RetellAgent[];
  /** Whether the choice between text and phone was ever put to anybody. */
  reachOffered: boolean;
  /** The provider-safe options shown at that choice. */
  reachOptions: Reach[];
  /** The numbers a choice was offered between, when one was. */
  numberChoices: RetellNumber[];
  /** Provider fields shown, never the answers typed into them. */
  connectionAsks: ConnectionAsk[];
  statuses: string[];
  summary: string;
  /** Every test the coding agent said it had written, in the order it said so. */
  written: string[];
  /** The list that waited on one keystroke, when one did. */
  gate: TestGate | null;
  /** The run, as it stood the last time the flow said anything about it. */
  run: RunView | null;
  /** Where the skill was offered, when it was offered. */
  skillPlaces: SkillPlaces | null;
  exit: ExitReport | null;
  gatesOpened: GateId[];
  asked: AskId[];
};

export type HeadlessOptions = {
  /** Where plain lines go. Omit to keep the run silent. */
  readonly write?: (line: string) => void;
  /** What the developer would have said, for a run where nobody is asked. */
  readonly answers?: Partial<Readonly<Record<AskId, string>>>;
};

export class HeadlessUI implements WizardUI {
  readonly record: HeadlessRecord = {
    phase: "coding-agent",
    drivenAgent: null,
    codingAgentChoices: [],
    drivenAgentLog: null,
    platform: null,
    detection: null,
    logins: [],
    goalAsk: null,
    keyAsks: [],
    agentChoices: [],
    reachOffered: false,
    reachOptions: [],
    numberChoices: [],
    connectionAsks: [],
    statuses: [],
    summary: "",
    written: [],
    gate: null,
    run: null,
    skillPlaces: null,
    exit: null,
    gatesOpened: [],
    asked: [],
  };

  private readonly write: (line: string) => void;
  private readonly answers: Partial<Readonly<Record<AskId, string>>>;

  constructor(options: HeadlessOptions = {}) {
    this.write = options.write ?? (() => undefined);
    this.answers = options.answers ?? {};
  }

  readonly log = {
    info: (message: string): void => this.write(message),
    warn: (message: string): void => this.write(message),
    error: (message: string): void => this.write(message),
    success: (message: string): void => this.write(message),
  };

  setPhase(phase: WizardPhase): void {
    this.record.phase = phase;
  }

  setDrivenAgent(drivenAgent: DrivenAgent | null): void {
    this.record.drivenAgent = drivenAgent;
    if (drivenAgent !== null) this.write(`Coding agent: ${drivenAgent.name}`);
  }

  setCodingAgentChoices(agents: readonly CodingAgentChoice[]): void {
    this.record.codingAgentChoices = [...agents];
    for (const agent of agents) {
      this.write(`coding_agent: ${agent.id} ${agent.name} ${agent.version}`);
    }
  }

  setDrivenAgentLog(file: string): void {
    this.record.drivenAgentLog = file;
  }

  /**
   * Which egma, as one plain line, in the same place in the walk the wizard's
   * first screen says it.
   *
   * The same `url:` line every verb prints, from a run that has nobody to draw
   * a screen for: whoever reads this output afterwards can see which egma this
   * repository's identifiers were about to go to, before any of them went.
   */
  setPlatform(chosen: PlatformNotice | null): void {
    if (chosen === null) return;
    this.record.platform = chosen.url;
    this.write(`url: ${chosen.url}`);
  }

  /**
   * Kept, and never printed.
   *
   * This exists to fill a screen while a developer is away in a browser, and a
   * run with nobody watching has neither. It also lands whenever it lands —
   * nothing waits on it — so printing it would put lines in a promptless run's
   * output in an order that depends on how fast a disk answered, and one of
   * those orders is after the exit line.
   */
  setDetection(detection: Detection | null): void {
    this.record.detection = detection;
  }

  setLogin(prompt: LoginPrompt | null): void {
    if (prompt === null) return;
    this.record.logins.push(prompt);
    // The same lines `egma login` prints, from the same place, so the two
    // promptless surfaces cannot drift apart.
    for (const line of loginLines(prompt)) this.write(line);
  }

  /**
   * The offer, printed the same way the screen draws it.
   *
   * Printed even though nobody is here to answer it, so the output says which
   * lanes were on offer and what each of them meant.
   */
  setGoalAsk(ask: GoalAsk | null): void {
    if (ask === null) return;
    this.record.goalAsk = ask;
    this.write(GOAL_ASK_LINE);
    for (const goal of ask.goals) this.write(`goal_option: ${goal} ${GOAL_LINES[goal]}`);
  }

  setKeyAsk(ask: KeyAsk | null): void {
    if (ask === null) return;
    this.record.keyAsks.push(ask);
    // The same lines the wizard's screen draws, from the same place, so the two
    // promptless surfaces cannot drift apart. The key itself is never among
    // them: it is typed, not printed.
    for (const line of keyAskLines(ask)) this.write(line);
  }

  setAgentChoices(agents: readonly RetellAgent[] | null): void {
    if (agents === null) return;
    this.record.agentChoices = [...agents];
    for (const agent of agents) {
      this.write(`retell_agent: ${agent.id} ${agent.name}`.trimEnd());
    }
  }

  /**
   * The offer, printed the same way the screen draws it.
   *
   * It is printed even though nobody is here to answer it, so the output says
   * exactly which provider-safe paths were available.
   */
  setReachOffer(offered: readonly Reach[] | null): void {
    if (offered === null) return;
    this.record.reachOffered = true;
    this.record.reachOptions = [...offered];
    this.write(REACH_ASK_LINE);
    for (const way of offered) {
      this.write(`reach_option: ${way} ${REACH_LINES[way]}`);
    }
  }

  setNumberChoices(numbers: readonly RetellNumber[] | null): void {
    if (numbers === null) return;
    this.record.numberChoices = [...numbers];
    this.write(NUMBER_ASK_LINE);
    for (const number of numbers) {
      this.write(`retell_number: ${number.number} ${number.label}`.trimEnd());
    }
  }

  setConnectionAsk(ask: ConnectionAsk | null): void {
    if (ask === null) return;
    this.record.connectionAsks.push(ask);
    if (ask.problem != null) this.write(ask.problem);
    this.write(`${ask.label}${ask.required ? "" : " (optional)"}`);
    this.write(ask.help);
    if (ask.custody !== undefined) this.write(ask.custody);
    for (const choice of ask.choices ?? []) {
      this.write(`connection_option: ${choice.value} ${choice.label}`);
    }
  }

  /** Nobody is at this keyboard, so nothing is ever pasted at it. */
  takeLoginPaste(): string | null {
    return null;
  }

  waitForGate(gate: GateId): Promise<void> {
    this.record.gatesOpened.push(gate);
    return Promise.resolve();
  }

  waitForAnswer(ask: AskId): Promise<string | null> {
    this.record.asked.push(ask);
    return Promise.resolve(this.answers[ask] ?? null);
  }

  taskStarted(): void {
    this.write("Starting the coding agent.");
  }

  taskFinished(): void {
    this.write("The task is over.");
  }

  /**
   * A pane cannot be drawn where there is no screen, so what is printed is the
   * one thing that is news: a file that has just landed. Every other change is
   * the same list said again, and a run with nobody watching does not need it
   * said twice.
   */
  setGeneration(progress: GenerationProgress | null): void {
    if (progress === null) return;
    for (const test of progress.tests) {
      if (test.state !== "written" || this.record.written.includes(test.name)) continue;
      this.record.written.push(test.name);
      this.write(`written: ${test.name}`);
    }
  }

  /**
   * The list a screen would have shown, as lines something can read.
   *
   * What runs is named as well as what is being run, because agreeing to this
   * list is agreeing to use that connection: with nobody watching, consent was
   * given in the command, and the output is the only place it is ever written
   * down what that consent reached. A connection that dials says so and says
   * where, so a phone run's cost is on the record before the first simulation
   * rather than afterwards in somebody's carrier bill.
   */
  setGate(gate: TestGate | null): void {
    if (gate === null) return;
    this.record.gate = gate;
    for (const row of gate.rows) {
      this.write(`test: ${row.name} ${row.persona}`);
      for (const tool of row.overrides) this.write(`override: ${row.name} ${tool}`);
    }
    for (const held of gate.heldBack) this.write(`held-back: ${held.shown} ${held.reason}`);
    this.write(`tests: ${gate.rows.length}`);
    // The mocked world the suite runs in, said beside the suite it serves:
    // approving the tests is approving the answers, so both are on the record.
    for (const mock of gate.mocks) this.write(`mock-tool: ${mock.tool} ${mock.says}`);
    this.write(`mock-tools: ${gate.mocks.length}`);
    this.write(
      `connection: ${gate.connectionName} ${gate.productLabel} ${gate.modality}`,
    );
    if (gate.destination !== null) this.write(`dials: ${gate.destination}`);
  }

  /**
   * A list cannot be drawn where there is no screen, so what is printed is the
   * one thing that is news: a simulation that has moved since the last look.
   *
   * The lines are the same ones `egma run` prints, from the same place, so the
   * two promptless surfaces cannot drift apart.
   */
  setRun(run: RunView | null): void {
    if (run === null) return;
    const before = new Map(
      (this.record.run?.rows ?? []).map((row) => [row.id, row] as const),
    );
    for (const row of run.rows) {
      const held = before.get(row.id);
      if (held !== undefined && held.status === row.status && held.verdict === row.verdict) {
        continue;
      }
      this.write(simulationLine(row));
      if (row.verdict !== null && held?.verdict !== row.verdict) {
        this.write(`verdict: ${row.name} ${row.persona} ${row.verdict}`);
        if (row.first) this.write(`first-verdict: ${row.name} ${row.persona} ${row.verdict}`);
      }
    }
    this.record.run = run;
  }

  setSkillPlaces(places: SkillPlaces | null): void {
    if (places === null) return;
    this.record.skillPlaces = places;
    this.write(`skill_project: ${places.repository}`);
    this.write(`skill_global: ${places.home}`);
    this.write(`skill_agent: ${places.skillsAgentId}`);
    for (const skill of places.skills) this.write(`skill: ${skill}`);
  }

  pushStatus(line: string): void {
    this.record.statuses.push(line);
    this.write(line);
  }

  setSummary(text: string): void {
    this.record.summary = text;
    if (text.trim() !== "") this.write(text.trim());
  }

  setExit(report: ExitReport): void {
    this.record.exit = report;
  }
}
