/** Read one credential document without making Ctrl-C wait for pipe EOF. */

import type { Readable } from "node:stream";

export type CredentialStdin = Readable & { readonly isTTY?: boolean };

export type CredentialStdinRead =
  | { readonly kind: "read"; readonly text: string }
  | { readonly kind: "interrupted" };

export type ApiKeyCredentialRead =
  | { readonly kind: "key"; readonly apiKey: string }
  | { readonly kind: "missing" }
  | { readonly kind: "invalid" }
  | { readonly kind: "interrupted" };

/**
 * Read until EOF, or detach every listener and return as soon as the command is
 * interrupted. The stream is paused, not destroyed, because process.stdin is
 * owned by the process rather than by one command helper.
 */
export async function readCredentialStdin(
  stdin: CredentialStdin | undefined,
  signal: AbortSignal | undefined,
): Promise<CredentialStdinRead> {
  if (signal?.aborted === true) return { kind: "interrupted" };
  if (stdin === undefined || stdin.isTTY === true) {
    return { kind: "read", text: "" };
  }

  return await new Promise<CredentialStdinRead>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let settled = false;

    const cleanup = (): void => {
      stdin.off("data", onData);
      stdin.off("end", onEnd);
      stdin.off("error", onError);
      signal?.removeEventListener("abort", onAbort);
    };
    const finish = (answer: CredentialStdinRead): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(answer);
    };
    const onData = (chunk: Buffer | string): void => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    };
    const onEnd = (): void => {
      finish({
        kind: "read",
        text: Buffer.concat(chunks).toString("utf8").trim(),
      });
    };
    const onError = (cause: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(cause);
    };
    const onAbort = (): void => {
      stdin.pause();
      finish({ kind: "interrupted" });
    };

    stdin.on("data", onData);
    stdin.once("end", onEnd);
    stdin.once("error", onError);
    signal?.addEventListener("abort", onAbort, { once: true });
    stdin.resume();
  });
}

/** Read one exact `{ "apiKey": "..." }` credential document. */
export async function readApiKeyCredential(
  stdin: CredentialStdin | undefined,
  signal: AbortSignal | undefined,
): Promise<ApiKeyCredentialRead> {
  const read = await readCredentialStdin(stdin, signal);
  if (read.kind === "interrupted") return read;
  if (read.text === "") return { kind: "missing" };

  let parsed: unknown;
  try {
    parsed = JSON.parse(read.text) as unknown;
  } catch {
    return { kind: "invalid" };
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    Array.isArray(parsed) ||
    Object.keys(parsed).length !== 1 ||
    !("apiKey" in parsed) ||
    typeof parsed.apiKey !== "string"
  ) {
    return { kind: "invalid" };
  }

  const apiKey = parsed.apiKey.trim();
  return apiKey === "" ? { kind: "missing" } : { kind: "key", apiKey };
}
