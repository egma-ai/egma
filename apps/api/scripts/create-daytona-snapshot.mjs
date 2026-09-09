import { writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { Daytona } from "@daytona/sdk";

export const SNAPSHOT_ENTRYPOINT = Object.freeze(["egma-simulator"]);

function hasExactEntrypoint(snapshot) {
  return Array.isArray(snapshot.entrypoint)
    && snapshot.entrypoint.length === SNAPSHOT_ENTRYPOINT.length
    && snapshot.entrypoint.every((value, index) => value === SNAPSHOT_ENTRYPOINT[index]);
}

export async function createOrReuseSnapshot({ daytona, sha, image, onLogs }) {
  if (!/^[0-9a-f]{40}$/.test(sha) || !image.endsWith(`:${sha}`)) {
    throw new Error("RELEASE_SHA and SIMULATOR_IMAGE must name the same exact commit");
  }

  const name = `egma-simulator-${sha}`;
  let existing;
  for (let page = 1; existing === undefined; page += 1) {
    const listed = await daytona.snapshot.list({ page, limit: 100 });
    existing = listed.items.find((snapshot) => snapshot.name === name);
    if (page >= listed.totalPages) break;
  }
  const snapshot = existing ?? await daytona.snapshot.create(
    { name, image, entrypoint: [...SNAPSHOT_ENTRYPOINT] },
    { timeout: 900, onLogs },
  );
  if (snapshot.imageName !== image) {
    throw new Error(`${name} already names a different simulator image`);
  }
  if (!hasExactEntrypoint(snapshot)) {
    throw new Error(`${name} does not run the required egma-simulator entrypoint`);
  }
  let active = snapshot;
  if (active.state === "inactive") active = await daytona.snapshot.activate(active);
  const deadline = Date.now() + 15 * 60_000;
  while (active.state !== "active") {
    if (active.state === "error" || active.state === "build_failed") {
      throw new Error(`${name} failed: ${active.errorReason ?? active.state}`);
    }
    if (Date.now() >= deadline) throw new Error(`${name} did not become active within 15 minutes`);
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    active = await daytona.snapshot.get(active.id);
  }
  return active.id;
}

async function main() {
  const id = await createOrReuseSnapshot({
    daytona: new Daytona({ apiKey: process.env.DAYTONA_API_KEY }),
    sha: process.env.RELEASE_SHA ?? "",
    image: process.env.SIMULATOR_IMAGE ?? "",
    onLogs: (chunk) => process.stdout.write(chunk),
  });
  await writeFile("daytona-snapshot-id.txt", `${id}\n`, { mode: 0o600 });
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
