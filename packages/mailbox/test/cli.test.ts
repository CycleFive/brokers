import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { execute, main, manifestPath, parseArgs, type Args } from "../src/cli.ts";
import type { Deps } from "../src/deploy.ts";
import type { Run } from "../src/wrangler.ts";

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const tempDirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "mailbox-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("parseArgs", () => {
  it("parses a command, names and flags", () => {
    expect(parseArgs(["deploy", "manus", "claude", "--mailroom", "--no-input", "--allow-change", "--manifest", "/x.jsonc"])).toEqual({
      command: "deploy",
      names: ["manus", "claude"],
      manifest: "/x.jsonc",
      mailroom: true,
      input: false,
      allowChange: true,
    });
    expect(parseArgs(["check"])).toEqual({ command: "check", names: [], manifest: undefined, mailroom: false, input: true, allowChange: false });
  });

  it("refuses an unknown command or flag with the usage line", () => {
    for (const argv of [[], ["frobnicate"], ["check", "--nope"], ["check", "--manifest"]]) {
      expect(() => parseArgs(argv)).toThrow(/check \| render \| deploy \| status/);
    }
  });

  it("refuses --mailroom with any command but deploy", () => {
    for (const command of ["check", "render", "status"]) {
      expect(() => parseArgs([command, "--mailroom"])).toThrow(/check \| render \| deploy \| status/);
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
    const file = join(tempDir(), "m.jsonc");
    writeFileSync(file, `{ "mailboxes": { "Bad": { "brokers": { "discord": {} } } } }`);
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await main(["check", "--manifest", file])).toBe(1);
    expect(String(err.mock.calls[0][0])).toMatch(/^mailboxes\.Bad: /);
  });

  it("returns 1 for a manifest that does not exist", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await main(["check", "--manifest", join(tmpdir(), "no-such-manifest.jsonc")])).toBe(1);
  });

  it("returns 2 and the usage line for a bad command line", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await main(["nonsense"])).toBe(2);
    expect(String(err.mock.calls[0][0])).toMatch(/usage: mailbox/);
  });
});

// ---- execute, against a fake account and files held in a Map -------------------------------------------------

const DISCORD_VARS = `"vars": { "DISCORD_CLIENT_ID": "1", "ALLOWED_DISCORD_USERS": "2" }`;
const GITHUB_VARS = `"vars": { "GITHUB_APP_CLIENT_ID": "1", "GITHUB_INSTALLATION_ID": "2", "ALLOWED_GITHUB_USERS": "3" }`;
const MANIFEST = `{ "hostname": "{mailbox}-{broker}.w.example.com",
  "mailroom": { "dir": "../mr", "url": "https://mail.w.example.com" },
  "mailboxes": {
    "one": { "brokers": { "discord": { ${DISCORD_VARS} }, "github": { ${GITHUB_VARS} } },
      "mail": { "signin": "discord", "sources": [{ "type": "discord", "broker": "discord" }, { "type": "github", "broker": "github" }] } },
    "two": { "brokers": { "discord": { ${DISCORD_VARS} } } } } }`;
const MR_EXAMPLE = `{ "name": "mailroom", "main": "src/index.ts", "vars": {} }`;
const SECRETS: Record<string, string[]> = {
  "discord-broker": ["DISCORD_BOT_TOKEN", "DISCORD_CLIENT_SECRET"],
  "github-broker": ["GITHUB_APP_PRIVATE_KEY", "GITHUB_APP_CLIENT_SECRET"],
};
const TITLES = ["discord-broker-one-oauth", "github-broker-one-oauth", "discord-broker-two-oauth"];

interface WorldOptions {
  manifest?: string;
  mailroomExample?: string | null;
  failDeploy?: string[];
  noSecrets?: boolean;
  existingKv?: boolean;
  fetchFails?: boolean;
}

