import { fileURLToPath } from "node:url";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ManifestError, loadTemplates, parseManifest, readTemplate, resolveCopies } from "../src/manifest.ts";

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));

function example(name: string, vars: Record<string, string>): string {
  return JSON.stringify({ name, vars, kv_namespaces: [{ binding: "OAUTH_KV", id: "<id>" }] });
}

function pkg(secrets: string[]): string {
  return JSON.stringify({ broker: { secrets } });
}

const templates = [
  readTemplate(
    "alpha",
    "/repo/brokers/alpha",
    example("alpha-broker", { PUBLIC_URL: "https://x", ALPHA_ID: "<id>", ALPHA_OPT: "" }),
    pkg(["ALPHA_TOKEN"]),
  ),
  readTemplate("beta", "/repo/brokers/beta", example("beta-broker", { PUBLIC_URL: "https://x", BETA_ID: "<id>" }), pkg(["BETA_KEY"])),
];

function problemsOf(fn: () => unknown): string[] {
  try {
    fn();
  } catch (e) {
    if (e instanceof ManifestError) return e.problems;
    throw e;
  }
  throw new Error("expected a ManifestError");
}

const paths = (problems: string[]) => problems.map((p) => p.split(": ")[0]).sort();

describe("resolveCopies", () => {
  it("resolves defaults from the hostname pattern", () => {
    const m = parseManifest(`{ "hostname": "{mailbox}-{broker}.w.example.com", // comment
      "mailboxes": { "m1": { "brokers": { "alpha": { "vars": { "ALPHA_ID": "7" } } } } } }`);
    expect(resolveCopies(m, templates)).toEqual([
      {
        mailbox: "m1",
        broker: "alpha",
        dir: "/repo/brokers/alpha",
        service: "alpha-broker",
        worker: "alpha-broker-m1",
        url: "https://m1-alpha.w.example.com",
        host: "m1-alpha.w.example.com",
        customDomain: true,
        kvId: undefined,
        kvTitle: "alpha-broker-m1-oauth",
        binding: "ALPHA_M1",
        vars: { PUBLIC_URL: "https://m1-alpha.w.example.com", ALPHA_ID: "7", ALPHA_OPT: "" },
        secrets: ["ALPHA_TOKEN"],
        configPath: "/repo/brokers/alpha/wrangler.m1.jsonc",
      },
    ]);
  });

  it("keeps what a mailbox pins", () => {
    const m = parseManifest(`{ "mailboxes": { "m2": { "brokers": { "alpha": {
      "worker": "custom-w", "url": "https://custom.example.workers.dev", "kv": "kv-1", "binding": "MYBIND",
      "vars": { "ALPHA_ID": "7", "ALPHA_OPT": "on" } } } } } }`);
    expect(resolveCopies(m, templates)[0]).toMatchObject({
      worker: "custom-w",
      url: "https://custom.example.workers.dev",
      host: "custom.example.workers.dev",
      customDomain: false,
      kvId: "kv-1",
      kvTitle: "custom-w-oauth",
      binding: "MYBIND",
      vars: { PUBLIC_URL: "https://custom.example.workers.dev", ALPHA_ID: "7", ALPHA_OPT: "on" },
    });
  });

  it("turns a dash in a mailbox name into an underscore in the binding", () => {
    const m = parseManifest(`{ "hostname": "{mailbox}-{broker}.example.com",
      "mailboxes": { "my-bot": { "brokers": { "alpha": { "vars": { "ALPHA_ID": "7" } } } } } }`);
    expect(resolveCopies(m, templates)[0].binding).toBe("ALPHA_MY_BOT");
  });

  it("lists mailboxes in manifest order, then brokers in manifest order", () => {
    const m = parseManifest(`{ "hostname": "{mailbox}-{broker}.example.com", "mailboxes": {
      "zed": { "brokers": { "beta": { "vars": { "BETA_ID": "1" } }, "alpha": { "vars": { "ALPHA_ID": "1" } } } },
      "abe": { "brokers": { "alpha": { "vars": { "ALPHA_ID": "1" } } } } } }`);
    expect(resolveCopies(m, templates).map((c) => `${c.mailbox}/${c.broker}`)).toEqual(["zed/beta", "zed/alpha", "abe/alpha"]);
  });

  it("rejects a misspelt variable, a set PUBLIC_URL and a missing required variable", () => {
    const m = parseManifest(`{ "hostname": "{mailbox}-{broker}.example.com", "mailboxes": { "m1": { "brokers": {
      "alpha": { "vars": { "ALPHA_IDD": "7", "PUBLIC_URL": "https://x.example.com" } } } } } }`);
    const problems = problemsOf(() => resolveCopies(m, templates));
    expect(problems).toHaveLength(3);
    expect(problems[0]).toMatch(/^mailboxes\.m1\.brokers\.alpha\.vars\.ALPHA_IDD: /);
    expect(problems[1]).toMatch(/^mailboxes\.m1\.brokers\.alpha\.vars\.PUBLIC_URL: /);
    expect(problems[2]).toMatch(/^mailboxes\.m1\.brokers\.alpha\.vars\.ALPHA_ID: /);
  });

  it("rejects an unknown broker", () => {
    const m = parseManifest(`{ "hostname": "{mailbox}-{broker}.example.com",
      "mailboxes": { "m1": { "brokers": { "gamma": {} } } } }`);
    const problems = problemsOf(() => resolveCopies(m, templates));
    expect(problems).toEqual([`mailboxes.m1.brokers.gamma: unknown broker "gamma" (no brokers/gamma/wrangler.example.jsonc)`]);
  });

  it("rejects two copies sharing a worker, a url or a binding", () => {
    const entry = `{ "worker": "w", "url": "https://u.example.com", "binding": "B", "vars": { "ALPHA_ID": "1" } }`;
    const m = parseManifest(`{ "mailboxes": { "a": { "brokers": { "alpha": ${entry} } }, "b": { "brokers": { "alpha": ${entry} } } } }`);
    const problems = problemsOf(() => resolveCopies(m, templates));
    expect(problems).toHaveLength(3);
    expect(paths(problems)).toEqual(["mailboxes.b.brokers.alpha.binding", "mailboxes.b.brokers.alpha.url", "mailboxes.b.brokers.alpha.worker"]);
    for (const p of problems) {
      expect(p).toContain("mailboxes.a.brokers.alpha");
      expect(p).toContain("mailboxes.b.brokers.alpha");
    }
  });

  it("rejects two copies pinning the same KV namespace", () => {
    const m = parseManifest(`{ "hostname": "{mailbox}-{broker}.example.com", "mailboxes": {
      "a": { "brokers": { "alpha": { "kv": "K", "vars": { "ALPHA_ID": "1" } } } },
      "b": { "brokers": { "alpha": { "kv": "K", "vars": { "ALPHA_ID": "1" } } } } } }`);
    const problems = problemsOf(() => resolveCopies(m, templates));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/^mailboxes\.b\.brokers\.alpha\.kv: /);
    expect(problems[0]).toContain("mailboxes.a.brokers.alpha");
  });

  it("checks a copy's variables even when its url cannot be resolved", () => {
    const m = parseManifest(`{ "mailboxes": { "m1": { "brokers": { "alpha": { "vars": { "ALPHA_IDD": "7" } } } } } }`);
    const problems = problemsOf(() => resolveCopies(m, templates));
    expect(paths(problems)).toEqual([
      "mailboxes.m1.brokers.alpha.url",
      "mailboxes.m1.brokers.alpha.vars.ALPHA_ID",
      "mailboxes.m1.brokers.alpha.vars.ALPHA_IDD",
    ]);
  });

  it("rejects a hostname pattern or url with a trailing dot", () => {
    const dotted = parseManifest(`{ "hostname": "{mailbox}-{broker}.example.com.", "mailboxes": { "m1": { "brokers": { "alpha": { "vars": { "ALPHA_ID": "1" } } } } } }`);
    expect(problemsOf(() => resolveCopies(dotted, templates))[0]).toMatch(/^mailboxes\.m1\.brokers\.alpha\.url: .*no port, path or trailing dot/);
  });

  it("needs a hostname when a broker gives no url", () => {
    const m = parseManifest(`{ "mailboxes": { "m1": { "brokers": { "alpha": { "vars": { "ALPHA_ID": "1" } } } } } }`);
    const problems = problemsOf(() => resolveCopies(m, templates));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/^mailboxes\.m1\.brokers\.alpha\.url: .*hostname/);
  });
});

