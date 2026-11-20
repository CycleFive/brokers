import { describe, expect, it } from "vitest";
import {
  deployCopies, deployMailroom, nextSteps, probe, renderAll, status, succeeded, verify, type Deps,
} from "../src/deploy.ts";
import { parseManifest, readTemplate, resolveCopies } from "../src/manifest.ts";
import type { Run } from "../src/wrangler.ts";

function example(name: string, vars: Record<string, string>, secrets: string[]): string {
  return JSON.stringify({
    name,
    main: "src/index.ts",
    vars,
    secrets: { required: secrets },
    kv_namespaces: [{ binding: "OAUTH_KV", id: "<id>" }],
  });
}
const alpha = readTemplate("alpha", "/repo/brokers/alpha", example("alpha-broker", { PUBLIC_URL: "https://x" }, ["ALPHA_TOKEN"]));
const beta = readTemplate("beta", "/repo/brokers/beta", example("beta-broker", { PUBLIC_URL: "https://x" }, ["BETA_KEY"]));
const templates = [alpha, beta];

function copiesOf(text: string) {
  const manifest = parseManifest(text);
  return { manifest, copies: resolveCopies(manifest, templates) };
}
const HOST = `"hostname": "{mailbox}-{broker}.w.example.com"`;
const ONE = `{ ${HOST}, "mailboxes": { "m1": { "brokers": { "alpha": {} } } } }`;
const TWO = `{ ${HOST}, "mailboxes": { "m1": { "brokers": { "alpha": {} } }, "m2": { "brokers": { "alpha": {} } } } }`;

interface Call { args: string[]; cwd: string; interactive?: boolean }

/** A fake account: KV namespaces by title, Workers with their secret names. */
function world(opts: { kv?: Record<string, string>; workers?: Record<string, string[]>; deployFails?: string[] } = {}) {
  const kv = new Map(Object.entries(opts.kv ?? {}));
  const workers = new Map(Object.entries(opts.workers ?? {}));
  const calls: Call[] = [];
  const run: Run = async (args, o) => {
    calls.push({ args, ...o });
    const ok = (stdout = "") => ({ code: 0, stdout, stderr: "" });
    const [a, b, c] = args;
    if (a === "kv" && c === "list") return ok(JSON.stringify([...kv].map(([title, id]) => ({ id, title }))));
    if (a === "kv" && c === "create") {
      kv.set(args[3], `kv-${args[3]}`);
      return ok();
    }
    if (a === "secret" && b === "list") {
      const secrets = workers.get(args[3]);
      if (!secrets) return { code: 1, stdout: "", stderr: "This Worker not found [code: 10007]" };
      return ok(JSON.stringify(secrets.map((name) => ({ name, type: "secret_text" }))));
    }
    if (a === "secret" && b === "put") {
      workers.get(args[4])?.push(args[2]); // secret put NAME --name WORKER
      return ok();
    }
    if (a === "deploy") {
      const worker = /wrangler\.(\w+)\.jsonc/.exec(args[2])?.[1] ?? "";
      if (opts.deployFails?.includes(worker)) return { code: 1, stdout: "", stderr: "Worker failed [code: 10007]" };
      const name = [...copyWorkers].find(([m]) => m === worker)?.[1] ?? worker;
      if (!workers.has(name)) workers.set(name, []);
      return ok(`Current Version ID: id-${worker}\n`);
    }
    throw new Error(`unexpected wrangler call ${args.join(" ")}`);
  };
  const copyWorkers = new Map<string, string>();
  return { run, calls, kv, workers, copyWorkers };
}

function fetching(opts: { version?: string; issuerOf?: (url: string) => string; failFirst?: number; services?: Record<string, string> } = {}) {
  const urls: string[] = [];
  let failures = opts.failFirst ?? 0;
  const impl: typeof fetch = async (input) => {
    const url = String(input);
    urls.push(url);
    if (failures > 0) {
      failures--;
      throw new TypeError("fetch failed");
    }
    const origin = new URL(url).origin;
    if (url.endsWith("/.well-known/oauth-authorization-server")) {
      return new Response(JSON.stringify({ issuer: opts.issuerOf ? opts.issuerOf(origin) : origin }), { status: 200 });
    }
    const service = opts.services?.[origin] ?? "alpha-broker";
    return new Response(`${service} ${opts.version ?? "1.2.3"}: ready\n`, { status: 200 });
  };
  return { fetch: impl, urls };
}

