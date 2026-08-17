/**
 * Project the public Agent Skills into the CLI package.
 *
 * People edit the repository-root `skills/` tree. npm cannot include files
 * above `apps/cli`, so the package keeps an exact generated projection. This
 * script is the only direction that copy moves: source to package.
 */

import { copyFile, mkdir, readdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const CODE_ROOT = fileURLToPath(new URL("..", import.meta.url));
const SOURCE_ROOT = path.join(CODE_ROOT, "skills");
const PACKAGE_ROOT = path.join(CODE_ROOT, "apps", "cli", "skills");

// Public release is an allowlist. Adding a directory does not publish it by
// accident, and this script never walks the private Planning repository.
const PUBLIC_SKILLS = ["egma", "find-voice-agent", "write-egma-tests"];

async function filesUnder(root, below = "") {
  const entries = await readdir(path.join(root, below), { withFileTypes: true });
  const found = await Promise.all(
    entries.map(async (entry) => {
      const relative = path.join(below, entry.name);
      if (entry.isSymbolicLink()) {
        throw new Error(`Agent Skill files must be real files: ${path.join(root, relative)}`);
      }
      return entry.isDirectory() ? filesUnder(root, relative) : [relative];
    }),
  );
  return found.flat().sort();
}

async function sourceFiles() {
  const entries = (await readdir(SOURCE_ROOT, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  if (JSON.stringify(entries) !== JSON.stringify(PUBLIC_SKILLS)) {
    throw new Error(
      `Public Agent Skills must be explicitly allowlisted. Expected ${PUBLIC_SKILLS.join(
        ", ",
      )}; found ${entries.join(", ")}.`,
    );
  }

  const files = [];
  for (const skill of PUBLIC_SKILLS) {
    const root = path.join(SOURCE_ROOT, skill);
    const held = await filesUnder(root);
    if (!held.includes("SKILL.md")) {
      throw new Error(`Public Agent Skill ${skill} has no SKILL.md.`);
    }
    files.push(...held.map((relative) => path.join(skill, relative)));
  }
  return files.sort();
}

async function writeProjection() {
  const files = await sourceFiles();
  await rm(PACKAGE_ROOT, { recursive: true, force: true });
  for (const relative of files) {
    const destination = path.join(PACKAGE_ROOT, relative);
    await mkdir(path.dirname(destination), { recursive: true });
    await copyFile(path.join(SOURCE_ROOT, relative), destination);
  }
}

async function checkProjection() {
  const source = await sourceFiles();
  const projected = await filesUnder(PACKAGE_ROOT).catch(() => []);
  const problems = [];

  for (const relative of source) {
    if (!projected.includes(relative)) {
      problems.push(`missing ${relative}`);
      continue;
    }
    const [authored, packaged] = await Promise.all([
      readFile(path.join(SOURCE_ROOT, relative)),
      readFile(path.join(PACKAGE_ROOT, relative)),
    ]);
    if (!authored.equals(packaged)) problems.push(`changed ${relative}`);
  }
  for (const relative of projected) {
    if (!source.includes(relative)) problems.push(`unexpected ${relative}`);
  }

  if (problems.length > 0) {
    throw new Error(
      [
        "The CLI Agent Skill projection is out of date:",
        ...problems.map((problem) => `- ${problem}`),
        "Run `pnpm skills:sync` and commit the generated projection.",
      ].join("\n"),
    );
  }
}

const mode = process.argv[2];
if (mode === "--write") await writeProjection();
else if (mode === "--check") await checkProjection();
else throw new Error("Use --write to update the projection or --check to verify it.");
