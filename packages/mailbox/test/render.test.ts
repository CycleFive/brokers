import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { loadTemplates, parseManifest, readTemplate, resolveCopies } from "../src/manifest.ts";
import { renderBroker, renderMailroom, serialize } from "../src/render.ts";

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));

function example(name: string, vars: Record<string, string>): string {
  return JSON.stringify({
    name,
    main: "src/index.ts",
    compatibility_date: "2025-01-01",
    observability: { enabled: true },
    vars,
    kv_namespaces: [{ binding: "OAUTH_KV", id: "<id>" }],
  });
}

const alpha = readTemplate("alpha", "/repo/brokers/alpha", example("alpha-broker", { PUBLIC_URL: "https://x", ALPHA_ID: "<id>" }), JSON.stringify({ broker: { secrets: ["ALPHA_TOKEN"] } }));
const beta = readTemplate("beta", "/repo/brokers/beta", example("beta-broker", { PUBLIC_URL: "https://x", BETA_ID: "<id>" }), JSON.stringify({ broker: { secrets: ["BETA_KEY"] } }));
const templates = [alpha, beta];

function copiesOf(text: string) {
  const manifest = parseManifest(text);
  return { manifest, copies: resolveCopies(manifest, templates) };
}

const HOST = `"hostname": "{mailbox}-{broker}.w.example.com"`;

describe("renderBroker", () => {
  it("fills the example with the copy's name, vars and KV id", () => {
    const { copies } = copiesOf(`{ ${HOST}, "mailboxes": { "m1": { "brokers": { "alpha": { "vars": { "ALPHA_ID": "7" } } } } } }`);
    const cfg = renderBroker(copies[0], alpha, "kv123");
    expect(cfg.main).toBe("src/index.ts");
    expect(cfg.compatibility_date).toBe("2025-01-01");
    expect(cfg.observability).toEqual({ enabled: true });
    expect(cfg.name).toBe("alpha-broker-m1");
    expect(cfg.vars).toEqual(copies[0].vars);
    expect(cfg.kv_namespaces).toEqual([{ binding: "OAUTH_KV", id: "kv123" }]);
  });

  it("adds a custom-domain route only for a hostname that is not workers.dev", () => {
    const { copies } = copiesOf(`{ ${HOST}, "mailboxes": {
      "m1": { "brokers": { "alpha": { "vars": { "ALPHA_ID": "7" } } } },
      "m2": { "brokers": { "alpha": { "url": "https://a.example.workers.dev", "vars": { "ALPHA_ID": "7" } } } } } }`);
    const custom = renderBroker(copies[0], alpha, "k");
    expect(custom.routes).toEqual([{ pattern: "m1-alpha.w.example.com", custom_domain: true }]);
    expect(custom.workers_dev).toBe(false);
    expect(custom.preview_urls).toBe(false);
    const plain = renderBroker(copies[1], alpha, "k");
    expect("routes" in plain).toBe(false);
    expect("workers_dev" in plain).toBe(false);
    expect("preview_urls" in plain).toBe(false);
  });

  it("does not mutate the template", () => {
    const { copies } = copiesOf(`{ ${HOST}, "mailboxes": { "m1": { "brokers": { "alpha": { "vars": { "ALPHA_ID": "7" } } } } } }`);
    const before = structuredClone(alpha.config);
    const varsBefore = structuredClone(copies[0].vars);
    const cfg = renderBroker(copies[0], alpha, "kv123");
    (cfg.vars as Record<string, string>).EXTRA = "x";
    expect(alpha.config).toEqual(before);
    expect(copies[0].vars).toEqual(varsBefore);
  });

  it("has exactly the template's variables, in the template's order", () => {
    const { copies } = copiesOf(`{ ${HOST}, "mailboxes": { "m1": { "brokers": { "alpha": { "vars": { "ALPHA_ID": "7" } } } } } }`);
    expect(Object.keys(renderBroker(copies[0], alpha, "k").vars as object)).toEqual(Object.keys(alpha.vars));
  });
});

const MAIL_MANIFEST = `{ ${HOST}, "mailroom": { "dir": "/d", "retain_days": 30 }, "mailboxes": {
  "m1": {
    "brokers": { "alpha": { "binding": "ALPHA", "vars": { "ALPHA_ID": "1" } }, "beta": { "vars": { "BETA_ID": "1" } } },
    "mail": { "signin": "alpha", "sources": [
      { "type": "a", "broker": "alpha", "every_secs": 120, "things": ["1"] },
      { "type": "b", "broker": "beta", "keep": "tagged" } ] } },
  "m2": { "brokers": { "alpha": { "vars": { "ALPHA_ID": "2" } } } } } }`;

const MAILROOM_EXAMPLE = {
  $schema: "x",
  name: "mailroom-core",
  services: [{ binding: "OLD" }],
  vars: { OTHER: "keep", MAILROOM: { retain_days: 1, agents: { old: {} } } },
};

