import { TokenVerifier } from "livekit-server-sdk";
import { describe, expect, it, vi } from "vitest";

import { daytonaVoiceFleet, type DaytonaClient } from "../src/voice-fleet-daytona.ts";
import {
  awsRecordingRole,
  issueVoiceSandboxCredentials,
  VOICE_CREDENTIAL_TTL_SECONDS,
} from "../src/voice-fleet-credentials.ts";
import type { DaytonaVoiceFleetSettings } from "../src/voice-fleet.ts";

const settings: DaytonaVoiceFleetSettings = {
  kind: "daytona",
  apiKey: "daytona-control-key",
  snapshot: "snapshot-exact",
  releaseSha: "a".repeat(40),
  ttlMinutes: 30,
  serviceTokenSecret: "simulator-service-token-secret",
  providerSecrets: { EGMA_OPENAI_API_KEY: "platform-openai-secret" },
  controlPlaneUrl: "https://egma.example",
  livekitUrl: "wss://livekit.example",
  livekitApiKey: "livekit-key",
  livekitApiSecret: "livekit-secret-with-enough-entropy",
  s3Endpoint: "https://s3.example",
  s3Bucket: "recordings",
  s3Region: "us-east-1",
  recordingRoleArn: "arn:aws:iam::123:role/recording",
};

const temporaryStorage = vi.fn(async () => ({
  accessKeyId: "temporary-access",
  secretAccessKey: "temporary-secret",
  sessionToken: "temporary-session",
}));

describe("Daytona voice credentials", () => {
  it("keeps the STS session token and scopes the role session lifetime", async () => {
    const send = vi.fn(async () => ({
      Credentials: {
        AccessKeyId: "temporary-access",
        SecretAccessKey: "temporary-secret",
        SessionToken: "temporary-session",
      },
    }));
    const assume = awsRecordingRole({ send } as never);

    expect(await assume({
      roleArn: settings.recordingRoleArn,
      sessionName: "egma-daytona-runtime",
      durationSeconds: 1_200,
    })).toEqual({
      accessKeyId: "temporary-access",
      secretAccessKey: "temporary-secret",
      sessionToken: "temporary-session",
    });
    expect(send.mock.calls[0]?.[0].input).toEqual({
      RoleArn: settings.recordingRoleArn,
      RoleSessionName: "egma-daytona-runtime",
      DurationSeconds: 1_200,
    });
  });

  it("scopes both LiveKit tokens to one room and the 20 minute execution window", async () => {
    const credentials = await issueVoiceSandboxCredentials({
      settings,
      runtimeId: "runtime-1",
      roomName: "egma-sim-runtime-1",
      assumeRole: temporaryStorage,
    });
    const verifier = new TokenVerifier(settings.livekitApiKey, settings.livekitApiSecret);
    const participant = await verifier.verify(credentials.roomToken);
    const control = await verifier.verify(credentials.apiToken);

    expect(participant.sub).toBe("egma-persona");
    expect(participant.video).toMatchObject({
      room: "egma-sim-runtime-1",
      roomJoin: true,
      canPublish: true,
      canSubscribe: true,
    });
    expect(control.video).toMatchObject({ room: "egma-sim-runtime-1", roomAdmin: true });
    expect(control.sip).toEqual({ call: true });
    const payload = JSON.parse(Buffer.from(credentials.roomToken.split(".")[1] ?? "", "base64url").toString()) as { exp: number; nbf: number };
    expect(payload.exp - payload.nbf).toBe(VOICE_CREDENTIAL_TTL_SECONDS);
    expect(temporaryStorage).toHaveBeenCalledWith({
      roleArn: settings.recordingRoleArn,
      sessionName: "egma-daytona-runtime-1",
      durationSeconds: VOICE_CREDENTIAL_TTL_SECONDS,
    });
  });
});

describe("Daytona voice fleet", () => {
  it("creates one exact-snapshot sandbox with TTL, short lived credentials, and org secrets", async () => {
    const created = {
      id: "sandbox-1",
      state: "started",
      process: {
        getEntrypointSession: vi.fn(async () => { throw new Error("stale sandbox object used"); }),
      },
    };
    const refreshed = {
      id: "sandbox-1",
      state: "started",
      process: {
        getEntrypointSession: vi.fn(async () => ({ commands: [{ exitCode: 0 }] })),
      },
    };
    const create = vi.fn(async () => created);
    const remove = vi.fn(async () => undefined);
    const client: DaytonaClient = {
      create,
      get: vi.fn(async () => refreshed),
      delete: remove,
      async *list() {},
    };
    const fleet = daytonaVoiceFleet(settings, {
      client,
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      assumeRole: temporaryStorage,
      id: () => "runtime-1",
      pollMilliseconds: 0,
    });

    expect(await fleet.launchTasks({ count: 1 })).toEqual({
      tasks: [{ id: "sandbox-1" }],
      failures: [],
    });
    const request = create.mock.calls[0]?.[0];
    expect(request).toMatchObject({
      name: "egma-voice-runtime-1",
      snapshot: "snapshot-exact",
      ttlMinutes: 30,
      autoStopInterval: 0,
      autoPauseInterval: 0,
      labels: {
        "egma.release_sha": "a".repeat(40),
        "egma.snapshot_id": "snapshot-exact",
      },
      secrets: {
        EGMA_SIMULATOR_SERVICE_TOKEN: "simulator-service-token-secret",
        EGMA_OPENAI_API_KEY: "platform-openai-secret",
      },
    });
    expect(request).not.toHaveProperty("ephemeral");
    expect(request?.envVars).toMatchObject({
      EGMA_SIMULATOR_RUNTIME: "daytona",
      EGMA_SIMULATOR_MODE: "one-shot",
      EGMA_SIMULATOR_MODALITIES: "voice",
      EGMA_SIMULATOR_VAD_PROVIDER: "silero",
      EGMA_SIMULATOR_S3_SESSION_TOKEN: "temporary-session",
    });
    const raw = JSON.stringify(request?.envVars);
    expect(raw).not.toContain(settings.livekitApiSecret);
    expect(raw).not.toContain(settings.apiKey);
    expect(raw).not.toContain(settings.serviceTokenSecret);
    await vi.waitFor(() => expect(remove).toHaveBeenCalledWith(refreshed, 60, true));
    expect(client.get).toHaveBeenCalledWith("sandbox-1");
  });

  it("lists existing fleet sandboxes and reports isolated create failures", async () => {
    const sandbox = {
      id: "existing",
      state: "started",
      process: {
        getEntrypointSession: vi.fn(async () => ({ commands: [{ exitCode: 0 }] })),
      },
    };
    const client: DaytonaClient = {
      create: vi.fn(async () => { throw new Error("quota reached"); }),
      get: vi.fn(async () => sandbox),
      delete: vi.fn(async () => undefined),
      async *list(query) {
        expect(query).toEqual({ labels: { "egma.runtime": "voice-simulator" } });
        yield sandbox;
      },
    };
    const fleet = daytonaVoiceFleet(settings, {
      client,
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      assumeRole: temporaryStorage,
      pollMilliseconds: 0,
    });

    expect(await fleet.listTasks()).toEqual([{ id: "existing" }]);
    expect(await fleet.launchTasks({ count: 1 })).toEqual({
      tasks: [],
      failures: [{ reason: "sandbox_create_failed", detail: "quota reached" }],
    });
  });
});
