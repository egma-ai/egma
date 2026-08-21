export type FetchInput = string | URL | Request;

export type ObservedRequest = {
  readonly address: URL;
  readonly url: string;
  readonly path: string;
  readonly method: string;
  readonly body: unknown;
};

/** Read an address without consuming the request body. */
export function requestUrl(input: FetchInput): string {
  const address = new URL(
    input instanceof Request ? input.url : String(input),
    "http://egma.test",
  );
  return `${address.pathname}${address.search}`;
}

/** Read a native generated-client Request the same way the API receives it. */
export async function observeRequest(
  input: FetchInput,
  init?: RequestInit,
): Promise<ObservedRequest> {
  const request = input instanceof Request ? input : null;
  const address = new URL(request?.url ?? String(input), "http://egma.test");
  const method = request?.method ?? init?.method ?? "GET";
  const suppliedBody = init?.body;
  let body: unknown;

  if (typeof suppliedBody === "string") {
    body = JSON.parse(suppliedBody) as unknown;
  } else if (request !== null && method !== "GET" && method !== "HEAD") {
    const text = await request.clone().text();
    body = text === "" ? undefined : (JSON.parse(text) as unknown);
  }

  return {
    address,
    url: `${address.pathname}${address.search}`,
    path: address.pathname,
    method,
    body,
  };
}
