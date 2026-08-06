import { mkdir, open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

export type Receipt = {
  readonly version: 1 | 2;
  readonly provider: "retell";
  readonly egmaBaseUrl: string | null;
  readonly projectId: string | null;
  readonly externalAgentId: string;
  readonly agentId: string;
  readonly connectionId: string;
  readonly testId: string;
  readonly personaId: string;
};

export type CurrentReceipt = Omit<
  Receipt,
  "version" | "egmaBaseUrl" | "projectId"
> & {
  readonly version: 2;
  readonly egmaBaseUrl: string;
  readonly projectId: string;
};

export function receiptPath(repositoryRoot: string): string {
  return path.join(repositoryRoot, ".egma", "project.yaml");
}

async function removeDeadInitLock(file: string): Promise<boolean> {
  let owner: string;
  try {
    owner = (await readFile(file, "utf8")).trim();
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw cause;
  }

  const pid = Number(owner);
  if (!Number.isSafeInteger(pid) || pid < 1) {
    throw new Error(
      `another egma init may be using this repository (${file} has an invalid owner); remove it only if no init process is running`,
    );
  }
  try {
    process.kill(pid, 0);
    return false;
  } catch (cause) {
    const code = (cause as NodeJS.ErrnoException).code;
    if (code !== "ESRCH") return false;
  }

  try {
    await unlink(file);
    return true;
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw cause;
  }
}

/** Stop two init processes in one checkout from creating the same test twice. */
export async function withInitLock<T>(
  repositoryRoot: string,
  operation: () => Promise<T>,
): Promise<T> {
  const directory = path.join(repositoryRoot, ".egma");
  const file = path.join(directory, "init.lock");
  await mkdir(directory, { recursive: true });
  let handle;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      handle = await open(file, "wx", 0o600);
      break;
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "EEXIST") throw cause;
      if (attempt === 0 && (await removeDeadInitLock(file))) {
        continue;
      }
      throw new Error(
        `another egma init is using this repository (${file} is owned by a running process)`,
      );
    }
  }
  if (handle === undefined) throw new Error(`could not acquire ${file}`);
  try {
    await handle.writeFile(`${process.pid}\n`, "utf8");
    return await operation();
  } finally {
    await handle.close();
    await unlink(file).catch((cause: unknown) => {
      if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
    });
  }
}

export async function readReceipt(repositoryRoot: string): Promise<Receipt | null> {
  let source: string;
  try {
    source = await readFile(receiptPath(repositoryRoot), "utf8");
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw cause;
  }

  const values = new Map<string, string>();
  for (const line of source.split(/\r?\n/u)) {
    const match = /^\s*([a-z_]+):\s*([^#\s]+)\s*$/u.exec(line);
    if (match?.[1] !== undefined && match[2] !== undefined) {
      values.set(match[1], match[2]);
    }
  }
  const version = values.get("version");
  if ((version !== "1" && version !== "2") || values.get("provider") !== "retell") {
    throw new Error(
      `${receiptPath(repositoryRoot)} is not an Egma Retell receipt version 1 or 2`,
    );
  }

  const required = (key: string): string => {
    const value = values.get(key);
    if (value === undefined) {
      throw new Error(`${receiptPath(repositoryRoot)} is missing ${key}`);
    }
    return value;
  };
  return {
    version: version === "2" ? 2 : 1,
    provider: "retell",
    egmaBaseUrl: version === "2" ? required("egma_base_url") : null,
    projectId: version === "2" ? required("project_id") : null,
    externalAgentId: required("external_agent_id"),
    agentId: required("agent_id"),
    connectionId: required("connection_id"),
    testId: required("test_id"),
    personaId: required("persona_id"),
  };
}

export async function writeReceipt(
  repositoryRoot: string,
  receipt: CurrentReceipt,
): Promise<string> {
  const file = receiptPath(repositoryRoot);
  const temporary = `${file}.${process.pid}.tmp`;
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(
    temporary,
    [
      "# Created by egma init. This file contains IDs, not secrets.",
      "version: 2",
      "provider: retell",
      `egma_base_url: ${receipt.egmaBaseUrl}`,
      `project_id: ${receipt.projectId}`,
      `external_agent_id: ${receipt.externalAgentId}`,
      "resources:",
      `  agent_id: ${receipt.agentId}`,
      `  connection_id: ${receipt.connectionId}`,
      `  test_id: ${receipt.testId}`,
      `  persona_id: ${receipt.personaId}`,
      "",
    ].join("\n"),
    "utf8",
  );
  await rename(temporary, file);
  return file;
}
