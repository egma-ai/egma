import { describe, expect, it } from "vitest";

import { dispatchKey, hintBar, hintsFor, type KeyBinding } from "../src/ui/tui/keybindings.ts";
import { WizardStore } from "../src/ui/tui/store.ts";

describe("which screen is on", () => {
  it("is worked out from state, so nothing has to navigate", () => {
    const store = new WizardStore();

    expect(store.activeScreen).toBe("intro");
    store.begin();
    expect(store.activeScreen).toBe("run");
  });

  it("parks the flow until the developer opens the gate", async () => {
    const store = new WizardStore();
    let past = false;
    void store.getGate("begin").then(() => {
      past = true;
    });

    await Promise.resolve();
    expect(past).toBe(false);

    store.begin();
    await store.getGate("begin");
    expect(past).toBe(true);
  });
});

describe("keys as data", () => {
  const pressed: string[] = [];
  const bindings: KeyBinding[] = [
    { match: "return", label: "enter", action: "begin", handler: () => pressed.push("begin") },
    { match: "q", label: "q", action: "quit", handler: () => pressed.push("quit") },
  ];

  it("runs the binding whose key was pressed", () => {
    pressed.length = 0;
    expect(dispatchKey(bindings, "", { return: true })).toBe(true);
    expect(dispatchKey(bindings, "q", {})).toBe(true);
    expect(dispatchKey(bindings, "z", {})).toBe(false);
    expect(pressed).toEqual(["begin", "quit"]);
  });

  it("builds the hint bar from the same list, so the two cannot drift", () => {
    const ordered: KeyBinding[] = [
      { ...(bindings[0] as KeyBinding), priority: 0 },
      { ...(bindings[1] as KeyBinding), priority: 1 },
    ];
    expect(hintsFor(ordered).map((hint) => hint.label)).toEqual(["enter", "q"]);
    expect(hintBar(ordered)).toBe("[enter] begin   [q] quit");
  });
});
