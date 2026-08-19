import { afterEach, describe, expect, it, vi } from "vitest";

import { PASSWORD_RESET_LIFETIME_MINUTES } from "../src/auth/password-reset.ts";
import type { Email } from "../src/auth/email.ts";
import { cookiesFrom, createApi, type TestApi } from "./support/api.ts";

/**
 * Getting back in after forgetting a password, followed the whole way.
 *
 * The claim is not that a sender was called. It is that a developer who cannot
 * remember their password ends up signed in: the link is taken out of the
 * message the transport was handed, followed, a password set behind it, and
 * that password used at the front door. Anything less proves nothing a
 * developer cares about, because every step between the message and the sign-in
 * is a step that can be broken without the sender ever noticing.
 *
 * It is driven on both transports on purpose. **Whether the link is posted or
 * written to the log is the only difference between them**, and reset works on
 * both — the same rule verification already follows, read off the one sender
 * rather than off a second setting that could disagree with it.
 */

let api: TestApi;

afterEach(async () => {
  vi.useRealTimers();
  await api?.close();
});

const FORGOTTEN = "the-password-they-forgot";
const CHOSEN = "the-password-they-just-chose";

async function signUp(email: string): Promise<string> {
  const created = await api.app.inject({
    method: "POST",
    url: "/api/signup",
    payload: { email, password: FORGOTTEN, organizationName: "Acme" },
  });
  expect(created.statusCode, created.body).toBe(201);
  const userId = (created.json() as { userId: string }).userId;

  // Standing in for the click on the verification message, which is the other
  // ticket's flow. A transport that delivers requires it before a session, and
  // this file is about the password rather than about the address.
  await api.database.sql('update "user" set email_verified = true where id = $1', [
    userId,
  ]);

  return userId;
}

async function askForALink(
  email: string,
  next?: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await api.app.inject({
    method: "POST",
    url: "/api/password-reset",
    payload: next === undefined ? { email } : { email, next },
  });
  return {
    status: response.statusCode,
    body: response.json() as Record<string, unknown>,
  };
}

/** The address out of the message itself, exactly as a person would copy it. */
function linkIn(message: Email): URL {
  const found = message.body.match(/https?:\/\/\S+/u);
  expect(found, `no link in: ${message.body}`).not.toBeNull();
  return new URL((found as RegExpMatchArray)[0]);
}

function tokenIn(link: URL): string {
  const token = link.searchParams.get("token");
  expect(token, `no token in ${link.href}`).not.toBeNull();
  return token as string;
}

/** Asking, then reading the one thing the person holding the link would read. */
async function linkSentTo(email: string, next?: string): Promise<URL> {
  const before = api.mail.length;
  expect((await askForALink(email, next)).status).toBe(202);

  const sent = api.mail.slice(before);
  expect(sent.map((message) => message.to)).toEqual([email]);
  return linkIn(sent[0] as Email);
}

/**
 * The provider's own token, read straight out of the seal.
 *
 * **The seal is signed and not encrypted**, so this is a thing anybody holding
 * a link can do — which is why what it opens is worth a test of its own.
 */
function rawTokenIn(sealed: string): string {
  const payload = sealed.slice(0, sealed.lastIndexOf("."));
  const opened = Buffer.from(payload, "base64url").toString("utf8");
  return opened.slice(0, opened.lastIndexOf(":"));
}

/**
 * Something that has not happened yet because nothing waits for it. Polls
 * rather than sleeps, so the test is as quick as the work is and never a
 * threshold somebody has to raise on a busy machine.
 */
async function eventually<T>(look: () => T | undefined): Promise<T> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const found = look();
    if (found !== undefined) return found;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("it never happened");
}

/** The clock, moved on, with only `Date` faked so the stores keep their timers. */
function minutesLater(minutes: number): void {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(Date.now() + minutes * 60_000));
}

async function setPassword(
  token: string,
  password: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await api.app.inject({
    method: "POST",
    url: "/api/password-reset/complete",
    payload: { token, password },
  });
  return {
    status: response.statusCode,
    body: response.json() as Record<string, unknown>,
  };
}

