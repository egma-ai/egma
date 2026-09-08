import {
  DescribeTasksCommand,
  ListTasksCommand,
  RunTaskCommand,
} from "@aws-sdk/client-ecs";
import { describe, expect, it, vi } from "vitest";

import { awsVoiceFleet } from "../src/voice-fleet-aws.ts";

const settings = {
  cluster: "egma",
  taskDefinition: "egma-voice-simulator",
  containerName: "simulator",
  subnets: ["subnet-a", "subnet-b"],
  securityGroups: ["sg-egma"],
};

describe("the AWS voice fleet", () => {
  it("pages pending and running tasks, describes in hundreds, and keeps task identities unique", async () => {
    const pending = Array.from({ length: 101 }, (_, index) => `arn:pending:${index}`);
    const send = vi.fn(async (command: unknown) => {
      if (command instanceof ListTasksCommand) {
        const input = command.input;
        if (input.desiredStatus === "PENDING" && input.nextToken === undefined) {
          return { taskArns: pending.slice(0, 100), nextToken: "more" };
        }
        if (input.desiredStatus === "PENDING") return { taskArns: pending.slice(100) };
        return { taskArns: [pending[0], "arn:running"] };
      }
      if (command instanceof DescribeTasksCommand) {
        return {
          tasks: command.input.tasks?.map((taskArn) => ({
            taskArn,
            tags: taskArn === "arn:running"
              ? [{ key: "egma:simulator-mode", value: "standby" }]
              : [],
          })),
        };
      }
      throw new Error("unexpected command");
    });
    const fleet = awsVoiceFleet(settings, { send } as never);

    const tasks = await fleet.listTasks();

    expect(tasks).toHaveLength(102);
    expect(tasks.at(-1)).toEqual({ id: "arn:running", mode: "standby" });
    expect(send.mock.calls.filter(([command]) => command instanceof ListTasksCommand)).toHaveLength(3);
    const describes = send.mock.calls.filter(([command]) => command instanceof DescribeTasksCommand);
    expect(describes.map(([command]) => (command as DescribeTasksCommand).input.tasks?.length)).toEqual([100, 2]);
  });

  it("launches at most ten tasks per request and retains partial failures", async () => {
    let sequence = 0;
    const send = vi.fn(async (command: unknown) => {
      if (!(command instanceof RunTaskCommand)) throw new Error("unexpected command");
      const count = command.input.count ?? 0;
      sequence += 1;
      return {
        tasks: Array.from({ length: count - (sequence === 2 ? 1 : 0) }, (_, index) => ({
          taskArn: `arn:${sequence}:${index}`,
        })),
        failures: sequence === 2 ? [{ reason: "RESOURCE:CPU", detail: "quota" }] : [],
      };
    });
    const fleet = awsVoiceFleet(settings, { send } as never);

    const result = await fleet.launchTasks({ count: 23, mode: "standby" });

    expect(result.tasks).toHaveLength(22);
    expect(result.failures).toEqual([{ reason: "RESOURCE:CPU", detail: "quota" }]);
    const runs = send.mock.calls.map(([command]) => (command as RunTaskCommand).input);
    expect(runs.map((input) => input.count)).toEqual([10, 10, 3]);
    expect(runs[0]?.platformVersion).toBe("1.4.0");
    expect(runs[0]?.overrides?.containerOverrides?.[0]?.environment).toContainEqual({
      name: "EGMA_SIMULATOR_MODE",
      value: "standby",
    });
  });
});