function world(opts: WorldOptions = {}) {
  const files = new Map<string, string>([["/cfg/mailboxes.jsonc", opts.manifest ?? MANIFEST]]);
  if (opts.mailroomExample !== null) files.set("/mr/wrangler.example.jsonc", opts.mailroomExample ?? MR_EXAMPLE);
  const kv = new Map<string, string>(opts.existingKv ? TITLES.map((t) => [t, `id-${t}`]) : []);
  const workers = new Map<string, string[]>();
  const live = new Set<string>();
  const calls: { args: string[]; cwd: string }[] = [];
  const secretsOf = (worker: string) => (opts.noSecrets ? [] : SECRETS[/^\w+-broker/.exec(worker)?.[0] ?? ""] ?? []);

  const run: Run = async (args, o) => {
    calls.push({ args, cwd: o.cwd });
    const ok = (stdout = "") => ({ code: 0, stdout, stderr: "" });
    if (args[0] === "kv" && args[2] === "list") return ok(JSON.stringify([...kv].map(([title, id]) => ({ id, title }))));
    if (args[0] === "kv" && args[2] === "create") {
      kv.set(args[3], `id-${args[3]}`);
      return ok();
    }
    if (args[0] === "secret" && args[1] === "list") {
      const names = workers.get(args[3]);
      if (!names) return { code: 1, stdout: "", stderr: `Worker "${args[3]}" not found.` };
      return ok(JSON.stringify(names.map((name) => ({ name, type: "secret_text" }))));
    }
    if (args[0] === "deploy") {
      if (args[2] === "wrangler.jsonc") return ok("Current Version ID: mailroom-v\n");
      const text = files.get(args[2]) ?? "";
      const config = JSON.parse(text.slice(text.indexOf("\n") + 1)) as { name: string; vars: { PUBLIC_URL: string } };
      if (opts.failDeploy?.includes(config.name)) return { code: 1, stdout: "", stderr: "boom" };
      workers.set(config.name, secretsOf(config.name));
      live.add(new URL(config.vars.PUBLIC_URL).host);
      return ok(`Current Version ID: v-${config.name}\n`);
    }
    throw new Error(`unexpected wrangler call ${args.join(" ")}`);
  };
  const fetchImpl: typeof fetch = async (input) => {
    const url = String(input);
    if (url.startsWith("https://cloudflare-dns.com/")) {
      const host = new URL(url).searchParams.get("name") ?? "";
      return new Response(JSON.stringify(live.has(host) ? { Answer: [{ data: "192.0.2.1" }] } : {}), { status: 200 });
    }
    if (opts.fetchFails) throw new TypeError("fetch failed");
    const origin = new URL(url).origin;
    if (url.endsWith("/.well-known/oauth-authorization-server")) return new Response(JSON.stringify({ issuer: origin }), { status: 200 });
    return new Response(`${url.includes("discord") ? "discord-broker" : "github-broker"} 9.9.9: ready\n`, { status: 200 });
  };
  const out: string[] = [];
  const err: string[] = [];
  const logs: string[] = [];
  const deps: Deps = {
    run,
    fetch: fetchImpl,
    log: (l) => logs.push(l),
    sleep: async () => {},
    read: (p) => {
      const t = files.get(p);
      if (t === undefined) throw new Error(`ENOENT: no such file ${p}`);
      return t;
    },
    write: (p, t) => void files.set(p, t),
    exists: (p) => files.has(p),
    interactive: false,
    version: "9.9.9",
    repoRoot,
    manifestPath: "/cfg/mailboxes.jsonc",
  };
  const wranglerDeploys = () => calls.filter((c) => c.args[0] === "deploy");
  return { files, kv, workers, calls, deps, out, err, logs, wranglerDeploys };
}

function argsOf(argv: string[]): Args {
  return parseArgs(argv);
}

async function exec(w: ReturnType<typeof world>, argv: string[]): Promise<number> {
  return execute(argsOf(argv), w.deps, (l) => w.out.push(l), (l) => w.err.push(l));
}

