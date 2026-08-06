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
import type { RetellAgent } from "../retell/client.ts";
import { keyAskLines, type KeyAsk } from "../retell/connect.ts";
import type { ExitReport } from "../wizard/exit-line.ts";
import type { TestGate } from "../wizard/gate.ts";
import type { GenerationProgress } from "../wizard/test-generation.ts";
import type { AskId, DrivenAgent, GateId, WizardUI } from "./wizard-ui.ts";

export type HeadlessRecord = {
  drivenAgent: DrivenAgent | null;
  drivenAgentLog: string | null;
  logins: LoginPrompt[];
  /** Every time a key was asked for, and what was said about it. */
  keyAsks: KeyAsk[];
  /** The agents a choice was offered between, when one was. */
  agentChoices: RetellAgent[];
  statuses: string[];
  summary: string;
  /** Every test the coding agent said it had written, in the order it said so. */
  written: string[];
  /** The list that waited on one keystroke, when one did. */
  gate: TestGate | null;
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
    drivenAgent: null,
    drivenAgentLog: null,
    logins: [],
    keyAsks: [],
    agentChoices: [],
    statuses: [],
    summary: "",
    written: [],
    gate: null,
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

  setDrivenAgent(drivenAgent: DrivenAgent | null): void {
    this.record.drivenAgent = drivenAgent;
    if (drivenAgent !== null) this.write(`Coding agent: ${drivenAgent.name}`);
  }

  setDrivenAgentLog(file: string): void {
    this.record.drivenAgentLog = file;
  }

  setLogin(prompt: LoginPrompt | null): void {
    if (prompt === null) return;
    this.record.logins.push(prompt);
    // The same lines `egma login` prints, from the same place, so the two
    // promptless surfaces cannot drift apart.
    for (const line of loginLines(prompt)) this.write(line);
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

  setGate(gate: TestGate | null): void {
    if (gate === null) return;
    this.record.gate = gate;
    for (const row of gate.rows) this.write(`test: ${row.name} ${row.persona}`);
    for (const held of gate.heldBack) this.write(`held-back: ${held.shown} ${held.reason}`);
    this.write(`tests: ${gate.rows.length}`);
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
