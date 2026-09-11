export type PreviewReach = {
  readonly url: string;
  readonly serviceToken: string;
  readonly fetch?: typeof fetch;
};

export type PreviewRequest = Readonly<Record<string, unknown>>;
export type PreviewResponse = {
  readonly audioBase64: string;
  readonly contentType: string;
  readonly usage: readonly Readonly<Record<string, unknown>>[];
};

const PREVIEW_TIMEOUT_MILLISECONDS = 15_000;

export async function renderPersonaPreview(
  reach: PreviewReach,
  body: PreviewRequest,
  parentSignal?: AbortSignal,
): Promise<PreviewResponse> {
  const timeout = AbortSignal.timeout(PREVIEW_TIMEOUT_MILLISECONDS);
  const signal = parentSignal === undefined ? timeout : AbortSignal.any([parentSignal, timeout]);
  const response = await (reach.fetch ?? fetch)(`${reach.url}/internal/persona-preview`, {
    method: "POST",
    signal,
    headers: { Authorization: `Bearer ${reach.serviceToken}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`Persona Preview renderer failed with status ${response.status}.`);
  const result = await response.json() as Partial<PreviewResponse>;
  if (typeof result.audioBase64 !== "string" || result.audioBase64.length === 0 ||
      typeof result.contentType !== "string" || !Array.isArray(result.usage)) {
    throw new Error("Persona Preview renderer returned an invalid response.");
  }
  return result as PreviewResponse;
}
