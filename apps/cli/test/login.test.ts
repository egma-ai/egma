/**
 * Login, end to end, against a fixture of egma's public HTTP API.
 *
 * No platform, no database and no browser: the CLI speaks the public API and
 * the fixture answers it, including which refusal goes with which state. What
 * is asserted is what a developer could check afterwards — what landed on
 * screen, what landed on disk, and what the file it landed in is readable by.
 */

import {
  chmod,
  lstat,
  mkdir,
  readdir,
  readFile,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openInBrowser } from "../src/platform/browser.ts";
import { codeFromPaste, startDeviceAuthorization } from "../src/platform/device-flow.ts";
import {
  CredentialsFileUnreadableError,
  readCredentials,
  resolvePlatformUrl,
  writeCredentials,
  UnusableUrlError,
} from "../src/platform/credentials.ts";
import { logIn, type LoginPrompt } from "../src/platform/login.ts";
import { startPlatform, type Platform } from "./support/fixture-platform/index.ts";
import { makeWorkspace, NO_BROWSER, type Workspace } from "./support/workspace.ts";

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
  /** Every wait, in milliseconds, in the order it was asked for. */
  readonly waits?: number[];
  /** Runs at each wait, so a test can change the world between two polls. */
  readonly whenWaiting?: (waits: readonly number[]) => void;
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
    // Nothing here waits on a person, so nothing here waits — but how long it
    // was going to wait for is written down, because the pace is a promise.
    sleep: async (ms) => {
      options.waits?.push(ms);
      options.whenWaiting?.(options.waits ?? []);
    },
  });
}

