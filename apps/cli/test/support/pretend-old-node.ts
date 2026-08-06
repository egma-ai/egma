/**
 * Makes the process report an old Node, so a test can watch the real entry
 * point refuse one. Loaded with `node --import`, which runs before the entry
 * point is even read.
 */

import process from "node:process";

Object.defineProperty(process.versions, "node", {
  value: process.env.PRETEND_NODE_VERSION ?? "18.20.4",
  configurable: true,
});
