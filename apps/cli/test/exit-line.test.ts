import { describe, expect, it } from "vitest";

import {
  MOVE_TO_ANOTHER_PLATFORM,
  teachingTheMove,
} from "../src/folder/egma-folder.ts";
import { skillPlacesFor, type SkillPlaces } from "../src/skills/install.ts";
import {
  buildExitLine,
  buildExitNotice,
  exitLines,
  WEB_MONITORING_POINTER,
  type ExitReport,
} from "../src/wizard/exit-line.ts";

/** Where an offer would have gone, from the same code the wizard asks. */
const PLACES: SkillPlaces = skillPlacesFor("claude", {
  repository: "/repo",
  home: "/home/you",
}) as SkillPlaces;

const RESULTS_URL = "http://localhost:3101/runs/run_01K7QXV2M8ZB4C6D8E0F2G4H6J";

const EVERY_ENDING: readonly ExitReport[] = [
  { kind: "found-agent", framework: "retell-sdk", prompts: "prompts/order-line.md" },
  { kind: "found-agent", framework: "retell-sdk", prompts: null },
  { kind: "found-agent", framework: null, prompts: null },
  { kind: "connected", agentName: "order-line", connectionName: "retell-1" },
  { kind: "tests-pushed", count: 12 },
  { kind: "tests-pushed", count: 1 },
  { kind: "tests-kept", count: 12, stopped: false },
  { kind: "tests-kept", count: 1, stopped: false },
  { kind: "tests-kept", count: 12, stopped: true },
  {
    kind: "run-started",
    resultsUrl: RESULTS_URL,
    resultsReady: 3,
    total: 12,
    skill: {
      kind: "installed",
      scope: "project",
      places: PLACES,
      landed: ["/repo/.claude/skills/egma"],
    },
  },
  {
    kind: "run-started",
    resultsUrl: RESULTS_URL,
    resultsReady: 3,
    total: 12,
    skill: {
      kind: "installed",
      scope: "global",
      places: PLACES,
      landed: [],
    },
  },
  {
    kind: "run-started",
    resultsUrl: RESULTS_URL,
    resultsReady: 12,
    total: 12,
    skill: { kind: "skipped", drivenAgentName: "Claude Code" },
  },
  {
    kind: "run-started",
    resultsUrl: RESULTS_URL,
    resultsReady: 0,
    total: 12,
    skill: { kind: "not-offered" },
  },
  { kind: "no-agent-context" },
  { kind: "unsupported-agent-platform", platform: "pipecat" },
  { kind: "unsupported-agent-platform", platform: "vapi" },
  { kind: "no-coding-agent" },
  {
    kind: "monitoring-started",
    agentName: "order-line",
    arrived: true,
    registered: true,
    platformUrl: "https://egma.example",
  },
  {
    kind: "monitoring-started",
    agentName: "order-line",
    arrived: false,
    registered: false,
    platformUrl: null,
  },
  {
    kind: "monitoring-wired",
    agentName: "front-desk",
    envFile: ".env",
    envRefusal: null,
    lines: ["export EGMA_URL=https://egma.example", "export EGMA_API_KEY=egma_sk_x"],
    wired: true,
    platformUrl: "https://egma.example",
  },
  {
    kind: "monitoring-wired",
    agentName: "front-desk",
    envFile: null,
    envRefusal: "Git does not ignore .env here.",
    lines: ["export EGMA_URL=https://egma.example", "export EGMA_API_KEY=egma_sk_x"],
    wired: false,
    platformUrl: null,
  },
  {
    kind: "monitoring-refused",
    lines: ["Another Egma agent is already watching that agent.", "agent_1 is already watched."],
  },
  { kind: "already-onboarded", folder: "egma/", hasSuites: true },
  { kind: "already-onboarded", folder: "egma/", hasSuites: false },
  {
    kind: "run-started",
    resultsUrl: RESULTS_URL,
    graded: 1,
    total: 12,
    skill: { kind: "install-failed", reason: "The skills installer stopped: no such agent." },
  },
  {
    kind: "coding-agent-stopped",
    drivenAgentName: "Claude Agent",
    reason: "I cannot read this repository.",
  },
  { kind: "coding-agent-stopped", drivenAgentName: "Claude Agent", reason: "" },
  { kind: "quit" },
  { kind: "interrupted", drivenAgentName: "Claude Agent" },
  { kind: "interrupted", drivenAgentName: null },
  { kind: "interrupted", drivenAgentName: "Claude Agent", testsKept: 12 },
  { kind: "interrupted", drivenAgentName: "Claude Agent", testsKept: 1 },
  { kind: "failed", reason: "the agent stopped talking" },
];

