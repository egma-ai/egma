import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  INTERNAL_CREDENTIAL_ID,
  INTERNAL_CREDENTIAL_PREFIX,
  isAuthenticated,
  type Verified,
  type Verifier,
} from "../src/verify.ts";
import {
  CALLER_PROVIDER_KEY,
  EGMA_PROVIDER_KEY,
  eventually,
  GATEWAY_SECRET,
  INFERENCE_KEY_ID,
  INTERNAL_KEY,
  openSocket,
  ORGANIZATION,
  records,
  standUp,
  watch,
  type Standing,
} from "./support/world.ts";

/**
 * Who a connection is for, where that answer comes from, and what it costs a
 * caller to disagree.
 *
 * Two rules are proved here and they are the two the whole managed-access
 * design leans on. **A connection is authenticated once, when it opens** — not
 * per audio frame, which is why a long simulation pays nothing for it and why a
 * revoked credential takes effect on the next connection rather than the next
 * frame. And **the organization comes from the credential and from nowhere
 * else** — not from a header, not from a query value, not from a path, not from
 * a body — so a caller who can open a connection still cannot act as anybody
 * but themselves.
 */

let standing: Standing;

beforeAll(async () => {
  standing = await standUp();
});

afterAll(async () => {
  await standing.world.stop();
});

/**
 * One internal gateway credential, minted the way the control plane mints one.
 *
 * Written out here rather than imported from the control plane on purpose: this
 * format is the one thing the two deployables have to agree about across a
 * boundary that cannot be crossed by an import — the gateway runs on Cloudflare
 * Workers and cannot load a package that speaks to Postgres. So one side mints
 * and the other checks, and the deterministic suite is where they meet.
 */
async function internalCredential(
  organizationId: string,
  livesForSeconds = 3600,
): Promise<string> {
  const payload = btoa(
    JSON.stringify({
      o: organizationId,
      x: Math.floor(Date.now() / 1000) + livesForSeconds,
    }),
  )
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(INTERNAL_KEY),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signed = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(payload),
  );
  let binary = "";
  for (const byte of new Uint8Array(signed)) binary += String.fromCharCode(byte);
  const signature = binary === "" ? "" : btoa(binary);
  return `${INTERNAL_CREDENTIAL_PREFIX}${payload}.${signature
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "")}`;
}

