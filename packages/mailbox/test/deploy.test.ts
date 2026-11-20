import { describe, expect, it } from "vitest";
import {
  deployCopies, deployMailroom, nextSteps, planMailroom, probe, publiclyResolves, renderAll, status, succeeded, verify, type Deps,
} from "../src/deploy.ts";
import { parseManifest, readTemplate, resolveCopies, type Copy } from "../src/manifest.ts";
import { renderBroker, serialize } from "../src/render.ts";
import type { Run } from "../src/wrangler.ts";

function example(name: string, vars: Record<string, string>): string {
  return JSON.stringify({
    name,
    main: "src/index.ts",
    vars,
    kv_namespaces: [{ binding: "OAUTH_KV", id: "<id>" }],
  });
}
const alpha = readTemplate("alpha", "/repo/brokers/alpha", example("alpha-broker", { PUBLIC_URL: "https://x" }), JSON.stringify({ broker: { secrets: ["ALPHA_TOKEN"] } }));
const beta = readTemplate("beta", "/repo/brokers/beta", example("beta-broker", { PUBLIC_URL: "https://x" }), JSON.stringify({ broker: { secrets: ["BETA_KEY"] } }));
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
      if (!secrets) return { code: 1, stdout: "", stderr: `Worker "${args[3]}" not found.` };
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
      const host = hostOf.get(worker);
      if (host) live.add(host);
      return ok(`Current Version ID: id-${worker}\n`);
    }
    throw new Error(`unexpected wrangler call ${args.join(" ")}`);
  };
  const copyWorkers = new Map<string, string>();
  const hostOf = new Map<string, string>();
  const live = new Set<string>();
  return { run, calls, kv, workers, copyWorkers, hostOf, live };
}

const DOH = "https://cloudflare-dns.com/dns-query";

