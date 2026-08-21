import {
  createClient,
  type Refusal as PlatformRefusal,
} from "@egma/platform-api/client";

import {
  answerFor,
  unreachable,
  type Answer,
} from "./api.ts";

/**
 * The browser always calls the platform on the same origin as the page.
 * Next forwards `/v1` to the API, so the session cookie follows without a
 * second origin or a second authentication rule.
 */
export const platformClient = createClient({
  // The generated client builds a native Request, which needs an absolute URL
  // in Node-based browser tests. In a browser this is still the page's origin.
  baseUrl:
    typeof globalThis.location === "undefined"
      ? ""
      : globalThis.location.origin,
  cache: "no-store",
  credentials: "same-origin",
  responseStyle: "fields",
  throwOnError: false,
});

type PlatformResult<T> =
  | {
      readonly data: T;
      readonly error: undefined;
      readonly response?: Response;
    }
  | {
      readonly data: undefined;
      readonly error: PlatformRefusal | unknown;
      readonly response?: Response;
    };

export type PlatformRequest<T> = Promise<PlatformResult<T>>;

/** Keep the generated client's HTTP answer in the UI's existing four states. */
export async function platformAnswer<T>(
  request: PlatformRequest<T>,
): Promise<Answer<Exclude<T, undefined>>> {
  try {
    const result = await request;
    if (result.data !== undefined) {
      return {
        status: "ready",
        value: result.data as Exclude<T, undefined>,
      };
    }

    if (result.response === undefined) {
      return unreachable<Exclude<T, undefined>>();
    }
    return answerFor<Exclude<T, undefined>>(
      result.response.status,
      result.error,
    );
  } catch {
    return unreachable<Exclude<T, undefined>>();
  }
}
