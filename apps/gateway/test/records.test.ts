import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { RECORD_FIELDS } from "../src/record.ts";
import {
  CALLER_PROVIDER_KEY,
  EGMA_PROVIDER_KEY,
  eventually,
  GATEWAY_SECRET,
  INFERENCE_KEY_ID,
  openSocket,
  ORGANIZATION,
  records,
  standUp,
  watch,
  type Standing,
} from "./support/world.ts";

/**
 * What the gateway writes down, and everything it must not.
 *
 * This is the file that would fail if the Egma model gateway ever became a
 * place customers' conversations are kept. It drives one exchange of every
 * shape, carrying payload sentinels in every slot a payload can occupy — a
 * prompt, a tool definition, a transcript, the text a persona is about to
 * speak, a voice identifier, audio bytes — and then reads every line the
 * gateway wrote and every answer a caller got, and requires that not one of
 * them is there. The credentials get the same treatment from both directions:
 * Egma's own, which the gateway holds, and the caller's, which it strips.
 *
 * The second half is the other absence: no field here counts a provider usage
 * unit or any other customer-billable quantity, so these records cannot quietly
 * become the usage ledger this effort deliberately does not build.
 */

/** One sentinel per kind of thing a payload can be. None may ever be recorded. */
const PAYLOAD = {
  prompt: "SENTINEL-PROMPT-a-persona-would-say-this",
  tool: "SENTINEL-TOOL-DEFINITION-book_the_appointment",
  transcript: "SENTINEL-TRANSCRIPT-the-agent-said-this",
  speech: "SENTINEL-TTS-INPUT-the-persona-speaks-this",
  voice: "SENTINEL-VOICE-ID-5ee9feff-a-provider-voice",
} as const;

const SECRETS = [
  GATEWAY_SECRET,
  CALLER_PROVIDER_KEY,
  EGMA_PROVIDER_KEY.deepgram,
  EGMA_PROVIDER_KEY.openai,
  EGMA_PROVIDER_KEY.cartesia,
];

let standing: Standing;
/** Everything a caller ever saw, so a scan reads the responses too. */
const answers: string[] = [];

beforeAll(async () => {
  standing = await standUp();

  // One LLM exchange carrying a prompt and a tool definition.
  const llm = await fetch(`${standing.world.origin}/openai/v1/chat/completions`, {
    method: "POST",
    headers: {
      "egma-inference-key": GATEWAY_SECRET,
      "content-type": "application/json",
      authorization: `Bearer ${CALLER_PROVIDER_KEY}`,
    },
    body: JSON.stringify({
      model: "a-small-model",
      messages: [{ role: "user", content: PAYLOAD.prompt }],
      tools: [{ type: "function", function: { name: PAYLOAD.tool } }],
    }),
  });
  answers.push(await llm.text());

  // One listening exchange carrying audio and getting a transcript back.
  const listening = openSocket(
    standing.world,
    "/deepgram/v1/listen?model=nova-3-general&encoding=linear16",
    { headers: { "egma-inference-key": GATEWAY_SECRET } },
  );
  const heard = watch(listening);
  await heard.opened;
  listening.send(Buffer.from(PAYLOAD.transcript));
  listening.send(JSON.stringify({ channel: { alternatives: [{ transcript: PAYLOAD.transcript }] } }));
  await eventually(() => (heard.frames.length >= 2 ? heard.frames : undefined));
  answers.push(heard.frames.map(String).join("\n"));
  listening.close(1000, "done");

  // One speaking exchange carrying the words and the voice it speaks them in.
  const speaking = openSocket(standing.world, "/cartesia/tts/websocket", {
    headers: { "egma-inference-key": GATEWAY_SECRET },
  });
  const spoke = watch(speaking);
  await spoke.opened;
  speaking.send(JSON.stringify({ transcript: PAYLOAD.speech, voice: { id: PAYLOAD.voice } }));
  await eventually(() => (spoke.frames.length >= 1 ? spoke.frames : undefined));
  answers.push(spoke.frames.map(String).join("\n"));
  speaking.close(1000, "done");

  // And one refusal, so a refused connection's record is scanned too.
  const refused = await fetch(`${standing.world.origin}/openai/v1/chat/completions`, {
    method: "POST",
    headers: { "egma-inference-key": "not-the-secret", "content-type": "application/json" },
    body: JSON.stringify({ messages: [{ role: "user", content: PAYLOAD.prompt }] }),
  });
  answers.push(await refused.text());

  await eventually(() => (records(standing.world).length >= 4 ? true : undefined));
});

afterAll(async () => {
  await standing.world.stop();
});

