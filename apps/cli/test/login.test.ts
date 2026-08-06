/**
 * Login, end to end, against a fixture of egma's public HTTP API.
 *
 * No platform, no database and no browser: the CLI speaks the public API and
 * the fixture answers it, including which refusal goes with which state. What
 * is asserted is what a developer could check afterwards — what landed on
 * screen, what landed on disk, and what the file it landed in is readable by.
 */

import { stat } from "node:fs/promises";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { codeFromPaste } from "../src/platform/device-flow.ts";
import {
  readCredentials,
  resolvePlatformUrl,
  DEFAULT_PLATFORM_URL,
} from "../src/platform/credentials.ts";
import { logIn, type LoginPrompt } from "../src/platform/login.ts";
import { startPlatform, type Platform } from "./support/fixture-platform/index.ts";
import { makeWorkspace, type Workspace } from "./support/workspace.ts";

let platform: Platform;
let workspace: Workspace;

beforeEach(async () => {
  platform = await startPlatform();
  workspace = await makeWorkspace();
});

afterEach(async () => {
  await platform.close();
  await workspace.remove();
});

/** Everything a run of `logIn` said and did, collected for the assertions. */
type Watched = {
  readonly prompts: LoginPrompt[];
  readonly said: string[];
  readonly opened: string[];
};

function watch(): Watched {
  return { prompts: [], said: [], opened: [] };
}

type RunOptions = {
  readonly watched: Watched;
  readonly signal?: AbortSignal;
  readonly force?: boolean;
  /** Answers with whatever should be pasted back, once. */
  readonly paste?: () => string | null;
  /** Runs the moment the code is on screen: what a person in a browser does. */
  readonly whenPrompted?: (prompt: LoginPrompt) => void;
};

async function login(options: RunOptions) {
  return logIn({
    url: platform.url,
    credentialsFile: workspace.credentialsFile,
    signal: options.signal ?? new AbortController().signal,
    ...(options.force === undefined ? {} : { force: options.force }),
    ...(options.paste === undefined ? {} : { paste: options.paste }),
    onPrompt: (prompt) => {
      options.watched.prompts.push(prompt);
      options.whenPrompted?.(prompt);
    },
    say: (line) => options.watched.said.push(line),
    openBrowser: async (url) => {
      options.watched.opened.push(url);
      return true;
    },
    // Nothing here waits on a person, so nothing here waits.
    sleep: async () => undefined,
  });
}

