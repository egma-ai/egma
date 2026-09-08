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
} from "./voice-fleet.ts";

export type AwsVoiceFleetSettings = {
  readonly cluster: string;
  readonly taskDefinition: string;
  readonly containerName: string;
  readonly subnets: readonly string[];
  readonly securityGroups: readonly string[];
};

type EcsSender = Pick<ECSClient, "send">;

const TASK_MODE_TAG = "egma:simulator-mode";
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
  tags?: readonly { key?: string | undefined; value?: string | undefined }[] | undefined;
  overrides?: {
    containerOverrides?: readonly {
      environment?: readonly {
        name?: string | undefined;
        value?: string | undefined;
      }[] | undefined;
    }[] | undefined;
  } | undefined;
}): VoiceTaskMode {
  const tagged = task.tags?.find((tag) => tag.key === TASK_MODE_TAG)?.value;
  const environment = task.overrides?.containerOverrides
    ?.flatMap((container) => container.environment ?? [])
    .find((entry) => entry.name === MODE_ENVIRONMENT)?.value;
  return tagged === "standby" || environment === "standby"
    ? "standby"
    : "one-shot";
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
              family: settings.taskDefinition,
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
            include: ["TAGS"],
          }),
        );
        for (const task of described.tasks ?? []) {
          if (task.taskArn !== undefined) {
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
        const launched = await client.send(
          new RunTaskCommand({
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
            tags: [{ key: TASK_MODE_TAG, value: mode }],
          }),
        );
        for (const task of launched.tasks ?? []) {
          if (task.taskArn !== undefined) tasks.push({ id: task.taskArn, mode });
        }
        for (const failure of launched.failures ?? []) {
          failures.push({
            reason: failure.reason ?? "unknown",
            ...(failure.detail === undefined ? {} : { detail: failure.detail }),
          });
        }
      }
      return { tasks, failures };
    },
  };
}
