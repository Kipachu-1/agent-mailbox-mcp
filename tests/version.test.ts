import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { VERSION } from "../src/version";

test("VERSION is a non-empty semver string", () => {
  expect(VERSION).toMatch(/^\d+\.\d+\.\d+/);
});

test("package.json version matches the source-of-truth VERSION", () => {
  const pkg = JSON.parse(readFileSync("package.json", "utf-8")) as { version?: string };
  expect(pkg.version).toBe(VERSION);
});

test("package.json declares a license field", () => {
  const pkg = JSON.parse(readFileSync("package.json", "utf-8")) as { license?: string };
  expect(pkg.license).toBeTruthy();
});
