import { execFile } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline/promises";

export type RepositoryAgent = {
  readonly tenant: string;
  readonly slug: string;
  readonly directory: string;
  readonly externalAgentId: string;
};

export type RetellContext = {
  readonly name: string;
  readonly engine: "retell-llm" | "conversation-flow";
  readonly language: string | null;
  readonly toolCount: number;
};

export type RepositoryDiscovery = {
  readonly root: string;
  readonly dirtyFiles: readonly string[];
  readonly agent: RepositoryAgent;
  readonly retell: RetellContext;
  readonly retellApiKey: string;
};

type Candidate = {
  readonly tenant: string;
  readonly slug: string;
  readonly directory: string;
};

type DiscoveryOptions = {
  readonly cwd: string;
  readonly tenant?: string;
  readonly agent?: string;
  readonly externalAgentId?: string;
  readonly receiptExternalAgentId?: string;
  readonly interactive: boolean;
};

function run(
  command: string,
  args: readonly string[],
  cwd: string,
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, [...args], { cwd, encoding: "utf8" }, (error, stdout) => {
      if (error !== null) reject(error);
      else resolve(stdout);
    });
  });
}

function parseEnvironment(source: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const raw of source.split(/\r?\n/u)) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/u.exec(line);
    if (match?.[1] === undefined || match[2] === undefined) continue;
    let value = match[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    values[match[1]] = value;
  }
  return values;
}

async function localEnvironment(root: string): Promise<Record<string, string>> {
  const files = [
    path.join(root, "worker", ".dev.vars"),
    path.join(root, ".env"),
  ];
  for (const file of files) {
    try {
      return parseEnvironment(await readFile(file, "utf8"));
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
    }
  }
  return {};
}

function valueOf(environment: Record<string, string>, name: string): string | undefined {
  return process.env[name]?.trim() || environment[name]?.trim() || undefined;
}

async function candidatesIn(root: string): Promise<Candidate[]> {
  const tenantsRoot = path.join(root, "tenants");
  let tenants;
  try {
    tenants = await readdir(tenantsRoot, { withFileTypes: true });
  } catch {
    throw new Error(
      "this prototype supports egma-receptionist repositories with tenants/<tenant>/agents/<agent>",
    );
  }

  const found: Candidate[] = [];
  for (const tenant of tenants) {
    if (!tenant.isDirectory()) continue;
    const agentsRoot = path.join(tenantsRoot, tenant.name, "agents");
    let agents;
    try {
      agents = await readdir(agentsRoot, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const agent of agents) {
      if (!agent.isDirectory()) continue;
      found.push({
        tenant: tenant.name,
        slug: agent.name,
        directory: path.join(agentsRoot, agent.name),
      });
    }
  }
  if (found.length === 0) {
    throw new Error("no Retell agent directories were found under tenants/*/agents/*");
  }
  return found.sort((left, right) =>
    `${left.tenant}/${left.slug}`.localeCompare(`${right.tenant}/${right.slug}`),
  );
}

async function externalIdFromSupabase(
  candidate: Candidate,
  environment: Record<string, string>,
): Promise<string | null> {
  const processUrl = process.env.SUPABASE_URL?.trim();
  const processKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if ((processUrl === undefined) !== (processKey === undefined)) {
    throw new Error(
      "SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must come from the same environment source",
    );
  }
  const baseUrl = processUrl ?? environment.SUPABASE_URL?.trim();
  const key = processKey ?? environment.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (baseUrl === undefined || key === undefined) return null;

  const source = new URL(baseUrl);
  if (
    source.protocol !== "https:" &&
    !(source.protocol === "http:" && ["localhost", "127.0.0.1"].includes(source.hostname))
  ) {
    throw new Error("SUPABASE_URL must use HTTPS, except for a local development server");
  }
  const url = new URL("/rest/v1/tenant_agents", source);
  url.searchParams.set("select", "retell_agent_id");
  url.searchParams.set("tenant_id", `eq.${candidate.tenant}`);
  url.searchParams.set("slug", `eq.${candidate.slug}`);
  const response = await fetch(url, {
    headers: { apikey: key, authorization: `Bearer ${key}` },
  });
  if (!response.ok) {
    throw new Error(
      `could not resolve ${candidate.tenant}/${candidate.slug} through its repository configuration (HTTP ${response.status})`,
    );
  }
  const rows = (await response.json()) as Array<{ retell_agent_id?: unknown }>;
  const id = rows[0]?.retell_agent_id;
  return typeof id === "string" && id !== "" ? id : null;
}

function envSegment(value: string): string {
  return value
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/gu, "_")
    .replace(/^_+|_+$/gu, "");
}

function retellKey(
  candidate: Candidate,
  environment: Record<string, string>,
): string {
  const tenant = envSegment(candidate.tenant);
  const agent = envSegment(candidate.slug);
  const names = [
    `RETELL_API_KEY_${tenant}_${agent}`,
    `RETELL_API_KEY_${tenant}`,
    "RETELL_API_KEY",
  ];
  for (const name of names) {
    const value = valueOf(environment, name);
    if (value !== undefined) return value;
  }
  throw new Error(
    `no Retell credential was found for ${candidate.tenant}/${candidate.slug}; load the repository's environment and run again`,
  );
}