describe("execute check", () => {
  it("prints one line per copy and reads mailroom's example", async () => {
    const w = world();
    expect(await exec(w, ["check"])).toBe(0);
    expect(w.out).toHaveLength(3);
    expect(w.calls).toEqual([]);
  });

  it("limits itself to the mailboxes named", async () => {
    const w = world();
    expect(await exec(w, ["check", "two"])).toBe(0);
    expect(w.out).toHaveLength(1);
  });

  it("fails when mailroom's directory has no example", async () => {
    const w = world({ mailroomExample: null });
    expect(await exec(w, ["check"])).toBe(1);
    expect(w.err.join("\n")).toContain("wrangler.example.jsonc");
  });

  it("fails when mailroom's example cannot be parsed", async () => {
    const w = world({ mailroomExample: "{ nope" });
    expect(await exec(w, ["check"])).toBe(1);
    expect(w.err.join("\n")).toContain("wrangler.example.jsonc");
  });

  it("fails when mailroom is set and no mailbox has mail", async () => {
    const manifest = `{ "hostname": "{mailbox}-{broker}.w.example.com", "mailroom": { "dir": "../mr" },
      "mailboxes": { "two": { "brokers": { "discord": { ${DISCORD_VARS} } } } } }`;
    const w = world({ manifest });
    expect(await exec(w, ["check"])).toBe(1);
    expect(w.err.join("\n")).toContain('"mail"');
  });

  it("does not need mailroom's example without a mailroom entry", async () => {
    const manifest = `{ "hostname": "{mailbox}-{broker}.w.example.com", "mailboxes": { "two": { "brokers": { "discord": { ${DISCORD_VARS} } } } } }`;
    expect(await exec(world({ manifest, mailroomExample: null }), ["check"])).toBe(0);
  });

  it("names the known mailboxes when a name is not one of them", async () => {
    const w = world();
    expect(await exec(w, ["check", "nope"])).toBe(1);
    expect(w.err.join("\n")).toContain("nope");
    expect(w.err.join("\n")).toContain("one, two");
  });

  it("reports a manifest with problems", async () => {
    const w = world({ manifest: `{ "mailboxes": { "Bad": { "brokers": { "discord": {} } } } }` });
    expect(await exec(w, ["check"])).toBe(1);
    expect(w.err[0]).toMatch(/^mailboxes\.Bad: /);
  });
});

describe("execute usage", () => {
  it("answers 2 with the usage line for --mailroom outside deploy", async () => {
    for (const command of ["render", "status", "check"] as const) {
      const w = world();
      const args: Args = { ...argsOf([command]), mailroom: true };
      expect(await execute(args, w.deps, (l) => w.out.push(l), (l) => w.err.push(l))).toBe(2);
      expect(w.err.join("\n")).toMatch(/usage: mailbox/);
      expect(w.calls).toEqual([]);
    }
  });
});

