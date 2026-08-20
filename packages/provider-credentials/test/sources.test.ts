import { describe, expect, it, vi } from "vitest";

import {
  ProviderCredentialMissingError,
  ProviderCredentialSourceUnavailableError,
  credentialFor,
  environmentProviderCredentialSource,
  providerAccountFor,
  providerCredentialSource,
  secretsManagerProviderCredentialSource,
} from "../src/index.ts";

describe("provider credential accounts", () => {
  it("accepts only provider-account names from the model catalog", () => {
    expect(providerAccountFor("openai")).toBe("openai");
    expect(providerAccountFor("deepgram")).toBe("deepgram");
    expect(providerAccountFor("cartesia")).toBe("cartesia");
    expect(providerAccountFor("openai_realtime")).toBeUndefined();
    expect(providerAccountFor("unknown-provider")).toBeUndefined();
  });

  it("resolves only the selected account and never falls back", () => {
    const bundle = { openai: "openai-current" } as const;
    expect(credentialFor(bundle, "openai")).toBe("openai-current");
    expect(() => credentialFor(bundle, "openai_realtime")).toThrow(
      "no credential-account mapping",
    );
    expect(() => credentialFor(bundle, "deepgram")).toThrow(
      ProviderCredentialMissingError,
    );
    expect(() => credentialFor(bundle, "cartesia")).toThrow(
      "no cartesia key",
    );
  });
});

describe("environment provider credentials", () => {
  it("reads one key per provider account and drops empty values", async () => {
    const source = environmentProviderCredentialSource({
      EGMA_OPENAI_API_KEY: "  openai-current  ",
      EGMA_DEEPGRAM_API_KEY: "deepgram-current",
      EGMA_CARTESIA_API_KEY: "   ",
    });

    await expect(source.load()).resolves.toEqual({
      openai: "openai-current",
      deepgram: "deepgram-current",
    });
  });
});

describe("the shared deployment selector", () => {
  it("uses self-host keys unless both Egma cloud variables name AWS", async () => {
    const selfHosted = providerCredentialSource({
      AWS_REGION: "eu-west-1",
      EGMA_OPENAI_API_KEY: "self-host-openai",
    });
    await expect(selfHosted.load()).resolves.toEqual({
      openai: "self-host-openai",
    });

    expect(() =>
      providerCredentialSource({
        EGMA_PROVIDER_CREDENTIALS_SECRET_ID: "egma/providers",
      }),
    ).toThrow("EGMA_PROVIDER_CREDENTIALS_REGION");
    expect(() =>
      providerCredentialSource({
        EGMA_PROVIDER_CREDENTIALS_REGION: "us-west-2",
      }),
    ).toThrow("EGMA_PROVIDER_CREDENTIALS_SECRET_ID");
    expect(() =>
      providerCredentialSource({
        EGMA_PROVIDER_CREDENTIALS_SECRET_ID: "egma/providers",
        EGMA_PROVIDER_CREDENTIALS_REGION: "us-west-2",
      }),
    ).not.toThrow();
  });
});

describe("AWS Secrets Manager provider credentials", () => {
  it("reads the current bundle on every load without keeping a cross-work cache", async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce({
        SecretString: JSON.stringify({
          openai_api_key: "openai-first",
          cartesia_api_key: "cartesia-first",
          ignored: "not-a-provider-key",
        }),
      })
      .mockResolvedValueOnce({
        SecretString: JSON.stringify({
          openai_api_key: "openai-rotated",
          deepgram_api_key: "deepgram-added",
        }),
      });
    const source = secretsManagerProviderCredentialSource({
      secretId: "egma/providers",
      region: "us-west-2",
      client: { send },
    });

    await expect(source.load()).resolves.toEqual({
      openai: "openai-first",
      cartesia: "cartesia-first",
    });
    await expect(source.load()).resolves.toEqual({
      openai: "openai-rotated",
      deepgram: "deepgram-added",
    });
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[0]?.[0].input).toEqual({
      SecretId: "egma/providers",
    });
  });

  it("turns unreadable or malformed secret values into a safe typed failure", async () => {
    const providerMessage = "provider leaked openai-super-secret";
    const failures = [
      { send: vi.fn().mockRejectedValue(new Error(providerMessage)) },
      { send: vi.fn().mockResolvedValue({}) },
      { send: vi.fn().mockResolvedValue({ SecretString: "not-json" }) },
      {
        send: vi.fn().mockResolvedValue({
          SecretString: JSON.stringify({ openai_api_key: 42 }),
        }),
      },
    ];

    for (const client of failures) {
      const source = secretsManagerProviderCredentialSource({
        secretId: "egma/providers",
        region: "us-west-2",
        client,
      });
      const error = await source.load().catch((fault: unknown) => fault);
      expect(error).toBeInstanceOf(ProviderCredentialSourceUnavailableError);
      expect(String(error)).not.toContain(providerMessage);
      expect(String(error)).not.toContain("openai-super-secret");
    }
  });
});