function depsFor(w: ReturnType<typeof world>, extra: Partial<Deps> = {}) {
  const files = new Map<string, string>();
  const logs: string[] = [];
  const sleeps: number[] = [];
  const deps: Deps = {
    run: w.run,
    fetch: fetching().fetch,
    log: (l) => logs.push(l),
    sleep: async (ms) => void sleeps.push(ms),
    read: (p) => {
      const t = files.get(p);
      if (t === undefined) throw new Error(`no such file ${p}`);
      return t;
    },
    write: (p, t) => void files.set(p, t),
    interactive: false,
    version: "1.2.3",
    repoRoot: "/repo",
    manifestPath: "/cfg/mailboxes.jsonc",
    ...extra,
  };
  return { deps, files, logs, sleeps };
}

function setup(manifestText: string, opts: Parameters<typeof world>[0] = {}) {
  const { manifest, copies } = copiesOf(manifestText);
  const w = world(opts);
  for (const c of copies) w.copyWorkers.set(c.mailbox, c.worker);
  return { manifest, copies, w };
}

describe("probe and verify", () => {
  it("reads the version from the banner and checks the issuer", async () => {
    const { copies, w } = setup(ONE);
    const { deps } = depsFor(w);
    expect(await probe(copies[0], deps)).toEqual({ version: "1.2.3", issuer: true });
  });

  it("does not verify a banner with another version or a wrong issuer", async () => {
    const { copies, w } = setup(ONE);
    const old = depsFor(w, { fetch: fetching({ version: "1.0.0" }).fetch });
    expect(await verify(copies[0], old.deps, 2)).toEqual({ version: "1.0.0", verified: false });
    const wrong = depsFor(w, { fetch: fetching({ issuerOf: () => "https://elsewhere.example.com" }).fetch });
    expect(await probe(copies[0], wrong.deps)).toEqual({ version: "1.2.3", issuer: false });
    expect((await verify(copies[0], wrong.deps, 2)).verified).toBe(false);
  });

  it("answers with no version for a non-200 or a banner of another service", async () => {
    const { copies, w } = setup(ONE);
    const down = depsFor(w, { fetch: async () => new Response("nope", { status: 502 }) });
    expect(await probe(copies[0], down.deps)).toEqual({ issuer: false });
    const other = depsFor(w, { fetch: fetching({ services: { "https://m1-alpha.w.example.com": "beta-broker" } }).fetch });
    expect((await probe(copies[0], other.deps)).version).toBeUndefined();
  });
});