describe("signing a machine in", () => {
  it("shows a code and an address, and leaves a key only a person can read", async () => {
    const watched = watch();

    const outcome = await login({
      watched,
      // The browser opened and somebody approved what was already in the field.
      whenPrompted: (prompt) => {
        expect(platform.device.approve(prompt.userCode)).toBe(true);
      },
    });

    expect(outcome.kind).toBe("stored");

    // What the developer saw: one code, one address, and the address carries
    // the code so nobody retypes eight characters between two windows.
    expect(watched.prompts).toHaveLength(1);
    const shown = watched.prompts[0] as LoginPrompt;
    expect(shown.userCode).toMatch(/^[A-Z]{4}-[A-Z]{4}$/u);
    expect(shown.url).toContain(platform.url);
    expect(shown.url).toContain(encodeURIComponent(shown.userCode));
    expect(shown.browserOpened).toBe(true);
    expect(watched.opened).toEqual([shown.url]);

    // The key landed, against the egma that minted it.
    const held = await readCredentials(workspace.credentialsFile);
    expect(held?.url).toBe(platform.url);
    expect(held?.key).toMatch(/^egma_sk_/u);
    expect(held?.key).toBe(platform.device.keys.at(-1));

    // And nobody else on the machine can read it.
    const mode = (await stat(workspace.credentialsFile)).mode & 0o777;
    expect(mode.toString(8)).toBe("600");
  });

  it("proves the key it stored works on a request that needs one", async () => {
    const watched = watch();
    await login({
      watched,
      whenPrompted: (prompt) => void platform.device.approve(prompt.userCode),
    });

    const held = await readCredentials(workspace.credentialsFile);
    const used = await fetch(`${platform.url}/api/keys`, {
      headers: { authorization: `Bearer ${held?.key ?? ""}` },
    });
    expect(used.status).toBe(200);

    const refused = await fetch(`${platform.url}/api/keys`, {
      headers: { authorization: "Bearer egma_sk_not-a-real-one" },
    });
    expect(refused.status).toBe(401);
  });

  it("says so and stores nothing when the browser says no", async () => {
    const watched = watch();
    const outcome = await login({
      watched,
      whenPrompted: (prompt) => void platform.device.deny(prompt.userCode),
    });

    expect(outcome.kind).toBe("denied");
    expect(await readCredentials(workspace.credentialsFile)).toBeNull();
  });

  it("says the code ran out, which is not the same as being told no", async () => {
    const watched = watch();
    const outcome = await login({
      watched,
      whenPrompted: (prompt) => void platform.device.expire(prompt.userCode),
    });

    expect(outcome.kind).toBe("expired");
    expect(await readCredentials(workspace.credentialsFile)).toBeNull();
  });

  it("backs off when told it is asking too fast, and still gets there", async () => {
    const watched = watch();
    platform.device.slowDownOnce();

    const outcome = await login({
      watched,
      whenPrompted: (prompt) => void platform.device.approve(prompt.userCode),
    });

    expect(outcome.kind).toBe("stored");
    expect(platform.records.filter((seen) => seen.path === "/api/device/token").length)
      .toBeGreaterThan(1);
  });

  it("names an egma that never answered, rather than reporting a broken thing", async () => {
    const outcome = await logIn({
      // Nothing listens here: the port is reserved and the address is not routed.
      url: "http://127.0.0.1:1",
      credentialsFile: workspace.credentialsFile,
      signal: new AbortController().signal,
      onPrompt: () => undefined,
      sleep: async () => undefined,
    });

    expect(outcome.kind).toBe("unreachable");
    expect(outcome.kind === "unreachable" && outcome.reason).toContain("127.0.0.1:1");
    expect(await readCredentials(workspace.credentialsFile)).toBeNull();
  });

  it("stops where it stands when the developer stops it", async () => {
    const controller = new AbortController();
    const watched = watch();

    const outcome = await login({
      watched,
      signal: controller.signal,
      whenPrompted: () => controller.abort("interrupt"),
    });

    expect(outcome.kind).toBe("interrupted");
    expect(await readCredentials(workspace.credentialsFile)).toBeNull();
  });
});

describe("a machine that is already signed in", () => {
  it("asks for nothing and approves nothing", async () => {
    await workspace.signIn(platform.url, "egma_sk_held-already");

    const watched = watch();
    const outcome = await login({ watched });

    expect(outcome.kind).toBe("already-stored");
    expect(watched.prompts).toHaveLength(0);
    // Not one call was made: the whole step costs nothing on a second run.
    expect(platform.records).toHaveLength(0);
  });

  it("signs in again when told to, and replaces the key it held", async () => {
    await workspace.signIn(platform.url, "egma_sk_held-already");

    const watched = watch();
    const outcome = await login({
      watched,
      force: true,
      whenPrompted: (prompt) => void platform.device.approve(prompt.userCode),
    });

    expect(outcome.kind).toBe("stored");
    const held = await readCredentials(workspace.credentialsFile);
    expect(held?.key).not.toBe("egma_sk_held-already");
    expect(held?.key).toBe(platform.device.keys.at(-1));
  });

  it("signs in again for a different egma, because a key is only good at one", async () => {
    await workspace.signIn("https://somewhere.else.example", "egma_sk_for-somewhere-else");

    const watched = watch();
    const outcome = await login({
      watched,
      whenPrompted: (prompt) => void platform.device.approve(prompt.userCode),
    });

    expect(outcome.kind).toBe("stored");
    expect((await readCredentials(workspace.credentialsFile))?.url).toBe(platform.url);
  });
});

/**
 * The machine with no browser on it: a devbox, anything over SSH.
 *
 * The address goes to a browser somewhere else, and what comes back is whatever
 * was easiest to select over there. All three shapes carry the same fact, so
 * all three work — and a code from somebody else's terminal is refused by name
 * rather than silently waited on.
 */