describe("parseManifest origins", () => {
  it("rejects an url with a port or a trailing dot", () => {
    for (const bad of ["https://h.example.com:8443", "https://h.example.com."]) {
      const problems = problemsOf(() => parseManifest(`{ "mailboxes": { "m1": { "brokers": { "alpha": { "url": "${bad}" } } } } }`));
      expect(problems[0]).toMatch(/^mailboxes\.m1\.brokers\.alpha\.url: .*must be https:\/\/<host> with no port, path or trailing dot/);
    }
    const mr = problemsOf(() => parseManifest(`{ "mailroom": { "dir": "d", "url": "https://m.example.com:1" }, "mailboxes": { "m1": { "brokers": { "alpha": {} } } } }`));
    expect(mr[0]).toMatch(/^mailroom\.url: .*no port, path or trailing dot/);
  });
});

describe("parseManifest duplicate keys", () => {
  it("reports a mailbox given twice", () => {
    const problems = problemsOf(() =>
      parseManifest(`{ "mailboxes": { "a": { "brokers": { "alpha": {} } }, "a": { "brokers": { "beta": {} } } } }`),
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/^mailboxes: duplicate key "a"/);
  });

  it("reports a variable given twice, at any depth", () => {
    const problems = problemsOf(() =>
      parseManifest(`{ "mailboxes": { "a": { "brokers": { "alpha": { "vars": { "X": "1", "X": "2" } } } } } }`),
    );
    expect(problems).toEqual([`mailboxes.a.brokers.alpha.vars: duplicate key "X"`]);
  });

  it("reports a top-level duplicate and a __proto__ key", () => {
    expect(problemsOf(() => parseManifest(`{ "hostname": "a", "hostname": "b", "mailboxes": {} }`))[0]).toMatch(/duplicate key "hostname"/);
    const proto = problemsOf(() => parseManifest(`{ "mailboxes": { "__proto__": { "brokers": { "alpha": {} } } } }`));
    expect(proto).toEqual([`mailboxes: "__proto__" is not allowed`]);
  });
});

