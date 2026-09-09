import { describe, expect, it, vi } from "vitest";
import {
  createOrReuseSnapshot,
  SNAPSHOT_ENTRYPOINT,
} from "../scripts/create-daytona-snapshot.mjs";

const sha = "e259b92bf149e841bee03cb52defcd86c4415fc5";
const image = `registry.example/egma/simulator:${sha}`;
const name = `egma-simulator-${sha}`;

function daytona(items) {
  return {
    snapshot: {
      list: vi.fn(async () => ({ items, totalPages: 1 })),
      create: vi.fn(async (params) => ({
        id: "created",
        imageName: params.image,
        entrypoint: params.entrypoint,
        state: "active",
      })),
      activate: vi.fn(),
      get: vi.fn(),
    },
  };
}

describe("Daytona snapshot entrypoint", () => {
  it("sets the simulator entrypoint when it creates a snapshot", async () => {
    const client = daytona([]);

    await expect(createOrReuseSnapshot({ daytona: client, sha, image })).resolves.toBe("created");
    expect(client.snapshot.create).toHaveBeenCalledWith(
      { name, image, entrypoint: [...SNAPSHOT_ENTRYPOINT] },
      { timeout: 900, onLogs: undefined },
    );
  });

  it("reuses a snapshot only when its entrypoint is exact", async () => {
    const valid = daytona([{
      id: "existing",
      name,
      imageName: image,
      entrypoint: ["egma-simulator"],
      state: "active",
    }]);
    await expect(createOrReuseSnapshot({ daytona: valid, sha, image })).resolves.toBe("existing");
    expect(valid.snapshot.create).not.toHaveBeenCalled();

    const invalid = daytona([{
      id: "broken",
      name,
      imageName: image,
      entrypoint: null,
      state: "active",
    }]);
    await expect(createOrReuseSnapshot({ daytona: invalid, sha, image }))
      .rejects.toThrow("does not run the required egma-simulator entrypoint");
  });
});
