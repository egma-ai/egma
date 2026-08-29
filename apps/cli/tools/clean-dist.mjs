/** Remove compiled files that no longer have a source file. */
import { rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const dist = fileURLToPath(new URL("../dist", import.meta.url));

await rm(dist, { recursive: true, force: true });