describe("signing a machine in", () => {
  it("shows a code and an address, and leaves a key only a person can read", async () => {
    const watched = watch();

    const result = await login({
      watched,
      // The browser opened and somebody approved what was already in the field.
      whenPrompted: (prompt) => {
        expect(platform.device.approve(prompt.userCode)).toBe(true);
      },
    });

    expect(result.kind).toBe("stored");

    // What the developer saw: one code, one address, and the address carries
    // the code so nobody retypes eight characters between two windows.
    expect(watched.prompts).toHaveLength(1);
    const shown = watched.prompts[0] as LoginPrompt;
    // Eight characters, exactly as the real instance issues them.
    expect(shown.userCode).toMatch(/^[A-Z0-9]{8}$/u);
    expect(shown.url).toContain(platform.url);
    expect(shown.url).toContain(encodeURIComponent(shown.userCode));
    expect(shown.browserOpened).toBe(true);
    expect(watched.opened).toEqual([shown.url]);

    // The key landed, against the egma that minted it.
    const held = await readCredentials(workspace.credentialsFile, platform.url);
    expect(held?.url).toBe(platform.url);
    expect(held?.key).toMatch(/^egma_sk_/u);
    expect(held?.key).toBe(platform.device.keys.at(-1));
    expect(held?.login).toEqual({
      apiKeyId: expect.stringMatching(/^ak_/u),
      projectId: platform.projectId,
    });
    expect(JSON.parse(await readFile(workspace.credentialsFile, "utf8"))).toEqual({
      version: 2,
      platforms: {
        [platform.url]: {
          api_key: held?.key,
          login: {
            api_key_id: held?.login?.apiKeyId,
            project_id: platform.projectId,
          },
        },
      },
    });

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

    const held = await readCredentials(workspace.credentialsFile, platform.url);
    const used = await fetch(`${platform.url}/v1/keys`, {
      headers: { authorization: `Bearer ${held?.key ?? ""}` },
    });
    expect(used.status).toBe(200);

    const refused = await fetch(`${platform.url}/v1/keys`, {
      headers: { authorization: "Bearer egma_sk_not-a-real-one" },
    });
    expect(refused.status).toBe(401);
  });

  it("says so and stores nothing when the browser says no", async () => {
    const watched = watch();
    const result = await login({
      watched,
      whenPrompted: (prompt) => void platform.device.deny(prompt.userCode),
    });

    expect(result.kind).toBe("denied");
    expect(
      await readCredentials(workspace.credentialsFile, platform.url),
    ).toBeNull();
  });

  it("says the code ran out, which is not the same as being told no", async () => {
    const watched = watch();
    const result = await login({
      watched,
      whenPrompted: (prompt) => void platform.device.expire(prompt.userCode),
    });

    expect(result.kind).toBe("expired");
    expect(
      await readCredentials(workspace.credentialsFile, platform.url),
    ).toBeNull();
  });

  it("backs off by five seconds when told it is asking too fast, and stays there", async () => {
    const watched = watch();
    platform.device.slowDownOnce();

    // Nobody approves at first, so the poll after the back-off is an ordinary
    // "still waiting" — which is the answer the pace used to spring back on.
    const waits: number[] = [];
    const result = await login({
      watched,
      waits,
      whenWaiting: (asked) => {
        if (asked.length === 2) platform.device.approve(watched.prompts[0]?.userCode ?? "");
      },
    });

    expect(result.kind).toBe("stored");
    // RFC 8628: five seconds on top, for this request and every one after it.
    // The fixture issues an interval of zero, so both waits are the five.
    expect(waits).toEqual([5_000, 5_000]);
  });

  it("does not ask for a key again because somebody pasted the wrong thing", async () => {
    // A wrong paste must not be a way to make egma poll: a developer holding a
    // paste key would otherwise ask for a key as fast as they could type.
    platform.device.pollEvery(30);

    const watched = watch();
    const controller = new AbortController();
    const flood = ["I approved it, thanks", "https://example.test/somewhere", "ZZZZZZZZ"];
    let pasted = 0;

    const result = await login({
      watched,
      signal: controller.signal,
      paste: () => {
        if (pasted < flood.length) {
          pasted += 1;
          return flood[pasted - 1] ?? null;
        }
        controller.abort("interrupt");
        return null;
      },
    });

    expect(result.kind).toBe("interrupted");
    expect(pasted).toBe(flood.length);
    // One request, and it is the one that was going to happen anyway. Not one
    // of the three pastes added another.
    expect(platform.records.filter((seen) => seen.path === "/api/device/token")).toHaveLength(1);
    // And the developer was told about every one of them.
    expect(watched.said).toHaveLength(flood.length);
  });

  it("names an egma that never answered, rather than reporting a broken thing", async () => {
    const result = await logIn({
      // Nothing listens here: the port is reserved and the address is not routed.
      url: "http://127.0.0.1:1",
      credentialsFile: workspace.credentialsFile,
      signal: new AbortController().signal,
      onPrompt: () => undefined,
      sleep: async () => undefined,
    });

    expect(result.kind).toBe("unreachable");
    expect(result.kind === "unreachable" && result.reason).toContain("127.0.0.1:1");
    expect(
      await readCredentials(workspace.credentialsFile, "http://127.0.0.1:1"),
    ).toBeNull();
  });

  it("stops where it stands when the developer stops it", async () => {
    const controller = new AbortController();
    const watched = watch();

    const result = await login({
      watched,
      signal: controller.signal,
      whenPrompted: () => controller.abort("interrupt"),
    });

    expect(result.kind).toBe("interrupted");
    expect(
      await readCredentials(workspace.credentialsFile, platform.url),
    ).toBeNull();
  });
});

