/** Cross-platform local path components derived from unlimited product names. */

import { createHash } from "node:crypto";

/** Safely below the 255-byte component ceiling of the supported file systems. */
export const MAX_PORTABLE_COMPONENT_LENGTH = 120;

const SUITE_DIRECTORY = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u;
const TEST_FILE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.md$/u;
const WINDOWS_DEVICE = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/iu;

function digest(value: string): string {
  return createHash("sha256")
    .update(value.normalize("NFKC"), "utf8")
    .digest("hex")
    .slice(0, 10);
}

function slug(value: string): string {
  return value
    .normalize("NFKD")
    .replaceAll(/\p{Mark}+/gu, "")
    .replaceAll(/[^A-Za-z0-9]+/gu, "-")
    .replaceAll(/^-+|-+$/gu, "")
    .replaceAll(/-+/gu, "-")
    .toLowerCase();
}

/** Windows reserves these device names even when an extension follows. */
export function isWindowsReservedPathComponent(component: string): boolean {
  const withoutTrailingDots = component.trim().replace(/[ .]+$/u, "");
  const [base = ""] = withoutTrailingDots.split(".", 1);
  return WINDOWS_DEVICE.test(base);
}

function boundedStem(
  displayName: string,
  fallback: "suite" | "test",
  maximum: number,
): string {
  let stem = slug(displayName) || fallback;
  if (isWindowsReservedPathComponent(stem)) stem = `${fallback}-${stem}`;
  if (stem.length <= maximum) return stem;

  const ending = `-${digest(displayName)}`;
  const prefix = stem
    .slice(0, Math.max(1, maximum - ending.length))
    .replace(/-+$/u, "");
  return `${prefix || fallback}${ending}`.slice(0, maximum);
}

export function portableSuiteDirectory(displayName: string): string {
  return boundedStem(displayName, "suite", MAX_PORTABLE_COMPONENT_LENGTH);
}

export function portableTestFileName(displayName: string): string {
  return `${boundedStem(
    displayName,
    "test",
    MAX_PORTABLE_COMPONENT_LENGTH - ".md".length,
  )}.md`;
}

/** Add stable identity to a colliding component without exceeding its bound. */
export function withStablePathSuffix(
  component: string,
  stableSuffix: string,
  extension: "" | ".md" = "",
): string {
  const stem = extension === "" ? component : component.slice(0, -extension.length);
  const maximum = MAX_PORTABLE_COMPONENT_LENGTH - extension.length;
  const safeSuffix = slug(stableSuffix) || digest(stableSuffix);
  const ending = `-${safeSuffix}`;
  const prefix = stem
    .slice(0, Math.max(1, maximum - ending.length))
    .replace(/-+$/u, "");
  return `${prefix || (extension === "" ? "suite" : "test")}${ending}${extension}`;
}

export function isPortableSuiteDirectory(component: string): boolean {
  return (
    component.length <= MAX_PORTABLE_COMPONENT_LENGTH &&
    SUITE_DIRECTORY.test(component) &&
    !isWindowsReservedPathComponent(component)
  );
}

export function isPortableTestFile(component: string): boolean {
  return (
    component.length <= MAX_PORTABLE_COMPONENT_LENGTH &&
    TEST_FILE.test(component) &&
    !isWindowsReservedPathComponent(component)
  );
}
