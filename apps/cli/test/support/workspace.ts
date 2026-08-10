/**
 * A throwaway folder for a test to run a walk inside, and the fake agent that
 * gets driven in it.
 */

import { chmod, cp, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import type { DrivenAgentLaunch } from "../../src/acp/registry.ts";
import type { PlatformAccess } from "../../src/platform/binding.ts";
import type { FakeScript } from "./fake-agent.ts";

export const FAKE_AGENT = fileURLToPath(new URL("./fake-agent.ts", import.meta.url));

/**
 * A small repository shaped like a Retell voice agent, committed so CI has one.
 *
 * Every word of it is invented: a bookbinding workshop that does not exist,
 * with prompts and tools written for this test and nowhere else.
 */
export const RETELL_FIXTURE_REPO = fileURLToPath(
  new URL("../fixtures/retell-agent", import.meta.url),
);

/**
 * Test cases somebody had written down before egma existed, committed so CI
 * has some. A spreadsheet export and a page of notes, both invented, both
 * about the bookbinding workshop that does not exist.
 */
export const EXISTING_TESTS_FIXTURES = fileURLToPath(
  new URL("../fixtures/existing-tests", import.meta.url),
);

/** The stand-in browser a workspace wraps in a command of its own. */
export const APPROVING_BROWSER = fileURLToPath(
  new URL("./approving-browser.ts", import.meta.url),
);

/** The file a workspace is given so the walk has something to read. */
export const MANIFEST = JSON.stringify({ name: "customer-repo", version: "1.0.0" }, null, 2);

export const CLI_ENTRY = fileURLToPath(new URL("../../dist/bin.js", import.meta.url));

export const PRETEND_OLD_NODE = fileURLToPath(
  new URL("./pretend-old-node.ts", import.meta.url),
);

/**
 * A platform as `--url` resolves one: an address, a key file, and a repository
 * bound to nothing.
 *
 * Every check that drives a step directly builds one through here, so a new
 * field on the resolved shape lands in one place rather than in a dozen. What a
 * bound repository does is checked where it is decided — in `main`, before a
 * step is reached — and never by handing a step a binding it does not read.
 */
export function platformNamed<Extra extends object>(
  platform: { readonly url: string; readonly credentialsFile: string } & Extra,
): PlatformAccess & Extra {
  return { source: "flag", binding: null, identity: null, ...platform };
}

export type Workspace = {
  readonly dir: string;
  /**
   * The egma folder this workspace's runs use, inside the throwaway directory.
   *
   * Every check that starts the command hands this over, so no check anywhere
   * can read or write the credentials of the person running the suite.
   */
  readonly egmaFolder: string;
  /** The credentials file inside it. */
  readonly credentialsFile: string;
  /** What the command is given so it looks there and nowhere else. */
  env(extra?: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
  /** Puts a key in that folder, as a login would have. */
  signIn(url: string, key?: string): Promise<void>;
  /**
   * A stand-in browser to point `BROWSER` at, and the file it writes every
   * address egma hands it into.
   */
  browser(): Promise<{ readonly command: string; readonly opened: string }>;
  /**
   * A stand-in editor to point `EDITOR` at: it writes every argument it was
   * given into `opened`, adds one line to the last of them, and leaves. A real
   * editor owns the terminal for as long as a person is in it; this one owns it
   * for as long as two writes take, which is all a check needs to prove that
   * egma handed it over and took it back.
   *
   * Every argument, because `$EDITOR` is a command line and not a command:
   * `code --wait` and `emacs -nw` are both ordinary settings, and an editor
   * that only ever read `$1` could not tell a wizard that splits them from one
   * that hands the whole line to a shell.
   *
   * `alternateScreen` makes it a vim rather than a nano: it takes the whole
   * terminal, paints over the wizard, and gives it back on the way out. What
   * that proves is that the wizard is drawn again afterwards rather than left
   * as whatever the editor put there.
   */
  editor(
    line: string,
    options?: { readonly alternateScreen?: boolean },
  ): Promise<{ readonly command: string; readonly opened: string }>;
  /** Writes a script and answers the path to it. */
  script(script: FakeScript): Promise<string>;
  /** How egma would be told to start the fake agent with that script. */
  launch(scriptPath: string): DrivenAgentLaunch;
  remove(): Promise<void>;
};

export type WorkspaceOptions = {
  /** A folder copied in whole before anything else, e.g. a fixture repository. */
  readonly from?: string;
};

/**
 * A browser that opens nothing.
 *
 * The command is handed one, rather than none, because the code that starts a
 * browser is part of what is being checked — and a check that started a real
 * browser on the machine running it would be intolerable.
 */
export const NO_BROWSER = "/usr/bin/true";

/**
 * An egma that is not an egma.
 *
 * Where a check points when it is about driving a coding agent and not about
 * the platform. Nothing answers there, and the workspace is signed in to it, so
 * the walk's login step costs no request and no check can reach a real egma —
 * not by accident, and not because somebody's shell had an address in it.
 */
export const NO_PLATFORM = "https://egma.invalid";

/**
 * A Retell that is not Retell.
 *
 * Every run started from here is pointed at a closed port unless the check
 * itself says otherwise, so no check anywhere can reach the real Retell — not
 * by accident, and not because somebody's shell had a key in it.
 */
export const NO_RETELL = "http://127.0.0.1:1";

export async function makeWorkspace(
  files: Readonly<Record<string, string>> = {},
  options: WorkspaceOptions = {},
): Promise<Workspace> {
  const dir = await mkdtemp(path.join(tmpdir(), "egma-cli-"));
  if (options.from !== undefined) await cp(options.from, dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    await writeFile(path.join(dir, name), content, "utf8");
  }

  const egmaFolder = path.join(dir, "egma-home");
  const credentialsFile = path.join(egmaFolder, "credentials");

  let scripts = 0;
  let editors = 0;
  return {
    dir,
    egmaFolder,
    credentialsFile,
    env(extra = {}) {
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        EGMA_HOME: egmaFolder,
        BROWSER: NO_BROWSER,
        EGMA_RETELL_URL: NO_RETELL,
        ...extra,
      };
      // Whatever the person running the suite has set, a check talks to the
      // egma it is checking against and to nothing else. Removed rather than
      // set to nothing: a pseudo-terminal turns an unset value into the word.
      if (extra.EGMA_URL === undefined) delete env.EGMA_URL;
      // And a key the person running the suite happens to have in their shell
      // is not a key any check may use.
      if (extra.EGMA_RETELL_API_KEY === undefined) delete env.EGMA_RETELL_API_KEY;
      if (extra.RETELL_API_KEY === undefined) delete env.RETELL_API_KEY;
      if (extra.EGMA_RETELL_AGENT_ID === undefined) delete env.EGMA_RETELL_AGENT_ID;
      return env;
    },
    async signIn(url, key = "egma_sk_already-held") {
      await mkdir(egmaFolder, { recursive: true, mode: 0o700 });
      // Written the way a login writes it: a list, keyed by platform, because
      // one machine holds a key for each egma it has signed in to.
      await writeFile(credentialsFile, `${JSON.stringify({ platforms: [{ url, key }] })}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
    },
    async browser() {
      // `BROWSER` names one command, exactly as it does for every other tool
      // that honours it, so the stand-in is a command rather than a command
      // line.
      const command = path.join(dir, "stand-in-browser");
      const opened = path.join(dir, "addresses-opened.txt");
      await writeFile(
        command,
        `#!/bin/sh\nexec '${process.execPath}' '${APPROVING_BROWSER}' "$@"\n`,
        { encoding: "utf8", mode: 0o755 },
      );
      await chmod(command, 0o755);
      return { command, opened };
    },
    async editor(line, options) {
      editors += 1;
      const command = path.join(dir, `stand-in-editor-${editors}`);
      const opened = path.join(dir, `files-opened-${editors}.txt`);
      const takesTheScreen = options?.alternateScreen === true;
      await writeFile(
        command,
        [
          "#!/bin/sh",
          // The alternate screen, entered and left the way vim does it, with
          // something painted over the wizard in between.
          ...(takesTheScreen
            ? [
                "printf '\\033[?1049h\\033[H\\033[2J' > /dev/tty 2>/dev/null || true",
                "printf 'STAND-IN EDITOR HAS THE SCREEN\\n' > /dev/tty 2>/dev/null || true",
              ]
            : []),
          // Every argument, in the order egma passed them, and the last of them
          // is the file: that is the one contract `$EDITOR` has.
          'last=""',
          "for argument in \"$@\"; do",
          `  printf '%s\\n' "$argument" >> '${opened}'`,
          '  last="$argument"',
          "done",
          `printf '%s\\n' '${line.replaceAll("'", "'\\''")}' >> "$last"`,
          ...(takesTheScreen
            ? ["printf '\\033[?1049l' > /dev/tty 2>/dev/null || true"]
            : []),
          "",
        ].join("\n"),
        { encoding: "utf8", mode: 0o755 },
      );
      await chmod(command, 0o755);
      return { command, opened };
    },
    async script(script) {
      scripts += 1;
      const file = path.join(dir, `.fake-agent-${scripts}.json`);
      await writeFile(file, JSON.stringify(script), "utf8");
      return file;
    },
    launch(scriptPath) {
      return {
        id: "fake-agent",
        name: "Fake Agent",
        command: process.execPath,
        args: [FAKE_AGENT, scriptPath],
        env: {},
      };
    },
    async remove() {
      // A command that has just been stopped can still have a file open in
      // here, and a directory gaining an entry while it is being walked is a
      // removal that fails rather than one that waits. Retried, because a
      // throwaway folder failing to go away must never fail somebody's check.
      await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    },
  };
}

/**
 * Every file in a folder, relative and sorted — the way to check that a step
 * which promised to leave a repository alone left it alone.
 */
export async function filesUnder(dir: string, prefix = ""): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const name = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) found.push(...(await filesUnder(path.join(dir, entry.name), name)));
    else found.push(name);
  }
  return found.sort();
}

/** True while the process is alive. */
export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function waitUntil(
  condition: () => boolean | Promise<boolean>,
  timeoutMs = 5_000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await condition()) return true;
    if (Date.now() > deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
