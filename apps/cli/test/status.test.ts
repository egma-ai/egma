import { describe, expect, it } from "vitest";

import { ActionStream, drivenAgentTextIn } from "../src/wizard/status.ts";

const CWD = "/repo";

describe("what the developer is shown while the agent works", () => {
  it("shows every action the agent takes, with the file it touched", () => {
    const actions = new ActionStream(CWD);

    expect(
      actions.lines({
        sessionUpdate: "tool_call",
        toolCallId: "t1",
        title: "Read",
        kind: "read",
        status: "in_progress",
        locations: [{ path: "/repo/src/config.ts" }],
      }),
    ).toEqual(["◆ Read src/config.ts"]);
  });

  it("shows the action at once and the file as soon as the agent names it", () => {
    const actions = new ActionStream(CWD);

    // The real Claude adapter announces the call before it knows the file.
    expect(
      actions.lines({
        sessionUpdate: "tool_call",
        toolCallId: "t1",
        title: "Read File",
        kind: "read",
        status: "pending",
        locations: [],
        rawInput: {},
      }),
    ).toEqual(["◆ Read File"]);

    expect(
      actions.lines({
        sessionUpdate: "tool_call_update",
        toolCallId: "t1",
        title: "Read /repo/package.json",
        locations: [{ path: "/repo/package.json" }],
      }),
    ).toEqual(["┊ package.json"]);

    // And once told, it is not told again.
    expect(
      actions.lines({
        sessionUpdate: "tool_call_update",
        toolCallId: "t1",
        status: "completed",
      }),
    ).toEqual([]);
  });

  /**
   * `◆ Terminal` is a line nobody can check. The command is the whole content
   * of a terminal action, and a run that shows seven of these shows nothing
   * seven times.
   */
  it("names the command a terminal action runs", () => {
    const actions = new ActionStream(CWD);

    expect(
      actions.lines({
        sessionUpdate: "tool_call",
        toolCallId: "t1",
        title: "Terminal",
        kind: "execute",
        status: "in_progress",
        rawInput: { command: "rg -l retell-sdk src", description: "Look for the SDK" },
      }),
    ).toEqual(["◆ Terminal ┊ rg -l retell-sdk src"]);
  });

  it("finds the command wherever the adapter buried it, and keeps it to one line", () => {
    const actions = new ActionStream(CWD);

    // Split into words by one agent, nested by another, and wrapped by a third.
    expect(
      actions.lines({
        sessionUpdate: "tool_call",
        toolCallId: "t1",
        title: "Terminal",
        kind: "execute",
        status: "in_progress",
        rawInput: { tool: { input: { terminal: { command: ["cat", "package.json"] } } } },
      }),
    ).toEqual(["◆ Terminal ┊ cat package.json"]);

    expect(
      actions.lines({
        sessionUpdate: "tool_call",
        toolCallId: "t2",
        title: "Terminal",
        kind: "execute",
        status: "in_progress",
        rawInput: { command: `grep -rn "retell"\n  --include=*.ts\n  ${"src/".repeat(30)}` },
      })[0]?.split("\n"),
    ).toHaveLength(1);
  });

  it("says the command as soon as the agent names it, when it comes later", () => {
    const actions = new ActionStream(CWD);

    expect(
      actions.lines({
        sessionUpdate: "tool_call",
        toolCallId: "t1",
        title: "Terminal",
        kind: "execute",
        status: "pending",
        rawInput: {},
      }),
    ).toEqual(["◆ Terminal"]);

    expect(
      actions.lines({
        sessionUpdate: "tool_call_update",
        toolCallId: "t1",
        rawInput: { command: "ls prompts" },
      }),
    ).toEqual(["┊ ls prompts"]);
  });

  it("shows an action that never names a file rather than swallowing it", () => {
    const actions = new ActionStream(CWD);

    expect(
      actions.lines({
        sessionUpdate: "tool_call",
        toolCallId: "t1",
        title: "Think",
        status: "pending",
      }),
    ).toEqual(["◆ Think"]);

    expect(
      actions.lines({ sessionUpdate: "tool_call_update", toolCallId: "t1", status: "completed" }),
    ).toEqual([]);
  });

  it("says so when a step did not work", () => {
    const actions = new ActionStream(CWD);

    expect(
      actions.lines({
        sessionUpdate: "tool_call",
        toolCallId: "t1",
        title: "Read",
        status: "in_progress",
        locations: [{ path: "/repo/.env" }],
      }),
    ).toEqual(["◆ Read .env"]);

    expect(
      actions.lines({ sessionUpdate: "tool_call_update", toolCallId: "t1", status: "failed" }),
    ).toEqual(["✗ Read .env did not work"]);
  });

  it("shows the failure reason when the adapter provides one", () => {
    const actions = new ActionStream(CWD);

    actions.lines({
      sessionUpdate: "tool_call",
      toolCallId: "t1",
      title: "Terminal",
      status: "in_progress",
      rawInput: { command: "pnpm test" },
    });

    expect(
      actions.lines({
        sessionUpdate: "tool_call_update",
        toolCallId: "t1",
        status: "failed",
        rawOutput: { stderr: "No test files found" },
      }),
    ).toEqual([
      "✗ Terminal ┊ pnpm test did not work",
      "┊ No test files found",
    ]);
  });

  it("keeps the agent's own prose out of the stream and in the summary", () => {
    const actions = new ActionStream(CWD);
    const update = {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "It is a package manifest." },
    } as const;

    expect(actions.lines(update)).toEqual([]);
    expect(drivenAgentTextIn(update)).toBe("It is a package manifest.");
  });
});
