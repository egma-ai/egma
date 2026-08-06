import { createInterface } from "node:readline/promises";

import { login, resolveApiKey } from "./auth.ts";
import { EgmaApi, EgmaApiError, egmaBaseUrl } from "./egma-api.ts";
import {
  discoverRepository,
  type RepositoryDiscovery,
} from "./repository.ts";
import {
  readReceipt,
  receiptPath,
  withInitLock,
  writeReceipt,
  type Receipt,
} from "./receipt.ts";
import type {
  Agent,
  Connection,
  ResourceAction,
  Test,
} from "./types.ts";

export type InitOptions = {
  readonly cwd: string;
  readonly baseUrl: string;
  readonly tenant?: string;
  readonly agent?: string;
  readonly externalAgentId?: string;
  readonly scenario?: string;
  readonly expectedBehaviors?: readonly string[];
  readonly testName?: string;
  readonly planOnly: boolean;
  readonly apply: boolean;
  readonly resume: boolean;
  readonly yes: boolean;
  readonly json: boolean;
};

type LocatedAgent = {
  readonly agent: Agent | null;
  readonly connection: Connection | null;
};

type ProposedTest = {
  readonly name: string;
  readonly scenario: string;
  readonly expectedBehaviors: readonly string[];
};

type InitPlan = {
  readonly kind: "egma.init.plan";
  readonly repository: string;
  readonly dirtyFiles: readonly string[];
  readonly retell: {
    readonly tenant: string;
    readonly agentSlug: string;
    readonly agentId: string;
    readonly name: string;
    readonly engine: string;
    readonly language: string | null;
    readonly toolCount: number;
  };
  readonly willRead: readonly string[];
  readonly resources: {
    readonly agent: { readonly name: string; readonly action: ResourceAction };
    readonly connection: {
      readonly name: string;
      readonly action: ResourceAction;
    };
    readonly test: {
      readonly name: string;
      readonly action: ResourceAction;
      readonly scenario: string;
      readonly expectedBehaviors: readonly string[];
    };
    readonly persona: { readonly action: "reuse project default" };
  };
  readonly effects: {
    readonly retellChanges: "none";
    readonly sourceUpload: false;
    readonly simulationStarts: false;
    readonly localWrite: string;
  };
};

function slug(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
}

