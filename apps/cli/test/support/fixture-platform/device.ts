/**
 * The device-flow endpoints of the fixture platform.
 *
 * This is the contract the CLI is built against, written down as something that
 * runs: the three calls a terminal makes to sign a machine in, and the one call
 * it makes afterwards to prove the key works. It answers exactly what the real
 * instance answers, including which refusal goes with which state, because a
 * fixture that is kinder than the real thing is a fixture that hides bugs.
 *
 * Approving is a control, not a contract. On a real instance a person approves
 * in a browser; here a test says so directly, which is what lets the whole of
 * login run in CI with no browser and no platform.
 */

import { randomBytes } from "node:crypto";

import type { RouteGroup } from "./server.ts";

type Authorization = {
  readonly deviceCode: string;
  readonly userCode: string;
  state: "pending" | "approved" | "denied" | "expired";
  /** Set once, when the key is collected. */
  collected: boolean;
};

export type DeviceState = {
  /** Every key this fixture has minted, newest last. */
  readonly keys: string[];
  /** Set to make the next collection answer `slow_down` once. */
  slowDownOnce: boolean;
};

const ALPHABET = "BCDFGHJKLMNPQRSTVWXZ";

function userCode(): string {
  const letters = [...randomBytes(8)].map((byte) => ALPHABET[byte % ALPHABET.length]);
  return `${letters.slice(0, 4).join("")}-${letters.slice(4).join("")}`;
}

function normalize(code: string): string {
  return code.replaceAll(/[^0-9A-Za-z]/gu, "").toUpperCase();
}

export type DeviceControls = {
  /** What a person clicking Approve in a browser does. */
  approve(code: string): boolean;
  deny(code: string): boolean;
  /** What time passing does. */
  expire(code: string): boolean;
  slowDownOnce(): void;
  readonly keys: readonly string[];
};

export function deviceRoutes(origin: () => string): {
  readonly group: RouteGroup;
  readonly controls: DeviceControls;
} {
  const byDeviceCode = new Map<string, Authorization>();
  const byUserCode = new Map<string, Authorization>();
  const keys: string[] = [];
  const state: DeviceState = { keys, slowDownOnce: false };

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

          const approveUrl = `${origin()}/device/approve?user_code=${encodeURIComponent(code)}`;
          return {
            status: 200,
            body: {
              device_code: deviceCode,
              user_code: code,
              verification_uri: `${origin()}/device`,
              verification_uri_complete: approveUrl,
              expires_in: 900,
              // Nothing here waits on a person, so nothing here waits at all.
              interval: 0,
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

          const authorization = byDeviceCode.get(form.get("device_code") ?? "");
          if (authorization === undefined || authorization.collected) {
            return {
              status: 400,
              body: { error: "invalid_grant", error_description: "no such device code" },
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
        path: "/device/approve",
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
        path: "/api/keys",
        handle: (request) => {
          const offered = (request.headers.authorization ?? "").replace(/^Bearer\s+/iu, "");
          if (offered === "" || !keys.includes(offered)) {
            return {
              status: 401,
              body: { error: "not_authenticated", message: "no key, or not one of ours" },
            };
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
      keys,
    },
  };
}