describe("a machine that is already signed in", () => {
  it("asks for nothing and approves nothing", async () => {
    await workspace.signIn(platform.url, "egma_sk_held-already");

    const watched = watch();
    const result = await login({ watched });

    expect(result.kind).toBe("already-stored");
    expect(watched.prompts).toHaveLength(0);
    // Not one call was made: the whole step costs nothing on a second run.
    expect(platform.records).toHaveLength(0);
  });

  it("signs in again when told to, and replaces the key it held", async () => {
    await workspace.signIn(platform.url, "egma_sk_held-already");

    const watched = watch();
    const result = await login({
      watched,
      force: true,
      whenPrompted: (prompt) => void platform.device.approve(prompt.userCode),
    });

    expect(result.kind).toBe("stored");
    const held = await readCredentials(workspace.credentialsFile, platform.url);
    expect(held?.key).not.toBe("egma_sk_held-already");
    expect(held?.key).toBe(platform.device.keys.at(-1));
  });

  it("signs in again for a different egma, because a key is only good at one", async () => {
    await workspace.signIn("https://somewhere.else.example", "egma_sk_for-somewhere-else");

    const watched = watch();
    const result = await login({
      watched,
      whenPrompted: (prompt) => void platform.device.approve(prompt.userCode),
    });

    expect(result.kind).toBe("stored");
    expect((await readCredentials(workspace.credentialsFile, platform.url))?.url).toBe(
      platform.url,
    );
    expect(
      await readCredentials(workspace.credentialsFile, "https://somewhere.else.example"),
    ).toEqual({
      url: "https://somewhere.else.example",
      key: "egma_sk_for-somewhere-else",
    });
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
      called: "the code as somebody read it out",
      of: (prompt: LoginPrompt) =>
        `${prompt.userCode.slice(0, 4)} ${prompt.userCode.slice(4)}`.toLowerCase(),
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

      const result = await login({
        watched,
        // No browser opens here: this is the machine that has none.
        whenPrompted: (prompt) => {
          held.text = shape.of(prompt);
        },
        paste: pasteAfterApproving(watched, held),
      });

      expect(result.kind).toBe("stored");
      expect(watched.said).toContain("Checking that one now.");
      expect(
        (await readCredentials(workspace.credentialsFile, platform.url))?.key,
      ).toBe(platform.device.keys.at(-1));
    });
  }

  it("says which code it is waiting on when somebody pastes another one", async () => {
    const watched = watch();
    const held = { text: "ZZZZ-ZZZZ" as string | null };

    const result = await login({ watched, paste: pasteAfterApproving(watched, held) });

    // Somebody else's code changes nothing about this terminal's own login,
    // which still finishes on the approval that did happen.
    expect(result.kind).toBe("stored");
    const complaint = watched.said.find((line) => line.includes("ZZZZZZZZ"));
    expect(complaint).toBeDefined();
    expect(complaint).toContain(watched.prompts[0]?.userCode);
  });

  it("says so when what was pasted is not a code at all", async () => {
    const watched = watch();
    const held = { text: "I approved it, thanks" as string | null };

    await login({ watched, paste: pasteAfterApproving(watched, held) });

    expect(watched.said.some((line) => line.includes("not an Egma code"))).toBe(true);
  });
});