describe("parseManifest", () => {
  it("expands $lists references anywhere under mailboxes", () => {
    const m = parseManifest(`{ "lists": { "r": ["o/a", "o/b"] }, "mailboxes": { "m1": {
      "brokers": { "alpha": {} },
      "mail": { "signin": "alpha", "sources": [ { "type": "t", "broker": "alpha", "repos": "$lists.r" } ] } } } }`);
    expect(m.mailboxes.m1.mail?.sources[0].repos).toEqual(["o/a", "o/b"]);
  });

  it("reports every problem at once, each with its path", () => {
    const problems = problemsOf(() =>
      parseManifest(`{
        "bogus": 1,
        "lists": { "r": ["a"] },
        "mailboxes": {
          "Bad_Name": { "brokers": { "alpha": {} } },
          "example": { "brokers": { "alpha": {} } },
          "m1": {
            "brokers": { "alpha": { "url": "https://x.example.com/", "binding": "lower" } },
            "mail": {
              "signin": "beta",
              "sources": [
                { "type": "t", "broker": "alpha", "repos": "$lists.nope" },
                { "type": "t", "broker": "gamma" }
              ]
            }
          }
        }
      }`),
    );
    expect(paths(problems)).toEqual(
      [
        "bogus",
        "mailboxes.Bad_Name",
        "mailboxes.example",
        "mailboxes.m1.brokers.alpha.url",
        "mailboxes.m1.brokers.alpha.binding",
        "mailboxes.m1.mail.sources[0].repos",
        "mailboxes.m1.mail.signin",
        "mailboxes.m1.mail.sources[1].broker",
      ].sort(),
    );
    expect(problems).toHaveLength(8);
  });

  it("rejects a hostname without both placeholders and a malformed mailroom", () => {
    const problems = problemsOf(() =>
      parseManifest(`{ "hostname": "{mailbox}.example.com",
        "mailroom": { "dir": "", "url": "http://m.example.com", "retain_days": -1 },
        "mailboxes": { "m1": { "brokers": { "alpha": {} } } } }`),
    );
    expect(paths(problems)).toEqual(["hostname", "mailroom.dir", "mailroom.retain_days", "mailroom.url"]);
  });

  it("names the line of a syntax error", () => {
    const problems = problemsOf(() => parseManifest(`{\n  "mailboxes": {\n    "m1": ,\n  }\n}`));
    expect(problems[0]).toMatch(/^line 3: /);
  });
});

