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
 */

import type { LoginPrompt } from "../platform/login.ts";
import type { ExitReport } from "../wizard/exit-line.ts";
import type { DrivenAgent, GateId, WizardUI } from "./wizard-ui.ts";

export type HeadlessRecord = {
  drivenAgent: DrivenAgent | null;
  drivenAgentLog: string | null;
  taskFile: string | null;
  logins: LoginPrompt[];
  statuses: string[];
  summary: string;
  exit: ExitReport | null;
  gatesOpened: GateId[];
};

export type HeadlessOptions = {
  /** Where plain lines go. Omit to keep the run silent. */
  readonly write?: (line: string) => void;
};

export class HeadlessUI implements WizardUI {
  readonly record: HeadlessRecord = {
    drivenAgent: null,
    drivenAgentLog: null,
    taskFile: null,
    logins: [],
    statuses: [],
    summary: "",
    exit: null,
    gatesOpened: [],
  };

  private readonly write: (line: string) => void;

  constructor(options: HeadlessOptions = {}) {
    this.write = options.write ?? (() => undefined);
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

  setTaskFile(file: string): void {
    this.record.taskFile = file;
    this.write(`Task: read ${file} and say what it is`);
  }

  setLogin(prompt: LoginPrompt | null): void {
    if (prompt === null) return;
    this.record.logins.push(prompt);
    this.write(`code: ${prompt.userCode}`);
    this.write(`approve_url: ${prompt.url}`);
    this.write(`browser: ${prompt.browserOpened ? "opened" : "not-opened"}`);
  }

  /** Nobody is at this keyboard, so nothing is ever pasted at it. */
  takeLoginPaste(): string | null {
    return null;
  }

  waitForGate(gate: GateId): Promise<void> {
    this.record.gatesOpened.push(gate);
    return Promise.resolve();
  }

  taskStarted(): void {
    this.write("Starting the coding agent.");
  }

  taskFinished(): void {
    this.write("The task is over.");
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
