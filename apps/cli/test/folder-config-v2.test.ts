import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  EMPTY_CONFIG,
  parseConfig,
  platformOwnedIds,
  recordRegisteredTarget,
  serializeConfig,
  writeConfig,
} from "../src/folder/egma-folder.ts";
import { makeWorkspace, type Workspace } from "./support/workspace.ts";

const PROJECT_ID = "prj_01K3XQ7M4E8YB2FVN0H9TZQWER";
const FIRST_AGENT_ID = "agt_01K3XQ7M4E8YB2FVN0H9TZQWER";
const SECOND_AGENT_ID = "agt_01K3XQ7M4E8YB2FVN0H9TZQWES";
const FIRST_CONNECTION_ID = "con_01K3XQ7M4E8YB2FVN0H9TZQWER";
const SECOND_CONNECTION_ID = "con_01K3XQ7M4E8YB2FVN0H9TZQWES";

let workspace: Workspace | null = null;

afterEach(async () => {
  await workspace?.remove();
  workspace = null;
});

describe("folder config format 2", () => {
  it("round-trips many agents and their connections", () => {
    const config = {
      format: 2,
      platform: { origin: "https://egma.example" },
      project: { id: PROJECT_ID, name: "LiveKit examples" },
      agents: [
        {
          id: FIRST_AGENT_ID,
          name: "Appointment scheduler",
          connections: [
            { id: FIRST_CONNECTION_ID, name: "livekit-1" },
            { id: SECOND_CONNECTION_ID, name: "phone_number-1" },
          ],
        },
        {
          id: SECOND_AGENT_ID,
          name: "Billing support",
          connections: [],
        },
      ],
    } as const;

    const written = serializeConfig(config);

    expect(written).toBe(
      [
        "# What this folder points at on Egma.",
        "#",
        "# Committed on purpose: nothing in this folder is secret. Egma writes an id",
        "# beside each name once it has registered one.",
        "format: 2",
        "platform:",
        "  origin: https://egma.example",
        "project:",
        `  id: ${PROJECT_ID}`,
        "  name: LiveKit examples",
        "agents:",
        `  - id: ${FIRST_AGENT_ID}`,
        "    name: Appointment scheduler",
        "    connections:",
        `      - id: ${FIRST_CONNECTION_ID}`,
        "        name: livekit-1",
        `      - id: ${SECOND_CONNECTION_ID}`,
        "        name: phone_number-1",
        `  - id: ${SECOND_AGENT_ID}`,
        "    name: Billing support",
        "    connections: []",
        "",
      ].join("\n"),
    );
    expect(parseConfig(written, "config.yaml")).toEqual(config);
  });

  it.each([
    [
      "the former unversioned singleton shape",
      "platform:\nproject:\nagent:\nconnection:\n",
      /folder format none.*requires format 2.*no legacy reader/i,
    ],
    [
      "another explicit format",
      "format: 1\nplatform:\nproject:\nagents: []\n",
      /folder format 1.*requires format 2.*no legacy reader/i,
    ],
  ])("refuses %s", (_name, document, message) => {
    expect(() => parseConfig(document, "config.yaml")).toThrow(message);
  });

  it("refuses duplicate agent and connection identities", () => {
    const duplicateAgent = [
      "format: 2",
      "platform:",
      "project:",
      "agents:",
      `  - id: ${FIRST_AGENT_ID}`,
      "    name: One",
      "    connections: []",
      `  - id: ${FIRST_AGENT_ID}`,
      "    name: Two",
      "    connections: []",
      "",
    ].join("\n");
    expect(() => parseConfig(duplicateAgent, "config.yaml")).toThrow(
      new RegExp(`agent id ${FIRST_AGENT_ID}.*more than once`, "i"),
    );

    const duplicateConnection = [
      "format: 2",
      "platform:",
      "project:",
      "agents:",
      `  - id: ${FIRST_AGENT_ID}`,
      "    name: One",
      "    connections:",
      `      - id: ${FIRST_CONNECTION_ID}`,
      "        name: First",
      `  - id: ${SECOND_AGENT_ID}`,
      "    name: Two",
      "    connections:",
      `      - id: ${FIRST_CONNECTION_ID}`,
      "        name: Copy",
      "",
    ].join("\n");
    expect(() => parseConfig(duplicateConnection, "config.yaml")).toThrow(
      new RegExp(`connection id ${FIRST_CONNECTION_ID}.*both agent`, "i"),
    );
  });

  it("records a target by id without replacing sibling agents or connections", async () => {
    workspace = await makeWorkspace();
    const root = path.join(workspace.dir, "egma");
    await mkdir(root);
    const file = path.join(root, "config.yaml");
    await writeConfig(file, {
      ...EMPTY_CONFIG,
      platform: { origin: "https://egma.example" },
      project: { id: PROJECT_ID, name: "LiveKit examples" },
      agents: [
        {
          id: FIRST_AGENT_ID,
          name: "Old appointment name",
          connections: [{ id: FIRST_CONNECTION_ID, name: "old-livekit" }],
        },
        {
          id: SECOND_AGENT_ID,
          name: "Billing support",
          connections: [],
        },
      ],
    });

    await recordRegisteredTarget(file, {
      project: { id: PROJECT_ID, name: "LiveKit Examples" },
      agent: { id: FIRST_AGENT_ID, name: "Appointment scheduler" },
      connection: { id: SECOND_CONNECTION_ID, name: "phone_number-1" },
    });
    const recorded = await recordRegisteredTarget(file, {
      agent: { id: FIRST_AGENT_ID, name: "Appointment scheduler" },
      connection: { id: SECOND_CONNECTION_ID, name: "phone-production" },
    });

    expect(recorded.project?.name).toBe("LiveKit Examples");
    expect(recorded.agents).toEqual([
      {
        id: FIRST_AGENT_ID,
        name: "Appointment scheduler",
        connections: [
          { id: FIRST_CONNECTION_ID, name: "old-livekit" },
          { id: SECOND_CONNECTION_ID, name: "phone-production" },
        ],
      },
      {
        id: SECOND_AGENT_ID,
        name: "Billing support",
        connections: [],
      },
    ]);
    expect(parseConfig(await readFile(file, "utf8"), "config.yaml")).toEqual(recorded);
  });

  it("reports every platform-owned identity in the new hierarchy", () => {
    expect(
      platformOwnedIds(
        {
          ...EMPTY_CONFIG,
          project: { id: PROJECT_ID, name: "LiveKit examples" },
          agents: [
            {
              id: FIRST_AGENT_ID,
              name: "Appointment scheduler",
              connections: [{ id: FIRST_CONNECTION_ID, name: "livekit-1" }],
            },
          ],
        },
        ["ste_01K3XQ7M4E8YB2FVN0H9TZQWER"],
      ),
    ).toEqual([
      `project ${PROJECT_ID} in egma/config.yaml`,
      `agent ${FIRST_AGENT_ID} in egma/config.yaml`,
      `connection ${FIRST_CONNECTION_ID} under agent ${FIRST_AGENT_ID} in egma/config.yaml`,
      "suite ste_01K3XQ7M4E8YB2FVN0H9TZQWER in egma/tests/*/suite.yaml",
    ]);
  });
});
