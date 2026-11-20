import { describe, expect, it } from "vitest";
import { createKv, deployConfig, kvNamespaces, secretNames, type Run, type RunResult } from "../src/wrangler.ts";

interface Call { args: string[]; cwd: string; interactive?: boolean }

function fakeRun(script: (args: string[], n: number) => Partial<RunResult>): { run: Run; calls: Call[] } {
  const calls: Call[] = [];
  const run: Run = async (args, opts) => {
    calls.push({ args, ...opts });
    return { code: 0, stdout: "", stderr: "", ...script(args, calls.length) };
  };
  return { run, calls };
}

const list = (items: { id: string; title: string }[]) => `⛅️ wrangler 4.157\n${JSON.stringify(items, null, 2)}\n`;

describe("kvNamespaces", () => {
  it("reads KV namespaces from JSON surrounded by other output", async () => {
    const { run, calls } = fakeRun(() => ({ stdout: list([{ id: "a1", title: "one" }, { id: "b2", title: "two" }]) + "done\n" }));
    expect(await kvNamespaces(run, "/w")).toEqual(new Map([["one", "a1"], ["two", "b2"]]));
    expect(calls[0]).toMatchObject({ args: ["kv", "namespace", "list"], cwd: "/w" });
  });
});

describe("createKv", () => {
  it("creates a namespace and returns the id found by listing again", async () => {
    const { run, calls } = fakeRun((args) => (args[2] === "list" ? { stdout: list([{ id: "new1", title: "t1" }]) } : {}));
    expect(await createKv(run, "/w", "t1")).toBe("new1");
    expect(calls.map((c) => c.args)).toEqual([["kv", "namespace", "create", "t1", "--update-config=false"], ["kv", "namespace", "list"]]);
  });

  it("fails when a created namespace does not appear in the listing", async () => {
    const { run } = fakeRun((args) => (args[2] === "list" ? { stdout: "[]" } : {}));
    await expect(createKv(run, "/w", "t1")).rejects.toThrow(/t1/);
  });

  it("fails when the create command fails", async () => {
    const { run } = fakeRun(() => ({ code: 1, stderr: "boom" }));
    await expect(createKv(run, "/w", "t1")).rejects.toThrow(/boom/);
  });
});

describe("secretNames", () => {
  it("tells a Worker that does not exist from one with no secrets", async () => {
    const missing = fakeRun(() => ({ code: 1, stderr: 'Worker "w1" not found.' }));
    expect(await secretNames(missing.run, "/w", "w1")).toBeNull();
    expect(missing.calls[0].args).toEqual(["secret", "list", "--name", "w1"]);
    const none = fakeRun(() => ({ stdout: "[]" }));
    expect(await secretNames(none.run, "/w", "w1")).toEqual([]);
    const some = fakeRun(() => ({ stdout: `[{"name":"A","type":"secret_text"},{"name":"B","type":"secret_text"}]` }));
    expect(await secretNames(some.run, "/w", "w1")).toEqual(["A", "B"]);
  });

  it("trusts a clean listing first, even when a secret's name contains 'not found'", async () => {
    const { run } = fakeRun(() => ({ stdout: `[{"name":"X_not found_Y","type":"secret_text"},{"name":"Worker \\"w1\\" not found","type":"secret_text"}]` }));
    expect(await secretNames(run, "/w", "w1")).toEqual(["X_not found_Y", 'Worker "w1" not found']);
  });

  it("throws on a failure that mentions another thing not found", async () => {
    const other = fakeRun(() => ({ code: 1, stderr: 'Account "a" not found. Worker "other" not found.' }));
    await expect(secretNames(other.run, "/w", "w1")).rejects.toThrow(/secret list/);
    const file = fakeRun(() => ({ code: 1, stderr: "config file not found" }));
    await expect(secretNames(file.run, "/w", "w1")).rejects.toThrow(/secret list/);
  });

  it("throws on secret-list output it does not understand", async () => {
    const { run } = fakeRun(() => ({ code: 1, stderr: "You are not logged in" }));
    await expect(secretNames(run, "/w", "w1")).rejects.toThrow(/secret list/);
    const odd = fakeRun(() => ({ stdout: "hello" }));
    await expect(secretNames(odd.run, "/w", "w1")).rejects.toThrow(/secret list/);
  });
});

describe("deployConfig", () => {
  it("returns the version id of a deploy", async () => {
    const { run, calls } = fakeRun(() => ({ stdout: "Uploaded\nCurrent Version ID: 11111111-2222-3333-4444-555555555555\n" }));
    expect(await deployConfig(run, "/w", "wrangler.m1.jsonc")).toBe("11111111-2222-3333-4444-555555555555");
    expect(calls[0]).toMatchObject({ args: ["deploy", "-c", "wrangler.m1.jsonc"], cwd: "/w" });
  });

  it("returns undefined when no version id is printed", async () => {
    const { run } = fakeRun(() => ({ stdout: "ok" }));
    expect(await deployConfig(run, "/w", "c")).toBeUndefined();
  });

  it("repeats a deploy once on code 10007", async () => {
    const { run, calls } = fakeRun((_a, n) => (n === 1 ? { code: 1, stderr: "[code: 10007]" } : { stdout: "Current Version ID: v2" }));
    expect(await deployConfig(run, "/w", "c")).toBe("v2");
    expect(calls).toHaveLength(2);
  });

  it("gives up after the second failure, with the tail of the output", async () => {
    const lines = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join("\n");
    const { run, calls } = fakeRun(() => ({ code: 1, stderr: `${lines}\n[code: 10007]` }));
    const err = await deployConfig(run, "/w", "c").catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain("line 30");
    expect((err as Error).message).not.toContain("line 5\n");
    expect(calls).toHaveLength(2);
  });

  it("does not repeat a failure that is not 10007", async () => {
    const { run, calls } = fakeRun(() => ({ code: 1, stderr: "syntax error" }));
    await expect(deployConfig(run, "/w", "c")).rejects.toThrow(/syntax error/);
    expect(calls).toHaveLength(1);
  });
});
