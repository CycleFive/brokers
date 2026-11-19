import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { VERSION } from "../src";

it("is the one version every package.json states", () => {
  for (const p of ["package.json", "packages/core/package.json", "brokers/discord/package.json", "brokers/github/package.json"]) {
    expect(JSON.parse(readFileSync(new URL(`../../../${p}`, import.meta.url), "utf8")).version, p).toBe(VERSION);
  }
  expect(VERSION).toBe("0.3.0");
});
