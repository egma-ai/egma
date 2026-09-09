import { writeFile } from "node:fs/promises";
import { Daytona } from "@daytona/sdk";

const sha = process.env.RELEASE_SHA ?? "";
const image = process.env.SIMULATOR_IMAGE ?? "";
if (!/^[0-9a-f]{40}$/.test(sha) || !image.endsWith(`:${sha}`)) {
  throw new Error("RELEASE_SHA and SIMULATOR_IMAGE must name the same exact commit");
}

const daytona = new Daytona({ apiKey: process.env.DAYTONA_API_KEY });
const name = `egma-simulator-${sha}`;
let existing;
for (let page = 1; existing === undefined; page += 1) {
  const listed = await daytona.snapshot.list({ page, limit: 100 });
  existing = listed.items.find((snapshot) => snapshot.name === name);
  if (page >= listed.totalPages) break;
}
const snapshot = existing ?? await daytona.snapshot.create(
  { name, image },
  { timeout: 900, onLogs: (chunk) => process.stdout.write(chunk) },
);
if (snapshot.imageName !== image) {
  throw new Error(`${name} already names a different simulator image`);
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
await writeFile("daytona-snapshot-id.txt", `${active.id}\n`, { mode: 0o600 });
