/**
 * The device-flow endpoints of the fixture platform.
 *
 * This is the contract the CLI is built against, written down as something that
 * runs: the three requests a terminal makes to sign a machine in, and the one
 * it makes afterwards to prove the key works. It answers exactly what the real
 * instance answers, including which refusal goes with which state, because a
 * fixture that is kinder than the real thing is a fixture that hides bugs.
 *
 * Every answer here is pinned to `apps/api/test/device-flow.test.ts`, which is
 * the same contract asserted against the real API: an eight-character code, an
 * address of the shape `/device?user_code=…`, and `expired_token` — not
 * `invalid_grant` — for a device code that was spent or never issued.
 *
 * Approving is a control, not a contract. On a real instance a person approves
 * in a browser; here a test says so directly, which is what lets the whole of
 * login run in CI with no browser and no platform.
 */

import { randomBytes } from "node:crypto";

import { NOT_AUTHENTICATED } from "./reading.ts";
import type { RouteGroup } from "./server.ts";

type Authorization = {
  readonly deviceCode: string;
  readonly userCode: string;
  state: "pending" | "approved" | "denied" | "expired";
  /** Set once, when the key is collected. */
  collected: boolean;
};

/** An answer a test has asked the next token request to be given. */
type TokenAnswer = { readonly error: string; readonly said: string };

export type DeviceState = {
  /** Every key this fixture has minted, newest last. */
  readonly keys: string[];
  /** Set to make the next collection answer `slow_down` once. */
  slowDownOnce: boolean;
  /** How long the terminal is told to leave between two collections. */
  intervalSeconds: number;
  /** What the next collection answers, whatever state the code is in. */
  nextAnswer: TokenAnswer | null;
};

/**
 * The characters a code is made of. Eight of them, upper case, letters and
 * digits — the shape `apps/api/test/device-flow.test.ts` pins on the real one.
 */
const ALPHABET = "BCDFGHJKLMNPQRSTVWXZ0123456789";
const CODE_LENGTH = 8;

function userCode(): string {
  return [...randomBytes(CODE_LENGTH)]
    .map((byte) => ALPHABET[byte % ALPHABET.length])
    .join("");
}

function normalize(code: string): string {
  return code.replaceAll(/[^0-9A-Za-z]/gu, "").toUpperCase();
}

export type DeviceControls = {
  /** What a person clicking Approve in a browser does. */
  approve(code: string): boolean;
  /**
   * A key this instance is to treat as one of its own, for a check that starts
   * from a machine that is already signed in rather than from a login.
   */
  accept(key: string): void;
  /** Stop accepting a key immediately, as production revocation does. */
  reject(key: string): void;
  deny(code: string): boolean;
  /** What time passing does. */
  expire(code: string): boolean;
  slowDownOnce(): void;
  /** What the instance tells the terminal its pace is. Zero by default. */
  pollEvery(seconds: number): void;
  /**
   * Make the next collection answer this, whatever state the code is in.
   *
   * The real instance answers `invalid_grant` for states a fixture cannot
   * reach — an account switched off between approving and collecting, a
   * project that went away — and each of those answers carries a description
   * written for whoever built the client. A test that wants to see what the
   * terminal does with one says so here, with the instance's own words.
   */
  answerTokenWith(error: string, said: string): void;
  /**
   * A key this fixture will accept, without walking the whole login.
   *
   * What a login leaves behind, produced directly. It is a control and not a
   * contract: checks about what a *signed-in* machine can do should not have
   * to drive a browser first, and the real instance has no such door.
   */
  mint(): string;
  readonly keys: readonly string[];
};

