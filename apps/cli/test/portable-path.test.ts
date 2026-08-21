import { describe, expect, it } from "vitest";

import {
  MAX_PORTABLE_COMPONENT_LENGTH,
  isPortableSuiteDirectory,
  isPortableTestFile,
  isWindowsReservedPathComponent,
  portableSuiteDirectory,
  portableTestFileName,
  withStablePathSuffix,
} from "../src/folder/portable-path.ts";

describe("portable repository path components", () => {
  it.each(["CON", "prn", "AuX", "nul", "Com1", "cOm9", "LPT1", "lpt9"])(
    "recognizes the Windows device name %s in every extension form",
    (name) => {
      expect(isWindowsReservedPathComponent(name)).toBe(true);
      expect(isWindowsReservedPathComponent(`${name}.md`)).toBe(true);
      expect(isWindowsReservedPathComponent(`${name}.anything.txt`)).toBe(true);
    },
  );

  it.each(["COM0", "COM10", "LPT0", "LPT10", "console", "auxiliary"])(
    "does not reserve the ordinary name %s",
    (name) => {
      expect(isWindowsReservedPathComponent(name)).toBe(false);
    },
  );

  it("keeps unlimited display names but derives bounded deterministic components", () => {
    const suiteName = `${"Northside-".repeat(40)}suite`;
    const testName = `${"Books-a-visit-".repeat(30)}test`;

    const suite = portableSuiteDirectory(suiteName);
    const test = portableTestFileName(testName);

    expect(suite.length).toBeLessThanOrEqual(MAX_PORTABLE_COMPONENT_LENGTH);
    expect(test.length).toBeLessThanOrEqual(MAX_PORTABLE_COMPONENT_LENGTH);
    expect(portableSuiteDirectory(suiteName)).toBe(suite);
    expect(portableTestFileName(testName)).toBe(test);
    expect(isPortableSuiteDirectory(suite)).toBe(true);
    expect(isPortableTestFile(test)).toBe(true);
  });

  it("does not merge distinct long display names that share one long prefix", () => {
    const shared = "northside".repeat(50);

    expect(portableSuiteDirectory(`${shared}-first`)).not.toBe(
      portableSuiteDirectory(`${shared}-second`),
    );
    expect(portableTestFileName(`${shared}-first`)).not.toBe(
      portableTestFileName(`${shared}-second`),
    );
  });

  it("avoids reserved names and every supported-platform separator", () => {
    expect(portableSuiteDirectory("CON")).toBe("suite-con");
    expect(portableTestFileName("pRn")).toBe("test-prn.md");

    const suite = portableSuiteDirectory('North/West\\Desk: <A>|"B"?*');
    const test = portableTestFileName('North/West\\Desk: <A>|"B"?*');
    expect(suite).toBe("north-west-desk-a-b");
    expect(test).toBe("north-west-desk-a-b.md");
    expect(suite).not.toMatch(/[\\/]/u);
    expect(test).not.toMatch(/[\\/]/u);
  });

  it("adds stable collision suffixes without breaking the component bound", () => {
    const wanted = portableTestFileName("same ".repeat(100));
    const first = withStablePathSuffix(wanted, "01abcdefgh", ".md");
    const second = withStablePathSuffix(wanted, "01abcdefgh-2", ".md");

    expect(first).toBe(withStablePathSuffix(wanted, "01abcdefgh", ".md"));
    expect(first).not.toBe(second);
    expect(first.length).toBeLessThanOrEqual(MAX_PORTABLE_COMPONENT_LENGTH);
    expect(second.length).toBeLessThanOrEqual(MAX_PORTABLE_COMPONENT_LENGTH);
    expect(isPortableTestFile(first)).toBe(true);
    expect(isPortableTestFile(second)).toBe(true);
  });
});