function proposal(discovery: RepositoryDiscovery, options: InitOptions): ProposedTest {
  return {
    name:
      options.testName ??
      `${discovery.agent.tenant}-${discovery.agent.slug}-first-simulation`,
    scenario:
      options.scenario ??
      "The caller wants to book an appointment and asks for the next available time.",
    expectedBehaviors:
      options.expectedBehaviors === undefined || options.expectedBehaviors.length === 0
        ? [
            "The agent asks for the information needed to find an appointment and clearly explains the next step.",
          ]
        : options.expectedBehaviors,
  };
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

async function allAgents(api: EgmaApi, name: string): Promise<Agent[]> {
  const found: Agent[] = [];
  let cursor: string | undefined;
  do {
    const page = await api.listAgents(cursor, name);
    found.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor !== undefined);
  return found;
}

async function allTests(api: EgmaApi, name: string): Promise<Test[]> {
  const found: Test[] = [];
  let cursor: string | undefined;
  do {
    const page = await api.listTests(cursor, name);
    found.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor !== undefined);
  return found;
}

async function absentWhenMissing<T>(operation: () => Promise<T>): Promise<T | null> {
  try {
    return await operation();
  } catch (cause) {
    if (cause instanceof EgmaApiError && cause.status === 404) return null;
    throw cause;
  }
}

async function locateAgent(
  api: EgmaApi,
  discovery: RepositoryDiscovery,
  receipt: Receipt | null,
): Promise<LocatedAgent> {
  if (
    receipt !== null &&
    receipt.externalAgentId === discovery.agent.externalAgentId
  ) {
    const [agent, connection] = await Promise.all([
      absentWhenMissing(() => api.getAgent(receipt.agentId)),
      absentWhenMissing(() =>
        api.getConnection(receipt.agentId, receipt.connectionId),
      ),
    ]);
    if (
      agent !== null &&
      connection !== null &&
      connection.config.retellAgentId === discovery.agent.externalAgentId
    ) {
      return { agent, connection };
    }
  }

  const providerMatches = await api.findRetellAgents(
    discovery.agent.externalAgentId,
  );
  if (providerMatches.length > 1) {
    throw new Error(
      `more than one Egma connection points to Retell agent ${discovery.agent.externalAgentId}; remove the duplicate before continuing`,
    );
  }
  const providerMatch = providerMatches[0];
  if (providerMatch?.connection !== undefined) {
    return { agent: providerMatch, connection: providerMatch.connection };
  }

  const stableName = slug(`${discovery.agent.tenant}-${discovery.agent.slug}`);
  let nameMatch: Agent | null = null;
  let nameMatchConnections: readonly Connection[] = [];
  for (const agent of await allAgents(api, stableName)) {
    const connections = await api.listConnections(agent.id);
    if (agent.name === stableName) {
      nameMatch = agent;
      nameMatchConnections = connections.items;
    }
    const connection = connections.items.find(
      (candidate) =>
        candidate.type === "retell" &&
        candidate.config.retellAgentId === discovery.agent.externalAgentId,
    );
    if (connection !== undefined) return { agent, connection };
  }
  if (nameMatch !== null && nameMatchConnections.length > 0) {
    throw new Error(
      `agent "${stableName}" already exists but none of its connections point to Retell agent ${discovery.agent.externalAgentId}; choose the right repository agent before continuing`,
    );
  }
  return { agent: nameMatch, connection: null };
}

async function locateTest(
  api: EgmaApi,
  proposed: ProposedTest,
  receipt: Receipt | null,
): Promise<Test | null> {
  if (receipt !== null) {
    const direct = await absentWhenMissing(() => api.getTest(receipt.testId));
    if (direct !== null) return direct;
  }
  return (await allTests(api, proposed.name))[0] ?? null;
}

function verifyTest(
  test: Test,
  proposed: ProposedTest,
  expectedPersonaId: string,
): void {
  if (
    test.name !== proposed.name ||
    test.scenario !== proposed.scenario ||
    !sameStrings(test.expectedBehaviors, proposed.expectedBehaviors)
  ) {
    throw new Error(
      `test "${proposed.name}" already exists with different content; choose another --test-name or review it before continuing`,
    );
  }
  if (test.personas.length !== 1 || test.personas[0] === undefined) {
    throw new Error(
      `test "${proposed.name}" does not name exactly one persona, so it cannot be reused as the default-persona test`,
    );
  }
  if (test.personas[0].id !== expectedPersonaId) {
    throw new Error(
      `test "${proposed.name}" does not use the project's current default persona`,
    );
  }
  if (test.personas[0].deletedAt !== null) {
    throw new Error(`test "${proposed.name}" uses a deleted persona`);
  }
}

function retellConnection(discovery: RepositoryDiscovery): Record<string, unknown> {
  return {
    name: "retell-chat",
    type: "retell",
    modality: "chat",
    environment: "development",
    config: { retellAgentId: discovery.agent.externalAgentId },
    credentials: { apiKey: discovery.retellApiKey },
  };
}

function renderPlan(plan: InitPlan): string {
  const dirty =
    plan.dirtyFiles.length === 0
      ? "  clean"
      : plan.dirtyFiles.map((file) => `  ${file}`).join("\n");
  return [
    `Found Retell agent: ${plan.retell.name} (${plan.retell.agentId})`,
    `Repository agent: ${plan.retell.tenant}/${plan.retell.agentSlug}`,
    `Engine: ${plan.retell.engine}; language: ${plan.retell.language ?? "unknown"}; tools found: ${plan.retell.toolCount}`,
    "",
    "Uncommitted repository files:",
    dirty,
    "",
    "Will create or reuse in Egma:",
    `  Agent       ${plan.resources.agent.name} (${plan.resources.agent.action})`,
    `  Connection  ${plan.resources.connection.name} (${plan.resources.connection.action})`,
    `  Test        ${plan.resources.test.name} (${plan.resources.test.action})`,
    "  Persona     reuse project default",
    "",
    "Proposed test:",
    `  Scenario    ${plan.resources.test.scenario}`,
    ...plan.resources.test.expectedBehaviors.map(
      (behavior) => `  Expect      ${behavior}`,
    ),
    "",
    "Will change in Retell:       nothing",
    "Will upload repository code: no",
    "Will start a simulation:     no",
    `Will write locally:           ${plan.effects.localWrite}`,
  ].join("\n");
}

async function approve(plan: InitPlan): Promise<boolean> {
  process.stdout.write(`${renderPlan(plan)}\n\n`);
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await terminal.question("Continue? [Y/n] ")).trim().toLowerCase();
    return answer === "" || answer === "y" || answer === "yes";
  } finally {
    terminal.close();
  }
}

