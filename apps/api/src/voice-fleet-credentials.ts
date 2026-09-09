import { AssumeRoleCommand, STSClient } from "@aws-sdk/client-sts";
import { AccessToken } from "livekit-server-sdk";

export const VOICE_CREDENTIAL_TTL_SECONDS = 20 * 60;

export type VoiceSandboxCredentials = {
  readonly roomName: string;
  readonly roomToken: string;
  readonly apiToken: string;
  readonly s3AccessKeyId: string;
  readonly s3SecretAccessKey: string;
  readonly s3SessionToken: string;
};

export type VoiceCredentialSettings = {
  readonly livekitApiKey: string;
  readonly livekitApiSecret: string;
  readonly recordingRoleArn: string;
};

export type AssumeRecordingRole = (options: {
  readonly roleArn: string;
  readonly sessionName: string;
  readonly durationSeconds: number;
}) => Promise<{
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly sessionToken: string;
}>;

export function awsRecordingRole(client = new STSClient({})): AssumeRecordingRole {
  return async ({ roleArn, sessionName, durationSeconds }) => {
    const response = await client.send(new AssumeRoleCommand({
      RoleArn: roleArn,
      RoleSessionName: sessionName,
      DurationSeconds: durationSeconds,
    }));
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

export async function issueVoiceSandboxCredentials(options: {
  readonly settings: VoiceCredentialSettings;
  readonly runtimeId: string;
  readonly roomName: string;
  readonly assumeRole: AssumeRecordingRole;
}): Promise<VoiceSandboxCredentials> {
  const { settings, runtimeId, roomName } = options;
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
      sessionName: `egma-daytona-${runtimeId}`.slice(0, 64),
      durationSeconds: VOICE_CREDENTIAL_TTL_SECONDS,
    }),
  ]);
  return {
    roomName,
    roomToken,
    apiToken,
    s3AccessKeyId: storage.accessKeyId,
    s3SecretAccessKey: storage.secretAccessKey,
    s3SessionToken: storage.sessionToken,
  };
}