describe("the exit line", () => {
  it("is always exactly one line, with nothing to select around", () => {
    for (const report of EVERY_ENDING) {
      const line = buildExitLine(report);
      expect(line).not.toContain("\n");
      // Nothing painted: a terminal selects a plain line cleanly.
      expect(line).not.toContain("");
      expect(line.trim()).toBe(line);
      expect(line.length).toBeGreaterThan(0);
    }
  });

  it("says what happened, in words", () => {
    expect(
      buildExitLine({
        kind: "found-agent",
        framework: "retell-sdk",
        prompts: "prompts/order-line.md",
      }),
    ).toBe("Egma found your voice agent: retell-sdk, prompts in prompts/order-line.md.");

    expect(buildExitLine({ kind: "no-agent-context" })).toContain(
      "Use its folder or configure it in the UI",
    );

    expect(
      buildExitLine({ kind: "unsupported-agent-platform", platform: "pipecat" }),
    ).toContain("CLI support is coming soon");

    expect(buildExitLine({ kind: "interrupted", drivenAgentName: "Claude Agent" })).toContain(
      "stopped before the task finished",
    );

    // A stop that left files behind says so, in the same one line: a folder a
    // developer was never told about is a half-truth.
    expect(
      buildExitLine({ kind: "interrupted", drivenAgentName: "Claude Agent", testsKept: 12 }),
    ).toBe(
      "Egma stopped before the task finished, and shut Claude Agent down. Your 12 tests are in egma/tests/.",
    );

    expect(buildExitLine({ kind: "failed", reason: "no answer" })).toContain("no answer");
  });

  /**
   * Both endings the gate has leave files in the repository, so both have to
   * say where they are — the whole point of the wizard's alternate screen is
   * that nothing else survives it.
   */
  it("says where the tests are, whichever way the gate ended", () => {
    expect(buildExitLine({ kind: "tests-pushed", count: 12 })).toBe(
      "Egma put 12 tests on Egma and left them in egma/tests/ — commit them, edit them, then run egma push.",
    );
    expect(buildExitLine({ kind: "tests-kept", count: 12, stopped: false })).toBe(
      "Nothing was uploaded. Your 12 tests are in egma/tests/ — read them, then run egma push.",
    );

    // One test is one test, in both of them.
    expect(buildExitLine({ kind: "tests-pushed", count: 1 })).toContain("1 test on Egma");
    expect(buildExitLine({ kind: "tests-kept", count: 1, stopped: false })).toContain(
      "Your test is in",
    );

    // Ctrl-C over the list is the same decision as q, and it leaves the same
    // files. It says it stopped, because a person who pressed it knows they
    // did — and it still says where the files are, which is the whole job of
    // this line.
    expect(buildExitLine({ kind: "tests-kept", count: 12, stopped: true })).toBe(
      "Egma stopped. Your 12 tests are in egma/tests/ — read them, then run egma push.",
    );
  });

  /**
   * A coding agent that stopped is not a folder that held nothing. Telling the
   * second story for the first says egma looked and found no voice agent, when
   * what happened is that nobody ever looked.
   */
  it("says a stop was a stop, and whose it was", () => {
    expect(
      buildExitLine({
        kind: "coding-agent-stopped",
        drivenAgentName: "Claude Agent",
        reason: "I cannot read this repository.",
      }),
    ).toBe(
      "Claude Agent stopped before it found your voice agent: I cannot read this repository.",
    );

    expect(
      buildExitLine({ kind: "coding-agent-stopped", drivenAgentName: "Claude Agent", reason: "" }),
    ).toBe("Claude Agent stopped before it found your voice agent, and did not say why.");
  });

  /**
   * The one ending with no coding agent to drive still has a path to watching
   * production traffic, and it names the flow that needs no terminal.
   */
  it("points at the web Monitoring flow where the terminal cannot do it", () => {
    expect(buildExitLine({ kind: "no-coding-agent" })).toContain(WEB_MONITORING_POINTER);
  });

  /**
   * Watching is really on, and the line says whether Egma saw proof of it.
   *
   * An account with nothing to import is not a failure and must not read as
   * one: the sentence says what is true and what happens next, and the exit
   * code beside it is zero.
   */
  it("says whether a conversation arrived, and never implies a failure", () => {
    const arrived = buildExitLine({
      kind: "monitoring-started",
      agentName: "order-line",
      arrived: true,
      registered: true,
      platformUrl: "https://egma.example",
    });
    expect(arrived).toContain("watching order-line's production calls");
    expect(arrived).toContain("first conversation has already arrived");
    expect(arrived).toContain("https://egma.example");

    const empty = buildExitLine({
      kind: "monitoring-started",
      agentName: "order-line",
      arrived: false,
      registered: false,
      platformUrl: "https://egma.example",
    });
    expect(empty).toContain("Nothing has arrived yet");
    expect(empty).toContain("Monitoring page");
  });

  /**
   * The two lines a monitored worker exports with are the deliverable, so they
   * survive the screen — one to a line, whether the file was written or not.
   */
  it("prints the two environment lines whether or not the file was written", () => {
    const lines = [
      "export EGMA_URL=https://egma.example",
      "export EGMA_API_KEY=egma_sk_x",
    ];
    const written = exitLines({
      kind: "monitoring-wired",
      agentName: "front-desk",
      envFile: ".env",
      envRefusal: null,
      lines,
      wired: true,
      platformUrl: "https://egma.example",
    });
    expect(written).toContain(lines[0]);
    expect(written).toContain(lines[1]);
    expect(written[0]).toContain("pushes its production evidence");

    const refused = exitLines({
      kind: "monitoring-wired",
      agentName: "front-desk",
      envFile: null,
      envRefusal: "Git does not ignore .env here.",
      lines,
      wired: true,
      platformUrl: null,
    });
    expect(refused).toContain(lines[1]);
    expect(refused).toContain("Git does not ignore .env here.");
  });

  /**
   * A refusal says two things and keeps them apart: Egma's own sentence about
   * what to do, and the platform's own for whatever is reading rather than
   * looking.
   */
  it("keeps Egma's sentence and the platform's apart on a refusal", () => {
    const said = exitLines({
      kind: "monitoring-refused",
      lines: [
        "Another Egma agent is already watching that agent on the platform.",
        "agent_1 is already watched by “order-line”.",
      ],
    });
    expect(said[0]).toContain("Another Egma agent is already watching");
    expect(said).toContain("agent_1 is already watched by “order-line”.");
  });

  /**
   * A repository that has been through the wizard is refused politely, and the
   * refusal has to carry the one thing that redoes setup on purpose.
   *
   * The second way forward is only a way forward when there is something to
   * push. A folder holding a binding and no suite — which is what a walk that
   * stopped between binding and registering leaves behind — is refused by
   * `egma push` for the contract it does not have yet, so the line does not
   * send anybody there.
   */
  it("says how to redo setup, and names push and run only when there is a suite", () => {
    const withTests = buildExitLine({
      kind: "already-onboarded",
      folder: "egma/",
      hasSuites: true,
    });
    expect(withTests).toContain("already set up");
    expect(withTests).toContain("only works with new repositories");
    expect(withTests).toContain("Delete or rename egma/");
    expect(withTests).toContain("egma push and egma run on the tests that are already there");

    const empty = buildExitLine({
      kind: "already-onboarded",
      folder: "egma/",
      hasSuites: false,
    });
    expect(empty).toContain("Delete or rename egma/ and run egma again to redo setup.");
    expect(empty).not.toContain("egma push");
  });

  it("prints something to copy when the developer has to copy something", () => {
    for (const report of EVERY_ENDING) {
      const notice = buildExitNotice(report);
      if (report.kind === "no-coding-agent") {
        expect(notice).toContain("paste this into it");
        continue;
      }
      if (report.kind === "run-started") continue;
      expect(notice).toBeNull();
    }
  });

  /**
   * The whole point of the alternate screen is that nothing on it survives, so
   * the three things a developer takes away from the walk have to be here — and
   * each of them is a thing somebody copies, which on a terminal means a whole
   * line and nothing sharing it.
   */
  it("leaves three copyable things behind, each alone on its line", () => {
    const lines = exitLines({
      kind: "run-started",
      resultsUrl: RESULTS_URL,
      resultsReady: 3,
      total: 12,
      skill: { kind: "skipped", drivenAgentName: "Claude Code" },
    });

    expect(lines).toEqual([
      "✓ Your first run is live — 3 of 12 simulation results ready.",
      "",
      RESULTS_URL,
      "",
      "Tests are code now: egma/tests/ (committed). Edit them, then egma push.",
      'Hand your coding agent this: "Read egma/config.yaml, then egma --help — you can pull, push, and trigger runs from here."',
    ]);

    for (const line of lines) {
      // No indentation, no border, no colour: a triple-click takes the line
      // and gets exactly what is on it.
      expect(line.trim()).toBe(line);
      expect(line).not.toContain("");
      expect(line).not.toContain("\n");
    }
  });

  /**
   * The results page opens already signed in, because the browser holds the
   * sign-in made at device approval. That is the whole reason nothing has to
   * ride the address — and an address carrying a key would be a key in
   * scrollback, in shell history, and in whatever the developer pastes it into.
   */
  it("carries no token on the results address, ever", () => {
    const lines = exitLines({
      kind: "run-started",
      resultsUrl: RESULTS_URL,
      resultsReady: 1,
      total: 12,
      skill: { kind: "not-offered" },
    });

    const address = lines[2] as string;
    expect(address).toBe(RESULTS_URL);
    expect(new URL(address).search).toBe("");
    expect(new URL(address).hash).toBe("");
    expect(new URL(address).username).toBe("");
    expect(new URL(address).pathname).toMatch(/^\/runs\/run_[0-9A-HJKMNP-TV-Z]{26}$/u);
  });

  it("counts terminal trace results honestly, however far the suite got", () => {
    const of = (resultsReady: number, total: number): string =>
      buildExitLine({
        kind: "run-started",
        resultsUrl: RESULTS_URL,
        resultsReady,
        total,
        skill: { kind: "not-offered" },
      });

    expect(of(3, 12)).toBe("✓ Your first run is live — 3 of 12 simulation results ready.");
    expect(of(12, 12)).toBe("✓ Your first run is live — all 12 simulation results are ready.");
    expect(of(0, 12)).toBe("✓ Your first run is live — no simulation result is ready yet (12 total).");
    expect(of(0, 1)).toBe("✓ Your first run is live — no simulation result is ready yet (1 total).");
  });

  /** Never silent, in either direction, and it has to outlive the screen. */
  it("says what became of the skill offer, whichever way it was answered", () => {
    expect(
      buildExitNotice({
        kind: "run-started",
        resultsUrl: RESULTS_URL,
        resultsReady: 1,
        total: 12,
        skill: {
          kind: "installed",
          scope: "global",
          places: PLACES,
          landed: ["~/.agents/skills/egma"],
        },
      }),
    ).toBe(
      "1 Egma skill is beside Claude Code. ~/.agents/skills/egma. Every repository you open Claude Code in has them.",
    );

    // Where they went, in the installer's own words, because that is the only
    // account of it that cannot be wrong.
    expect(
      buildExitNotice({
        kind: "run-started",
        resultsUrl: RESULTS_URL,
        resultsReady: 1,
        total: 12,
        skill: {
          kind: "installed",
          scope: "project",
          places: PLACES,
          landed: ["./.claude/skills/egma", "./.claude/skills/write-egma-tests"],
        },
      }),
    ).toBe(
      "2 Egma skills are in this repository. ./.claude/skills/egma, ./.claude/skills/write-egma-tests. It also wrote skills-lock.json at the repository root. Commit all of it, and everybody on this repository has these skills.",
    );

    // An offer accepted and not kept is never silent either.
    expect(
      buildExitNotice({
        kind: "run-started",
        resultsUrl: RESULTS_URL,
        graded: 1,
        total: 12,
        skill: { kind: "install-failed", reason: "The skills installer stopped: no agent." },
      }),
    ).toBe("The skills installer stopped: no agent.");

    expect(
      buildExitNotice({
        kind: "run-started",
        resultsUrl: RESULTS_URL,
        resultsReady: 1,
        total: 12,
        skill: { kind: "skipped", drivenAgentName: "Codex" },
      }),
    ).toBe("Nothing was installed. Codex can still drive Egma — tell it to run egma --help.");

    // A coding agent egma has no skill convention for was never offered one,
    // so there is nothing to report either way.
    expect(
      buildExitNotice({
        kind: "run-started",
        resultsUrl: RESULTS_URL,
        resultsReady: 1,
        total: 12,
        skill: { kind: "not-offered" },
      }),
    ).toBeNull();
  });

  /**
   * Four endings carry more than a sentence, and each carries it for a reason
   * a developer can name: the walk's own ending has three things to copy, a
   * wired worker has the two lines it exports with, a refusal has the
   * platform's own sentence, and a failure may arrive with a block. Every
   * other ending is one line, and stays one line.
   */
  it("is one line for every ending that is one thing", () => {
    const carriesMore = new Set(["run-started", "monitoring-wired", "monitoring-refused"]);
    for (const report of EVERY_ENDING) {
      if (carriesMore.has(report.kind)) continue;
      expect(exitLines(report)).toEqual([buildExitLine(report)]);
    }
  });

  /**
   * A reason that arrived carrying a block keeps the block.
   *
   * One refusal in egma is more than a sentence: the one that keeps a
   * repository on the platform URL it is bound to ends with every line a developer
   * deletes to move it, and a coding agent is meant to act on those lines
   * without a person reading them out. Squashed into the exit line they are
   * neither readable nor usable — which is exactly what happened, because a
   * reason is otherwise flattened to one line on purpose.
   *
   * The flattening stays for everything else. A wrapped sentence and a stack
   * trace are still one line, so the last thing in scrollback still selects
   * whole with one triple-click.
   */
  it("keeps a block under the line, and flattens everything else onto it", () => {
    const refusal = teachingTheMove(
      "This repository is bound to the Egma platform at https://theirs.example, and --url names https://ours.example instead. Drop --url to use the bound platform. If https://ours.example is the same platform at a new address, edit the platform origin in egma/config.yaml on purpose. Egma does not move a repository between platforms, and no repository identifiers were sent.",
    );
    const lines = exitLines({ kind: "failed", reason: refusal });

    expect(lines[0]).toBe(
      "Egma could not finish: This repository is bound to the Egma platform at https://theirs.example, and --url names https://ours.example instead. Drop --url to use the bound platform. If https://ours.example is the same platform at a new address, edit the platform origin in egma/config.yaml on purpose. Egma does not move a repository between platforms, and no repository identifiers were sent.",
    );
    expect(lines[1]).toBe("");
    expect(lines.slice(2)).toEqual([...MOVE_TO_ANOTHER_PLATFORM]);
    // One line each, which is what "one plain block of lines" means.
    expect(lines.filter((line) => line.startsWith("  - "))).toHaveLength(6);

    // And a reason that is one paragraph is still one line, however it wrapped.
    expect(
      exitLines({ kind: "failed", reason: "no answer\n  from the\n  platform" }),
    ).toEqual(["Egma could not finish: no answer from the platform"]);
  });
});