/** One relayed LLM request, with whatever authentication the test wants to try. */
async function ask(
  headers: Record<string, string>,
  query = "",
  body: unknown = { model: "a-small-model", messages: [{ role: "user", content: "hello" }] },
): Promise<Response> {
  return fetch(`${standing.world.origin}/openai/v1/chat/completions${query}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

describe("the credential a caller offers", () => {
  it("is taken from the gateway's own header", async () => {
    expect((await ask({ "egma-inference-key": GATEWAY_SECRET })).status).toBe(200);
  });

  it("is taken from the gateway's own query parameter, for a client that cannot set a header", async () => {
    expect((await ask({}, `?egma_inference_key=${GATEWAY_SECRET}`)).status).toBe(200);
  });

  /**
   * The compatibility carrier, and the reason it exists: a shipped provider
   * adapter is handed the Egma credential where it expects a provider key and
   * needs no change at all. The next test proves the other half — that the
   * value stops here whichever slot it arrived in.
   */
  it("is taken from the provider's own authorization slot, so a shipped adapter needs no change", async () => {
    expect((await ask({ authorization: `Bearer ${GATEWAY_SECRET}` })).status).toBe(200);

    const listening = openSocket(standing.world, "/deepgram/v1/listen", {
      headers: { authorization: `Token ${GATEWAY_SECRET}` },
    });
    await watch(listening).opened;
    listening.close(1000, "done");

    const speaking = openSocket(
      standing.world,
      `/cartesia/tts/websocket?api_key=${GATEWAY_SECRET}`,
    );
    await watch(speaking).opened;
    speaking.close(1000, "done");
  });
});

describe("caller-supplied provider authorization", () => {
  it("never reaches the provider, even beside a valid gateway credential", async () => {
    const answered = await ask({
      "egma-inference-key": GATEWAY_SECRET,
      authorization: `Bearer ${CALLER_PROVIDER_KEY}`,
      "x-api-key": CALLER_PROVIDER_KEY,
      "api-key": CALLER_PROVIDER_KEY,
      cookie: `session=${CALLER_PROVIDER_KEY}`,
    });
    expect(answered.status).toBe(200);

    const seen = standing.openai.seen.at(-1);
    expect(seen?.headers["authorization"]).toBe(`Bearer ${EGMA_PROVIDER_KEY.openai}`);
    expect(JSON.stringify(seen?.headers)).not.toContain(CALLER_PROVIDER_KEY);
  });

  it("never reaches a socket provider, in a header, a query, or a subprotocol", async () => {
    /**
     * Every slot at once, and each one was a real hole.
     *
     * `?api_key=` and `?token=` are not this route's own credential parameter,
     * so the first version of this gateway forwarded both straight through.
     * `Sec-WebSocket-Protocol: token, <key>` is Deepgram's own documented
     * carrier for a client that cannot set a header, so a forwarded subprotocol
     * list is a forwarded key. The `xi-api-key` header belongs to a provider
     * this gateway does not even ship, which is exactly why a list of the three
     * it does ship was the wrong shape for the rule.
     */
    const deepgramsSoFar = standing.deepgram.seen.length;
    const cartesiasSoFar = standing.cartesia.seen.length;
    const listening = openSocket(
      standing.world,
      `/deepgram/v1/listen?model=nova-3-general&api_key=${CALLER_PROVIDER_KEY}` +
        `&token=${CALLER_PROVIDER_KEY}&access_token=${CALLER_PROVIDER_KEY}` +
        `&keyterm=${encodeURIComponent("a word the caller really said")}`,
      {
        headers: {
          "egma-inference-key": GATEWAY_SECRET,
          authorization: `Token ${CALLER_PROVIDER_KEY}`,
          "xi-api-key": CALLER_PROVIDER_KEY,
          "anthropic-api-key": CALLER_PROVIDER_KEY,
          "x-auth-token": CALLER_PROVIDER_KEY,
        },
      },
    );
    await watch(listening).opened;
    // This connection, not the first one this world ever accepted.
    const seen = await eventually(() =>
      standing.deepgram.seen.length > deepgramsSoFar
        ? standing.deepgram.seen[deepgramsSoFar]
        : undefined,
    );

    expect(seen.headers["authorization"]).toBe(`Token ${EGMA_PROVIDER_KEY.deepgram}`);
    expect(JSON.stringify(seen.headers)).not.toContain(CALLER_PROVIDER_KEY);
    expect(seen.query.toString()).not.toContain(CALLER_PROVIDER_KEY);
    expect(seen.query.get("api_key")).toBeNull();
    expect(seen.query.get("token")).toBeNull();
    expect(seen.query.get("access_token")).toBeNull();
    // The subprotocol carrier is refused outright rather than stripped; see
    // socket-relay.test.ts. Nothing reaches the provider through it either way.
    expect(seen.protocols).toEqual([]);
    // And the provider's own parameters, which are not credentials however much
    // one of them starts with the same three letters, are untouched.
    expect(seen.query.get("model")).toBe("nova-3-general");
    expect(seen.query.get("keyterm")).toBe("a word the caller really said");
    listening.close(1000, "done");

    const speaking = openSocket(
      standing.world,
      `/cartesia/tts/websocket?api_key=${CALLER_PROVIDER_KEY}` +
        `&egma_inference_key=${GATEWAY_SECRET}&cartesia_version=2025-04-16`,
    );
    await watch(speaking).opened;
    const spoke = await eventually(() =>
      standing.cartesia.seen.length > cartesiasSoFar
        ? standing.cartesia.seen[cartesiasSoFar]
        : undefined,
    );
    expect(spoke.query.get("api_key")).toBe(EGMA_PROVIDER_KEY.cartesia);
    expect(spoke.query.getAll("api_key")).toHaveLength(1);
    expect(spoke.query.get("cartesia_version")).toBe("2025-04-16");
    speaking.close(1000, "done");
  });

  it("never reaches an HTTP provider under any name a credential goes by", async () => {
    const answered = await ask(
      {
        "egma-inference-key": GATEWAY_SECRET,
        authorization: `Bearer ${CALLER_PROVIDER_KEY}`,
        "xi-api-key": CALLER_PROVIDER_KEY,
        "anthropic-api-key": CALLER_PROVIDER_KEY,
        "x-goog-api-key": CALLER_PROVIDER_KEY,
        "x-auth-token": CALLER_PROVIDER_KEY,
        "x-session-secret": CALLER_PROVIDER_KEY,
      },
      `?api_key=${CALLER_PROVIDER_KEY}&token=${CALLER_PROVIDER_KEY}` +
        `&access_token=${CALLER_PROVIDER_KEY}&stream_options=include_usage`,
    );
    expect(answered.status).toBe(200);

    const seen = standing.openai.seen.at(-1);
    expect(seen?.headers["authorization"]).toBe(`Bearer ${EGMA_PROVIDER_KEY.openai}`);
    expect(JSON.stringify(seen?.headers)).not.toContain(CALLER_PROVIDER_KEY);
    expect(seen?.query.toString()).not.toContain(CALLER_PROVIDER_KEY);
    expect(seen?.query.get("stream_options")).toBe("include_usage");
  });
});

describe("a connection that is not authorized", () => {
  const bad = [
    { what: "no credential at all", headers: {} },
    { what: "an empty credential", headers: { "egma-inference-key": "" } },
    { what: "somebody else's credential", headers: { "egma-inference-key": "not-the-secret" } },
    {
      what: "an ordinary Egma product key, which authorizes the product and not this",
      headers: { "egma-inference-key": "key_01K3XQ7M4E8YB2FVN0H9TZQWER" },
    },
    {
      what: "a provider key, offered where the gateway's own credential goes",
      headers: { authorization: `Bearer ${CALLER_PROVIDER_KEY}` },
    },
  ] as const;

  for (const { what, headers } of bad) {
    it(`is refused with ${what}, and the provider is never asked`, async () => {
      const before = standing.openai.attempts();
      const answered = await ask(headers);
      expect(answered.status).toBe(401);
      expect(standing.openai.attempts()).toBe(before);
      const body = (await answered.json()) as { error: { code: string; message: string } };
      expect(JSON.stringify(body)).not.toContain(GATEWAY_SECRET);
      expect(JSON.stringify(body)).not.toContain(CALLER_PROVIDER_KEY);
      expect(JSON.stringify(body)).not.toContain(EGMA_PROVIDER_KEY.openai);
    });
  }

  it("is refused before a socket handshake completes", async () => {
    const before = standing.deepgram.attempts();
    const socket = openSocket(standing.world, "/deepgram/v1/listen", {
      headers: { "egma-inference-key": "not-the-secret" },
    });
    await expect(watch(socket).opened).rejects.toThrow(/401/);
    expect(standing.deepgram.attempts()).toBe(before);
  });
});

describe("the organization a connection acts in", () => {
  it("is the one the credential resolves to, and is on the record", async () => {
    await ask({ "egma-inference-key": GATEWAY_SECRET });
    const written = await eventually(() =>
      records(standing.world).find((line) => line["statusClass"] === "ok"),
    );
    expect(written["organizationId"]).toBe(ORGANIZATION);
    expect(written["inferenceKeyId"]).toBe(INFERENCE_KEY_ID);
  });

  /**
   * Every shape somebody would reach for. Each is refused rather than ignored,
   * because a caller who built one believes it worked, and the expensive
   * version of this failure is the one where they go on believing it.
   */
  const tried = [
    { what: "a header", headers: { "egma-organization": "org_somebody_else" }, query: "" },
    { what: "a prefixed header", headers: { "egma-organization-id": "org_somebody_else" }, query: "" },
    { what: "a query value", headers: {}, query: "?egma_organization=org_somebody_else" },
    { what: "a query value with another spelling", headers: {}, query: "?egma_org_id=org_somebody_else" },
  ] as const;

  for (const { what, headers, query } of tried) {
    it(`cannot be overridden by ${what}`, async () => {
      const before = standing.openai.attempts();
      const answered = await ask(
        { "egma-inference-key": GATEWAY_SECRET, ...headers },
        query === "" ? "" : `${query}&egma_inference_key=${GATEWAY_SECRET}`,
      );
      expect(answered.status).toBe(400);
      expect(((await answered.json()) as { error: { code: string } }).error.code).toBe(
        "organization_cannot_be_named",
      );
      expect(standing.openai.attempts()).toBe(before);
    });
  }

  it("is unmoved by a body that names one, because no body is ever read", async () => {
    const answered = await ask({ "egma-inference-key": GATEWAY_SECRET }, "", {
      model: "a-small-model",
      messages: [],
      organization: "org_somebody_else",
      organization_id: "org_somebody_else",
    });
    expect(answered.status).toBe(200);
    // The body crossed to the provider exactly as it was written — the gateway
    // did not read it, did not strip a field out of it, and did not change who
    // the connection is for because of it.
    expect(standing.openai.seen.at(-1)?.body).toContain("org_somebody_else");
    const written = await eventually(() =>
      records(standing.world)
        .reverse()
        .find((line) => line["statusClass"] === "ok"),
    );
    expect(written["organizationId"]).toBe(ORGANIZATION);
  });
});

describe("a credential that stops being good", () => {
  /**
   * The static verifier a preview deploys cannot revoke, so this is proved with
   * one of the test's own — which is the point of there being a verifier seam
   * at all. The store that arrives with real inference keys plugs in here and
   * this behavior comes with it.
   */
  it("keeps an open connection and refuses the next one", async () => {
    let live = true;
    const revocable: Verifier = {
      verify: async (credential): Promise<Verified> =>
        credential === GATEWAY_SECRET && live
          ? { organizationId: ORGANIZATION, inferenceKeyId: INFERENCE_KEY_ID }
          : { refused: "not-recognized" },
    };
    const world = await standUp({ verifier: revocable });
    try {
      const socket = openSocket(world.world, "/deepgram/v1/listen", {
        headers: { "egma-inference-key": GATEWAY_SECRET },
      });
      const seen = watch(socket);
      await seen.opened;

      live = false;

      // The open one is untouched: authentication happened when it opened, and
      // an audio frame does not re-ask.
      socket.send("still-listening");
      const provider = await world.deepgram.opened();
      await eventually(() => (provider.frames.length > 0 ? provider.frames : undefined));
      expect(provider.frames).toContain("still-listening");

      // The next one is refused.
      const again = openSocket(world.world, "/deepgram/v1/listen", {
        headers: { "egma-inference-key": GATEWAY_SECRET },
      });
      await expect(watch(again).opened).rejects.toThrow(/401/);

      socket.close(1000, "done");
    } finally {
      await world.world.stop();
    }
  });

  it("is what the verifier says it is, and the verifier is the only thing asked", async () => {
    // The seam itself, read directly: the answer has an organization on it and
    // a refusal has nothing on it but the fact of being one.
    const verifier: Verifier = {
      verify: async (credential) =>
        credential === "good"
          ? { organizationId: "org_x", inferenceKeyId: "key_x" }
          : { refused: "not-recognized" },
    };
    const good = await verifier.verify("good");
    expect(isAuthenticated(good)).toBe(true);
    const bad = await verifier.verify("bad");
    expect(isAuthenticated(bad)).toBe(false);
    expect(JSON.stringify(bad)).not.toContain("bad");
  });
});

/**
 * The two shipped answers, driven the way a simulator and a grader drive them:
 * real credentials over real sockets, against the real Egma Cloud door on
 * loopback. Nothing here hands the gateway a verifier of its own — that seam is
 * exercised above, and what is left to prove is that the answers a deployment
 * actually runs behave the way the product promises.
 */
describe("hosted Egma's own credential", () => {
  it("opens a connection without asking Egma Cloud anything at all", async () => {
    const before = standing.cloud.asks.length;

    const answered = await ask({
      "egma-inference-key": await internalCredential(ORGANIZATION),
    });

    expect(answered.status).toBe(200);
    // The whole point of signing rather than storing: hosted managed traffic
    // pays no round trip, and Egma Cloud never hears about it.
    expect(standing.cloud.asks.length).toBe(before);
  });

  it("acts for the organization inside its signature and for no other", async () => {
    const another = "org_01K3XQ7M4E8YB2FVN0H9TZQZZZ";
    const answered = await ask({
      "egma-inference-key": await internalCredential(another),
    });
    expect(answered.status).toBe(200);

    const filed = await eventually(() =>
      records(standing.world)
        .reverse()
        .find((line) => line["organizationId"] === another),
    );
    expect(filed["inferenceKeyId"]).toBe(INTERNAL_CREDENTIAL_ID);
  });

  it("is refused once its own signature is edited", async () => {
    const credential = await internalCredential(ORGANIZATION);
    const [payload, signature] = credential
      .slice(INTERNAL_CREDENTIAL_PREFIX.length)
      .split(".");
    // The organization swapped for another, with the signature left as it was:
    // the exact move the whole shape exists to make useless.
    const forged = `${INTERNAL_CREDENTIAL_PREFIX}${btoa(
      JSON.stringify({ o: "org_somebody_else", x: Math.floor(Date.now() / 1000) + 60 }),
    )
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "")}.${signature}`;
    expect(payload).toBeDefined();

    expect((await ask({ "egma-inference-key": forged })).status).toBe(401);
  });

  it("is refused once it has expired, however good its signature is", async () => {
    const expired = await internalCredential(ORGANIZATION, -60);
    expect((await ask({ "egma-inference-key": expired })).status).toBe(401);
  });
});

describe("an inference key", () => {
  it("is validated at Egma Cloud, content-free, once per connection", async () => {
    const before = standing.cloud.asks.length;

    expect((await ask({ "egma-inference-key": GATEWAY_SECRET })).status).toBe(200);

    const asked = standing.cloud.asks.slice(before);
    expect(asked).toHaveLength(1);
    expect(asked[0]?.method).toBe("POST");
    expect(asked[0]?.credential).toBe(GATEWAY_SECRET);
    // Content-free: the ask carries the credential and nothing about the
    // simulation, the persona, the model or the payload behind it.
    expect(asked[0]?.body).toBe("");
  });

  it("stops working on the next connection once Egma Cloud revokes it", async () => {
    const world = await standUp();
    try {
      const retired = "egma_ik_sentinel-about-to-be-revoked-Mn3Qr7";
      world.cloud.issue(retired, ORGANIZATION, "ifk_01K3XQ7M4E8YB2FVN0H9TZQWET");

      const first = await fetch(`${world.world.origin}/openai/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", "egma-inference-key": retired },
        body: JSON.stringify({ model: "m", messages: [] }),
      });
      expect(first.status).toBe(200);

      world.cloud.revoke(retired);

      const next = await fetch(`${world.world.origin}/openai/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", "egma-inference-key": retired },
        body: JSON.stringify({ model: "m", messages: [] }),
      });
      expect(next.status).toBe(401);
    } finally {
      await world.world.stop();
    }
  });

  it("refuses an ordinary Egma product key, because a product key is not one of these", async () => {
    // Never issued in Egma Cloud's inference-key store, because a product key
    // lives in a different table entirely. The gateway learns that by asking.
    const productKey = "egma_sk_sentinel-a-product-key-not-an-inference-one";
    expect((await ask({ "egma-inference-key": productKey })).status).toBe(401);
  });
});

describe("an Egma Cloud that cannot be reached", () => {
  it("says so, rather than telling a customer their key is bad", async () => {
    const world = await standUp();
    try {
      world.cloud.goDown();

      const answered = await fetch(
        `${world.world.origin}/openai/v1/chat/completions`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "egma-inference-key": GATEWAY_SECRET,
          },
          body: JSON.stringify({ model: "m", messages: [] }),
        },
      );

      expect(answered.status).toBe(503);
      expect(
        ((await answered.json()) as { error: { code: string } }).error.code,
      ).toBe("gateway_authentication_unavailable");
      // Filed as its own thing, so an Egma outage does not arrive in the count
      // of customers who mistyped a key.
      const filed = await eventually(() =>
        records(world.world).find(
          (line) => line["statusClass"] === "authentication-unavailable",
        ),
      );
      expect(filed["organizationId"]).toBeUndefined();
    } finally {
      await world.world.stop();
    }
  });

  it("still lets hosted Egma's own credential through, because nothing is asked for it", async () => {
    const world = await standUp();
    try {
      world.cloud.goDown();

      const answered = await fetch(
        `${world.world.origin}/openai/v1/chat/completions`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "egma-inference-key": await internalCredential(ORGANIZATION),
          },
          body: JSON.stringify({ model: "m", messages: [] }),
        },
      );

      expect(answered.status).toBe(200);
    } finally {
      await world.world.stop();
    }
  });
});
