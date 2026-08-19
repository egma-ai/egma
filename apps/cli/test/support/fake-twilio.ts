/**
 * A local server shaped like the two Twilio APIs the setup command drives.
 *
 * Trunks and their attachments on one, credential lists, credentials and
 * numbers on the other. It exists so that proving setup makes the right things
 * in the right order — and, far more importantly, that a second run makes
 * *nothing* — needs no account, no network and no money.
 *
 * It records every write it was asked for, so a test can assert on the count
 * rather than on a summary the command wrote about itself. A command that
 * claimed "reused" while quietly creating a second trunk would pass a test that
 * read its output and fail this one.
 */

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export type FakeTwilioOptions = {
  /** Numbers the account already owns. Nothing else can be attached. */
  readonly numbers: Readonly<Record<string, string>>;
  /** A trunk already on the account, as a previous setup would have left it. */
  readonly existingTrunk?: { readonly sid: string; readonly domain: string };
  readonly existingCredentialList?: { readonly sid: string };
  readonly existingCredential?: { readonly sid: string; readonly username: string };
  /** Whether the existing trunk already has the credential list on it. */
  readonly credentialListAttached?: boolean;
  /** Whether the existing trunk already has the source number on it. */
  readonly numberAttached?: boolean;
  /** Refuse every request with this status, for the refusal checks. */
  readonly refuseWith?: number;
};

export type FakeTwilio = {
  readonly apiRoot: string;
  readonly trunkingRoot: string;
  /** Every write, in order: `POST <path>`. */
  readonly writes: readonly string[];
  /** Every request, in order, so a plan can be proved to have written none. */
  readonly requests: readonly string[];
  readonly trunks: ReadonlyArray<{ sid: string; friendly_name: string; domain_name: string }>;
  readonly credentialLists: ReadonlyArray<{ sid: string; friendly_name: string }>;
  /** The passwords the account was told, in order. */
  readonly passwords: readonly string[];
  /** The `Authorization` headers it was shown, so a test can prove what was sent. */
  readonly authorizations: readonly string[];
  close(): Promise<void>;
};

const ARBITRARY = (): string =>
  Math.random().toString(16).slice(2).padEnd(32, "0").slice(0, 32);

