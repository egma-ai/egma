import { describe, expect, it } from "vitest";

import {
  EMPTY_CONFIG,
  parseConfig,
  platformOwnedIds,
  serializeConfig,
} from "../src/folder/egma-folder.ts";

const PROJECT_ID = "prj_01K3XQ7M4E8YB2FVN0H9TZQWER";
const FIRST_AGENT_ID = "agt_01K3XQ7M4E8YB2FVN0H9TZQWER";
const SECOND_AGENT_ID = "agt_01K3XQ7M4E8YB2FVN0H9TZQWES";
const FIRST_CONNECTION_ID = "con_01K3XQ7M4E8YB2FVN0H9TZQWER";
const SECOND_CONNECTION_ID = "con_01K3XQ7M4E8YB2FVN0H9TZQWES";

describe("folder config format 4", () => {
  it("round-trips many agents and their connections", () => {
    const config = {
      format: 4,
      platform: { origin: "https://egma.example" },
      project: { id: PROJECT_ID, name: "LiveKit examples" },
      agents: [
        {
          id: FIRST_AGENT_ID,
          name: "Appointment scheduler",
          platform: "livekit",
          connections: [
            { id: FIRST_CONNECTION_ID, name: "livekit-1" },
            { id: SECOND_CONNECTION_ID, name: "livekit-chat" },
          ],
        },
        {
          id: SECOND_AGENT_ID,
          name: "Billing support",
          platform: "retell",
          connections: [],
        },
      ],
    } as const;

    const written = serializeConfig(config);

    expect(written).toBe(
      [
        "# config file for egma",
        "format: 4",
        "platform:",
        "  origin: https://egma.example",
        "project:",
        `  id: ${PROJECT_ID}`,
        "  name: LiveKit examples",
        "agents:",
        `  - id: ${FIRST_AGENT_ID}`,
        "    name: Appointment scheduler",
        "    platform: livekit",
        "    connections:",
        `      - id: ${FIRST_CONNECTION_ID}`,
        "        name: livekit-1",
        `      - id: ${SECOND_CONNECTION_ID}`,
        "        name: livekit-chat",
        `  - id: ${SECOND_AGENT_ID}`,
        "    name: Billing support",
        "    platform: retell",
        "    connections: []",
        "",
      ].join("\n"),
    );
    expect(parseConfig(written, "config.yaml")).toEqual(config);
  });

  it.each([
    [
      "the former format",
      "format: 3\nplatform:\nproject:\nagents: []\n",
      /folder format 3.*requires format 4.*no legacy reader/i,
    ],
  ])("refuses %s", (_name, document, message) => {
    expect(() => parseConfig(document, "config.yaml")).toThrow(message);
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
              platform: "livekit",
              connections: [
                { id: FIRST_CONNECTION_ID, name: "livekit-1" },
              ],
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
