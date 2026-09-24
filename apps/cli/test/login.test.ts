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

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openInBrowser } from "../src/platform/browser.ts";
import { startDeviceAuthorization } from "../src/platform/device-flow.ts";
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
  readonly opened: string[];
};

function watch(): Watched {
  return { prompts: [], opened: [] };
}

type RunOptions = {
  readonly watched: Watched;
  readonly signal?: AbortSignal;
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
    onPrompt: (prompt) => {
      options.watched.prompts.push(prompt);
      options.whenPrompted?.(prompt);
    },
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

describe("which egma a command talks to", () => {
  // The address egma falls back to, stood in for so that reading this test
  // never says which address ships. That is asserted in one place, on its own.
  const BUILT_IN = "http://built-in.example";

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

});

/**
 * What egma will start a browser on.
 *
 * The address comes back from the instance, and handing a string to a browser
 * opener is handing it to a program. What fails here is not a failed login:
 * the address is still on the screen and polling can still finish the login.
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
   * Only ENOENT permits a new keys file. Use a directory to force a read failure
   * even as root, and verify login does not replace existing credentials.
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