async function signIn(
  email: string,
  password: string,
): Promise<{ status: number; cookie: string }> {
  const response = await api.app.inject({
    method: "POST",
    url: "/api/auth/sign-in/email",
    headers: { "content-type": "application/json", origin: api.config.baseUrl },
    payload: { email, password },
  });
  return {
    status: response.statusCode,
    cookie: cookiesFrom(response.headers["set-cookie"]),
  };
}

describe("a developer who forgot their password", () => {
  it("asks for a link, follows it, sets a password, and signs in with it", async () => {
    api = await createApi("reset_whole_walk", { emailDelivers: true });
    await signUp("ada@acme.example");

    const link = await linkSentTo("ada@acme.example");

    // The link is this instance's own page, on the origin the person is
    // already on. Nothing about getting back in reaches a domain egma runs.
    expect(link.origin).toBe(api.config.baseUrl);
    expect(link.pathname).toBe("/reset-password");

    const set = await setPassword(tokenIn(link), CHOSEN);
    expect(set.status, JSON.stringify(set.body)).toBe(200);

    const back = await signIn("ada@acme.example", CHOSEN);
    expect(back.status).toBe(200);
    expect(back.cookie).not.toBe("");

    // And the password they could not remember is not a way in any more.
    expect((await signIn("ada@acme.example", FORGOTTEN)).status).not.toBe(200);
  });

  it("gets the same walk on a platform that posts no mail, from the log", async () => {
    // The fake sender stands in for the logging transport, which delivers
    // nothing and writes the whole message to the log instead. Nothing about
    // the reset itself changes: the same message, carrying the same link, and
    // the same walk behind it. There is no second setting that turns reset on,
    // so there is nothing that can disagree with the transport.
    api = await createApi("reset_no_transport", { emailDelivers: false });
    await signUp("ada@acme.example");

    const link = await linkSentTo("ada@acme.example");
    expect((await setPassword(tokenIn(link), CHOSEN)).status).toBe(200);

    expect((await signIn("ada@acme.example", CHOSEN)).status).toBe(200);
    expect((await signIn("ada@acme.example", FORGOTTEN)).status).not.toBe(200);
  });

  it("is told what the message is for, and who sent it", async () => {
    api = await createApi("reset_message", { emailDelivers: true });
    await signUp("ada@acme.example");
    await linkSentTo("ada@acme.example");

    const message = api.mail.at(-1) as Email;
    expect(message.subject.toLowerCase()).toContain("egma");
    expect(message.subject.toLowerCase()).toContain("password");
    expect(message.body.toLowerCase()).toContain("egma");
    expect(message.body.toLowerCase()).toContain("password");
  });
});

