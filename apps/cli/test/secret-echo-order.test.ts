import { EventEmitter } from "node:events";

import { expect, it } from "vitest";

import { askSecret, type AskOptions } from "../src/self-host/protected-input.ts";

/**
 * Echo goes off before the prompt invites anybody to type.
 *
 * **The order is the whole guarantee.** A prompt is an invitation, and this one
 * says "not shown as you type" in its own words. Printing it while the terminal
 * driver is still echoing leaves a window where what somebody types lands on
 * the screen and stays in the scrollback — with the prompt above it promising
 * the opposite.
 *
 * It was that way round, and CI found it: the first secret of a self-host run
 * turned up in the scrollback while every later secret was correctly hidden,
 * because by the second one the terminal had already been through raw mode. A
 * person is in that window too — pasting, or typing ahead of a prompt they knew
 * was coming.
 *
 * **This test records the order rather than reading the screen.** The terminal
 * check next door asserts the same guarantee by scraping what was rendered,
 * which is true but races the renderer under load and fails for reasons that
 * have nothing to do with echo. Two calls on one fake, in order, cannot race.
 */

type Step = "raw-on" | "raw-off" | "resume" | "pause" | `write:${string}`;

function terminalRecording(steps: Step[]): AskOptions {
  const input = Object.assign(new EventEmitter(), {
    isTTY: true,
    isRaw: false,
    setRawMode(on: boolean) {
      steps.push(on ? "raw-on" : "raw-off");
      (input as { isRaw: boolean }).isRaw = on;
      return input;
    },
    resume() {
      steps.push("resume");
      // The answer arrives once somebody is listening for it, which is the
      // earliest a real keystroke could: nothing is typed into a stream that
      // has not been resumed.
      queueMicrotask(() => input.emit("data", Buffer.from("sk-typed\r")));
      return input;
    },
    pause() {
      steps.push("pause");
      return input;
    },
  });

  const output = {
    write(chunk: string) {
      steps.push(`write:${chunk}`);
      return true;
    },
  };

  return {
    env: {},
    input: input as unknown as AskOptions["input"],
    output: output as unknown as AskOptions["output"],
  };
}

it("turns the echo off before it prints the prompt that promises no echo", async () => {
  const steps: Step[] = [];
  const answered = await askSecret(
    "EGMA_PERSONA_MODEL_API_KEY",
    "the persona's model key (not shown as you type)",
    terminalRecording(steps),
  );

  expect(answered.value).toBe("sk-typed");
  expect(answered.from).toBe("typed");

  const rawOn = steps.indexOf("raw-on");
  const prompted = steps.findIndex(
    (step) => step.startsWith("write:") && step.includes("not shown as you type"),
  );

  expect(rawOn, "the echo was never turned off").toBeGreaterThanOrEqual(0);
  expect(prompted, "the prompt was never printed").toBeGreaterThanOrEqual(0);
  // The one assertion this file exists for.
  expect(rawOn).toBeLessThan(prompted);
});

it("puts the echo back, so the next command is not typed into blind", async () => {
  const steps: Step[] = [];
  await askSecret("EGMA_PERSONA_MODEL_API_KEY", "a key", terminalRecording(steps));

  expect(steps.at(-1)).toBe("write:\n");
  expect(steps).toContain("raw-off");
  expect(steps.indexOf("raw-off")).toBeGreaterThan(steps.indexOf("raw-on"));
});

it("asks nothing at all when the variable already holds the secret", async () => {
  const steps: Step[] = [];
  const options = terminalRecording(steps);
  const answered = await askSecret("EGMA_PERSONA_MODEL_API_KEY", "a key", {
    ...options,
    env: { EGMA_PERSONA_MODEL_API_KEY: "  sk-from-the-environment  " },
  });

  expect(answered.value).toBe("sk-from-the-environment");
  expect(answered.from).toBe("EGMA_PERSONA_MODEL_API_KEY");
  // Nothing was printed and the terminal was never touched, so there is no
  // window to get wrong on this path.
  expect(steps).toEqual([]);
});
