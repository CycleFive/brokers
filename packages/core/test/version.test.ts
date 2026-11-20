import { existsSync, readdirSync, readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { VERSION } from "../src";

const root = new URL("../../../", import.meta.url);

function packageFiles(): string[] {
  const files = ["package.json"];
  for (const dir of ["packages", "brokers"]) {
    for (const entry of readdirSync(new URL(`${dir}/`, root), { withFileTypes: true })) {
      const file = `${dir}/${entry.name}/package.json`;
      if (entry.isDirectory() && existsSync(new URL(file, root))) files.push(file);
    }
  }
  return files;
}

it("is the one version every package.json states", () => {
  const files = packageFiles();
  expect(files.length).toBeGreaterThanOrEqual(5);
  for (const p of files) {
    expect(JSON.parse(readFileSync(new URL(p, root), "utf8")).version, p).toBe(VERSION);
  }
  expect(VERSION).toBe("0.5.1");
});