async function choose(
  candidates: readonly RepositoryAgent[],
  options: DiscoveryOptions,
): Promise<RepositoryAgent> {
  const narrowed = candidates.filter(
    (candidate) =>
      (options.tenant === undefined || candidate.tenant === options.tenant) &&
      (options.agent === undefined || candidate.slug === options.agent) &&
      (options.receiptExternalAgentId === undefined ||
        candidate.externalAgentId === options.receiptExternalAgentId),
  );
  if (narrowed.length === 1) return narrowed[0] as RepositoryAgent;
  if (narrowed.length === 0) {
    throw new Error(
      "no repository agent matches the explicit selector or existing Egma receipt",
    );
  }

  if (!options.interactive) {
    const choices = narrowed
      .map((candidate) => `  ${candidate.tenant}/${candidate.slug}`)
      .join("\n");
    throw new Error(
      `more than one Retell agent is present. Name one with --tenant and --agent:\n${choices}`,
    );
  }

  process.stdout.write("Retell agents found:\n");
  narrowed.forEach((candidate, index) => {
    process.stdout.write(`  ${index + 1}. ${candidate.tenant}/${candidate.slug}\n`);
  });
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await terminal.question("Choose an agent: ");
    const selected = narrowed[Number(answer) - 1];
    if (selected === undefined) throw new Error("that is not one of the listed agents");
    return selected;
  } finally {
    terminal.close();
  }
}

function toolCount(definition: Readonly<Record<string, unknown>>): number {
  let total = 0;
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      total += value.filter(
        (entry) =>
          typeof entry === "object" &&
          entry !== null &&
          ("type" in entry || "name" in entry),
      ).length;
      value.forEach(visit);
    } else if (typeof value === "object" && value !== null) {
      Object.values(value).forEach(visit);
    }
  };
  visit(definition.tools);
  visit(definition.general_tools);
  return total;
}

async function retellContext(
  externalAgentId: string,
  apiKey: string,
): Promise<RetellContext> {
  const headers = { authorization: `Bearer ${apiKey}`, accept: "application/json" };
  const agentResponse = await fetch(
    `https://api.retellai.com/get-agent/${encodeURIComponent(externalAgentId)}`,
    { headers },
  );
  if (!agentResponse.ok) {
    throw new Error(
      `Retell could not read agent ${externalAgentId} (HTTP ${agentResponse.status})`,
    );
  }
  const agent = (await agentResponse.json()) as Record<string, unknown>;
  const responseEngine = agent.response_engine as
    | { type?: unknown; llm_id?: unknown; conversation_flow_id?: unknown }
    | undefined;
  const engine = responseEngine?.type;
  if (engine !== "retell-llm" && engine !== "conversation-flow") {
    throw new Error(`Retell agent ${externalAgentId} has no supported response engine`);
  }
  const definitionId =
    engine === "retell-llm"
      ? responseEngine?.llm_id
      : responseEngine?.conversation_flow_id;
  if (typeof definitionId !== "string" || definitionId === "") {
    throw new Error(`Retell agent ${externalAgentId} does not name its ${engine} definition`);
  }
  const definitionRoute =
    engine === "retell-llm" ? "get-retell-llm" : "get-conversation-flow";
  const definitionResponse = await fetch(
    `https://api.retellai.com/${definitionRoute}/${encodeURIComponent(definitionId)}`,
    { headers },
  );
  if (!definitionResponse.ok) {
    throw new Error(
      `Retell could not read the agent's ${engine} definition (HTTP ${definitionResponse.status})`,
    );
  }
  const definition = (await definitionResponse.json()) as Record<string, unknown>;
  return {
    name:
      typeof agent.agent_name === "string" && agent.agent_name.trim() !== ""
        ? agent.agent_name.trim()
        : externalAgentId,
    engine,
    language: typeof agent.language === "string" ? agent.language : null,
    toolCount: toolCount(definition),
  };
}

export async function discoverRepository(
  options: DiscoveryOptions,
): Promise<RepositoryDiscovery> {
  let root: string;
  try {
    root = (await run("git", ["rev-parse", "--show-toplevel"], options.cwd)).trim();
  } catch {
    throw new Error("run egma init inside a Git repository");
  }
  const dirtyFiles = (await run("git", ["status", "--short"], root))
    .split(/\r?\n/u)
    .filter(Boolean);
  const environment = await localEnvironment(root);
  const candidates = (await candidatesIn(root)).filter(
    (candidate) =>
      (options.tenant === undefined || candidate.tenant === options.tenant) &&
      (options.agent === undefined || candidate.slug === options.agent),
  );
  if (candidates.length === 0) {
    throw new Error("the named tenant and agent do not exist in this repository");
  }
  const resolved: RepositoryAgent[] = [];
  for (const candidate of candidates) {
    const supplied =
      options.tenant === candidate.tenant && options.agent === candidate.slug
        ? options.externalAgentId
        : undefined;
    const externalAgentId =
      supplied ?? (await externalIdFromSupabase(candidate, environment));
    if (externalAgentId !== null && externalAgentId !== undefined) {
      resolved.push({ ...candidate, externalAgentId });
    }
  }
  if (resolved.length === 0) {
    throw new Error(
      "the repository contains agent directories, but no Retell agent ID could be resolved; pass --tenant, --agent and --retell-agent-id",
    );
  }
  const agent = await choose(resolved, options);
  const apiKey = retellKey(agent, environment);
  return {
    root,
    dirtyFiles,
    agent,
    retell: await retellContext(agent.externalAgentId, apiKey),
    retellApiKey: apiKey,
  };
}
