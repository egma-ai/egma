import {
  DescribeTasksCommand,
  ECSClient,
  ListTasksCommand,
  RunTaskCommand,
  type ECSClientConfig,
} from "@aws-sdk/client-ecs";

import type {
  VoiceFleet,
  VoiceFleetLaunchFailure,
  VoiceFleetTask,
  VoiceTaskMode,
  AwsVoiceFleetSettings,
} from "./voice-fleet.ts";

type EcsSender = Pick<ECSClient, "send">;

const MODE_ENVIRONMENT = "EGMA_SIMULATOR_MODE";
const LIST_STATUSES = ["PENDING", "RUNNING"] as const;
const DESCRIBE_BATCH = 100;
const RUN_BATCH = 10;

function batches<T>(values: readonly T[], size: number): T[][] {
  const result: T[][] = [];
  for (let offset = 0; offset < values.length; offset += size) {
    result.push(values.slice(offset, offset + size));
  }
  return result;
}

function modeOf(task: {
  overrides?: {
    containerOverrides?: readonly {
      environment?: readonly {
        name?: string | undefined;
        value?: string | undefined;
      }[] | undefined;
    }[] | undefined;
  } | undefined;
}): VoiceTaskMode {
  const environment = task.overrides?.containerOverrides
    ?.flatMap((container) => container.environment ?? [])
    .find((entry) => entry.name === MODE_ENVIRONMENT)?.value;
  return environment === "standby" ? "standby" : "one-shot";
}

function taskFamily(taskDefinition: string): string {
  const afterSlash = taskDefinition.slice(taskDefinition.lastIndexOf("/") + 1);
  return afterSlash.replace(/:\d+$/u, "");
}

/** ECS implementation loaded only when the hosted launcher setting names it. */
export function awsVoiceFleet(
  settings: AwsVoiceFleetSettings,
  client: EcsSender = new ECSClient({} satisfies ECSClientConfig),
): VoiceFleet {
  return {
    async listTasks() {
      const arns = new Set<string>();
      for (const desiredStatus of LIST_STATUSES) {
        let nextToken: string | undefined;
        do {
          const page = await client.send(
            new ListTasksCommand({
              cluster: settings.cluster,
              family: taskFamily(settings.taskDefinition),
              desiredStatus,
              ...(nextToken === undefined ? {} : { nextToken }),
            }),
          );
          for (const arn of page.taskArns ?? []) arns.add(arn);
          nextToken = page.nextToken;
        } while (nextToken !== undefined);
      }

      const found: VoiceFleetTask[] = [];
      for (const taskArns of batches([...arns], DESCRIBE_BATCH)) {
        if (taskArns.length === 0) continue;
        const described = await client.send(
          new DescribeTasksCommand({
            cluster: settings.cluster,
            tasks: taskArns,
          }),
        );
        for (const task of described.tasks ?? []) {
          if (
            task.taskArn !== undefined &&
            ["PROVISIONING", "PENDING", "RUNNING"].includes(task.lastStatus ?? "")
          ) {
            found.push({ id: task.taskArn, mode: modeOf(task) });
          }
        }
      }
      return found;
    },

    async launchTasks({ count, mode }) {
      const tasks: VoiceFleetTask[] = [];
      const failures: VoiceFleetLaunchFailure[] = [];
      for (const chunk of batches(Array.from({ length: count }, (_, i) => i), RUN_BATCH)) {
        try {
          const launched = await client.send(new RunTaskCommand({
            cluster: settings.cluster,
            taskDefinition: settings.taskDefinition,
            count: chunk.length,
            launchType: "FARGATE",
            platformVersion: "1.4.0",
            networkConfiguration: {
              awsvpcConfiguration: {
                subnets: [...settings.subnets],
                securityGroups: [...settings.securityGroups],
                assignPublicIp: "ENABLED",
              },
            },
            overrides: {
              containerOverrides: [
                {
                  name: settings.containerName,
                  environment: [{ name: MODE_ENVIRONMENT, value: mode }],
                },
              ],
            },
          }));
          for (const task of launched.tasks ?? []) {
            if (task.taskArn !== undefined) tasks.push({ id: task.taskArn, mode });
          }
          for (const failure of launched.failures ?? []) {
            failures.push({
              reason: failure.reason ?? "unknown",
              ...(failure.detail === undefined ? {} : { detail: failure.detail }),
            });
          }
        } catch (err) {
          failures.push({
            reason: "run_task_failed",
            detail: err instanceof Error ? err.message : String(err),
          });
          break;
        }
      }
      return { tasks, failures };
    },
  };
}
