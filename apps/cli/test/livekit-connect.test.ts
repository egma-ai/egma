/**
 * LiveKit's two connection shapes through the CLI's provider module and the
 * fixture platform. There is no fake LiveKit server here on purpose: setup
 * registers what the simulator will use later and does not probe the target.
 */

import { inspect } from "node:util";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  connectLiveKit,
  liveKitKeyPair,
  liveKitTokenHeaders,
  LIVEKIT_KEY_PAIR_VARIANT,
  LIVEKIT_TOKEN_ENDPOINT_VARIANT,
  type LiveKitRegistration,
} from "../src/livekit/connect.ts";
import {
  ConnectionCredentials,
  MASKED_CONNECTION_CREDENTIALS,
} from "../src/platform/connection-credentials.ts";
import {
  connectionTypeNamed,
  readConnectionTypes,
} from "../src/platform/connection-types.ts";
import { startPlatform, type Platform } from "./support/fixture-platform/index.ts";

const API_KEY = "APIhx4bmvHnLcWXYZ";
const API_SECRET = "livekit-secret-E5F6G7H8QRST";
const HEADERS = '{"Authorization":"Bearer private-token","x-workspace":"acme"}';

let platform: Platform;
let key: string;

beforeEach(async () => {
  platform = await startPlatform();
  key = platform.device.mint();
});

afterEach(async () => {
  await platform.close();
});

function options() {
  return { url: platform.url, key };
}

describe("the key-pair shape", () => {
  it("registers the server, optional dispatch fields, and sealed pair", async () => {
    const credentials = liveKitKeyPair(API_KEY, API_SECRET);
    const input: LiveKitRegistration = {
      variant: LIVEKIT_KEY_PAIR_VARIANT,
      name: "front-desk",
      url: " wss://acme.livekit.cloud ",
      agentName: " receptionist ",
      metadata: ' {"tenant":"acme"} ',
      credentials,
    };

    const result = await connectLiveKit(input, options());

    expect(result.kind).toBe("registered");
    if (result.kind !== "registered") return;
    expect(result.registered.result).toBe("created");
    expect(result.registered.agent.name).toBe("front-desk");
    expect(result.registered.connection).toMatchObject({
      name: "livekit-1",
      type: "livekit",
      modality: "voice",
      credentialsHint: API_KEY.slice(-4),
      config: {
        url: "wss://acme.livekit.cloud",
        agentName: "receptionist",
        metadata: '{"tenant":"acme"}',
      },
    });
    expect(platform.registered.sealed).toEqual([API_KEY, API_SECRET]);
  });

  it("keeps both fields out of string, JSON, and Node inspection", () => {
    const credentials = liveKitKeyPair(API_KEY, API_SECRET);
    const shown = [String(credentials), JSON.stringify(credentials), inspect(credentials)];

    expect(shown).toEqual([
      MASKED_CONNECTION_CREDENTIALS,
      `"${MASKED_CONNECTION_CREDENTIALS}"`,
      MASKED_CONNECTION_CREDENTIALS,
    ]);
    expect(shown.join(" ")).not.toContain(API_KEY);
    expect(shown.join(" ")).not.toContain(API_SECRET);
  });

  it("does not open deferred credentials while they are inspected", () => {
    const reveal = vi.fn(() => ({ apiKey: API_KEY }));
    const credentials = ConnectionCredentials.defer(reveal);

    String(credentials);
    JSON.stringify(credentials);
    inspect(credentials);

    expect(reveal).not.toHaveBeenCalled();
    expect(credentials.reveal()).toEqual({ apiKey: API_KEY });
    expect(reveal).toHaveBeenCalledOnce();
  });
});