async function authenticatedApi(options: InitOptions): Promise<EgmaApi> {
  let apiKey = await resolveApiKey(options.baseUrl);
  if (apiKey === null && process.stdin.isTTY && !options.json) {
    await login(options.baseUrl);
    apiKey = await resolveApiKey(options.baseUrl);
  }
  if (apiKey === null) {
    throw new Error(
      "Egma is not authenticated. Run `egma auth login`, or set EGMA_API_KEY without putting it on the command line.",
    );
  }
  return new EgmaApi(options.baseUrl, apiKey);
}

function buildPlan(
  discovery: RepositoryDiscovery,
  located: LocatedAgent,
  existingTest: Test | null,
  proposed: ProposedTest,
): InitPlan {
  return {
    kind: "egma.init.plan",
    repository: discovery.root,
    dirtyFiles: discovery.dirtyFiles,
    retell: {
      tenant: discovery.agent.tenant,
      agentSlug: discovery.agent.slug,
      agentId: discovery.agent.externalAgentId,
      name: discovery.retell.name,
      engine: discovery.retell.engine,
      language: discovery.retell.language,
      toolCount: discovery.retell.toolCount,
    },
    willRead: ["Retell agent settings", `${discovery.retell.engine} definition`],
    resources: {
      agent: {
        name: slug(`${discovery.agent.tenant}-${discovery.agent.slug}`),
        action: located.agent === null ? "created" : "reused",
      },
      connection: {
        name: "retell-chat",
        action: located.connection === null ? "created" : "reused",
      },
      test: {
        ...proposed,
        action: existingTest === null ? "created" : "reused",
      },
      persona: { action: "reuse project default" },
    },
    effects: {
      retellChanges: "none",
      sourceUpload: false,
      simulationStarts: false,
      localWrite: receiptPath(discovery.root),
    },
  };
}