describe("execute deploy", () => {
  it("deploys every copy, then mailroom with --mailroom, and prints the next steps", async () => {
    const w = world();
    expect(await exec(w, ["deploy", "--mailroom"])).toBe(0);
    const deploys = w.wranglerDeploys();
    expect(deploys).toHaveLength(4);
    expect(deploys[3]).toEqual({ args: ["deploy", "-c", "wrangler.jsonc"], cwd: "/mr" });
    expect(w.files.get("/mr/wrangler.jsonc")).toContain('"MAILROOM"');
    expect(w.out).toContain("mailroom deployed");
    expect(w.out).toContain("one/mail  connect: https://mail.w.example.com/one/mcp");
    expect(w.out).toContain("one/discord  connect: https://one-discord.w.example.com/mcp");
  });

  it("does not print mailroom's lines or deploy it without --mailroom", async () => {
    const w = world();
    expect(await exec(w, ["deploy"])).toBe(0);
    expect(w.wranglerDeploys()).toHaveLength(3);
    expect(w.files.has("/mr/wrangler.jsonc")).toBe(false);
    expect(w.out.some((l) => l.includes("/mail "))).toBe(false);
    expect(w.out.some((l) => l.includes("mailroom deployed"))).toBe(false);
  });

  it("checks mailroom before deploying a single copy", async () => {
    const w = world({ mailroomExample: "{ nope" });
    expect(await exec(w, ["deploy", "--mailroom"])).toBe(1);
    expect(w.calls).toEqual([]);
    expect(w.err.join("\n")).toContain("wrangler.example.jsonc");
  });

  it("refuses --mailroom without a mailroom entry, deploying nothing", async () => {
    const manifest = `{ "hostname": "{mailbox}-{broker}.w.example.com", "mailboxes": { "two": { "brokers": { "discord": { ${DISCORD_VARS} } } } } }`;
    const w = world({ manifest });
    expect(await exec(w, ["deploy", "--mailroom"])).toBe(1);
    expect(w.calls).toEqual([]);
    expect(w.err.join("\n")).toContain('no "mailroom" entry');
  });

  it("refuses a renamed mailroom binding before deploying a single copy", async () => {
    const w = world();
    w.files.set("/mr/wrangler.jsonc", `{ "services": [{ "binding": "OLD", "service": "discord-broker-one" }] }`);
    expect(await exec(w, ["deploy", "--mailroom"])).toBe(1);
    expect(w.calls).toEqual([]);
    expect(w.err.join("\n")).toContain("--allow-change");
  });

  it("does not deploy mailroom when a copy failed, and prints no next steps for it", async () => {
    const w = world({ failDeploy: ["github-broker-one"] });
    expect(await exec(w, ["deploy", "--mailroom"])).toBe(1);
    expect(w.wranglerDeploys().some((c) => c.cwd === "/mr")).toBe(false);
    expect(w.out.some((l) => l.includes("mailroom deployed"))).toBe(false);
    expect(w.out.some((l) => l.startsWith("one/github  connect"))).toBe(false);
    expect(w.out.some((l) => l.startsWith("one/discord  connect"))).toBe(true);
    expect(w.out.some((l) => l.startsWith("one/mail "))).toBe(false);
  });

  it("does not deploy mailroom and exits 1 when a secret is missing", async () => {
    const w = world({ noSecrets: true });
    expect(await exec(w, ["deploy", "--mailroom"])).toBe(1);
    expect(w.wranglerDeploys().some((c) => c.cwd === "/mr")).toBe(false);
    expect(w.out.some((l) => l.includes("missing: DISCORD_BOT_TOKEN"))).toBe(true);
  });

  it("does not deploy mailroom and exits 1 when a copy is unverified", async () => {
    const w = world({ fetchFails: true });
    expect(await exec(w, ["deploy", "--mailroom"])).toBe(1);
    expect(w.wranglerDeploys().some((c) => c.cwd === "/mr")).toBe(false);
    expect(w.out.some((l) => l.includes("UNVERIFIED"))).toBe(true);
  });

  it("exits 1 when a copy has an error, a missing secret or is unverified", async () => {
    expect(await exec(world({ failDeploy: ["discord-broker-two"] }), ["deploy"])).toBe(1);
    expect(await exec(world({ noSecrets: true }), ["deploy"])).toBe(1);
    expect(await exec(world({ fetchFails: true }), ["deploy"])).toBe(1);
  });

  it("hands --allow-change on to the copies and to mailroom", async () => {
    const w = world({ existingKv: true });
    w.files.set("/mr/wrangler.jsonc", `{ "services": [{ "binding": "OLD", "service": "discord-broker-one" }] }`);
    expect(await exec(w, ["deploy", "--mailroom", "--allow-change"])).toBe(0);
    expect(w.files.get("/mr/wrangler.jsonc")).toContain('"binding": "DISCORD_ONE"');
  });
});

describe("execute render", () => {
  it("writes the configs and, with no mailbox named, mailroom's", async () => {
    const w = world({ existingKv: true });
    expect(await exec(w, ["render"])).toBe(0);
    expect(w.out.filter((l) => l.startsWith("wrote "))).toHaveLength(4);
    expect(w.files.has("/mr/wrangler.jsonc")).toBe(true);
    expect(w.calls.every((c) => c.args.join(" ") === "kv namespace list")).toBe(true);
  });

  it("does not write mailroom's config when a mailbox is named", async () => {
    const w = world({ existingKv: true });
    expect(await exec(w, ["render", "one"])).toBe(0);
    expect(w.out.filter((l) => l.startsWith("wrote "))).toHaveLength(2);
    expect(w.files.has("/mr/wrangler.jsonc")).toBe(false);
  });

  it("exits 1 when it skipped a copy", async () => {
    const w = world();
    expect(await exec(w, ["render", "two"])).toBe(1);
    expect(w.logs.join("\n")).toContain("not rendered: two/discord");
    expect(w.out.some((l) => l.startsWith("wrote "))).toBe(false);
  });
});

describe("execute status", () => {
  it("prints a line per copy and exits 1 for a Worker that is not deployed", async () => {
    const w = world();
    expect(await exec(w, ["status"])).toBe(1);
    expect(w.out).toHaveLength(3);
    expect(w.files.size).toBe(2);
  });
});
