import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { main, manifestPath, parseArgs } from "../src/cli.ts";

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));

afterEach(() => vi.restoreAllMocks());

describe("parseArgs", () => {
  it("parses a command, names and flags", () => {
    expect(parseArgs(["deploy", "manus", "claude", "--mailroom", "--no-input", "--manifest", "/x.jsonc"])).toEqual({
      command: "deploy",
      names: ["manus", "claude"],
      manifest: "/x.jsonc",
      mailroom: true,
      input: false,
    });
    expect(parseArgs(["check"])).toEqual({ command: "check", names: [], manifest: undefined, mailroom: false, input: true });
  });

  it("refuses an unknown command or flag with the usage line", () => {
    for (const argv of [[], ["frobnicate"], ["check", "--nope"], ["check", "--manifest"]]) {
      expect(() => parseArgs(argv)).toThrow(/check \| render \| deploy \| status/);
    }
  });
});

describe("manifestPath", () => {
  it("finds the manifest: flag, then MAILBOXES, then the repository root", () => {
    const args = parseArgs(["check"]);
    expect(manifestPath({ ...args, manifest: "/flag.jsonc" }, { MAILBOXES: "/env.jsonc" }, "/repo")).toBe("/flag.jsonc");
    expect(manifestPath(args, { MAILBOXES: "/env.jsonc" }, "/repo")).toBe("/env.jsonc");
    expect(manifestPath(args, {}, "/repo")).toBe("/repo/mailboxes.jsonc");
  });
});

describe("main check", () => {
  it("prints one line per copy and returns 0", async () => {
    const out = vi.spyOn(console, "log").mockImplementation(() => {});
    const code = await main(["check", "--manifest", join(repoRoot, "mailboxes.example.jsonc")]);
    expect(code).toBe(0);
    expect(out).toHaveBeenCalledTimes(4);
  });

  it("prints the problems to stderr and returns 1", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mailbox-test-"));
    const file = join(dir, "m.jsonc");
    writeFileSync(file, `{ "mailboxes": { "Bad": { "brokers": { "discord": {} } } } }`);
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await main(["check", "--manifest", file])).toBe(1);
    expect(String(err.mock.calls[0][0])).toMatch(/^mailboxes\.Bad: /);
  });

  it("returns 1 for a manifest that does not exist", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await main(["check", "--manifest", join(tmpdir(), "no-such-manifest.jsonc")])).toBe(1);
  });

  it("returns 1 and names the known mailboxes when a name is not one of them", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mailbox-test-"));
    const file = join(dir, "m.jsonc");
    writeFileSync(
      file,
      `{ "hostname": "{mailbox}-{broker}.w.example.com", "mailboxes": { "one": { "brokers": { "discord": { "vars": {} } } }, "two": { "brokers": { "github": { "vars": {} } } } } }`,
    );
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await main(["check", "nope", "--manifest", file])).toBe(1);
    const message = String(err.mock.calls[0][0]);
    expect(message).toContain("nope");
    expect(message).toContain("one, two");
  });
});