describe("a link that is no longer worth following", () => {
  /**
   * Inside the hour, a token the provider will not take is a token somebody
   * already used, and the refusal says exactly that — because "you already did
   * this, so sign in" and "nothing happened at all, so ask for another" are
   * opposite instructions to whoever is holding the link.
   */
  it("says the link was already used, when it was", async () => {
    api = await createApi("reset_spent", { emailDelivers: true });
    await signUp("ada@acme.example");

    const token = tokenIn(await linkSentTo("ada@acme.example"));
    expect((await setPassword(token, CHOSEN)).status).toBe(200);

    const again = await setPassword(token, "a-third-password-entirely");
    expect(again.status).toBe(409);
    expect(again.body.error).toBe("reset_link_already_used");
    expect(String(again.body.message)).toMatch(/already been used/i);

    // And the second attempt changed nothing: the password set by the first
    // one is still the password.
    expect((await signIn("ada@acme.example", CHOSEN)).status).toBe(200);
    expect(
      (await signIn("ada@acme.example", "a-third-password-entirely")).status,
    ).not.toBe(200);
  });

  /**
   * And past the hour, egma says what it knows, which is that the link is dead.
   *
   * There is one deadline and both systems have it, so the moment egma stops
   * honouring a link is the moment the provider forgets the token. Nothing is
   * left to ask, a link that ran out unused and one somebody spent look
   * identical from out here, and either of the other two sentences would be a
   * guess. **That is the price of one number**, and it is written down as two
   * tests rather than one, because the two situations it flattens together are
   * opposite and a reader has to see both of them being flattened.
   */
  it("says only what it can still check, once the hour is up and nobody used the link", async () => {
    api = await createApi("reset_expired", { emailDelivers: true });
    await signUp("ada@acme.example");

    const token = tokenIn(await linkSentTo("ada@acme.example"));

    // The clock, moved past the deadline the link was minted with.
    minutesLater(PASSWORD_RESET_LIFETIME_MINUTES + 1);

    const late = await setPassword(token, CHOSEN);
    vi.useRealTimers();

    expect(late.status).toBe(409);
    expect(late.body.error).toBe("reset_link_no_longer_works");
    expect(String(late.body.message)).toMatch(/whether it was used/i);

    // Nothing was set by asking, and the password they forgot is still theirs.
    expect((await signIn("ada@acme.example", FORGOTTEN)).status).toBe(200);
    expect((await signIn("ada@acme.example", CHOSEN)).status).not.toBe(200);
  });

  /**
   * The same answer for the opposite situation, and **the sentence that must
   * never be written is the one that guesses**: telling somebody nothing has
   * changed, about an account whose password has changed, sends them off to go
   * on using a password that no longer signs them in.
   */
  it("says the same when the link was used and then followed after the hour", async () => {
    api = await createApi("reset_spent_then_late", { emailDelivers: true });
    await signUp("ada@acme.example");

    const token = tokenIn(await linkSentTo("ada@acme.example"));
    expect((await setPassword(token, CHOSEN)).status).toBe(200);

    minutesLater(PASSWORD_RESET_LIFETIME_MINUTES + 1);
    const late = await setPassword(token, "a-third-password-entirely");
    vi.useRealTimers();

    expect(late.status).toBe(409);
    expect(late.body.error).toBe("reset_link_no_longer_works");
    // It claims neither of the two things it cannot see.
    expect(String(late.body.message)).not.toMatch(/nothing has changed/i);
    expect(String(late.body.message)).not.toMatch(/old password still works/i);

    // The state the refusal declines to name, against the one that is true.
    expect((await signIn("ada@acme.example", CHOSEN)).status).toBe(200);
    expect((await signIn("ada@acme.example", FORGOTTEN)).status).not.toBe(200);
  });

  it("refuses a link that was never one of egma's, naming nothing", async () => {
    api = await createApi("reset_forged", { emailDelivers: true });
    await signUp("ada@acme.example");

    const forged = await setPassword("not-a-link-this-egma-ever-sent", CHOSEN);
    expect(forged.status).toBe(404);
    expect(forged.body.error).toBe("no_such_reset_link");

    expect((await signIn("ada@acme.example", FORGOTTEN)).status).toBe(200);
  });
});

/**
 * The hour the message promises is the hour that applies — everywhere.
 *
 * The seal is signed rather than encrypted, so the provider's own token reads
 * straight out of any link, and the provider's whole surface is served under
 * this instance's origin. **So the provider's own deadline is the one that has
 * to be true**, and it is: egma states an hour and configures the provider with
 * that same hour, which is why there is now nothing to shut and nothing to
 * spell around.
 *
 * A route of egma's own in front of that endpoint would only ever have been a
 * spelling of it. `POST /api/auth/x/../reset-password` reaches the same handler
 * — Fastify matches the target as it arrived, so an exact route never sees it,
 * while the URL the provider is handed is parsed with its dot segments removed
 * — and that is exactly the shape a shorter deadline behind a longer one gets
 * found through. So both spellings are driven here, and neither is a way in.
 */