describe("templates", () => {
  it("reads a broker's secret names from its package.json", () => {
    const t = readTemplate("alpha", "/d", example("n", { PUBLIC_URL: "" }), pkg(["A", "B"]));
    expect(t.secrets).toEqual(["A", "B"]);
    expect(readTemplate("alpha", "/d", example("n", { PUBLIC_URL: "" }), pkg([])).secrets).toEqual([]);
  });

  it("readTemplate names what a broker lacks", () => {
    const ok = example("n", { PUBLIC_URL: "" });
    for (const bad of ["{}", JSON.stringify({ broker: {} }), JSON.stringify({ broker: { secrets: "A" } }), JSON.stringify({ broker: { secrets: [1] } })]) {
      expect(() => readTemplate("alpha", "/d", ok, bad)).toThrow(/brokers\/alpha\/package\.json.*broker\.secrets/);
    }
    const twoKv = JSON.stringify({
      name: "n",
      vars: { PUBLIC_URL: "" },
      kv_namespaces: [{ binding: "K", id: "i" }, { binding: "L", id: "j" }],
    });
    expect(() => readTemplate("alpha", "/d", twoKv, pkg([]))).toThrow(/alpha.*kv_namespaces/);
    const noPublicUrl = JSON.stringify({ name: "n", vars: {}, kv_namespaces: [{ binding: "K", id: "i" }] });
    expect(() => readTemplate("alpha", "/d", noPublicUrl, pkg([]))).toThrow(/PUBLIC_URL/);
  });

  it("refuses an example that declares secrets to wrangler", () => {
    const withSecrets = JSON.stringify({ name: "n", vars: { PUBLIC_URL: "" }, secrets: { required: [] }, kv_namespaces: [{ binding: "K", id: "i" }] });
    expect(() => readTemplate("alpha", "/d", withSecrets, pkg([]))).toThrow(/must not have "secrets"/);
  });

  it("loadTemplates names the missing package.json of a broker directory", () => {
    const root = mkdtempSync(join(tmpdir(), "mailbox-templates-"));
    try {
      mkdirSync(join(root, "brokers", "solo"), { recursive: true });
      writeFileSync(join(root, "brokers", "solo", "wrangler.example.jsonc"), example("solo", { PUBLIC_URL: "" }));
      expect(() => loadTemplates(root)).toThrow(/brokers\/solo\/package\.json/);
      expect(() => loadTemplates(root)).not.toThrow(/ENOENT/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("loadTemplates reads this repository's brokers", () => {
    const t = loadTemplates(repoRoot);
    expect(t.map((x) => x.broker)).toEqual(["discord", "github"]);
    expect(t[0].secrets).toEqual(["DISCORD_BOT_TOKEN", "DISCORD_CLIENT_SECRET"]);
    expect(t[1].secrets).toEqual(["GITHUB_APP_PRIVATE_KEY", "GITHUB_APP_CLIENT_SECRET"]);
    expect(Object.keys(t[0].vars)[0]).toBe("PUBLIC_URL");
  });

  it("the committed example manifest resolves against the real brokers", () => {
    const m = parseManifest(readFileSync(`${repoRoot}/mailboxes.example.jsonc`, "utf8"));
    expect(resolveCopies(m, loadTemplates(repoRoot))).toHaveLength(4);
  });
});