describe("deployCopies", () => {
  it("deploys a new mailbox: creates the KV namespace, writes the config, deploys, verifies", async () => {
    const { copies, w } = setup(ONE);
    const { deps, files } = depsFor(w);
    const [report] = await deployCopies(copies, templates, deps);
    expect(w.calls.map((c) => c.args)).toEqual([
      ["kv", "namespace", "list"],
      ["secret", "list", "--name", "alpha-broker-m1"],
      ["kv", "namespace", "create", "alpha-broker-m1-oauth"],
      ["kv", "namespace", "list"],
      ["deploy", "-c", copies[0].configPath],
      ["secret", "list", "--name", "alpha-broker-m1"],
    ]);
    expect(w.calls[4].cwd).toBe(copies[0].dir);
    const written = files.get(copies[0].configPath) ?? "";
    expect(written).toContain("kv-alpha-broker-m1-oauth");
    expect(written).toContain("/cfg/mailboxes.jsonc");
    expect(report).toMatchObject({
      mailbox: "m1", broker: "alpha", worker: "alpha-broker-m1", versionId: "id-m1", version: "1.2.3",
      missingSecrets: ["ALPHA_TOKEN"], verified: true,
    });
    expect(report.error).toBeUndefined();
  });

  it("never creates a KV namespace for a Worker that already exists", async () => {
    const { copies, w } = setup(ONE, { workers: { "alpha-broker-m1": ["ALPHA_TOKEN"] } });
    const { deps, files } = depsFor(w);
    const [report] = await deployCopies(copies, templates, deps);
    expect(w.calls.some((c) => c.args.includes("create"))).toBe(false);
    expect(w.calls.some((c) => c.args[0] === "deploy")).toBe(false);
    expect(files.size).toBe(0);
    expect(report.error).toContain('set "kv" for it in the manifest');
    expect(report.error).toContain('"alpha-broker-m1-oauth"');
    expect(succeeded([report])).toBe(false);
  });

  it("uses a pinned KV id without listing by title", async () => {
    const { copies, w } = setup(`{ ${HOST}, "mailboxes": { "m1": { "brokers": { "alpha": { "kv": "pinned1" } } } } }`, {
      workers: { "alpha-broker-m1": [] },
    });
    const { deps, files } = depsFor(w);
    await deployCopies(copies, templates, deps);
    expect(files.get(copies[0].configPath)).toContain("pinned1");
    expect(w.calls.some((c) => c.args[0] === "secret" && c.args[1] === "list")).toBe(true);
    // the id is known, so the only secret listing is the one after the deploy
    expect(w.calls.filter((c) => c.args[0] === "secret")).toHaveLength(1);
    expect(w.calls.some((c) => c.args.includes("create"))).toBe(false);
  });

  it("uses an existing namespace found by title, even for a Worker that exists", async () => {
    const { copies, w } = setup(ONE, { kv: { "alpha-broker-m1-oauth": "found9" }, workers: { "alpha-broker-m1": ["ALPHA_TOKEN"] } });
    const { deps, files } = depsFor(w);
    const [report] = await deployCopies(copies, templates, deps);
    expect(files.get(copies[0].configPath)).toContain("found9");
    expect(report.missingSecrets).toEqual([]);
    expect(succeeded([report])).toBe(true);
  });

  it("continues with the next copy when one fails to deploy", async () => {
    const { copies, w } = setup(TWO, { deployFails: ["m1"] });
    const { deps } = depsFor(w);
    const [first, second] = await deployCopies(copies, templates, deps);
    expect(w.calls.filter((c) => c.args[0] === "deploy" && c.args[2].includes("wrangler.m1.jsonc"))).toHaveLength(2);
    expect(first.error).toMatch(/deploy/);
    expect(first.verified).toBe(false);
    expect(second.error).toBeUndefined();
    expect(second.verified).toBe(true);
  });

  it("lists missing secrets with the command to set each when there is no terminal", async () => {
    const { copies, w } = setup(ONE);
    const { deps, logs } = depsFor(w, { interactive: false });
    const [report] = await deployCopies(copies, templates, deps);
    expect(w.calls.some((c) => c.interactive)).toBe(false);
    expect(logs).toContain("npx wrangler secret put ALPHA_TOKEN --name alpha-broker-m1");
    expect(report.missingSecrets).toEqual(["ALPHA_TOKEN"]);
    expect(succeeded([report])).toBe(false);
  });

  it("hands missing secrets to wrangler at a terminal and lists again", async () => {
    const { copies, w } = setup(ONE);
    const { deps } = depsFor(w, { interactive: true });
    const [report] = await deployCopies(copies, templates, deps);
    const put = w.calls.find((c) => c.args[0] === "secret" && c.args[1] === "put");
    expect(put).toMatchObject({ args: ["secret", "put", "ALPHA_TOKEN", "--name", "alpha-broker-m1"], interactive: true });
    expect(w.calls.filter((c) => c.interactive)).toHaveLength(1);
    expect(report.missingSecrets).toEqual([]);
    expect(succeeded([report])).toBe(true);
  });

  it("keeps verifying until the new hostname answers", async () => {
    const { copies, w } = setup(ONE, { workers: { "alpha-broker-m1": ["ALPHA_TOKEN"] }, kv: { "alpha-broker-m1-oauth": "k" } });
    // two failed fetches: the first probe's banner fails, and so does its issuer request
    const { deps, sleeps } = depsFor(w, { fetch: fetching({ failFirst: 2 }).fetch });
    const [report] = await deployCopies(copies, templates, deps);
    expect(report.verified).toBe(true);
    expect(sleeps).toEqual([5000]);
  });

  it("reports a copy that never answers as deployed but unverified", async () => {
    const { copies, w } = setup(ONE, { workers: { "alpha-broker-m1": ["ALPHA_TOKEN"] }, kv: { "alpha-broker-m1-oauth": "k" } });
    const f = fetching({ failFirst: 10_000 });
    const { deps, sleeps } = depsFor(w, { fetch: f.fetch });
    const [report] = await deployCopies(copies, templates, deps);
    expect(report.versionId).toBe("id-m1");
    expect(report.verified).toBe(false);
    expect(succeeded([report])).toBe(false);
    expect(sleeps).toHaveLength(23);
    expect(sleeps.every((ms) => ms === 5000)).toBe(true);
    expect(f.urls.filter((u) => u.endsWith("/"))).toHaveLength(24);
  });
});

