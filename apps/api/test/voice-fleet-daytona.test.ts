import { TokenVerifier } from "livekit-server-sdk";
import { describe, expect, it, vi } from "vitest";

import {
  daytonaClaimRuntime,
  daytonaVoiceFleet,
  type DaytonaClient,
} from "../src/voice-fleet-daytona.ts";
import {
  awsRecordingRole,
  issueVoiceClaimCredentials,
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
  recordingBucketArn: "arn:aws:s3:::recordings",
};

const temporaryStorage = vi.fn(async () => ({
  accessKeyId: "temporary-access",
  secretAccessKey: "temporary-secret",
  sessionToken: "temporary-session",
}));

describe("Daytona voice credentials", () => {
  it("keeps the STS session token and scopes the role session lifetime", async () => {
    const send = vi.fn(async (_command: unknown) => ({
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
      policy: "scoped-policy",
    })).toEqual({
      accessKeyId: "temporary-access",
      secretAccessKey: "temporary-secret",
      sessionToken: "temporary-session",
    });
    const command = send.mock.calls.at(0)?.at(0) as
      | { readonly input: unknown }
      | undefined;
    expect(command?.input).toEqual({
      RoleArn: settings.recordingRoleArn,
      RoleSessionName: "egma-daytona-runtime",
      DurationSeconds: 1_200,
      Policy: "scoped-policy",
    });
  });

  it("scopes both LiveKit tokens to one room and the 20 minute execution window", async () => {
    const credentials = await issueVoiceClaimCredentials({
      settings,
      simulationId: "sim_123",
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
      sessionName: "egma-daytona-sim_123",
      durationSeconds: VOICE_CREDENTIAL_TTL_SECONDS,
      policy: JSON.stringify({
        Version: "2012-10-17",
        Statement: [{
          Effect: "Allow",
          Action: "s3:PutObject",
          Resource: "arn:aws:s3:::recordings/sim_123/dual-channel.wav",
        }],
      }),
    });
  });

  it("labels the claimed sandbox before returning per-simulation authority", async () => {
    const sandbox = {
      id: "sandbox-1",
      labels: {
        "egma.runtime": "voice-simulator",
        "egma.release_sha": "a".repeat(40),
      },
      process: { getEntrypointSession: vi.fn(async () => ({ commands: [] })) },
      setLabels: vi.fn(async (labels: Record<string, string>) => labels),
    };
    const client = {
      get: vi.fn(async () => sandbox),
    } as unknown as DaytonaClient;
    const assign = daytonaClaimRuntime(settings, {
      client,
      assumeRole: temporaryStorage,
    });

    const runtime = await assign("egma-voice-runtime-1", "sim_123");

    expect(client.get).toHaveBeenCalledWith("egma-voice-runtime-1");
    expect(sandbox.setLabels).toHaveBeenCalledWith({
      "egma.runtime": "voice-simulator",
      "egma.release_sha": "a".repeat(40),
      "egma.simulation_id": "sim_123",
    });
    expect(runtime).toMatchObject({
      kind: "daytona_voice",
      media: {
        backend: "livekit",
        livekit_url: "wss://livekit.example",
        livekit_room_name: "egma-sim-sim_123",
      },
      storage: {
        backend: "s3",
        endpoint: "https://s3.example",
        bucket: "recordings",
        region: "us-east-1",
        session_token: "temporary-session",
      },
    });
    expect(temporaryStorage).toHaveBeenLastCalledWith(expect.objectContaining({
      policy: expect.stringContaining("arn:aws:s3:::recordings/sim_123/dual-channel.wav"),
    }));
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
      setLabels: vi.fn(async (labels: Record<string, string>) => labels),
    };
    const refreshed = {
      id: "sandbox-1",
      state: "started",
      process: {
        getEntrypointSession: vi.fn(async () => ({ commands: [{ exitCode: 0 }] })),
      },
      setLabels: vi.fn(async (labels: Record<string, string>) => labels),
    };
    const create = vi.fn<DaytonaClient["create"]>(async () => created);
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
      id: () => "runtime-1",
      pollMilliseconds: 0,
    });

    expect(await fleet.launchTasks({ count: 1 })).toEqual({
      tasks: [{ id: "sandbox-1" }],
      failures: [],
    });
    const call = create.mock.calls.at(0);
    if (call === undefined) throw new Error("Daytona create was not called");
    const [request] = call;
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
    expect(request.envVars).toMatchObject({
      EGMA_SIMULATOR_RUNTIME: "daytona",
      EGMA_SIMULATOR_MODE: "one-shot",
      EGMA_SIMULATOR_MODALITIES: "voice",
      EGMA_SIMULATOR_VAD_PROVIDER: "silero",
    });
    expect(Object.keys(request.envVars)).not.toEqual(
      expect.arrayContaining([
        "EGMA_SIMULATOR_LIVEKIT_ROOM_NAME",
        "EGMA_SIMULATOR_LIVEKIT_ROOM_TOKEN",
        "EGMA_SIMULATOR_LIVEKIT_API_TOKEN",
        "EGMA_SIMULATOR_S3_ACCESS_KEY_ID",
        "EGMA_SIMULATOR_S3_SECRET_ACCESS_KEY",
        "EGMA_SIMULATOR_S3_SESSION_TOKEN",
      ]),
    );
    const raw = JSON.stringify(request.envVars);
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
      setLabels: vi.fn(async (labels: Record<string, string>) => labels),
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
      pollMilliseconds: 0,
    });

    expect(await fleet.listTasks()).toEqual([{ id: "existing" }]);
    expect(await fleet.launchTasks({ count: 1 })).toEqual({
      tasks: [],
      failures: [{ reason: "sandbox_create_failed", detail: "quota reached" }],
    });
  });
});