describe("coming back from a browser on another machine", () => {
  const shapes = [
    { called: "the whole address", of: (prompt: LoginPrompt) => prompt.url },
    {
      called: "the query part of it",
      of: (prompt: LoginPrompt) => `?user_code=${prompt.userCode}`,
    },
    { called: "the bare code", of: (prompt: LoginPrompt) => prompt.userCode },
    {
      called: "the code as it was read out",
      of: (prompt: LoginPrompt) => prompt.userCode.replace("-", " ").toLowerCase(),
    },
  ];

  /**
   * The developer walks away with the address, approves it over there, and
   * comes back to paste something in. Approving therefore happens at the moment
   * the paste is handed over, and not before — which is why the first ask comes
   * back pending and the paste is what makes the second one land.
   */
  function pasteAfterApproving(
    watched: Watched,
    held: { text: string | null },
  ): () => string | null {
    return () => {
      const typed = held.text;
      if (typed === null) return null;
      held.text = null;
      platform.device.approve(watched.prompts[0]?.userCode ?? "");
      return typed;
    };
  }

  for (const shape of shapes) {
    it(`completes the login when ${shape.called} is pasted back`, async () => {
      const watched = watch();
      const held: { text: string | null } = { text: null };

      const outcome = await login({
        watched,
        // No browser opens here: this is the machine that has none.
        whenPrompted: (prompt) => {
          held.text = shape.of(prompt);
        },
        paste: pasteAfterApproving(watched, held),
      });

      expect(outcome.kind).toBe("stored");
      expect(watched.said).toContain("Checking that one now.");
      expect((await readCredentials(workspace.credentialsFile))?.key).toBe(
        platform.device.keys.at(-1),
      );
    });
  }

  it("says which code it is waiting on when somebody pastes another one", async () => {
    const watched = watch();
    const held = { text: "ZZZZ-ZZZZ" as string | null };

    const outcome = await login({ watched, paste: pasteAfterApproving(watched, held) });

    // Somebody else's code changes nothing about this terminal's own login,
    // which still finishes on the approval that did happen.
    expect(outcome.kind).toBe("stored");
    const complaint = watched.said.find((line) => line.includes("ZZZZZZZZ"));
    expect(complaint).toBeDefined();
    expect(complaint).toContain(watched.prompts[0]?.userCode);
  });

  it("says so when what was pasted is not a code at all", async () => {
    const watched = watch();
    const held = { text: "I approved it, thanks" as string | null };

    await login({ watched, paste: pasteAfterApproving(watched, held) });

    expect(watched.said.some((line) => line.includes("not an egma code"))).toBe(true);
  });
});

describe("reading a code out of whatever was pasted", () => {
  it("takes all three shapes and refuses what is not one", () => {
    expect(codeFromPaste("http://egma.example/device/approve?user_code=WDJB-MJHT")).toBe(
      "WDJBMJHT",
    );
    expect(codeFromPaste("?user_code=WDJB-MJHT")).toBe("WDJBMJHT");
    expect(codeFromPaste("user_code=wdjb-mjht")).toBe("WDJBMJHT");
    expect(codeFromPaste("  WDJB-MJHT  ")).toBe("WDJBMJHT");
    expect(codeFromPaste("wdjb mjht")).toBe("WDJBMJHT");

    expect(codeFromPaste("")).toBeNull();
    expect(codeFromPaste("http://egma.example/device")).toBeNull();
    expect(codeFromPaste("no idea what you mean")).toBeNull();
  });
});

describe("which egma a command talks to", () => {
  it("takes the flag first, then the environment, then what was stored", () => {
    expect(
      resolvePlatformUrl({
        flag: "http://flag.example/",
        env: "http://env.example",
        stored: "http://stored.example",
      }),
    ).toBe("http://flag.example");

    expect(
      resolvePlatformUrl({ flag: null, env: "http://env.example", stored: "http://stored.example" }),
    ).toBe("http://env.example");

    // Which is what "set it once" means: after the first login, nothing has to
    // say the address again.
    expect(resolvePlatformUrl({ flag: null, stored: "http://stored.example/" })).toBe(
      "http://stored.example",
    );

    expect(resolvePlatformUrl({ flag: null, env: "", stored: null })).toBe(DEFAULT_PLATFORM_URL);
  });
});
