import { spawn } from "node:child_process";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { egmaBaseUrl } from "./egma-api.ts";

const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";

type StoredCredential = {
  readonly version: 1;
  readonly base_url: string;
  readonly access_token: string;
  readonly api_key_id: string;
  readonly organization_id: string;
  readonly project_id: string;
};

type DeviceGrant = {
  readonly device_code: string;
  readonly user_code: string;
  readonly verification_uri: string;
  readonly verification_uri_complete: string;
  readonly expires_in: number;
  readonly interval: number;
};

type TokenAnswer = {
  readonly access_token: string;
  readonly api_key_id: string;
  readonly organization_id: string;
  readonly project_id: string;
  readonly error?: string;
  readonly error_description?: string;
};

function credentialPath(): string {
  const configHome =
    process.env.EGMA_CONFIG_HOME ??
    process.env.XDG_CONFIG_HOME ??
    path.join(os.homedir(), ".config");
  return path.join(configHome, "egma", "credentials.json");
}

async function storedCredential(baseUrl: string): Promise<StoredCredential | null> {
  try {
    const parsed = JSON.parse(await readFile(credentialPath(), "utf8")) as StoredCredential;
    return parsed.version === 1 && parsed.base_url === baseUrl ? parsed : null;
  } catch {
    return null;
  }
}

export async function resolveApiKey(baseUrl: string): Promise<string | null> {
  const origin = egmaBaseUrl(baseUrl);
  const fromEnvironment = process.env.EGMA_API_KEY?.trim();
  if (fromEnvironment) return fromEnvironment;
  return (await storedCredential(origin))?.access_token ?? null;
}

function openBrowser(url: string): void {
  let command: string;
  let args: string[];
  if (process.platform === "darwin") {
    command = "open";
    args = [url];
  } else if (process.platform === "win32") {
    command = "rundll32.exe";
    args = ["url.dll,FileProtocolHandler", url];
  } else {
    command = "xdg-open";
    args = [url];
  }
  const child = spawn(command, args, {
    detached: true,
    stdio: "ignore",
  });
  child.on("error", () => {
    // The complete address is already printed, so a missing opener is harmless.
  });
  child.unref();
}

async function json<T>(response: Response): Promise<T> {
  const body = (await response.json().catch(() => ({}))) as T & {
    readonly message?: string;
  };
  if (!response.ok) {
    throw new Error(body.message ?? `Egma answered HTTP ${response.status}`);
  }
  return body;
}

async function wait(milliseconds: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export async function login(baseUrl: string): Promise<{
  readonly apiKeyId: string;
  readonly projectId: string;
}> {
  const origin = egmaBaseUrl(baseUrl);
  const grant = await json<DeviceGrant>(
    await fetch(`${origin}/api/device/code`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_id: "egma-cli" }),
    }),
  );
  const verificationUrl = egmaBaseUrl(grant.verification_uri_complete);

  process.stdout.write(
    [
      "Open this address to approve the terminal:",
      verificationUrl,
      `Code: ${grant.user_code}`,
      "",
    ].join("\n"),
  );
  try {
    openBrowser(verificationUrl);
  } catch {
    // Printing the complete address is the reliable path. Opening it is a help.
  }

  const began = Date.now();
  let interval = grant.interval * 1_000;
  for (;;) {
    if (Date.now() - began >= grant.expires_in * 1_000) {
      throw new Error("the device login expired; run `egma auth login` again");
    }
    await wait(interval);
    const response = await fetch(`${origin}/api/device/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: DEVICE_GRANT,
        device_code: grant.device_code,
      }),
    });
    const answer = (await response.json().catch(() => ({}))) as TokenAnswer;
    if (!response.ok) {
      if (answer.error === "authorization_pending") continue;
      if (answer.error === "slow_down") {
        interval += 5_000;
        continue;
      }
      throw new Error(
        answer.error_description ?? answer.error ?? "device login failed",
      );
    }

    const saved: StoredCredential = {
      version: 1,
      base_url: origin,
      access_token: answer.access_token,
      api_key_id: answer.api_key_id,
      organization_id: answer.organization_id,
      project_id: answer.project_id,
    };
    const file = credentialPath();
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    await writeFile(file, `${JSON.stringify(saved, null, 2)}\n`, {
      mode: 0o600,
    });
    await chmod(file, 0o600);
    return { apiKeyId: saved.api_key_id, projectId: saved.project_id };
  }
}
