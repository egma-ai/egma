/**
 * Which self-hosted Pipecat connections belong to this machine.
 *
 * `egma agent dev` keeps them in `<EGMA_HOME or ~/.egma>/dev-connections.json`,
 * never in a repository, keyed by platform URL + agent + modality, so a second
 * computer creates its own and never writes into the first's.
 */

import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import type { FolderConfig } from "../folder/egma-folder.ts";
import { egmaFolderIn } from "../platform/credentials.ts";
import { whileFileLocked } from "../platform/file-lock.ts";
import { normalizePlatformOrigin } from "../platform/url.ts";

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
  return await whileFileLocked(
    lock,
    work,
    () =>
      new Error(
        `another Egma process held ${lock} for too long. If nothing else is running, delete it and try again.`,
      ),
  );
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

function originOf(url: string): string | null {
  try {
    return normalizePlatformOrigin(url);
  } catch {
    return null;
  }
}

/**
 * The repository's agents with this machine's `egma agent dev` connections
 * added under them, so a run can name one that egma/config.yaml does not list.
 * An unreadable memory file adds nothing.
 */
export async function withThisMachineConnections(
  config: FolderConfig,
  env: NodeJS.ProcessEnv,
): Promise<FolderConfig> {
  const origin = config.platform === null ? null : originOf(config.platform.origin);
  if (origin === null) return config;
  let entries: readonly MachineConnection[];
  try {
    entries = await readMachineConnections(machineConnectionsFileIn(env));
  } catch {
    return config;
  }
  const here = entries.filter((entry) => originOf(entry.platformUrl) === origin);
  if (here.length === 0) return config;
  return {
    ...config,
    agents: config.agents.map((agent) => {
      const mine = here.filter(
        (entry) =>
          entry.agentId === agent.id &&
          !agent.connections.some((connection) => connection.id === entry.connectionId),
      );
      return mine.length === 0
        ? agent
        : {
            ...agent,
            connections: [
              ...agent.connections,
              ...mine.map((entry) => ({
                id: entry.connectionId,
                name: `this machine's ${entry.modality} connection`,
              })),
            ],
          };
    }),
  };
}
