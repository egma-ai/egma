import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export async function installSkill(
  cwd: string,
  force: boolean,
): Promise<string> {
  const source = path.resolve(import.meta.dirname, "../skills/egma-init/SKILL.md");
  const target = path.resolve(cwd, ".agents", "skills", "egma-init", "SKILL.md");
  if (!force) {
    try {
      await readFile(target, "utf8");
      throw new Error(`${target} already exists; use --force to replace it`);
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
    }
  }
  const contents = await readFile(source, "utf8");
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, contents, "utf8");
  return target;
}