describe("the token-endpoint shape", () => {
  it("registers an unreachable endpoint without probing it", async () => {
    const result = await connectLiveKit(
      {
        variant: LIVEKIT_TOKEN_ENDPOINT_VARIANT,
        name: "front-desk",
        url: "wss://acme.livekit.cloud",
        // Nothing is listening here. Registration succeeding proves setup did
        // not try to dispatch or fetch a token.
        tokenEndpoint: "https://127.0.0.1:1/livekit/token",
        credentials: liveKitTokenHeaders(HEADERS),
      },
      options(),
    );

    expect(result.kind).toBe("registered");
    if (result.kind !== "registered") return;
    expect(result.registered.connection).toMatchObject({
      type: "livekit",
      modality: "voice",
      credentialsHint: "Authorization, x-workspace",
      config: {
        url: "wss://acme.livekit.cloud",
        tokenEndpoint: "https://127.0.0.1:1/livekit/token",
      },
    });
    expect(platform.registered.sealed).toEqual([HEADERS]);
  });

  it("allows a token endpoint with no auth headers", async () => {
    const result = await connectLiveKit(
      {
        variant: LIVEKIT_TOKEN_ENDPOINT_VARIANT,
        name: "private-network-agent",
        url: "wss://acme.livekit.cloud",
        tokenEndpoint: "https://tokens.internal.example/livekit",
      },
      options(),
    );

    expect(result.kind).toBe("registered");
    if (result.kind !== "registered") return;
    expect(result.registered.connection.credentialsHint).toBeNull();
    expect(platform.registered.sealed).toEqual([]);
  });

  it("does not silently merge two LiveKit targets that use one name", async () => {
    await connectLiveKit(
      {
        variant: LIVEKIT_KEY_PAIR_VARIANT,
        name: "front-desk",
        url: "wss://first.livekit.cloud",
        credentials: liveKitKeyPair(API_KEY, API_SECRET),
      },
      options(),
    );

    const second = await connectLiveKit(
      {
        variant: LIVEKIT_TOKEN_ENDPOINT_VARIANT,
        name: "front-desk",
        url: "wss://second.livekit.cloud",
        tokenEndpoint: "https://tokens.example/livekit",
      },
      options(),
    );

    expect(second).toEqual({ kind: "name-taken", name: "front-desk" });
    expect(platform.registered.agents).toHaveLength(1);
    expect(platform.registered.connections).toHaveLength(1);
  });
});

describe("the server-owned connection form", () => {
  it("reads LiveKit's two variants instead of keeping a CLI field list", async () => {
    const fetchImpl = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      expect(init?.headers).toEqual({ authorization: "Bearer machine-key" });
      return new Response(
        JSON.stringify({
          items: [
            {
              type: "livekit",
              label: "LiveKit",
              modalities: ["voice"],
              topology: "agent-dials-out",
              simulator_adapter: true,
              capability_discovery: false,
              variants: [
                {
                  id: LIVEKIT_KEY_PAIR_VARIANT,
                  label: "LiveKit project credentials — Recommended",
                  chosen_by: null,
                  fields: [
                    {
                      key: "url",
                      label: "LiveKit server URL",
                      kind: "url",
                      required: true,
                      help: "The server.",
                    },
                  ],
                  credential_rule: "required",
                  credential_help: "Stored sealed.",
                  credential_fields: [
                    {
                      field: "apiKey",
                      label: "API key",
                      kind: "secret",
                      required: true,
                      help: "The public half.",
                    },
                  ],
                },
                {
                  id: LIVEKIT_TOKEN_ENDPOINT_VARIANT,
                  label: "Customer token endpoint — Advanced",
                  chosen_by: "tokenEndpoint",
                  fields: [],
                  credential_rule: "optional",
                  credential_help: "Optional auth headers.",
                  credential_fields: [],
                },
              ],
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });

    const result = await readConnectionTypes({
      url: "https://egma.example/",
      key: "machine-key",
      fetchImpl: fetchImpl as typeof fetch,
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(String(fetchImpl.mock.calls[0]?.[0])).toBe(
      "https://egma.example/api/connection-types",
    );
    expect(result.kind).toBe("catalog");
    if (result.kind !== "catalog") return;
    const livekit = connectionTypeNamed(result.catalog, "livekit");
    expect(livekit).toMatchObject({
      type: "livekit",
      label: "LiveKit",
      modalities: ["voice"],
      simulatorAdapter: true,
      capabilityDiscovery: false,
    });
    expect(livekit?.variants.map((variant) => variant.id)).toEqual([
      LIVEKIT_KEY_PAIR_VARIANT,
      LIVEKIT_TOKEN_ENDPOINT_VARIANT,
    ]);
    expect(livekit?.variants[0]?.fields[0]).toEqual({
      key: "url",
      label: "LiveKit server URL",
      kind: "url",
      required: true,
      help: "The server.",
    });
  });
});
