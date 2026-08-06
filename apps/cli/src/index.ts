#!/usr/bin/env node

import { parseArgs } from "node:util";

import { login, resolveApiKey } from "./auth.ts";
import { EgmaApi } from "./egma-api.ts";
import { runInit, runInitStatus } from "./init.ts";
import { readReceipt } from "./receipt.ts";
import { installSkill } from "./skill.ts";

function usage(exitCode = 2): never {
  process.stderr.write(
    [
      "egma prototype",
      "",
      "usage:",
      "  egma auth login [--base-url <url>]",
      "  egma auth status [--base-url <url>]",
      "  egma init [--tenant <slug> --agent <slug>] [--plan | --apply]",
      "            [--scenario <text>] [--expect <text> ...] [--json]",
      "  egma init status [--json]",
      "  egma agent get <id>",
      "  egma connection get <id> [--agent-id <id>]",
      "  egma test get <id>",
      "  egma skill install [--force]",
      "",
      "Run `egma init` from the root of egma-receptionist.",
    ].join("\n"),
  );
  process.exit(exitCode);
}

const parsed = parseArgs({
  args: process.argv.slice(2),
  allowPositionals: true,
  strict: true,
  options: {
    "base-url": { type: "string" },
    cwd: { type: "string" },
    tenant: { type: "string" },
    agent: { type: "string" },
    "agent-id": { type: "string" },
    "retell-agent-id": { type: "string" },
    scenario: { type: "string" },
    expect: { type: "string", multiple: true },
    "test-name": { type: "string" },
    plan: { type: "boolean" },
    apply: { type: "boolean" },
    resume: { type: "boolean" },
    yes: { type: "boolean", short: "y" },
    json: { type: "boolean" },
    force: { type: "boolean" },
    help: { type: "boolean", short: "h" },
  },
});

if (parsed.values.help === true) usage(0);

const [area, action, id] = parsed.positionals;
const baseUrl =
  parsed.values["base-url"] ??
  process.env.EGMA_API_URL ??
  "http://localhost:3100";
const cwd = parsed.values.cwd ?? process.cwd();
const json = parsed.values.json === true;

async function api(): Promise<EgmaApi> {
  const key = await resolveApiKey(baseUrl);
  if (key === null) throw new Error("Egma is not authenticated; run `egma auth login`");
  return new EgmaApi(baseUrl, key);
}

async function main(): Promise<void> {
  if (area === "auth" && action === "login") {
    const result = await login(baseUrl);
    process.stdout.write(
      json
        ? `${JSON.stringify({ kind: "egma.auth.login", ...result }, null, 2)}\n`
        : `Authenticated for project ${result.projectId}. The credential is stored outside the repository.\n`,
    );
    return;
  }

  if (area === "auth" && action === "status") {
    const client = await api();
    await client.listApiKeys();
    process.stdout.write(
      json
        ? `${JSON.stringify({ kind: "egma.auth.status", authenticated: true }, null, 2)}\n`
        : "Authenticated.\n",
    );
    return;
  }

  if (area === "init" && action === "status") {
    await runInitStatus({ cwd, baseUrl, json });
    return;
  }

  if (area === "init") {
    if (parsed.values.plan === true && parsed.values.apply === true) {
      throw new Error("choose --plan or --apply, not both");
    }
    await runInit({
      cwd,
      baseUrl,
      ...(parsed.values.tenant === undefined
        ? {}
        : { tenant: parsed.values.tenant }),
      ...(parsed.values.agent === undefined
        ? {}
        : { agent: parsed.values.agent }),
      ...(parsed.values["retell-agent-id"] === undefined
        ? {}
        : { externalAgentId: parsed.values["retell-agent-id"] }),
      ...(parsed.values.scenario === undefined
        ? {}
        : { scenario: parsed.values.scenario }),
      ...(parsed.values.expect === undefined
        ? {}
        : { expectedBehaviors: parsed.values.expect }),
      ...(parsed.values["test-name"] === undefined
        ? {}
        : { testName: parsed.values["test-name"] }),
      planOnly: parsed.values.plan === true,
      apply: parsed.values.apply === true,
      resume: parsed.values.resume === true,
      yes: parsed.values.yes === true,
      json,
    });
    return;
  }

  if (area === "skill" && action === "install") {
    const target = await installSkill(cwd, parsed.values.force === true);
    process.stdout.write(
      json
        ? `${JSON.stringify({ kind: "egma.skill.install", target }, null, 2)}\n`
        : `Installed the Egma onboarding skill at ${target}.\n`,
    );
    return;
  }

  if (action === "get" && id !== undefined) {
    const client = await api();
    let result: unknown;
    if (area === "agent") result = await client.getAgent(id);
    else if (area === "test") result = await client.getTest(id);
    else if (area === "connection") {
      const receipt = await readReceipt(cwd);
      const agentId = parsed.values["agent-id"] ?? receipt?.agentId;
      if (agentId === undefined) {
        throw new Error("connection get needs --agent-id or a local Egma receipt");
      }
      result = await client.getConnection(agentId, id);
    } else usage();
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }

  usage();
}

main().catch((cause: unknown) => {
  const message = cause instanceof Error ? cause.message : String(cause);
  if (json) {
    process.stderr.write(
      `${JSON.stringify({ kind: "egma.error", error: message }, null, 2)}\n`,
    );
  } else {
    process.stderr.write(`egma: ${message}\n`);
  }
  process.exitCode = 1;
});