describe("reading a code out of whatever was pasted", () => {
  it("takes all three shapes and refuses what is not one", () => {
    expect(codeFromPaste("http://egma.example/device?user_code=WDJB-MJHT")).toBe("WDJBMJHT");
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
  // The address egma falls back to, stood in for so that reading this test
  // never says which address ships. That is asserted in one place, on its own.
  const BUILT_IN = "http://built-in.example";

  /** The published package, whose every written word is egma's to a reader. */
  const CLI_PACKAGE = fileURLToPath(new URL("..", import.meta.url));

  /** Every file under a folder, as full paths. */
  async function filesIn(folder: string): Promise<readonly string[]> {
    const entries = await readdir(folder, { recursive: true, withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile())
      .map((entry) => path.join(entry.parentPath, entry.name));
  }

  it("takes the flag, then the binding, then egma's own", () => {
    expect(
      resolvePlatformUrl({
        flag: "http://flag.example/",
        binding: "http://bound.example",
        fallback: BUILT_IN,
      }),
    ).toBe("http://flag.example");

    // The repository, not the latest login on the machine, is what makes the
    // selection stable after onboarding.
    expect(
      resolvePlatformUrl({ flag: null, binding: "http://bound.example/", fallback: BUILT_IN }),
    ).toBe("http://bound.example");

    // Nothing names a platform, so egma uses its own. This is the step ADR-0008
    // always had and the tree could not have while there was no hosted egma to
    // point at.
    expect(resolvePlatformUrl({ flag: null, binding: null, fallback: BUILT_IN })).toBe(
      BUILT_IN,
    );

    // And it really is last: each of the two deliberate places still wins over
    // it on its own.
    expect(resolvePlatformUrl({ flag: "http://flag.example", fallback: BUILT_IN })).toBe(
      "http://flag.example",
    );
    expect(resolvePlatformUrl({ binding: "http://bound.example", fallback: BUILT_IN })).toBe(
      "http://bound.example",
    );
  });

  it("refuses an address that is not one, and names where it came from", () => {
    // The next thing that happens to this address is that a browser is started
    // on it, so it is checked at the edge that takes it and not after.
    for (const given of [
      "javascript:alert(1)",
      "file:///etc/passwd",
      "not an address at all",
      "https://example.com;touch-owned",
      "https://exa$mple.com",
      "https://example.com`id`",
    ]) {
      expect(() =>
        resolvePlatformUrl({ flag: given, fallback: BUILT_IN }),
      ).toThrow(UnusableUrlError);
    }

    expect(() =>
      resolvePlatformUrl({ flag: "ftp://egma.example", fallback: BUILT_IN }),
    ).toThrow(/--url/u);

    // A committed binding is never stepped over in favour of egma's own.
    expect(() =>
      resolvePlatformUrl({ flag: null, binding: "javascript:alert(1)", fallback: BUILT_IN }),
    ).toThrow(/repository platform binding/u);
  });

  /**
   * One explicit way to name a platform, and the second one really gone.
   *
   * `EGMA_URL` was once a whole-shell name for `--url`, and taking the rung out
   * of resolution is only half of taking it out: a `--help` line, a README
   * paragraph or a refusal that still tells somebody to set it is a setting
   * egma no longer has, offered by egma. The one that would have survived a
   * careful edit is the refusal — "Remove --url or EGMA_URL" is the sentence a
   * developer meets at the exact moment they are least able to tell that half
   * of it is fiction.
   *
   * So the whole of what egma ships is scanned rather than the places anybody
   * remembered — the help text and every refusal are inside `src/`, so both are
   * covered by reading it. The checks themselves are not scanned: proving the
   * variable is inert means naming it.
   *
   * No shipped CLI source names it. Monitoring setup now points to the skill;
   * the CLI does not write a worker environment file.
   */
  it("offers one way to name a platform and does not name the old one", async () => {
    // Everything `package.json` puts in the published package, plus the
    // repository's own front page. `dist` is left out because it is `src`
    // compiled, and a scan of both would go red twice for one mention.
    const written = [
      ...(await filesIn(path.join(CLI_PACKAGE, "src"))),
      ...(await filesIn(path.join(CLI_PACKAGE, "smoke"))),
      path.join(CLI_PACKAGE, "NOTICE"),
      path.join(CLI_PACKAGE, "README.md"),
      path.join(CLI_PACKAGE, "..", "..", "README.md"),
    ];
    expect(written.length).toBeGreaterThan(20);

    const naming: string[] = [];
    for (const file of written) {
      if ((await readFile(file, "utf8")).includes("EGMA_URL")) {
        naming.push(path.relative(CLI_PACKAGE, file).replaceAll(path.sep, "/"));
      }
    }
    expect(naming).toEqual([]);
  });
});

/**
 * What egma will start a browser on.
 *
 * The address comes back from the instance, and handing a string to a browser
 * opener is handing it to a program. What fails here is not a failed login: the
 * address is still on the screen, and the paste-back still finishes it.
 */
describe("what an instance can put on this terminal's screen", () => {
  it("draws no instruction, whatever the instance sent", async () => {
    // A terminal reads a control character as an instruction rather than as
    // text. An address carrying one could clear the screen or redraw what egma
    // just said, so they are taken out where the wire is read.
    const ESCAPE = "\u001b";
    const BELL = "\u0007";
    const answered = new Response(
      JSON.stringify({
        device_code: "a-device-code",
        // An escape and a clear-the-screen, and an address that rings the bell.
        user_code: `ABCD${ESCAPE}[2J1234`,
        verification_uri_complete: `https://app.egma.example/device?user_code=ABCD${BELL}1234`,
        expires_in: 900,
        interval: 5,
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );

    const grant = await startDeviceAuthorization(
      "https://app.egma.example",
      async () => answered,
    );

    expect(grant.userCode).not.toContain(ESCAPE);
    expect(grant.userCode).toBe("ABCD[2J1234");
    expect(grant.approveUrl).not.toContain(BELL);
    expect(grant.approveUrl).toBe("https://app.egma.example/device?user_code=ABCD1234");
  });
});

describe("the addresses egma hands to a browser", () => {
  const instance = "https://app.egma.example";
  const opens = (url: string): Promise<boolean> =>
    // A browser that opens nothing, because a check that opened a real one on
    // the machine running the suite would be intolerable.
    openInBrowser(url, { instanceUrl: instance, env: { BROWSER: NO_BROWSER } });

  it("opens the approval address on the egma this login is against", async () => {
    expect(await opens(`${instance}/device?user_code=ABCD1234`)).toBe(true);
  });

  it("opens nothing for a scheme that is not the web", async () => {
    // `open` and `xdg-open` will launch these as happily as a web page.
    expect(await opens("javascript:alert(document.cookie)")).toBe(false);
    expect(await opens("file:///etc/passwd")).toBe(false);
  });

  it("opens nothing on an origin this login is not against", async () => {
    expect(await opens("https://not-egma.example/device?user_code=ABCD1234")).toBe(false);
  });

  it("opens nothing carrying a character a command interpreter reads", async () => {
    // On Windows the opener is `cmd /c start`, which reads what it is given a
    // second time: these end the address and begin a command.
    expect(await opens(`${instance}/device?user_code=A&calc.exe`)).toBe(false);
    expect(await opens(`${instance}/device?user_code=A|calc.exe`)).toBe(false);
    expect(await opens(`${instance}/device?user_code=A calc.exe`)).toBe(false);
  });
});

describe("writing the key down", () => {
  const held = { url: "https://app.egma.example", key: "egma_sk_freshly-minted" };

  it("narrows a file that was already there, whatever it was readable by", async () => {
    await mkdir(path.dirname(workspace.credentialsFile), { recursive: true });
    await writeFile(workspace.credentialsFile, "{}\n", "utf8");
    await chmod(workspace.credentialsFile, 0o644);

    await writeCredentials(workspace.credentialsFile, held);

    // The key landed in a file nobody else can read — which is only true
    // because a fresh file was renamed over this one rather than written into.
    expect(((await stat(workspace.credentialsFile)).mode & 0o777).toString(8)).toBe("600");
    expect(await readCredentials(workspace.credentialsFile, held.url)).toEqual(held);
  });

  it("does not follow a link standing where the key goes", async () => {
    // Somebody else's keys, in their own file, which this run must leave
    // exactly as it found them. A write that went through the link rather than
    // over it would put the fresh key in here.
    const theirs = `${JSON.stringify(
      { version: 1, platforms: { "https://theirs.example": { key: "egma_sk_theirs" } } },
      null,
      2,
    )}\n`;
    const elsewhere = path.join(workspace.dir, "somebody-elses-file");
    await writeFile(elsewhere, theirs, "utf8");
    await mkdir(path.dirname(workspace.credentialsFile), { recursive: true });
    await symlink(elsewhere, workspace.credentialsFile);

    await writeCredentials(workspace.credentialsFile, held);

    // The link itself was replaced. Nothing was written through it, so the file
    // it pointed at is exactly as it was, byte for byte.
    expect(await readFile(elsewhere, "utf8")).toBe(theirs);
    expect((await lstat(workspace.credentialsFile)).isSymbolicLink()).toBe(false);
    expect(((await stat(workspace.credentialsFile)).mode & 0o777).toString(8)).toBe("600");
    expect(await readCredentials(workspace.credentialsFile, held.url)).toEqual(held);
  });

  /**
   * A file egma cannot make sense of is not an empty file.
   *
   * Reading a damaged file as "no keys at all" reads harmlessly and then does
   * the worst thing in the package: the next login merges into nothing and
   * renames itself over the file, and every other platform's key is gone. A
   * truncated file can be repaired by whoever damaged it; one egma has already
   * overwritten cannot.
   */
  it("refuses a damaged file rather than starting from empty and writing over it", async () => {
    const damaged = '{"version": 1, "platforms": {"https://one.example": {"ke';
    await mkdir(path.dirname(workspace.credentialsFile), { recursive: true });
    await writeFile(workspace.credentialsFile, damaged, "utf8");

    await expect(
      readCredentials(workspace.credentialsFile, "https://one.example"),
    ).rejects.toBeInstanceOf(CredentialsFileUnreadableError);
    await expect(
      writeCredentials(workspace.credentialsFile, held),
    ).rejects.toBeInstanceOf(CredentialsFileUnreadableError);

    // Still exactly what it was, so whoever can repair it still can.
    expect(await readFile(workspace.credentialsFile, "utf8")).toBe(damaged);

    // An empty file is a different thing and stays ordinary: a folder can be
    // made before anything is written into it.
    await writeFile(workspace.credentialsFile, "", "utf8");
    await writeCredentials(workspace.credentialsFile, held);
    expect(await readCredentials(workspace.credentialsFile, held.url)).toEqual(held);
  });

  /**
   * A file egma cannot open is not a file that is not there.
   *
   * Only `ENOENT` means nobody has signed in yet. Everything else — a
   * permission change, a directory standing where the file goes — means the
   * keys exist and cannot be seen, and the write merges what it reads: treat
   * that as an empty file and the rename replaces every platform's key with
   * whichever one this run happened to be writing.
   *
   * A directory is used here because no user, root included, can read one as a
   * file, so this half of the proof holds wherever it is run.
   */
  it("refuses a keys file it cannot open, rather than taking it for an absent one", async () => {
    await mkdir(workspace.credentialsFile, { recursive: true });

    await expect(
      readCredentials(workspace.credentialsFile, held.url),
    ).rejects.toBeInstanceOf(CredentialsFileUnreadableError);
    await expect(
      writeCredentials(workspace.credentialsFile, held),
    ).rejects.toBeInstanceOf(CredentialsFileUnreadableError);

    // Nothing was put anywhere: not into the path, and not beside it.
    expect((await stat(workspace.credentialsFile)).isDirectory()).toBe(true);
    expect(await readdir(workspace.credentialsFile)).toEqual([]);
  });

  /**
   * The same rule, with the thing that would have been lost actually present.
   *
   * Skipped only for a user who can read anything, because there is no way to
   * stage an unreadable file for one — and every other run proves it.
   */
  it.skipIf(process.getuid?.() === 0)(
    "keeps another platform's key when the file is there and cannot be read",
    async () => {
      const theirs = {
        url: "https://already-signed-in.example",
        key: "egma_sk_must-survive-a-refused-write",
      };
      await writeCredentials(workspace.credentialsFile, theirs);
      const asWritten = await readFile(workspace.credentialsFile, "utf8");
      await chmod(workspace.credentialsFile, 0o000);

      await expect(
        writeCredentials(workspace.credentialsFile, held),
      ).rejects.toBeInstanceOf(CredentialsFileUnreadableError);

      await chmod(workspace.credentialsFile, 0o600);
      expect(await readFile(workspace.credentialsFile, "utf8")).toBe(asWritten);
      expect(await readCredentials(workspace.credentialsFile, theirs.url)).toEqual(theirs);
      expect(await readCredentials(workspace.credentialsFile, held.url)).toBeNull();
    },
  );

  /**
   * Two terminals, two repositories, one machine, one file. The write is a
   * read-modify-write over everybody's keys, so without a lock the second
   * rename wins and the first platform's key is gone — and the developer finds
   * out the next time a command says they are not signed in.
   */
  it("keeps every key when several logins land at once", async () => {
    const many = Array.from({ length: 8 }, (_, index) => ({
      url: `https://platform-${String(index)}.example`,
      key: `egma_sk_written-at-the-same-moment-${String(index)}`,
    }));

    await Promise.all(
      many.map((one) => writeCredentials(workspace.credentialsFile, one)),
    );

    for (const one of many) {
      expect(await readCredentials(workspace.credentialsFile, one.url)).toEqual(one);
    }
  });

  it("locks the folder down too, and says nothing when it could", async () => {
    // The other half of this — a folder egma cannot narrow — is a filesystem
    // refusing its own owner, which no check can stage. What is proved here is
    // that the ordinary run really does narrow it, and that the line about
    // failing to is not said when nothing failed.
    const said: string[] = [];
    await writeCredentials(workspace.credentialsFile, held, {
      warn: (line) => said.push(line),
    });

    expect(said).toEqual([]);
    const folder = await stat(path.dirname(workspace.credentialsFile));
    expect((folder.mode & 0o777).toString(8)).toBe("700");
  });

  it("migrates the old single-platform file without losing or exposing its key", async () => {
    const legacy = {
      url: "https://OLD.example/",
      key: "egma_sk_preserved-from-the-old-format",
    };
    const next = {
      url: "https://second.example",
      key: "egma_sk_added-after-the-upgrade",
    };
    await mkdir(path.dirname(workspace.credentialsFile), { recursive: true });
    await writeFile(workspace.credentialsFile, `${JSON.stringify(legacy)}\n`, {
      encoding: "utf8",
      mode: 0o644,
    });

    expect(await readCredentials(workspace.credentialsFile, legacy.url)).toEqual({
      url: "https://old.example",
      key: legacy.key,
    });
    const said: string[] = [];
    await writeCredentials(workspace.credentialsFile, next, {
      warn: (line) => said.push(line),
    });

    expect(await readCredentials(workspace.credentialsFile, legacy.url)).toEqual({
      url: "https://old.example",
      key: legacy.key,
    });
    expect(await readCredentials(workspace.credentialsFile, next.url)).toEqual(next);
    expect(((await stat(workspace.credentialsFile)).mode & 0o777).toString(8)).toBe("600");
    expect(said.join("\n")).not.toContain(legacy.key);
    expect(said.join("\n")).not.toContain(next.key);
    expect(JSON.parse(await readFile(workspace.credentialsFile, "utf8"))).toEqual({
      version: 2,
      platforms: {
        "https://old.example": { api_key: legacy.key },
        "https://second.example": { api_key: next.key },
      },
    });
  });

  it("reads the version 1 platform map and moves it forward on the next write", async () => {
    const old = {
      url: "https://old-map.example",
      key: "egma_sk_preserved-from-version-one",
    };
    await mkdir(path.dirname(workspace.credentialsFile), { recursive: true });
    await writeFile(
      workspace.credentialsFile,
      `${JSON.stringify({ version: 1, platforms: { [old.url]: { key: old.key } } })}\n`,
      "utf8",
    );

    expect(await readCredentials(workspace.credentialsFile, old.url)).toEqual(old);
    await writeCredentials(workspace.credentialsFile, {
      url: "https://new-map.example",
      key: "egma_sk_new-version-two-entry",
    });

    expect(JSON.parse(await readFile(workspace.credentialsFile, "utf8"))).toEqual({
      version: 2,
      platforms: {
        "https://new-map.example": { api_key: "egma_sk_new-version-two-entry" },
        "https://old-map.example": { api_key: old.key },
      },
    });
  });

  it("keeps one key per normalized platform origin", async () => {
    const first = { url: "https://ONE.example/", key: "egma_sk_for-one" };
    const second = { url: "http://localhost:4310", key: "egma_sk_for-two" };

    await writeCredentials(workspace.credentialsFile, first);
    await writeCredentials(workspace.credentialsFile, second);

    expect(await readCredentials(workspace.credentialsFile, "https://one.example")).toEqual({
      url: "https://one.example",
      key: first.key,
    });
    expect(await readCredentials(workspace.credentialsFile, second.url)).toEqual(second);
    expect(
      await readCredentials(workspace.credentialsFile, "https://not-signed-in.example"),
    ).toBeNull();
  });
});