describe("renderAll", () => {
  it("renders without creating or deploying, and says which copies it skipped", async () => {
    const { manifest, copies, w } = setup(TWO, { kv: { "alpha-broker-m1-oauth": "k1" } });
    const { deps, files, logs } = depsFor(w);
    const paths = await renderAll(manifest, copies, templates, deps);
    expect(paths).toEqual([copies[0].configPath]);
    expect([...files.keys()]).toEqual([copies[0].configPath]);
    expect(logs).toEqual([`not rendered: m2/alpha (KV namespace "alpha-broker-m2-oauth" does not exist yet; deploy creates it)`]);
    expect(w.calls.every((c) => c.args.join(" ") === "kv namespace list")).toBe(true);
  });
});

const MAILROOM = `{ ${HOST},
  "mailroom": { "dir": "../mr/worker", "url": "https://mail.w.example.com" },
  "mailboxes": { "m1": { "brokers": { "alpha": {} },
    "mail": { "signin": "alpha", "sources": [{ "type": "feed", "broker": "alpha" }] } } } }`;
const MR_EXAMPLE = `{ // mailroom
  "$schema": "x", "name": "mailroom", "main": "src/index.ts", "vars": {},
}`;

describe("deployMailroom", () => {
  it("writes mailroom's config next to its example and deploys from that directory", async () => {
    const { manifest, copies, w } = setup(MAILROOM);
    const { deps, files } = depsFor(w);
    files.set("/mr/worker/wrangler.example.jsonc", MR_EXAMPLE);
    await deployMailroom(manifest, copies, deps);
    expect(files.has("/mr/worker/wrangler.jsonc")).toBe(true);
    expect(files.get("/mr/worker/wrangler.jsonc")).toContain('"name": "mailroom"');
    expect(w.calls).toEqual([{ args: ["deploy", "-c", "wrangler.jsonc"], cwd: "/mr/worker" }]);
  });

  it("refuses a manifest without a mailroom entry", async () => {
    const { manifest, copies, w } = setup(ONE);
    await expect(deployMailroom(manifest, copies, depsFor(w).deps)).rejects.toThrow('the manifest has no "mailroom" entry');
  });

  it("is written by render too, when the manifest has a mailroom", async () => {
    const { manifest, copies, w } = setup(MAILROOM, { kv: { "alpha-broker-m1-oauth": "k1" } });
    const { deps, files } = depsFor(w);
    files.set("/mr/worker/wrangler.example.jsonc", MR_EXAMPLE);
    const paths = await renderAll(manifest, copies, templates, deps);
    expect(paths).toEqual([copies[0].configPath, "/mr/worker/wrangler.jsonc"]);
    expect(w.calls.some((c) => c.args[0] === "deploy")).toBe(false);
  });
});

describe("status", () => {
  it("reads and writes nothing but the probes and the secret list", async () => {
    const { copies, w } = setup(TWO, { workers: { "alpha-broker-m1": ["ALPHA_TOKEN"] } });
    const f = fetching();
    const { deps, files } = depsFor(w, { fetch: f.fetch });
    const [first, second] = await status(copies, deps);
    expect(files.size).toBe(0);
    expect(w.calls.every((c) => c.args[0] === "secret" && c.args[1] === "list")).toBe(true);
    expect(f.urls).toHaveLength(4);
    expect(first).toMatchObject({ missingSecrets: [], verified: true, version: "1.2.3" });
    expect(second).toMatchObject({ missingSecrets: ["ALPHA_TOKEN"], error: "not deployed" });
    expect(succeeded([first, second])).toBe(false);
  });
});

describe("nextSteps", () => {
  it("lists the addresses and redirects left to enter by hand", () => {
    const { manifest, copies } = copiesOf(MAILROOM);
    expect(nextSteps(manifest, copies)).toEqual([
      "m1/alpha  connect: https://m1-alpha.w.example.com/mcp",
      "m1/alpha  redirect to allow on the upstream application: https://m1-alpha.w.example.com/callback",
      "m1/mail  connect: https://mail.w.example.com/m1/mcp",
      "m1/mail  redirect to allow on the sign-in application: https://mail.w.example.com/callback",
    ]);
  });

  it("leaves out mail lines without a mailroom url", () => {
    const { manifest, copies } = copiesOf(ONE);
    expect(nextSteps(manifest, copies)).toHaveLength(2);
  });
});
