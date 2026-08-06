/**
 * The terminal UI's side of the seam.
 *
 * Every method is a write to the store. Nothing here draws and nothing here
 * asks — the screens read the store and own every keystroke.
 */

import type { LoginPrompt } from "../../platform/login.ts";
import type { ExitReport } from "../../wizard/exit-line.ts";
import type { AskId, DrivenAgent, GateId, WizardUI } from "../wizard-ui.ts";
import type { WizardStore } from "./store.ts";

export class InkUI implements WizardUI {
  private readonly store: WizardStore;

  constructor(store: WizardStore) {
    this.store = store;
  }

  readonly log = {
    info: (message: string): void => this.store.pushStatus(message),
    warn: (message: string): void => this.store.pushStatus(message),
    error: (message: string): void => this.store.pushStatus(message),
    success: (message: string): void => this.store.pushStatus(message),
  };

  setDrivenAgent(drivenAgent: DrivenAgent | null): void {
    this.store.setDrivenAgent(drivenAgent);
  }

  setDrivenAgentLog(file: string): void {
    this.store.setDrivenAgentLog(file);
  }

  setLogin(prompt: LoginPrompt | null): void {
    this.store.setLogin(prompt);
  }

  takeLoginPaste(): string | null {
    return this.store.takeLoginPaste();
  }

  waitForGate(gate: GateId): Promise<void> {
    return this.store.getGate(gate);
  }

  waitForAnswer(ask: AskId): Promise<string | null> {
    return this.store.ask(ask);
  }

  taskStarted(): void {
    this.store.taskStarted();
  }

  taskFinished(): void {
    this.store.taskFinished();
  }

  pushStatus(line: string): void {
    this.store.pushStatus(line);
  }

  setSummary(text: string): void {
    this.store.setSummary(text);
  }

  setExit(report: ExitReport): void {
    this.store.setExit(report);
  }
}
