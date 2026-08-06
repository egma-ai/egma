#!/usr/bin/env node
/**
 * The `egma` entry point.
 *
 * Only the Node check is imported statically. Everything else arrives through a
 * dynamic import, so a developer on an old Node reads a sentence instead of a
 * syntax error from a module they never asked for.
 */

import process from "node:process";

import { nodeVersionRefusal } from "./preflight.ts";

const refusal = nodeVersionRefusal(process.versions.node);
if (refusal !== null) {
  process.stderr.write(`${refusal}\n`);
  process.exit(1);
}

const { main } = await import("./main.ts");
await main(process.argv.slice(2));