describe("renderMailroom", () => {
  it("builds mailroom's services and agents from the mail entries", () => {
    const { manifest, copies } = copiesOf(MAIL_MANIFEST);
    const out = renderMailroom(manifest, copies, MAILROOM_EXAMPLE);
    expect(out.$schema).toBeUndefined();
    expect(out.name).toBe("mailroom-core");
    expect(out.services).toEqual([
      { binding: "ALPHA", service: "alpha-broker-m1", entrypoint: "Feed" },
      { binding: "BETA_M1", service: "beta-broker-m1", entrypoint: "Feed" },
    ]);
    expect(out.vars).toEqual({
      OTHER: "keep",
      MAILROOM: {
        retain_days: 30,
        agents: {
          m1: {
            signin: "ALPHA",
            sources: [
              { type: "a", broker: "ALPHA", every_secs: 120, things: ["1"] },
              { type: "b", broker: "BETA_M1", keep: "tagged" },
            ],
          },
        },
      },
    });
    expect(Object.keys((out.vars as any).MAILROOM.agents.m1.sources[0])).toEqual(["type", "broker", "every_secs", "things"]);
  });

  it("does not mutate the example", () => {
    const { manifest, copies } = copiesOf(MAIL_MANIFEST);
    const before = structuredClone(MAILROOM_EXAMPLE);
    renderMailroom(manifest, copies, MAILROOM_EXAMPLE);
    expect(MAILROOM_EXAMPLE).toEqual(before);
  });

  it("leaves retain_days out when the manifest does not give it", () => {
    const { manifest, copies } = copiesOf(MAIL_MANIFEST.replace(`"mailroom": { "dir": "/d", "retain_days": 30 }, `, ""));
    const out = renderMailroom(manifest, copies, MAILROOM_EXAMPLE);
    expect((out.vars as any).MAILROOM).not.toHaveProperty("retain_days");
    expect(Object.keys((out.vars as any).MAILROOM)).toEqual(["agents"]);
  });

  it("lists agents in manifest order and services in copy order, once each", () => {
    const text = `{ ${HOST}, "mailboxes": {
      "m2": { "brokers": { "alpha": { "vars": { "ALPHA_ID": "2" } } },
        "mail": { "signin": "alpha", "sources": [{ "type": "a", "broker": "alpha" }] } },
      "m1": { "brokers": { "beta": { "vars": { "BETA_ID": "1" } }, "alpha": { "vars": { "ALPHA_ID": "1" } } },
        "mail": { "signin": "alpha", "sources": [{ "type": "b", "broker": "beta" }, { "type": "a", "broker": "alpha" }] } } } }`;
    const { manifest, copies } = copiesOf(text);
    const out = renderMailroom(manifest, copies, MAILROOM_EXAMPLE);
    expect(Object.keys((out.vars as any).MAILROOM.agents)).toEqual(["m2", "m1"]);
    expect((out.services as any[]).map((s) => s.service)).toEqual(["alpha-broker-m2", "beta-broker-m1", "alpha-broker-m1"]);
  });

  it("refuses to render mailroom when no mailbox has mail", () => {
    const { manifest, copies } = copiesOf(`{ ${HOST}, "mailboxes": { "m2": { "brokers": { "alpha": { "vars": { "ALPHA_ID": "2" } } } } } }`);
    expect(() => renderMailroom(manifest, copies, MAILROOM_EXAMPLE)).toThrow(Error);
  });
});

describe("serialize", () => {
  it("serializes with the header line and a final newline", () => {
    const config = { name: "n", vars: { A: "b" } };
    const text = serialize(config, "mailboxes.jsonc");
    const nl = text.indexOf("\n");
    expect(text.slice(0, nl)).toBe("// Generated by `npm run mailbox` from mailboxes.jsonc. Do not edit: change the manifest and run it again.");
    expect(text.endsWith("}\n")).toBe(true);
    expect(text.slice(nl + 1)).toBe(JSON.stringify(config, null, 2) + "\n");
    expect(JSON.parse(text.slice(nl + 1))).toEqual(config);
  });
});

describe("the example manifest", () => {
  it("renders this repository's example manifest for both real brokers", () => {
    const real = loadTemplates(repoRoot);
    const manifest = parseManifest(readFileSync(`${repoRoot}/mailboxes.example.jsonc`, "utf8"));
    const copies = resolveCopies(manifest, real);
    expect(new Set(copies.map((c) => c.broker))).toEqual(new Set(["discord", "github"]));
    for (const copy of copies) {
      const t = real.find((x) => x.broker === copy.broker)!;
      const cfg = renderBroker(copy, t, "kv-id") as any;
      expect(cfg.main).toBe("src/index.ts");
      expect(cfg.compatibility_flags).toEqual(["global_fetch_strictly_public"]);
      expect("secrets" in cfg).toBe(false);
      expect(cfg.vars.PUBLIC_URL).toBe(copy.url);
      expect(Object.keys(cfg.vars)).toEqual(Object.keys(t.vars));
    }
  });
});