function fetching(opts: {
  version?: string;
  issuerOf?: (url: string) => string;
  failFirst?: number;
  services?: Record<string, string>;
  /** Hosts that resolve publicly; every host does when absent. */
  live?: Set<string>;
  /** Overrides `live`: answers the n-th (from 0) public DNS question. */
  dns?: (host: string, n: number) => boolean;
} = {}) {
  const urls: string[] = [];
  let failures = opts.failFirst ?? 0;
  let questions = 0;
  const impl: typeof fetch = async (input) => {
    const url = String(input);
    urls.push(url);
    if (url.startsWith(DOH)) {
      const host = new URL(url).searchParams.get("name") ?? "";
      const answered = opts.dns ? opts.dns(host, questions++) : opts.live ? opts.live.has(host) : true;
      return new Response(JSON.stringify(answered ? { Status: 0, Answer: [{ name: host, type: 1, data: "192.0.2.1" }] } : { Status: 0 }), { status: 200 });
    }
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
  return { fetch: impl, urls, probes: () => urls.filter((u) => !u.startsWith(DOH)) };
}

function depsFor(w: ReturnType<typeof world>, extra: Partial<Deps> = {}) {
  const files = new Map<string, string>();
  const logs: string[] = [];
  const sleeps: number[] = [];
  const deps: Deps = {
    run: w.run,
    fetch: fetching({ live: w.live }).fetch,
    log: (l) => logs.push(l),
    sleep: async (ms) => void sleeps.push(ms),
    read: (p) => {
      const t = files.get(p);
      if (t === undefined) throw new Error(`no such file ${p}`);
      return t;
    },
    write: (p, t) => void files.set(p, t),
    exists: (p) => files.has(p),
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
  for (const c of copies) {
    w.copyWorkers.set(c.mailbox, c.worker);
    w.hostOf.set(c.mailbox, c.host);
    if (w.workers.has(c.worker)) w.live.add(c.host);
  }
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

describe("verify a new hostname", () => {
  it("does not touch the host until public DNS answers, counting each wait as an attempt", async () => {
    const { copies, w } = setup(ONE);
    const f = fetching({ dns: (_host, n) => n >= 3 });
    const { deps, sleeps, logs } = depsFor(w, { fetch: f.fetch });
    expect(await verify(copies[0], deps, 10)).toEqual({ version: "1.2.3", verified: true });
    expect(sleeps).toEqual([5000, 5000, 5000]);
    expect(f.urls.slice(0, 4).every((u) => u.startsWith(DOH))).toBe(true);
    expect(f.probes()).toEqual(["https://m1-alpha.w.example.com/", "https://m1-alpha.w.example.com/.well-known/oauth-authorization-server"]);
    expect(f.urls.filter((u) => u.startsWith(DOH))).toHaveLength(4); // not asked again once it has answered
    expect(logs).toEqual(["waiting for m1-alpha.w.example.com: a new hostname needs a few minutes for DNS and its certificate"]);
  });

  it("gives up after the attempts when DNS never answers, without a single probe", async () => {
    const { copies, w } = setup(ONE);
    const f = fetching({ dns: () => false });
    const { deps, sleeps } = depsFor(w, { fetch: f.fetch });
    expect((await verify(copies[0], deps, 5)).verified).toBe(false);
    expect(sleeps).toHaveLength(4);
    expect(f.probes()).toEqual([]);
  });

  it("never asks public DNS for a workers.dev copy", async () => {
    const { copies, w } = setup(`{ "mailboxes": { "m1": { "brokers": { "alpha": { "url": "https://a.example.workers.dev" } } } } }`);
    const f = fetching();
    const { deps, logs } = depsFor(w, { fetch: f.fetch });
    expect((await verify(copies[0], deps, 3)).verified).toBe(true);
    expect(f.urls.some((u) => u.startsWith(DOH))).toBe(false);
    expect(logs).toEqual([]);
  });
});

describe("deployCopies", () => {
  it("deploys a new mailbox: creates the KV namespace, writes the config, deploys, verifies", async () => {
    const { copies, w } = setup(ONE);
    const { deps, files } = depsFor(w);
    const [report] = await deployCopies(copies, copies, templates, deps);
    expect(w.calls.map((c) => c.args)).toEqual([
      ["kv", "namespace", "list"],
      ["secret", "list", "--name", "alpha-broker-m1"],
      ["kv", "namespace", "create", "alpha-broker-m1-oauth", "--update-config=false"],
      ["kv", "namespace", "list"],
      ["deploy", "-c", copies[0].configPath],
      ["secret", "list", "--name", "alpha-broker-m1"],
    ]);
    expect(w.calls.map((c) => c.cwd)).toEqual(["/repo", "/repo", "/repo", "/repo", copies[0].dir, "/repo"]);
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
    const [report] = await deployCopies(copies, copies, templates, deps);
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
    await deployCopies(copies, copies, templates, deps);
    expect(files.get(copies[0].configPath)).toContain("pinned1");
    // the id is known, but a custom domain still needs the Worker's existence checked: one listing before, one after
    expect(w.calls.filter((c) => c.args[0] === "secret")).toHaveLength(2);
    expect(w.calls.filter((c) => c.args.join(" ") === "kv namespace list")).toHaveLength(1);
    expect(w.calls.some((c) => c.args.includes("create"))).toBe(false);
  });

  it("uses an existing namespace found by title, even for a Worker that exists", async () => {
    const { copies, w } = setup(ONE, { kv: { "alpha-broker-m1-oauth": "found9" }, workers: { "alpha-broker-m1": ["ALPHA_TOKEN"] } });
    const { deps, files } = depsFor(w);
    const [report] = await deployCopies(copies, copies, templates, deps);
    expect(files.get(copies[0].configPath)).toContain("found9");
    expect(report.missingSecrets).toEqual([]);
    expect(succeeded([report])).toBe(true);
  });

  it("continues with the next copy when one fails to deploy", async () => {
    const { copies, w } = setup(TWO, { deployFails: ["m1"] });
    const { deps } = depsFor(w);
    const [first, second] = await deployCopies(copies, copies, templates, deps);
    expect(w.calls.filter((c) => c.args[0] === "deploy" && c.args[2].includes("wrangler.m1.jsonc"))).toHaveLength(2);
    expect(first.error).toMatch(/deploy/);
    expect(first.verified).toBe(false);
    expect(second.error).toBeUndefined();
    expect(second.verified).toBe(true);
  });

  it("lists missing secrets with the command to set each when there is no terminal", async () => {
    const { copies, w } = setup(ONE);
    const { deps, logs } = depsFor(w, { interactive: false });
    const [report] = await deployCopies(copies, copies, templates, deps);
    expect(w.calls.some((c) => c.interactive)).toBe(false);
    expect(logs).toContain("npx wrangler secret put ALPHA_TOKEN --name alpha-broker-m1");
    expect(report.missingSecrets).toEqual(["ALPHA_TOKEN"]);
    expect(succeeded([report])).toBe(false);
  });

  it("hands missing secrets to wrangler at a terminal and lists again", async () => {
    const { copies, w } = setup(ONE);
    const { deps } = depsFor(w, { interactive: true });
    const [report] = await deployCopies(copies, copies, templates, deps);
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
    const [report] = await deployCopies(copies, copies, templates, deps);
    expect(report.verified).toBe(true);
    expect(sleeps).toEqual([5000]);
  });

  it("reports a copy that never answers as deployed but unverified, trying 120 times for a new hostname", async () => {
    const { copies, w } = setup(ONE, { workers: { "alpha-broker-m1": ["ALPHA_TOKEN"] }, kv: { "alpha-broker-m1-oauth": "k" } });
    const f = fetching({ failFirst: 10_000 });
    const { deps, sleeps } = depsFor(w, { fetch: f.fetch });
    const [report] = await deployCopies(copies, copies, templates, deps);
    expect(report.versionId).toBe("id-m1");
    expect(report.verified).toBe(false);
    expect(succeeded([report])).toBe(false);
    expect(sleeps).toHaveLength(119);
    expect(sleeps.every((ms) => ms === 5000)).toBe(true);
    expect(f.probes().filter((u) => u.endsWith("/"))).toHaveLength(120);
  });

  it("tries 24 times for a workers.dev copy and never asks public DNS", async () => {
    const { copies, w } = setup(
      `{ "mailboxes": { "m1": { "brokers": { "alpha": { "url": "https://a.example.workers.dev" } } } } }`,
      { workers: { "alpha-broker-m1": ["ALPHA_TOKEN"] }, kv: { "alpha-broker-m1-oauth": "k" } },
    );
    const f = fetching({ failFirst: 10_000 });
    const { deps, sleeps } = depsFor(w, { fetch: f.fetch });
    const [report] = await deployCopies(copies, copies, templates, deps);
    expect(report.verified).toBe(false);
    expect(sleeps).toHaveLength(23);
    expect(f.urls.filter((u) => u.endsWith("/"))).toHaveLength(24);
    expect(f.urls.some((u) => u.startsWith(DOH))).toBe(false);
  });

  it("runs kv and secret commands from the repository root and only the deploy from the broker directory", async () => {
    const { copies, w } = setup(ONE);
    const { deps } = depsFor(w, { interactive: true });
    await deployCopies(copies, copies, templates, deps);
    for (const c of w.calls) expect(c.cwd).toBe(c.args[0] === "deploy" ? copies[0].dir : "/repo");
    expect(w.calls.some((c) => c.args[0] === "secret" && c.args[1] === "put")).toBe(true);
  });

  it("keeps the missing secrets in the report when a secret put fails", async () => {
    const { copies, w } = setup(ONE);
    const inner = w.run;
    w.run = async (args, o) => (args[0] === "secret" && args[1] === "put" ? { code: 1, stdout: "", stderr: "" } : inner(args, o));
    const { deps } = depsFor(w, { interactive: true });
    const [report] = await deployCopies(copies, copies, templates, deps);
    expect(report.error).toMatch(/secret put ALPHA_TOKEN/);
    expect(report.missingSecrets).toEqual(["ALPHA_TOKEN"]);
  });

  it("refuses a KV namespace that another copy already uses, and deploys nothing for it", async () => {
    const text = `{ ${HOST}, "mailboxes": {
      "m1": { "brokers": { "alpha": { "kv": "K" } } },
      "m2": { "brokers": { "alpha": {} } } } }`;
    const { copies, w } = setup(text, { kv: { "alpha-broker-m2-oauth": "K" }, workers: { "alpha-broker-m1": ["ALPHA_TOKEN"], "alpha-broker-m2": ["ALPHA_TOKEN"] } });
    const { deps, files } = depsFor(w);
    const [first, second] = await deployCopies(copies, copies, templates, deps);
    expect(first.error).toBeUndefined();
    expect(second.error).toBe("KV namespace K is already used by m1/alpha");
    expect(files.has(copies[1].configPath)).toBe(false);
    expect(w.calls.filter((c) => c.args[0] === "deploy")).toHaveLength(1);
    // also when only the later copy was chosen
    const only = await deployCopies([copies[1]], copies, templates, deps);
    expect(only[0].error).toBe("KV namespace K is already used by m1/alpha");
  });

  describe("a hostname that already belongs to something else", () => {
    const taken = (host: string) => host === "m1-alpha.w.example.com";

    it("is refused for a new Worker, before anything is created or deployed", async () => {
      const { copies, w } = setup(ONE);
      const { deps, files } = depsFor(w, { fetch: fetching({ dns: taken }).fetch });
      const [report] = await deployCopies(copies, copies, templates, deps);
      expect(report.error).toBe(
        'm1-alpha.w.example.com already resolves, so it belongs to something else; remove that or give this copy another "url"',
      );
      expect(w.calls.some((c) => c.args[0] === "deploy" || c.args.includes("create"))).toBe(false);
      expect(files.size).toBe(0);
    });

    it("is not an issue when the Worker already exists", async () => {
      const { copies, w } = setup(ONE, { workers: { "alpha-broker-m1": ["ALPHA_TOKEN"] }, kv: { "alpha-broker-m1-oauth": "k" } });
      const { deps } = depsFor(w, { fetch: fetching({ dns: taken }).fetch });
      const [report] = await deployCopies(copies, copies, templates, deps);
      expect(report.error).toBeUndefined();
      expect(report.verified).toBe(true);
    });

    it("is not an issue when the hostname does not resolve yet", async () => {
      const { copies, w } = setup(ONE);
      const { deps } = depsFor(w);
      const [report] = await deployCopies(copies, copies, templates, deps);
      expect(report.error).toBeUndefined();
    });
  });

  describe("changing what a copy is", () => {
    const oldFile = (copy: Copy, patch: (c: Record<string, any>) => void) => {
      const config = renderBroker(copy, alpha, "k1") as Record<string, any>;
      patch(config);
      return serialize(config, "/cfg/mailboxes.jsonc");
    };
    const live = { kv: { "alpha-broker-m1-oauth": "k1" }, workers: { "alpha-broker-m1": ["ALPHA_TOKEN"] } };

    it("refuses a different name, KV namespace or PUBLIC_URL, naming every difference", async () => {
      const { copies, w } = setup(ONE, live);
      const { deps, files } = depsFor(w);
      const old = oldFile(copies[0], (c) => {
        c.name = "other-worker";
        c.kv_namespaces[0].id = "oldkv";
        c.vars.PUBLIC_URL = "https://old.example.com";
      });
      files.set(copies[0].configPath, old);
      const [report] = await deployCopies(copies, copies, templates, deps);
      expect(report.error).toBe(
        "m1/alpha: this would change name from other-worker to alpha-broker-m1, KV namespace from oldkv to k1, " +
          "PUBLIC_URL from https://old.example.com to https://m1-alpha.w.example.com; if that is intended, run again with --allow-change",
      );
      expect(files.get(copies[0].configPath)).toBe(old);
      expect(w.calls.some((c) => c.args[0] === "deploy")).toBe(false);
    });

    it("refuses each of the three on its own", async () => {
      for (const patch of [
        (c: Record<string, any>) => (c.name = "other-worker"),
        (c: Record<string, any>) => (c.kv_namespaces[0].id = "oldkv"),
        (c: Record<string, any>) => (c.vars.PUBLIC_URL = "https://old.example.com"),
      ]) {
        const { copies, w } = setup(ONE, live);
        const { deps, files } = depsFor(w);
        files.set(copies[0].configPath, oldFile(copies[0], patch));
        const [report] = await deployCopies(copies, copies, templates, deps);
        expect(report.error).toMatch(/--allow-change$/);
        expect(w.calls.some((c) => c.args[0] === "deploy")).toBe(false);
      }
    });

    it("treats a file that cannot be parsed as a difference", async () => {
      const { copies, w } = setup(ONE, live);
      const { deps, files } = depsFor(w);
      files.set(copies[0].configPath, "{ not json");
      const [report] = await deployCopies(copies, copies, templates, deps);
      expect(report.error).toMatch(/--allow-change$/);
    });

    it("goes ahead with allowChange", async () => {
      const { copies, w } = setup(ONE, live);
      const { deps, files } = depsFor(w);
      files.set(copies[0].configPath, oldFile(copies[0], (c) => (c.name = "other-worker")));
      const [report] = await deployCopies(copies, copies, templates, deps, { allowChange: true });
      expect(report.error).toBeUndefined();
      expect(files.get(copies[0].configPath)).toContain('"name": "alpha-broker-m1"');
    });

    it("overwrites an unchanged file without complaint", async () => {
      const { copies, w } = setup(ONE, live);
      const { deps, files } = depsFor(w);
      files.set(copies[0].configPath, oldFile(copies[0], () => {}));
      const [report] = await deployCopies(copies, copies, templates, deps);
      expect(report.error).toBeUndefined();
      expect(w.calls.some((c) => c.args[0] === "deploy")).toBe(true);
    });
  });
});

describe("publiclyResolves", () => {
  const answer = (body: unknown, status = 200): typeof fetch => async () => new Response(JSON.stringify(body), { status });

  it("asks cloudflare-dns.com for the A record in the JSON format", async () => {
    const { w } = setup(ONE);
    const seen: { url: string; accept: string | null }[] = [];
    const f: typeof fetch = async (input, init) => {
      seen.push({ url: String(input), accept: new Headers(init?.headers).get("accept") });
      return new Response(JSON.stringify({ Answer: [{ data: "1.2.3.4" }] }), { status: 200 });
    };
    expect(await publiclyResolves("h.example.com", depsFor(w, { fetch: f }).deps)).toBe(true);
    expect(seen).toEqual([{ url: "https://cloudflare-dns.com/dns-query?name=h.example.com&type=A", accept: "application/dns-json" }]);
  });

  it("is false for an empty or missing answer, a non-200 and an error", async () => {
    const { w } = setup(ONE);
    const resolves = (f: typeof fetch) => publiclyResolves("h.example.com", depsFor(w, { fetch: f }).deps);
    expect(await resolves(answer({ Answer: [] }))).toBe(false);
    expect(await resolves(answer({ Status: 3 }))).toBe(false);
    expect(await resolves(answer({ Answer: [{ data: "1.2.3.4" }] }, 500))).toBe(false);
    expect(await resolves(async () => { throw new TypeError("fetch failed"); })).toBe(false);
  });
});

describe("renderAll", () => {
  it("renders without creating or deploying, and says which copies it skipped", async () => {
    const { manifest, copies, w } = setup(TWO, { kv: { "alpha-broker-m1-oauth": "k1" } });
    const { deps, files, logs } = depsFor(w);
    const paths = await renderAll(manifest, copies, copies, templates, deps);
    expect(paths).toEqual([copies[0].configPath]);
    expect([...files.keys()]).toEqual([copies[0].configPath]);
    expect(logs).toEqual([`not rendered: m2/alpha (KV namespace "alpha-broker-m2-oauth" does not exist yet; deploy creates it)`]);
    expect(w.calls.every((c) => c.args.join(" ") === "kv namespace list")).toBe(true);
  });

  it("skips a copy whose KV namespace another copy uses", async () => {
    const text = `{ ${HOST}, "mailboxes": { "m1": { "brokers": { "alpha": { "kv": "K" } } }, "m2": { "brokers": { "alpha": {} } } } }`;
    const { manifest, copies, w } = setup(text, { kv: { "alpha-broker-m2-oauth": "K" } });
    const { deps, files, logs } = depsFor(w);
    const paths = await renderAll(manifest, copies, copies, templates, deps);
    expect(paths).toEqual([copies[0].configPath]);
    expect(files.has(copies[1].configPath)).toBe(false);
    expect(logs).toEqual(["not rendered: m2/alpha (KV namespace K is already used by m1/alpha)"]);
  });

  it("skips a copy whose name, KV namespace or PUBLIC_URL would change, unless allowChange", async () => {
    const { manifest, copies, w } = setup(ONE, { kv: { "alpha-broker-m1-oauth": "k1" } });
    const { deps, files, logs } = depsFor(w);
    const config = renderBroker(copies[0], alpha, "oldkv");
    const old = serialize(config, "/cfg/mailboxes.jsonc");
    files.set(copies[0].configPath, old);
    expect(await renderAll(manifest, copies, copies, templates, deps)).toEqual([]);
    expect(files.get(copies[0].configPath)).toBe(old);
    expect(logs[0]).toBe(
      "not rendered: m1/alpha: this would change KV namespace from oldkv to k1; if that is intended, run again with --allow-change",
    );
    expect(await renderAll(manifest, copies, copies, templates, deps, { allowChange: true })).toEqual([copies[0].configPath]);
    expect(files.get(copies[0].configPath)).toContain('"id": "k1"');
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

  it("is written by render when asked for, and only then", async () => {
    const { manifest, copies, w } = setup(MAILROOM, { kv: { "alpha-broker-m1-oauth": "k1" } });
    const { deps, files } = depsFor(w);
    files.set("/mr/worker/wrangler.example.jsonc", MR_EXAMPLE);
    expect(await renderAll(manifest, copies, copies, templates, deps)).toEqual([copies[0].configPath]);
    const paths = await renderAll(manifest, copies, copies, templates, deps, { mailroom: true });
    expect(paths).toEqual([copies[0].configPath, "/mr/worker/wrangler.jsonc"]);
    expect(w.calls.some((c) => c.args[0] === "deploy")).toBe(false);
  });

  it("keeps a hand-written config as wrangler.jsonc.bak, once", async () => {
    const { manifest, copies, w } = setup(MAILROOM);
    const { deps, files, logs } = depsFor(w);
    files.set("/mr/worker/wrangler.example.jsonc", MR_EXAMPLE);
    files.set("/mr/worker/wrangler.jsonc", `{ "name": "mailroom", "hand": "written" }`);
    await deployMailroom(manifest, copies, deps);
    expect(files.get("/mr/worker/wrangler.jsonc.bak")).toBe(`{ "name": "mailroom", "hand": "written" }`);
    expect(files.get("/mr/worker/wrangler.jsonc")).toContain("Generated by");
    expect(logs).toEqual(["kept the hand-written /mr/worker/wrangler.jsonc as /mr/worker/wrangler.jsonc.bak"]);
    // a generated file is not kept, and an existing backup is not replaced
    await deployMailroom(manifest, copies, deps);
    files.set("/mr/worker/wrangler.jsonc", "// another hand-written one\n{}");
    await deployMailroom(manifest, copies, deps);
    expect(files.get("/mr/worker/wrangler.jsonc.bak")).toBe(`{ "name": "mailroom", "hand": "written" }`);
    expect(logs).toHaveLength(1);
  });

  describe("renaming a binding", () => {
    const existing = `{ "services": [{ "binding": "OLD_NAME", "service": "alpha-broker-m1", "entrypoint": "Feed" }] }`;
    const message =
      "mailroom: this would rename the binding of alpha-broker-m1 from OLD_NAME to ALPHA_M1, and mailroom would lose its read positions; " +
      "if that is intended, run again with --allow-change";

    it("is refused, writing and deploying nothing", async () => {
      const { manifest, copies, w } = setup(MAILROOM);
      const { deps, files } = depsFor(w);
      files.set("/mr/worker/wrangler.example.jsonc", MR_EXAMPLE);
      files.set("/mr/worker/wrangler.jsonc", existing);
      await expect(deployMailroom(manifest, copies, deps)).rejects.toThrow(message);
      expect(files.get("/mr/worker/wrangler.jsonc")).toBe(existing);
      expect(files.has("/mr/worker/wrangler.jsonc.bak")).toBe(false);
      expect(w.calls).toEqual([]);
    });

    it("is refused by render too, before anything is written", async () => {
      const { manifest, copies, w } = setup(MAILROOM, { kv: { "alpha-broker-m1-oauth": "k1" } });
      const { deps, files } = depsFor(w);
      files.set("/mr/worker/wrangler.example.jsonc", MR_EXAMPLE);
      files.set("/mr/worker/wrangler.jsonc", existing);
      await expect(renderAll(manifest, copies, copies, templates, deps, { mailroom: true })).rejects.toThrow(message);
      expect(files.has(copies[0].configPath)).toBe(false);
    });

    it("goes ahead with allowChange", async () => {
      const { manifest, copies, w } = setup(MAILROOM);
      const { deps, files } = depsFor(w);
      files.set("/mr/worker/wrangler.example.jsonc", MR_EXAMPLE);
      files.set("/mr/worker/wrangler.jsonc", existing);
      await deployMailroom(manifest, copies, deps, { allowChange: true });
      expect(files.get("/mr/worker/wrangler.jsonc")).toContain('"binding": "ALPHA_M1"');
      expect(w.calls).toHaveLength(1);
    });

    it("does not mind a service that is new or keeps its binding", async () => {
      const { manifest, copies, w } = setup(MAILROOM);
      const { deps, files } = depsFor(w);
      files.set("/mr/worker/wrangler.example.jsonc", MR_EXAMPLE);
      files.set("/mr/worker/wrangler.jsonc", `{ "services": [{ "binding": "ALPHA_M1", "service": "alpha-broker-m1" }, { "binding": "X", "service": "gone" }] }`);
      await deployMailroom(manifest, copies, deps);
      expect(w.calls).toHaveLength(1);
    });
  });
});

describe("planMailroom", () => {
  it("does everything but write and deploy", () => {
    const { manifest, copies, w } = setup(MAILROOM);
    const { deps, files } = depsFor(w);
    files.set("/mr/worker/wrangler.example.jsonc", MR_EXAMPLE);
    const plan = planMailroom(manifest, copies, deps);
    expect(plan.dir).toBe("/mr/worker");
    expect(plan.path).toBe("/mr/worker/wrangler.jsonc");
    expect(plan.text).toBe(serialize(plan.config, "/cfg/mailboxes.jsonc"));
    expect(plan.config.name).toBe("mailroom");
    expect(files.size).toBe(1);
    expect(w.calls).toEqual([]);
  });

  it("fails for a missing mailroom entry, a missing or unparsable example, and no mailbox with mail", () => {
    const none = setup(ONE);
    expect(() => planMailroom(none.manifest, none.copies, depsFor(none.w).deps)).toThrow('the manifest has no "mailroom" entry');
    const { manifest, copies, w } = setup(MAILROOM);
    const { deps, files } = depsFor(w);
    expect(() => planMailroom(manifest, copies, deps)).toThrow(/wrangler\.example\.jsonc/);
    files.set("/mr/worker/wrangler.example.jsonc", "{ nope");
    expect(() => planMailroom(manifest, copies, deps)).toThrow(/wrangler\.example\.jsonc/);
    files.set("/mr/worker/wrangler.example.jsonc", MR_EXAMPLE);
    const noMail = setup(`{ ${HOST}, "mailroom": { "dir": "../mr/worker" }, "mailboxes": { "m1": { "brokers": { "alpha": {} } } } }`);
    const d = depsFor(noMail.w);
    d.files.set("/mr/worker/wrangler.example.jsonc", MR_EXAMPLE);
    expect(() => planMailroom(noMail.manifest, noMail.copies, d.deps)).toThrow(/"mail"/);
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