async function applyPlan(
  api: EgmaApi,
  discovery: RepositoryDiscovery,
  proposed: ProposedTest,
  defaultPersonaId: string,
  plannedAgent: LocatedAgent,
  plannedTest: Test | null,
): Promise<{
  readonly kind: "egma.init.result";
  readonly resources: {
    readonly agent: Agent & { readonly action: ResourceAction };
    readonly connection: Connection & { readonly action: ResourceAction };
    readonly test: Test & { readonly action: ResourceAction };
    readonly persona: Test["personas"][number];
  };
  readonly receipt: string;
  readonly simulation: "not run";
  readonly next: string;
}> {
  let located = plannedAgent;
  let agentAction: ResourceAction = located.agent === null ? "created" : "reused";
  let connectionAction: ResourceAction =
    located.connection === null ? "created" : "reused";

  if (located.agent === null) {
    const created = await api.createAgent({
      name: slug(`${discovery.agent.tenant}-${discovery.agent.slug}`),
      description: `Imported from Retell agent ${discovery.retell.name}`,
      connection: retellConnection(discovery),
    });
    if (created.connection === undefined) {
      throw new Error("Egma created the agent without the requested connection");
    }
    located = { agent: created, connection: created.connection };
  } else if (located.connection === null) {
    const connection = await api.createConnection(
      located.agent.id,
      retellConnection(discovery),
    );
    located = { agent: located.agent, connection };
    agentAction = "reused";
  }

  if (located.agent === null || located.connection === null) {
    throw new Error("Egma did not return the agent and connection it created");
  }

  let test = plannedTest;
  let testAction: ResourceAction = "reused";
  if (test === null) {
    test = await api.createTest({
      name: proposed.name,
      description: `First test for ${discovery.retell.name}`,
      scenario: proposed.scenario,
      expected_behaviors: [...proposed.expectedBehaviors],
      idempotency_key: `egma-init:${discovery.agent.externalAgentId}`,
    });
    testAction = "created";
  }
  verifyTest(test, proposed, defaultPersonaId);
  if (test.personas[0] === undefined) {
    throw new Error("the created test has no default persona");
  }

  const [verifiedAgent, verifiedConnection, verifiedTest] = await Promise.all([
    api.getAgent(located.agent.id),
    api.getConnection(located.agent.id, located.connection.id),
    api.getTest(test.id),
  ]);
  verifyTest(verifiedTest, proposed, defaultPersonaId);
  const persona = verifiedTest.personas[0];
  if (persona === undefined) throw new Error("the verified test has no default persona");
  if (
    verifiedConnection.agentId !== verifiedAgent.id ||
    verifiedConnection.config.retellAgentId !== discovery.agent.externalAgentId
  ) {
    throw new Error("the connection read-back does not point to the selected Retell agent");
  }

  const file = await writeReceipt(discovery.root, {
    version: 2,
    provider: "retell",
    egmaBaseUrl: api.baseUrl,
    projectId: verifiedAgent.projectId,
    externalAgentId: discovery.agent.externalAgentId,
    agentId: verifiedAgent.id,
    connectionId: verifiedConnection.id,
    testId: verifiedTest.id,
    personaId: persona.id,
  });
  return {
    kind: "egma.init.result",
    resources: {
      agent: { ...verifiedAgent, action: agentAction },
      connection: { ...verifiedConnection, action: connectionAction },
      test: { ...verifiedTest, action: testAction },
      persona,
    },
    receipt: file,
    simulation: "not run",
    next: `egma run create --test ${verifiedTest.id} --agent ${verifiedAgent.id} --connection ${verifiedConnection.id}`,
  };
}

function renderResult(result: Awaited<ReturnType<typeof applyPlan>>): string {
  return [
    "Egma setup is ready.",
    "",
    `  Agent       ${result.resources.agent.id} (${result.resources.agent.action})`,
    `  Connection  ${result.resources.connection.id} (${result.resources.connection.action})`,
    `  Test        ${result.resources.test.id} (${result.resources.test.action})`,
    `  Persona     ${result.resources.persona.id} (reused project default)`,
    "",
    `Receipt: ${result.receipt}`,
    "Simulation: not run",
    "",
    "Next command:",
    `  ${result.next}`,
  ].join("\n");
}