describe("an operational record", () => {
  it("holds only the fields that were agreed, and nothing a later edit slipped in", () => {
    const allowed = new Set<string>([...RECORD_FIELDS, "at", "level", "message"]);
    for (const line of records(standing.world)) {
      for (const field of Object.keys(line)) {
        expect(allowed, `an unexpected field "${field}" reached a record`).toContain(field);
      }
    }
  });

  it("says who it was for, what was asked of whom, how it ended, and how much and how long", async () => {
    const written = await eventually(() =>
      records(standing.world).find((line) => line["provider"] === "deepgram"),
    );
    expect(written).toMatchObject({
      organizationId: ORGANIZATION,
      inferenceKeyId: INFERENCE_KEY_ID,
      provider: "deepgram",
      job: "stt",
      providerModelId: "nova-3-general",
      statusClass: "ok",
    });
    expect(written["requestId"]).toMatch(/^gwr_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(typeof written["startedAt"]).toBe("string");
    expect(typeof written["endedAt"]).toBe("string");
    expect(written["bytesToProvider"]).toBeGreaterThan(0);
    expect(written["bytesFromProvider"]).toBeGreaterThan(0);
    expect(typeof written["openMs"]).toBe("number");
    expect(typeof written["totalMs"]).toBe("number");
  });

  it("carries the provider's own identifier for the exchange, where the provider gave one", async () => {
    const written = await eventually(() =>
      records(standing.world).find((line) => line["provider"] === "openai" && line["statusClass"] === "ok"),
    );
    expect(written["upstreamRequestId"]).toBe("upstream-request-id-1");
  });

  it("names no model where the model was only ever inside a payload", async () => {
    const written = await eventually(() =>
      records(standing.world).find((line) => line["provider"] === "openai" && line["statusClass"] === "ok"),
    );
    // The OpenAI request named its model in the body, and the gateway does not
    // read bodies — so the honest record has no model rather than a parsed one.
    expect(written["providerModelId"]).toBeUndefined();
  });

  it("counts no provider usage unit and no customer-billable quantity", () => {
    const billable =
      /token|character|audio_?second|minute|usage|units?\b|credit|balance|invoice|cost|price|spend|quota/i;
    for (const line of records(standing.world)) {
      for (const field of Object.keys(line)) {
        expect(field, "a record field reads like a usage ledger's").not.toMatch(billable);
      }
    }
    // The byte counts that are here are the relay's own traffic, and there are
    // exactly two of them.
    const counting = RECORD_FIELDS.filter((field) => field.startsWith("bytes"));
    expect(counting).toEqual(["bytesToProvider", "bytesFromProvider"]);
  });
});

describe("a scan of everything the gateway wrote or answered", () => {
  const everything = (): string => [...standing.world.raw, ...answers].join("\n");

  for (const [what, sentinel] of Object.entries(PAYLOAD)) {
    it(`finds no ${what}, because the gateway carries payloads and never keeps them`, () => {
      expect(standing.world.raw.join("\n")).not.toContain(sentinel);
    });
  }

  for (const secret of SECRETS) {
    it(`finds no credential ending "${secret.slice(-6)}"`, () => {
      expect(everything()).not.toContain(secret);
    });
  }

  it("finds no authorization header value at all, in any spelling", () => {
    const written = everything().toLowerCase();
    expect(written).not.toContain("authorization");
    expect(written).not.toContain("api_key");
    expect(written).not.toContain("api-key");
    expect(written).not.toContain("bearer ");
    expect(written).not.toContain("token ");
  });

  it("finds no upstream address, so a record cannot say where Egma's account lives", () => {
    expect(standing.world.raw.join("\n")).not.toContain("127.0.0.1");
    expect(standing.world.raw.join("\n")).not.toContain("api.deepgram.com");
    expect(standing.world.raw.join("\n")).not.toContain("api.openai.com");
    expect(standing.world.raw.join("\n")).not.toContain("api.cartesia.ai");
  });

  it("proves the payload really did cross, so the absence above is not an empty exchange", () => {
    expect(standing.openai.seen.at(0)?.body).toContain(PAYLOAD.prompt);
    expect(standing.openai.seen.at(0)?.body).toContain(PAYLOAD.tool);
    expect(standing.deepgram.seen.at(0)?.frames.map(String).join()).toContain(PAYLOAD.transcript);
    expect(standing.cartesia.seen.at(0)?.frames.map(String).join()).toContain(PAYLOAD.speech);
    expect(standing.cartesia.seen.at(0)?.frames.map(String).join()).toContain(PAYLOAD.voice);
  });
});
