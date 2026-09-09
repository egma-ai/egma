import { AssumeRoleCommand, STSClient } from "@aws-sdk/client-sts";
import { AccessToken } from "livekit-server-sdk";

export const VOICE_CREDENTIAL_TTL_SECONDS = 20 * 60;

export type VoiceClaimCredentials = {
  readonly roomName: string;
  readonly roomToken: string;
  readonly apiToken: string;
  readonly s3AccessKeyId: string;
  readonly s3SecretAccessKey: string;
  readonly s3SessionToken: string;
};

export type DaytonaVoiceRuntime = {
  readonly kind: "daytona_voice";
  readonly media: {
    readonly backend: "livekit";
    readonly livekit_url: string;
    readonly livekit_room_name: string;
    readonly livekit_room_token: string;
    readonly livekit_api_token: string;
  };
  readonly storage: {
    readonly backend: "s3";
    readonly endpoint: string;
    readonly bucket: string;
    readonly region: string;
    readonly access_key_id: string;
    readonly secret_access_key: string;
    readonly session_token: string;
  };
};

export type VoiceCredentialSettings = {
  readonly livekitUrl: string;
  readonly livekitApiKey: string;
  readonly livekitApiSecret: string;
  readonly recordingRoleArn: string;
  readonly recordingBucketArn: string;
  readonly s3Endpoint: string;
  readonly s3Bucket: string;
  readonly s3Region: string;
};

export type AssumeRecordingRole = (options: {
  readonly roleArn: string;
  readonly sessionName: string;
  readonly durationSeconds: number;
  readonly policy: string;
  readonly signal?: AbortSignal | undefined;
}) => Promise<{
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly sessionToken: string;
}>;

export function awsRecordingRole(client = new STSClient({})): AssumeRecordingRole {
  return async ({ roleArn, sessionName, durationSeconds, policy, signal }) => {
    const response = await client.send(new AssumeRoleCommand({
      RoleArn: roleArn,
      RoleSessionName: sessionName,
      DurationSeconds: durationSeconds,
      Policy: policy,
    }), signal === undefined ? undefined : { abortSignal: signal });
    const credentials = response.Credentials;
    if (!credentials?.AccessKeyId || !credentials.SecretAccessKey || !credentials.SessionToken) {
      throw new Error("the recording role returned incomplete temporary credentials");
    }
    return {
      accessKeyId: credentials.AccessKeyId,
      secretAccessKey: credentials.SecretAccessKey,
      sessionToken: credentials.SessionToken,
    };
  };
}

export async function issueVoiceClaimCredentials(options: {
  readonly settings: VoiceCredentialSettings;
  readonly simulationId: string;
  readonly roomName: string;
  readonly assumeRole: AssumeRecordingRole;
  readonly signal?: AbortSignal | undefined;
}): Promise<VoiceClaimCredentials> {
  const { settings, simulationId, roomName } = options;
  options.signal?.throwIfAborted();
  const participant = new AccessToken(settings.livekitApiKey, settings.livekitApiSecret, {
    identity: "egma-persona",
    ttl: VOICE_CREDENTIAL_TTL_SECONDS,
  });
  participant.addGrant({
    roomJoin: true,
    room: roomName,
    canPublish: true,
    canSubscribe: true,
    canPublishData: true,
  });

  const control = new AccessToken(settings.livekitApiKey, settings.livekitApiSecret, {
    ttl: VOICE_CREDENTIAL_TTL_SECONDS,
  });
  control.addGrant({ roomAdmin: true, room: roomName });
  control.addSIPGrant({ call: true });

  const [roomToken, apiToken, storage] = await Promise.all([
    participant.toJwt(),
    control.toJwt(),
    options.assumeRole({
      roleArn: settings.recordingRoleArn,
      sessionName: `egma-daytona-${simulationId}`.slice(0, 64),
      durationSeconds: VOICE_CREDENTIAL_TTL_SECONDS,
      policy: JSON.stringify({
        Version: "2012-10-17",
        Statement: [{
          Effect: "Allow",
          Action: "s3:PutObject",
          Resource: `${settings.recordingBucketArn}/${simulationId}/dual-channel.wav`,
        }],
      }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    }),
  ]);
  options.signal?.throwIfAborted();
  return {
    roomName,
    roomToken,
    apiToken,
    s3AccessKeyId: storage.accessKeyId,
    s3SecretAccessKey: storage.secretAccessKey,
    s3SessionToken: storage.sessionToken,
  };
}

export async function issueDaytonaVoiceRuntime(options: {
  readonly settings: VoiceCredentialSettings;
  readonly simulationId: string;
  readonly assumeRole: AssumeRecordingRole;
  readonly signal?: AbortSignal | undefined;
}): Promise<DaytonaVoiceRuntime> {
  const roomName = `egma-sim-${options.simulationId}`;
  const credentials = await issueVoiceClaimCredentials({
    ...options,
    roomName,
  });
  return {
    kind: "daytona_voice",
    media: {
      backend: "livekit",
      livekit_url: options.settings.livekitUrl,
      livekit_room_name: credentials.roomName,
      livekit_room_token: credentials.roomToken,
      livekit_api_token: credentials.apiToken,
    },
    storage: {
      backend: "s3",
      endpoint: options.settings.s3Endpoint,
      bucket: options.settings.s3Bucket,
      region: options.settings.s3Region,
      access_key_id: credentials.s3AccessKeyId,
      secret_access_key: credentials.s3SecretAccessKey,
      session_token: credentials.s3SessionToken,
    },
  };
}