describe("the provider's own reset endpoint", () => {
  async function setPasswordAtTheProvider(
    url: string,
    token: string,
    password: string,
  ): Promise<number> {
    const response = await api.app.inject({
      method: "POST",
      url,
      headers: {
        "content-type": "application/json",
        origin: api.config.baseUrl,
      },
      payload: { token, newPassword: password },
    });
    return response.statusCode;
  }

  it("stops honouring the raw token at the same hour the message names", async () => {
    api = await createApi("reset_raw_late", { emailDelivers: true });
    await signUp("ada@acme.example");
    const raw = rawTokenIn(tokenIn(await linkSentTo("ada@acme.example")));

    minutesLater(PASSWORD_RESET_LIFETIME_MINUTES + 1);
    const direct = await setPasswordAtTheProvider(
      "/api/auth/reset-password",
      raw,
      CHOSEN,
    );
    const around = await setPasswordAtTheProvider(
      "/api/auth/x/../reset-password",
      raw,
      CHOSEN,
    );
    vi.useRealTimers();

    expect(direct).not.toBe(200);
    expect(around).not.toBe(200);

    // The password is the one they forgot, and the one somebody typed at the
    // provider's own door is nothing.
    expect((await signIn("ada@acme.example", FORGOTTEN)).status).toBe(200);
    expect((await signIn("ada@acme.example", CHOSEN)).status).not.toBe(200);
  });
});

