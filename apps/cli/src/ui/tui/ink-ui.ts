/**
 * The terminal UI's side of the seam.
 *
 * Every method is a write to the store. Nothing here draws and nothing here
 * asks — the screens read the store and own every keystroke.
 */

import type { LoginPrompt } from "../../platform/login.ts";
import type { RetellAgent, RetellNumber } from "../../retell/client.ts";
import type { KeyAsk, Reach } from "../../retell/connect.ts";
import type { RunView } from "../../run/view.ts";
import type { SkillPlaces } from "../../skills/install.ts";
import type { Detection } from "../../wizard/detection.ts";
import type { ExitReport } from "../../wizard/exit-line.ts";
import type { TestGate } from "../../wizard/gate.ts";
import type { GenerationProgress } from "../../wizard/test-generation.ts";
import type { AskId, DrivenAgent, GateId, PlatformNotice, WizardUI } from "../wizard-ui.ts";
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

  setPlatform(chosen: PlatformNotice | null): void {
    this.store.setPlatform(chosen);
  }

  setDetection(detection: Detection | null): void {
    this.store.setDetection(detection);
  }

  setLogin(prompt: LoginPrompt | null): void {
    this.store.setLogin(prompt);
  }

  setKeyAsk(ask: KeyAsk | null): void {
    this.store.setKeyAsk(ask);
  }

  setAgentChoices(agents: readonly RetellAgent[] | null): void {
    this.store.setAgentChoices(agents);
  }

  setReachOffer(offered: readonly Reach[] | null): void {
    this.store.setReachOffer(offered);
  }

  setNumberChoices(numbers: readonly RetellNumber[] | null): void {
    this.store.setNumberChoices(numbers);
  }

  setGeneration(progress: GenerationProgress | null): void {
    this.store.setGeneration(progress);
  }

  setGate(gate: TestGate | null): void {
    this.store.setGate(gate);
  }

  setRun(run: RunView | null): void {
    this.store.setRun(run);
  }

  setSkillPlaces(places: SkillPlaces | null): void {
    this.store.setSkillPlaces(places);
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
