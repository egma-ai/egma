/**
 * Which self-hosted Pipecat connections belong to this machine.
 *
 * `egma agent dev` keeps them in `<EGMA_HOME or ~/.egma>/dev-connections.json`,
 * never in a repository, keyed by platform URL + agent + modality, so a second
 * computer creates its own and never writes into the first's.
 */

import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { egmaFolderIn } from "../platform/credentials.ts";

export const MACHINE_CONNECTIONS_FORMAT = 1;

export type DevModality = "voice" | "chat";

export type MachineConnection = {
  /** The platform's normalized origin, such as `https://app.egma.ai`. */
  readonly platformUrl: string;
  readonly agentId: string;
  readonly modality: DevModality;
  readonly connectionId: string;
};

const FILE_MODE = 0o600;
const FOLDER_MODE = 0o700;
const LOCK_WAIT_MS = 5_000;
const LOCK_STALE_MS = 30_000;

/** The file on this machine, beside the saved login. */
export function machineConnectionsFileIn(env: NodeJS.ProcessEnv): string {
  return path.join(egmaFolderIn(env), "dev-connections.json");
}

/** The file is there and is not one Egma can read; nothing overwrites it. */
export class MachineConnectionsUnreadableError extends Error {
  constructor(file: string, cause: unknown) {
    super(
      `Egma could not read ${file}, so it stopped rather than write over it. Look at that file. If it is damaged, move it aside and run egma agent dev again; this machine's Connections are then created again.`,
      { cause },
    );
    this.name = "MachineConnectionsUnreadableError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sameKey(left: MachineConnection, right: MachineConnection): boolean {
  return (
    left.platformUrl === right.platformUrl &&
    left.agentId === right.agentId &&
    left.modality === right.modality
  );
}

/** The entries a document holds. Entries of an unknown shape are skipped. */
function entriesIn(raw: string, file: string): MachineConnection[] {
  if (raw.trim() === "") return [];
  let held: unknown;
  try {
    held = JSON.parse(raw);
  } catch (cause) {
    throw new MachineConnectionsUnreadableError(file, cause);
  }
  if (!isRecord(held) || !Array.isArray(held["connections"])) {
    throw new MachineConnectionsUnreadableError(file, new Error("not a dev-connections document"));
  }
  if (held["format"] !== MACHINE_CONNECTIONS_FORMAT) {
    throw new MachineConnectionsUnreadableError(
      file,
      new Error(`format ${JSON.stringify(held["format"])} is not ${String(MACHINE_CONNECTIONS_FORMAT)}`),
    );
  }
  const entries: MachineConnection[] = [];
  for (const entry of held["connections"] as unknown[]) {
    if (!isRecord(entry)) continue;
    const { platformUrl, agentId, modality, connectionId } = entry;
    if (
      typeof platformUrl !== "string" ||
      platformUrl === "" ||
      typeof agentId !== "string" ||
      agentId === "" ||
      (modality !== "voice" && modality !== "chat") ||
      typeof connectionId !== "string" ||
      connectionId === ""
    ) {
      continue;
    }
    const one: MachineConnection = { platformUrl, agentId, modality, connectionId };
    const at = entries.findIndex((earlier) => sameKey(earlier, one));
    if (at === -1) entries.push(one);
    else entries[at] = one;
  }
  return entries;
}

async function bytesOf(file: string): Promise<string | null> {
  try {
    return await readFile(file, "utf8");
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new MachineConnectionsUnreadableError(file, cause);
  }
}

/** Every entry on this machine. A missing file holds none. */
export async function readMachineConnections(file: string): Promise<readonly MachineConnection[]> {
  const raw = await bytesOf(file);
  return raw === null ? [] : entriesIn(raw, file);
}

/** The connection this machine uses for one platform, agent and modality. */
export function machineConnectionFor(
  entries: readonly MachineConnection[],
  key: Omit<MachineConnection, "connectionId">,
): string | null {
  return (
    entries.find((entry) => sameKey(entry, { ...key, connectionId: "" }))?.connectionId ?? null
  );
}

/** One process at a time reads, merges and replaces the file. */
async function whileLocked<T>(file: string, work: () => Promise<T>): Promise<T> {
  const lock = `${file}.lock`;
  const until = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      await writeFile(lock, `${String(process.pid)}\n`, { encoding: "utf8", mode: FILE_MODE, flag: "wx" });
      break;
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "EEXIST") throw cause;
      const held = await stat(lock).catch(() => undefined);
      if (held !== undefined && Date.now() - held.mtimeMs > LOCK_STALE_MS) {
        await rm(lock, { force: true });
        continue;
      }
      if (Date.now() > until) {
        throw new Error(
          `another Egma process held ${lock} for too long. If nothing else is running, delete it and try again.`,
        );
      }
      await new Promise((resume) => setTimeout(resume, 50));
    }
  }
  try {
    return await work();
  } finally {
    await rm(lock, { force: true });
  }
}

/**
 * Replace the entries for these keys, keep every other entry, and write the
 * file atomically, readable by this user alone.
 */
export async function rememberMachineConnections(
  file: string,
  remembered: readonly MachineConnection[],
): Promise<void> {
  const folder = path.dirname(file);
  await mkdir(folder, { recursive: true, mode: FOLDER_MODE });
  await whileLocked(file, async () => {
    const raw = await bytesOf(file);
    const entries = raw === null ? [] : entriesIn(raw, file);
    for (const one of remembered) {
      const at = entries.findIndex((earlier) => sameKey(earlier, one));
      if (at === -1) entries.push(one);
      else entries[at] = one;
    }
    const document = `${JSON.stringify({ format: MACHINE_CONNECTIONS_FORMAT, connections: entries }, null, 2)}\n`;
    const fresh = path.join(folder, `.dev-connections-${String(process.pid)}-${randomBytes(6).toString("hex")}`);
    await writeFile(fresh, document, { encoding: "utf8", mode: FILE_MODE, flag: "wx" });
    try {
      await chmod(fresh, FILE_MODE);
      await rename(fresh, file);
    } catch (cause) {
      await rm(fresh, { force: true });
      throw cause;
    }
  });
}
