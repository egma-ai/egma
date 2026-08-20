import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { bannedWordIn } from "@egma/simulation-contract";
import { describe, expect, it } from "vitest";

/**
 * The words the mocked world is described in, held to the ones the product has
 * settled on.
 *
 * One entity, one word: a **mock tool**. The inverted form and the two
 * near-synonyms each read as a different thing to somebody arriving from
 * another tool, and a schema, a wire field or a refusal sentence carrying one
 * of them is the version that sticks — a column is renamed by a migration, and
 * a refusal sentence a client branches on is renamed by nobody at all. So the
 * whole surface is read back and checked, rather than trusted to review.
 *
 * **The list is the contract package's**, shared with the guard over that
 * package's own documents. Two lists written separately had already drifted
 * into disagreeing about which words are banned, which is exactly the failure
 * a vocabulary guard exists to prevent happening to itself.
 *
 * The files are the whole of what somebody outside egma can meet: the tables,
 * the factory and its refusals, the shared resolver, the route groups that
 * carry mock tools across the wire, both directions of the simulation
 * contract, the simulator's own side of the exchange, the folder and sync
 * modules a developer's repository is written by — and the SDK a customer
 * installs in their own agent, which is the surface with the least chance of
 * anyone at egma rereading it.
 */

const root = fileURLToPath(new URL("../../..", import.meta.url));

const SURFACE = [
  "packages/db/src/schema/mock-tools.ts",
  "packages/db/src/schema/runs.ts",
  "packages/db/migrations/0020_mock_tools.sql",
  "packages/db/migrations/0021_mock_tool_coverage.sql",
  "packages/db/src/access/mock-tools.ts",
  "packages/db/src/access/tests.ts",
  "packages/db/src/access/runs.ts",
  "packages/db/src/mock-tools/resolve.ts",
  "packages/db/src/access/errors.ts",
  "apps/api/src/http/mock-tools.ts",
  "apps/api/src/routes/mock-tools.ts",
  "apps/api/src/routes/tests.ts",
  "apps/api/src/routes/runs.ts",
  "apps/api/src/routes/claims.ts",
  "apps/api/src/routes/reports.ts",
  // The other ends of the same surface: the document the control plane hands
  // the simulator, the one the simulator hands back, and the simulator's own
  // side of the exchange that serves what they carry. A word that slipped into
  // any of them would be read by whoever writes the agent's side.
  "packages/simulation-contract/schemas/simulation-spec.v2.schema.json",
  "packages/simulation-contract/schemas/simulation-report.v1.schema.json",
  "apps/simulator/src/egma_simulator/mock_tools.py",
  // The half a customer installs and reads in their own repository, and the
  // half they author mock tools with. Nothing else in this list is opened as
  // often by somebody who does not work here.
  "sdks/python/src/egma/__init__.py",
  "sdks/python/src/egma/seam.py",
  "sdks/python/src/egma/mockable.py",
  "sdks/python/README.md",
  "apps/cli/src/folder/mock-tools.ts",
  "apps/cli/src/sync/mock-tools.ts",
  "apps/cli/src/platform/mock-tools.ts",
];

describe("the words the mocked world is described in", () => {
  it("carry no word the product has ruled out", async () => {
    for (const file of SURFACE) {
      const found = bannedWordIn(await readFile(path.join(root, file), "utf8"));
      expect(
        found === undefined,
        `${file} says "${found?.found ?? ""}"; say ${found?.instead ?? ""}`,
      ).toBe(true);
    }
  });

  /**
   * The guard's own tripwire. A scanner that quietly matched nothing — a
   * pattern that stopped compiling, an exemption that swallowed everything —
   * would pass this file forever while guarding nothing, and nobody would
   * find out. So it is shown a sentence of each kind.
   */
  it("still finds a banned word, and still lets the room-shaped double keep its name", () => {
    expect(bannedWordIn("the tool mock answers for it")?.found).toBe(
      "tool mock",
    );
    expect(bannedWordIn("a stub answers for it")?.instead).toBe("mock tool");
    // The word in every form it inflects into, and the one form that has a
    // word of its own to be told to use instead.
    expect(bannedWordIn("while evaluating the answer")?.found).toBe(
      "evaluating",
    );
    expect(bannedWordIn("the evaluator scores it")?.instead).toBe("grader");
    // `stub` is banned as a name for a mock tool. The room-shaped test double
    // stands in for a LiveKit room, not for one of the agent's tools, and the
    // glossary exempts it — so the guard encodes the exemption rather than
    // skipping the files that name it.
    expect(bannedWordIn("registered against the RoomStub")).toBeUndefined();
    expect(bannedWordIn("what room_stub answers")).toBeUndefined();
  });
});
