import { describe, expect, it } from "vitest";

import { dispatchKey, hintBar, hintsFor, type KeyBinding } from "../src/ui/tui/keybindings.ts";
import { WizardStore } from "../src/ui/tui/store.ts";

describe("which screen is on", () => {
  it("shows every installed coding agent before the consent screen", async () => {
    const store = new WizardStore();
    store.setPhase("coding-agent");
    store.setCodingAgentChoices([
      {
        id: "claude",
        name: "Claude Code",
        version: "2.1.233",
        executable: "/usr/local/bin/claude",
      },
      {
        id: "codex",
        name: "Codex",
        version: "0.148.0",
        executable: "/usr/local/bin/codex",
      },
    ]);

    expect(store.activeScreen).toBe("coding-agent");
    const answer = store.ask("coding-agent");
    store.answer("coding-agent", "codex");
    await expect(answer).resolves.toBe("codex");
  });

  it("is worked out from state, so nothing has to navigate", () => {
    const store = new WizardStore();

    expect(store.activeScreen).toBe("coding-agent");
    store.setPhase("intro");
    expect(store.activeScreen).toBe("intro");
    store.begin();
    store.setPhase("test-writing");
    expect(store.activeScreen).toBe("task");

    // The two screens the generate step writes: the files arriving, and the
    // list waiting on one keystroke. Neither is navigated to.
    store.setGeneration({ what: "generating", tests: [], total: 12 });
    expect(store.activeScreen).toBe("generating");

    store.setGate({
      rows: [
        {
          name: "price-question",
          persona: "default persona",
          shown: "egma/tests/release/price-question.md",
          file: "/tmp/egma/tests/release/price-question.md",
          overrides: [],
        },
      ],
      heldBack: [],
      mocks: [],
      agentName: "order-line",
      connectionName: "retell-1",
      productLabel: "Retell chat",
      modality: "chat",
      destination: null,
      suite: "Release contract",
    });
    store.setPhase("review");
    // The list is the thing to deal with, even while the pane is still set.
    expect(store.activeScreen).toBe("gate");

    store.setGate(null);
    store.setGeneration(null);
    expect(store.activeScreen).toBe("task");
  });

  it("parks the flow over the tests until the developer says run them", async () => {
    const store = new WizardStore();
    let past = false;
    void store.getGate("run-tests").then(() => {
      past = true;
    });

    await Promise.resolve();
    expect(past).toBe(false);

    store.runTests();
    await store.getGate("run-tests");
    expect(past).toBe(true);
  });

  it("asks again after an invalid answer instead of reusing the old value", async () => {
    const store = new WizardStore();

    const first = store.ask("retell-key");
    store.answer("retell-key", "wrong-key");
    await expect(first).resolves.toBe("wrong-key");

    let settled = false;
    const second = store.ask("retell-key");
    void second.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    store.answer("retell-key", "correct-key");
    await expect(second).resolves.toBe("correct-key");
  });

  it("keeps the gate's selection inside the list, however far it is pushed", () => {
    const store = new WizardStore();
    const row = (name: string) => ({
      name,
      persona: "default persona",
      shown: `egma/tests/release/${name}.md`,
      file: `/tmp/egma/tests/release/${name}.md`,
      overrides: [],
    });
    store.setGate({
      rows: [row("one"), row("two")],
      heldBack: [],
      mocks: [],
      agentName: "order-line",
      connectionName: "retell-1",
      productLabel: "Retell chat",
      modality: "chat",
      destination: null,
      suite: "Release contract",
    });

    expect(store.snapshot.gateAt).toBe(0);
    store.moveGate(-1);
    expect(store.snapshot.gateAt).toBe(0);
    store.moveGate(1);
    store.moveGate(1);
    expect(store.snapshot.gateAt).toBe(1);
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

  /**
   * A terminal that has not been taken into raw mode yet turns the carriage
   * return Enter sends into a line feed, and the renderer calls only the first
   * of those `return`. The developer pressed one key. So did the test.
   */
  it("takes Enter whichever byte the terminal sent for it", () => {
    pressed.length = 0;
    expect(dispatchKey(bindings, "\r", {})).toBe(true);
    expect(dispatchKey(bindings, "\n", {})).toBe(true);
    expect(dispatchKey(bindings, "", { return: true })).toBe(true);
    expect(pressed).toEqual(["begin", "begin", "begin"]);
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