export async function startFakeTwilio(options: FakeTwilioOptions): Promise<FakeTwilio> {
  const trunks: { sid: string; friendly_name: string; domain_name: string }[] = [];
  const credentialLists: { sid: string; friendly_name: string }[] = [];
  const credentials: { sid: string; username: string; listSid: string }[] = [];
  const listsOnTrunk: { trunkSid: string; sid: string }[] = [];
  const numbersOnTrunk: { trunkSid: string; sid: string }[] = [];
  const writes: string[] = [];
  const requests: string[] = [];
  const passwords: string[] = [];
  const authorizations: string[] = [];

  if (options.existingTrunk !== undefined) {
    trunks.push({
      sid: options.existingTrunk.sid,
      friendly_name: "egma-simulator",
      domain_name: options.existingTrunk.domain,
    });
  }
  if (options.existingCredentialList !== undefined) {
    credentialLists.push({
      sid: options.existingCredentialList.sid,
      friendly_name: "egma-simulator",
    });
    if (options.credentialListAttached === true && options.existingTrunk !== undefined) {
      listsOnTrunk.push({
        trunkSid: options.existingTrunk.sid,
        sid: options.existingCredentialList.sid,
      });
    }
    if (options.existingCredential !== undefined) {
      credentials.push({
        sid: options.existingCredential.sid,
        username: options.existingCredential.username,
        listSid: options.existingCredentialList.sid,
      });
    }
  }
  if (options.numberAttached === true && options.existingTrunk !== undefined) {
    const first = Object.values(options.numbers)[0];
    if (first !== undefined) {
      numbersOnTrunk.push({ trunkSid: options.existingTrunk.sid, sid: first });
    }
  }

  const server: Server = createServer((request, answer) => {
    const url = new URL(request.url ?? "/", "http://fake-twilio.invalid");
    const held = request.headers.authorization;
    if (typeof held === "string") authorizations.push(held);
    requests.push(`${request.method} ${url.pathname}`);

    const send = (status: number, body: unknown): void => {
      answer.writeHead(status, { "content-type": "application/json" });
      answer.end(JSON.stringify(body));
    };

    if (options.refuseWith !== undefined) {
      send(options.refuseWith, { message: "a refusal this test asked for", code: 20003 });
      return;
    }

    const body: Buffer[] = [];
    request.on("data", (chunk: Buffer) => body.push(chunk));
    request.on("end", () => {
      const form = new URLSearchParams(Buffer.concat(body).toString("utf8"));
      if (request.method === "POST") writes.push(`POST ${url.pathname}`);

      // -- the trunking API ------------------------------------------------
      if (url.pathname === "/v1/Trunks") {
        if (request.method === "GET") {
          send(200, { trunks, meta: {} });
          return;
        }
        const made = {
          sid: `TK${ARBITRARY()}`,
          friendly_name: form.get("FriendlyName") ?? "",
          domain_name: form.get("DomainName") ?? "",
        };
        trunks.push(made);
        send(201, made);
        return;
      }
      const attachedLists = /^\/v1\/Trunks\/([^/]+)\/CredentialLists$/u.exec(url.pathname);
      if (attachedLists !== null) {
        const trunkSid = attachedLists[1] as string;
        if (request.method === "GET") {
          send(200, {
            credential_lists: listsOnTrunk.filter((one) => one.trunkSid === trunkSid),
            meta: {},
          });
          return;
        }
        listsOnTrunk.push({ trunkSid, sid: form.get("CredentialListSid") ?? "" });
        send(201, {});
        return;
      }
      const attachedNumbers = /^\/v1\/Trunks\/([^/]+)\/PhoneNumbers$/u.exec(url.pathname);
      if (attachedNumbers !== null) {
        const trunkSid = attachedNumbers[1] as string;
        if (request.method === "GET") {
          send(200, {
            phone_numbers: numbersOnTrunk.filter((one) => one.trunkSid === trunkSid),
            meta: {},
          });
          return;
        }
        numbersOnTrunk.push({ trunkSid, sid: form.get("PhoneNumberSid") ?? "" });
        send(201, {});
        return;
      }

      // -- the older API ---------------------------------------------------
      if (url.pathname.endsWith("/IncomingPhoneNumbers.json")) {
        const asked = url.searchParams.get("PhoneNumber");
        const sid = asked === null ? undefined : options.numbers[asked];
        send(200, {
          incoming_phone_numbers:
            sid === undefined ? [] : [{ sid, phone_number: asked }],
        });
        return;
      }
      if (url.pathname.endsWith("/SIP/CredentialLists.json")) {
        if (request.method === "GET") {
          send(200, { credential_lists: credentialLists });
          return;
        }
        const made = {
          sid: `CL${ARBITRARY()}`,
          friendly_name: form.get("FriendlyName") ?? "",
        };
        credentialLists.push(made);
        send(201, made);
        return;
      }
      const listCredentials = /\/SIP\/CredentialLists\/([^/]+)\/Credentials\.json$/u.exec(
        url.pathname,
      );
      if (listCredentials !== null) {
        const listSid = listCredentials[1] as string;
        if (request.method === "GET") {
          send(200, { credentials: credentials.filter((one) => one.listSid === listSid) });
          return;
        }
        const made = {
          sid: `SC${ARBITRARY()}`,
          username: form.get("Username") ?? "",
          listSid,
        };
        credentials.push(made);
        passwords.push(form.get("Password") ?? "");
        send(201, made);
        return;
      }
      const oneCredential = /\/SIP\/CredentialLists\/([^/]+)\/Credentials\/([^/]+)\.json$/u.exec(
        url.pathname,
      );
      if (oneCredential !== null) {
        passwords.push(form.get("Password") ?? "");
        send(200, { sid: oneCredential[2] });
        return;
      }

      send(404, { message: `this fake twilio has no ${url.pathname}` });
    });
  });

  await new Promise<void>((listening) => server.listen(0, "127.0.0.1", listening));
  const { port } = server.address() as AddressInfo;
  const root = `http://127.0.0.1:${port}`;

  return {
    apiRoot: root,
    trunkingRoot: root,
    writes,
    requests,
    trunks,
    credentialLists,
    passwords,
    authorizations,
    close: () =>
      new Promise<void>((closed) => {
        server.close(() => closed());
      }),
  };
}
