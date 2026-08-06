import { describe, expect, it } from "vitest";

import { EgmaApi, egmaBaseUrl } from "../src/egma-api.ts";

describe("Egma API addresses", () => {
  it("refuses to send credentials over remote HTTP", () => {
    expect(() => new EgmaApi("http://egma.example", "egma_sk_secret")).toThrow(
      /must use HTTPS/,
    );
  });

  it("allows HTTP only on loopback development addresses", () => {
    expect(egmaBaseUrl("http://localhost:3100/")).toBe(
      "http://localhost:3100",
    );
    expect(egmaBaseUrl("http://127.0.0.1:3100/")).toBe(
      "http://127.0.0.1:3100",
    );
    expect(egmaBaseUrl("http://[::1]:3100/")).toBe("http://[::1]:3100");
  });

  it("accepts HTTPS and rejects embedded credentials", () => {
    expect(egmaBaseUrl("https://egma.example/")).toBe("https://egma.example");
    expect(() => egmaBaseUrl("https://name:secret@egma.example")).toThrow(
      /must not contain/,
    );
  });
});
