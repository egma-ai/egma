import { describe, expect, it, vi } from "vitest";
import { renderPersonaPreview } from "../src/persona-preview.ts";

describe("persona Preview client", () => {
  it("authenticates the private renderer and returns its audio", async () => {
    const fetcher = vi.fn(async (_url, init) => {
      expect(init?.headers).toMatchObject({ Authorization: "Bearer egma_st_fixture" });
      expect(JSON.parse(String(init?.body))).toMatchObject({ requestId: "preview-a" });
      return new Response(JSON.stringify({ audioBase64: "UklGRg==", contentType: "audio/wav", usage: { provider: "scripted" } }));
    });
    await expect(renderPersonaPreview({ url: "http://simulator:8091", serviceToken: "egma_st_fixture", fetch: fetcher }, { requestId: "preview-a" })).resolves.toMatchObject({ contentType: "audio/wav" });
  });

  it("passes client cancellation to the renderer request", async () => {
    const controller = new AbortController();
    const fetcher = vi.fn(async (_url, init) => {
      await new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true }));
      return new Response();
    });
    const rendering = renderPersonaPreview({ url: "http://simulator:8091", serviceToken: "egma_st_fixture", fetch: fetcher }, {}, controller.signal);
    controller.abort();
    await expect(rendering).rejects.toBeDefined();
  });
});
