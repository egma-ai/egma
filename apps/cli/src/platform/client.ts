import {
  createClient,
  type Client,
} from "@egma/platform-api/client";

import { PlatformUnreachableError, type Fetch } from "./device-flow.ts";
import type { SignedIn } from "./signed-in.ts";

/**
 * Keep the CLI's injectable fetch seam while the generated client uses a
 * Request object internally. In-process API tests and other callers of this
 * seam receive the same URL-and-init form as the CLI used before generation.
 */
function platformFetch(fetchImpl: Fetch): typeof fetch {
  return async (input, init) => {
    if (!(input instanceof Request) || init !== undefined) {
      return fetchImpl(input, init);
    }

    const body = input.body === null ? undefined : await input.text();
    return fetchImpl(input.url, {
      method: input.method,
      headers: input.headers,
      ...(body === undefined ? {} : { body }),
      signal: input.signal,
    });
  };
}

/** A string from the platform with no terminal control characters. */
export function platformText(value: unknown): string {
  return typeof value === "string"
    ? value.replaceAll(/[\p{Cc}\p{Cf}]/gu, "").trim()
    : "";
}

/** The platform's refusal message, or a safe fallback for an empty response. */
export function platformRefusalMessage(error: unknown, status: number): string {
  const message =
    typeof error === "object" && error !== null && "message" in error
      ? platformText(error.message)
      : "";
  return message === ""
    ? `Egma answered ${String(status)} and said nothing about it`
    : message;
}

/** Configure the shared generated client for one signed-in CLI operation. */
export function platformClient(
  signedIn: SignedIn,
  fetchImpl: Fetch = fetch,
): Client {
  return createClient({
    baseUrl: signedIn.url.replace(/\/+$/u, ""),
    auth: (security) => security.scheme === "bearer" ? signedIn.key : undefined,
    fetch: platformFetch(fetchImpl),
    responseStyle: "fields",
    throwOnError: false,
  });
}

/** The stable CLI sentence for a request that reached no platform response. */
export function platformUnreachableMessage(url: string): string {
  return `Egma at ${url} did not answer. Check the address, and that the platform is running.`;
}

/** The HTTP response for a generated call, or the normal transport error. */
export function platformResponse(
  answer: { readonly error?: unknown; readonly response?: Response },
  url: string,
): Response {
  if (answer.response === undefined) {
    throw new PlatformUnreachableError(url, answer.error);
  }
  return answer.response;
}