export async function runInit(options: InitOptions): Promise<void> {
  const receipt = await readReceipt(options.cwd);
  const discovery = await discoverRepository({
    cwd: options.cwd,
    ...(options.tenant === undefined ? {} : { tenant: options.tenant }),
    ...(options.agent === undefined ? {} : { agent: options.agent }),
    ...(options.externalAgentId === undefined
      ? {}
      : { externalAgentId: options.externalAgentId }),
    ...(receipt === null
      ? {}
      : { receiptExternalAgentId: receipt.externalAgentId }),
    interactive: process.stdin.isTTY && !options.json,
  });
  const actualReceipt = await readReceipt(discovery.root);
  const api = await authenticatedApi(options);
  await api.listApiKeys();
  const defaultPersona = await api.getDefaultPersona();
  const origin = egmaBaseUrl(options.baseUrl);
  if (
    actualReceipt?.version === 2 &&
    actualReceipt.egmaBaseUrl !== origin
  ) {
    throw new Error(
      `this repository is linked to ${actualReceipt.egmaBaseUrl}, not ${origin}`,
    );
  }
  if (
    actualReceipt?.version === 2 &&
    actualReceipt.projectId !== defaultPersona.projectId
  ) {
    throw new Error(
      `this repository is linked to project ${actualReceipt.projectId}, not ${defaultPersona.projectId}`,
    );
  }
  const reusableReceipt = actualReceipt?.version === 2 ? actualReceipt : null;
  const proposed = proposal(discovery, options);
  const located = await locateAgent(api, discovery, reusableReceipt);
  const existingTest = await locateTest(api, proposed, reusableReceipt);
  if (existingTest !== null) {
    verifyTest(existingTest, proposed, defaultPersona.id);
  }
  const plan = buildPlan(discovery, located, existingTest, proposed);

  if (options.planOnly) {
    process.stdout.write(
      options.json ? `${JSON.stringify(plan, null, 2)}\n` : `${renderPlan(plan)}\n`,
    );
    return;
  }

  const explicitApply = options.apply || options.resume;
  if (!explicitApply) {
    if (!options.json) process.stdout.write(`${renderPlan(plan)}\n`);
    else process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
    throw new Error("the plan was not applied; run again with --apply after approval");
  }
  if (!options.yes) {
    if (!process.stdin.isTTY || options.json) {
      throw new Error("--apply in a non-interactive terminal also needs --yes");
    }
    if (!(await approve(plan))) {
      process.stdout.write("No changes were made.\n");
      return;
    }
  } else if (!options.json) {
    process.stdout.write(`${renderPlan(plan)}\n\n`);
  }

  const result = await withInitLock(discovery.root, async () => {
    const currentDefault = await api.getDefaultPersona();
    if (currentDefault.projectId !== defaultPersona.projectId) {
      throw new Error("the active Egma project changed while init was waiting");
    }
    const currentAgent = await locateAgent(api, discovery, reusableReceipt);
    const currentTest = await locateTest(api, proposed, reusableReceipt);
    if (currentTest !== null) {
      verifyTest(currentTest, proposed, currentDefault.id);
    }
    return applyPlan(
      api,
      discovery,
      proposed,
      currentDefault.id,
      currentAgent,
      currentTest,
    );
  });
  process.stdout.write(
    options.json
      ? `${JSON.stringify(result, null, 2)}\n`
      : `${renderResult(result)}\n`,
  );
}

export async function runInitStatus(options: {
  readonly cwd: string;
  readonly baseUrl: string;
  readonly json: boolean;
}): Promise<void> {
  const root = options.cwd;
  const receipt = await readReceipt(root);
  if (receipt === null) throw new Error(`no receipt was found at ${receiptPath(root)}`);
  const apiKey = await resolveApiKey(options.baseUrl);
  if (apiKey === null) throw new Error("Egma is not authenticated; run `egma auth login`");
  const api = new EgmaApi(options.baseUrl, apiKey);
  if (receipt.version !== 2) {
    throw new Error("this receipt predates deployment binding; run `egma init --apply` to upgrade it");
  }
  if (receipt.egmaBaseUrl !== api.baseUrl) {
    throw new Error(
      `this receipt belongs to ${receipt.egmaBaseUrl}, not ${api.baseUrl}`,
    );
  }
  const [agent, connection, test, defaultPersona] = await Promise.all([
    api.getAgent(receipt.agentId),
    api.getConnection(receipt.agentId, receipt.connectionId),
    api.getTest(receipt.testId),
    api.getDefaultPersona(),
  ]);
  if (
    agent.projectId !== receipt.projectId ||
    connection.projectId !== receipt.projectId ||
    test.projectId !== receipt.projectId
  ) {
    throw new Error("the receipt resources do not all belong to its recorded project");
  }
  if (
    test.personas.length !== 1 ||
    test.personas[0]?.id !== receipt.personaId ||
    test.personas[0]?.id !== defaultPersona.id ||
    test.personas[0]?.deletedAt !== null
  ) {
    throw new Error("the receipt test no longer uses the project's living default persona");
  }
  const status = { kind: "egma.init.status", receipt, agent, connection, test };
  process.stdout.write(
    options.json
      ? `${JSON.stringify(status, null, 2)}\n`
      : [
          "Egma receipt is valid.",
          `  Agent       ${agent.id}`,
          `  Connection  ${connection.id}`,
          `  Test        ${test.id}`,
          `  Persona     ${test.personas[0]?.id ?? "missing"}`,
          "  Simulation  not run",
          "",
        ].join("\n"),
  );
}
