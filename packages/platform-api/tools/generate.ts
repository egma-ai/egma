import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createClient } from "@hey-api/openapi-ts";

import { platformClientConfig } from "../platform-client-config.ts";
import { platformOpenApi } from "../src/openapi.ts";

const here = dirname(fileURLToPath(import.meta.url));
const output = resolve(here, "../openapi/platform-api.openapi.json");
const generated = resolve(here, "../src/generated");
const packageRoot = resolve(here, "..");
const rendered = `${JSON.stringify(platformOpenApi, null, 2)}\n`;
const mode = process.argv[2];

async function filesIn(root: string, at = root): Promise<readonly string[]> {
  const entries = await readdir(at, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(at, entry.name);
    if (entry.isDirectory()) files.push(...(await filesIn(root, path)));
    else if (entry.isFile()) files.push(relative(root, path));
  }
  return files.sort();
}

async function sameGeneratedTree(left: string, right: string): Promise<boolean> {
  const [leftFiles, rightFiles] = await Promise.all([
    filesIn(left),
    filesIn(right),
  ]);
  if (JSON.stringify(leftFiles) !== JSON.stringify(rightFiles)) return false;
  const equal = await Promise.all(
    leftFiles.map(async (file) => {
      const [leftContents, rightContents] = await Promise.all([
        readFile(join(left, file), "utf8"),
        readFile(join(right, file), "utf8"),
      ]);
      return leftContents === rightContents;
    }),
  );
  return equal.every(Boolean);
}

async function generateClient(target: string): Promise<void> {
  await createClient({
    ...platformClientConfig(output, target),
    configFile: resolve(packageRoot, "openapi-ts.config.ts"),
  });

  // The OpenAPI security array contains alternatives: an API key OR a browser
  // session cookie. This generator version applies one scalar token to every
  // entry, which would copy an API key into the Cookie header. Stop after the
  // first scheme that accepted a token. The generator is pinned, and the exact
  // replacement makes an upstream output change fail loudly.
  const clientUtilities = join(target, "client/utils.gen.ts");
  const generated = await readFile(clientUtilities, "utf8");
  const endOfAuthLoop = `        options.headers.set(name, token);\n        break;\n    }\n  }\n}\n`;
  if (!generated.includes(endOfAuthLoop)) {
    throw new Error(
      "the generated authentication loop changed; review the platform API safety patch",
    );
  }
  await writeFile(
    clientUtilities,
    generated.replace(
      endOfAuthLoop,
      `        options.headers.set(name, token);\n        break;\n    }\n\n    // Security schemes on this API are alternatives, never a token fan-out.\n    return;\n  }\n}\n`,
    ),
    "utf8",
  );

  // `oneOf` makes mock-tool answers and errors exclusive on the wire. This
  // generator renders each closed branch as a structural union, where an
  // object carrying both members still type-checks unless the member forbidden
  // by that branch is `never`. Keep the generated client as strict as the
  // OpenAPI contract. The counts are tied to the pinned generator output so a
  // new operation or an upstream rendering change must be reviewed.
  const generatedTypes = join(target, "types.gen.ts");
  let types = await readFile(generatedTypes, "utf8");

  const replaceExactly = (
    pattern: RegExp,
    replacement: string,
    expected: number,
    name: string,
  ): void => {
    const matches = [...types.matchAll(pattern)].length;
    if (matches !== expected) {
      throw new Error(
        `the generated ${name} shape changed: expected ${expected} matches, found ${matches}`,
      );
    }
    types = types.replace(pattern, replacement);
  };

  replaceExactly(
    /error\?: unknown;/g,
    "error?: never;",
    17,
    "mock-tool forbidden error",
  );
  replaceExactly(
    /answer\?: unknown;(\n\s*error: string;)/g,
    "answer?: never;$1",
    16,
    "mock-tool forbidden answer",
  );
  replaceExactly(
    /answer\?: unknown;(\n\s*error\?: never;)/g,
    "answer?: never;$1",
    1,
    "mock-tool unchanged-answer branch",
  );
  await writeFile(generatedTypes, types, "utf8");
}

if (mode === "--write") {
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, rendered, "utf8");
  await generateClient(generated);
} else if (mode === "--check") {
  const current = await readFile(output, "utf8").catch(() => "");
  if (current !== rendered) {
    throw new Error(
      "platform API artifacts are stale; run `pnpm --filter @egma/platform-api generate`",
    );
  }
  const temporary = await mkdtemp(join(tmpdir(), "egma-platform-api-"));
  try {
    await generateClient(temporary);
    if (!(await sameGeneratedTree(generated, temporary))) {
      throw new Error(
        "the generated platform client is stale; run `pnpm --filter @egma/platform-api generate`",
      );
    }
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
} else {
  throw new Error("usage: node tools/generate.ts --write|--check");
}