export function deviceRoutes(origin: () => string): {
  readonly group: RouteGroup;
  readonly controls: DeviceControls;
} {
  const byDeviceCode = new Map<string, Authorization>();
  const byUserCode = new Map<string, Authorization>();
  const keys: string[] = [];
  const state: DeviceState = {
    keys,
    slowDownOnce: false,
    // Nothing here waits on a person, so by default nothing here waits at all.
    intervalSeconds: 0,
    nextAnswer: null,
  };

  const find = (code: string): Authorization | undefined =>
    byUserCode.get(normalize(code));

  const group: RouteGroup = {
    name: "device",
    routes: [
      {
        method: "POST",
        path: "/api/device/code",
        handle: () => {
          const deviceCode = randomBytes(24).toString("hex");
          const code = userCode();
          const authorization: Authorization = {
            deviceCode,
            userCode: code,
            state: "pending",
            collected: false,
          };
          byDeviceCode.set(deviceCode, authorization);
          byUserCode.set(normalize(code), authorization);

          // The address the real instance hands back: its own `/device` page,
          // with the code already in the field.
          const approveUrl = `${origin()}/device?user_code=${encodeURIComponent(code)}`;
          return {
            status: 200,
            body: {
              device_code: deviceCode,
              user_code: code,
              verification_uri: `${origin()}/device`,
              verification_uri_complete: approveUrl,
              expires_in: 900,
              interval: state.intervalSeconds,
            },
          };
        },
      },
      {
        method: "POST",
        path: "/api/device/token",
        handle: (request) => {
          const form = request.form ?? new URLSearchParams();
          if (form.get("grant_type") !== "urn:ietf:params:oauth:grant-type:device_code") {
            return {
              status: 400,
              body: {
                error: "unsupported_grant_type",
                error_description: "this endpoint understands the device grant and nothing else",
              },
            };
          }

          if (state.nextAnswer !== null) {
            const { error, said } = state.nextAnswer;
            state.nextAnswer = null;
            return { status: 400, body: { error, error_description: said } };
          }

          const authorization = byDeviceCode.get(form.get("device_code") ?? "");
          if (authorization === undefined || authorization.collected) {
            // A code that was spent and a code nobody was ever given are the
            // same answer on the real instance, and it is `expired_token`.
            return {
              status: 400,
              body: { error: "expired_token", error_description: "this authorization is over" },
            };
          }

          if (state.slowDownOnce) {
            state.slowDownOnce = false;
            return {
              status: 400,
              body: {
                error: "slow_down",
                error_description: "polling faster than the interval this was issued with",
              },
            };
          }

          switch (authorization.state) {
            case "pending":
              return {
                status: 400,
                body: {
                  error: "authorization_pending",
                  error_description: "nobody has approved this yet",
                },
              };
            case "denied":
              return {
                status: 400,
                body: { error: "access_denied", error_description: "this was denied in the browser" },
              };
            case "expired":
              return {
                status: 400,
                body: { error: "expired_token", error_description: "this authorization is over" },
              };
            case "approved": {
              authorization.collected = true;
              const key = `egma_sk_${randomBytes(24).toString("hex")}`;
              keys.push(key);
              return {
                status: 200,
                body: {
                  access_token: key,
                  token_type: "Bearer",
                  api_key_id: `ak_${randomBytes(8).toString("hex")}`,
                },
              };
            }
          }
        },
      },
      {
        // What a person's browser lands on. It is here so that the address the
        // terminal shows is an address that answers, exactly as it is on a real
        // instance — a link that 404s is not a link a check can trust.
        method: "GET",
        path: "/device",
        handle: (request) => {
          const asked = request.url.searchParams.get("user_code") ?? "";
          const authorization = find(asked);
          return {
            status: authorization === undefined ? 404 : 200,
            contentType: "text/html; charset=utf-8",
            text:
              authorization === undefined
                ? "<main>No terminal is waiting on that code.</main>"
                : `<main>Authorize this terminal? <input id="user_code" value="${authorization.userCode}"></main>`,
          };
        },
      },
      {
        // The first door a minted key opens, which is how the end of login is
        // proved rather than asserted.
        method: "GET",
        path: "/v1/keys",
        handle: (request) => {
          const offered = (request.headers.authorization ?? "").replace(/^Bearer\s+/iu, "");
          if (offered === "" || !keys.includes(offered)) {
            return { status: 401, body: NOT_AUTHENTICATED };
          }
          return {
            status: 200,
            body: { keys: keys.map((key, index) => ({ id: `ak_${index}`, name: "egma-cli login" })) },
          };
        },
      },
    ],
  };

  return {
    group,
    controls: {
      approve(code) {
        const authorization = find(code);
        if (authorization === undefined || authorization.state !== "pending") return false;
        authorization.state = "approved";
        return true;
      },
      accept(key) {
        if (!keys.includes(key)) keys.push(key);
      },
      reject(key) {
        const at = keys.indexOf(key);
        if (at >= 0) keys.splice(at, 1);
      },
      deny(code) {
        const authorization = find(code);
        if (authorization === undefined) return false;
        authorization.state = "denied";
        return true;
      },
      expire(code) {
        const authorization = find(code);
        if (authorization === undefined) return false;
        authorization.state = "expired";
        return true;
      },
      slowDownOnce() {
        state.slowDownOnce = true;
      },
      pollEvery(seconds) {
        state.intervalSeconds = seconds;
      },
      answerTokenWith(error, said) {
        state.nextAnswer = { error, said };
      },
      mint() {
        const key = `egma_sk_${randomBytes(24).toString("hex")}`;
        keys.push(key);
        return key;
      },
      keys,
    },
  };
}