describe("asking for a link", () => {
  /**
   * The flow never says who holds an account here. An address nobody signed up
   * with and an address somebody did get the same status and the same sentence,
   * so the form is not a way to ask egma who its customers are.
   */
  it("answers an address with no account exactly as one with an account", async () => {
    api = await createApi("reset_no_account", { emailDelivers: true });
    await signUp("ada@acme.example");

    const known = await askForALink("ada@acme.example");
    const stranger = await askForALink("nobody@globex.example");

    expect(stranger).toEqual(known);

    // Identical to whoever asked, and different underneath: nothing was posted
    // to the address nobody holds, because there was nobody to post it to.
    expect(api.mail.map((message) => message.to)).not.toContain(
      "nobody@globex.example",
    );
  });

  it("refuses a body with no address in it, which is a different thing", async () => {
    api = await createApi("reset_no_address", { emailDelivers: true });

    const response = await api.app.inject({
      method: "POST",
      url: "/api/password-reset",
      payload: {},
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe("invalid_request");
  });

  /**
   * And says so about the person's situation rather than about a body parser.
   * The provider's own sentence for this is `[body.email] Invalid email
   * address`, which names code; what reaches a person, or the coding agent
   * reading for them, is what they typed and what is wrong with it.
   */
  it("refuses an address that is not one, in words about the address", async () => {
    api = await createApi("reset_bad_address", { emailDelivers: true });

    const refused = await askForALink("not-an-email");
    expect(refused.status).toBe(400);
    expect(refused.body.error).toBe("invalid_request");
    expect(refused.body.message).toBe("not-an-email is not an email address");
  });

  it("mints a second link without spending the first", async () => {
    api = await createApi("reset_two_links", { emailDelivers: true });
    await signUp("ada@acme.example");

    const first = tokenIn(await linkSentTo("ada@acme.example"));
    const second = tokenIn(await linkSentTo("ada@acme.example"));
    expect(second).not.toBe(first);

    expect((await setPassword(first, CHOSEN)).status).toBe(200);
    expect((await signIn("ada@acme.example", CHOSEN)).status).toBe(200);
  });

  /**
   * **Saying the same words is only half of saying the same thing.** A platform
   * that posts mail spends a quarter of a second reaching an SMTP server before
   * it answers an address it knows, and nothing at all before it answers one it
   * does not — so the two identical sentences arrive twenty times apart, and one
   * unauthenticated request tells a stranger who holds an account here.
   *
   * The transport here is held open on purpose, because a fake one that returns
   * the instant it is called cannot tell a flow that waits for delivery from one
   * that does not. The claim is that the answer is back **while the message is
   * still going**, which is a fact rather than a measurement: no threshold, no
   * clock, nothing to be flaky about on a busy machine.
   */
  it("answers before the message has gone anywhere, so the wait says nothing", async () => {
    let posting: Promise<void> | undefined;
    let handOver: () => void = () => {};

    api = await createApi("reset_timing", {
      emailDelivers: true,
      emailSendCompletesOn: () => posting,
    });
    // Armed only now: the message signup posts is not what this is about.
    await signUp("ada@acme.example");
    posting = new Promise<void>((resolve) => {
      handOver = resolve;
    });

    const answered = await Promise.race([
      askForALink("ada@acme.example").then((asked) => asked.status),
      new Promise<"still waiting for the message">((resolve) =>
        setTimeout(() => resolve("still waiting for the message"), 2_000),
      ),
    ]);
    // The message was handed to the transport, and is still on its way.
    expect(api.mail.map((message) => message.to)).toContain("ada@acme.example");
    handOver();

    expect(answered).toBe(202);
  });

  /**
   * A mail failure keeps its exception class and source frames. Its message is
   * removed before the log is written because an SMTP response can quote the
   * recipient or message content.
   */
  it("writes a safe exception shape when a message does not go", async () => {
    const lines: string[] = [];
    api = await createApi("reset_send_failed", {
      emailDelivers: true,
      logTo: { write: (line) => lines.push(line) },
      emailSendCompletesOn: () =>
        Promise.reject(new Error("the smtp server refused the message")),
    });
    await signUp("ada@acme.example");

    expect((await askForALink("ada@acme.example")).status).toBe(202);

    const failure = await eventually(() =>
      lines
        .map((line) => JSON.parse(line) as { level: number; err?: unknown })
        .find((line) => line.level >= 50 && line.err !== undefined),
    );
    const cause = failure.err as { type?: string; message?: string; stack?: string };
    expect(cause.type).toBe("Error");
    expect(cause.message).toBe("[redacted]");
    expect(cause.stack).toBe("");
    expect(JSON.stringify(failure)).not.toContain(
      "the smtp server refused the message",
    );
  });

  /**
   * Where somebody was going survives the message, because the message is the
   * one hop no page does: a fresh tab, minutes later, with nothing left holding
   * it. A developer who was approving a terminal's login when they discovered
   * they had forgotten their password lands back on that page, and the terminal
   * stops waiting.
   */
  it("writes where to go afterwards into the link, when it was told", async () => {
    api = await createApi("reset_return_to", { emailDelivers: true });
    await signUp("ada@acme.example");

    const link = await linkSentTo("ada@acme.example", "/device/approve?code=WDJB");
    expect(link.searchParams.get("next")).toBe("/device/approve?code=WDJB");
  });

  /**
   * **This door is open to the whole internet and it writes a message egma
   * signs its own name to**, so a return path that leaves the instance is an
   * open redirect somebody else gets to post. The tab is the one that mattered:
   * `/<TAB>/elsewhere.example` passed a rule written as a list of shapes, and a
   * browser reads it as `//elsewhere.example` because a URL parser strips the
   * tab before it parses. A victim would have got a genuine egma link, on the
   * real origin, and landed off the instance the moment they signed in.
   */
  it("writes nothing that could send somebody off this instance", async () => {
    api = await createApi("reset_return_elsewhere", { emailDelivers: true });
    await signUp("ada@acme.example");

    for (const hostile of [
      "https://elsewhere.example/x",
      "//elsewhere.example/x",
      "/\\elsewhere.example",
      "javascript:alert(1)",
      "/\t/elsewhere.example",
      "/\t\\elsewhere.example",
      "/\n/elsewhere.example",
      "/\r\n//elsewhere.example",
    ]) {
      const link = await linkSentTo("ada@acme.example", hostile);
      expect(link.searchParams.get("next"), hostile).toBeNull();
    }
  });

  /**
   * And a path that stays here but carries a line break is answered rather than
   * thrown over. It used to travel to the provider as a header, where
   * `Headers.append` refused it: an unauthenticated caller could reach a 500 and
   * an error-level log with a stack in it, from a public door, by typing two
   * characters. ADR-0007 has no room for either.
   */
  it("does not break over a line ending in one", async () => {
    api = await createApi("reset_return_crlf", { emailDelivers: true });
    await signUp("ada@acme.example");

    const asked = await askForALink("ada@acme.example", "/foo\r\nx: y");
    expect(asked.status).toBe(202);

    const link = linkIn(api.mail.at(-1) as Email);
    const next = link.searchParams.get("next");
    expect(next).not.toBeNull();
    expect(next).not.toMatch(/[\r\n]/);
  });
});
