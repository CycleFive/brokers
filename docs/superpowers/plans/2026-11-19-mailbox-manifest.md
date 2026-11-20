# Mailbox Manifest Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One manifest describes every mailbox (an agent's copy of each broker plus its mailroom entry), and `npm run mailbox -- <check|render|deploy|status>` generates every wrangler config from it, deploys and verifies.

**Architecture:** A new workspace package `packages/mailbox` in TypeScript, run directly by Node. `manifest.ts` parses and resolves the manifest against each broker's `wrangler.example.jsonc` into a flat list of `Copy` values; `render.ts` turns a `Copy` into a wrangler config and the whole manifest into mailroom's config; `wrangler.ts` wraps the wrangler commands behind an injected `Run`; `deploy.ts` orchestrates; `cli.ts` is the thin entry point. No Worker source changes.

**Tech Stack:** Node ≥ 22.18 (native type stripping), TypeScript 5.9, vitest 3.2, wrangler 4.157, `jsonc-parser` 3.3.1.

**Spec:** `docs/superpowers/specs/2026-11-19-mailbox-manifest-design.md`

## Global Constraints

- Never create, read, print or commit a real `wrangler.jsonc`, `wrangler.<name>.jsonc`, `mailboxes.jsonc`, `.dev.vars` or `*.pem`. Tests use fixtures written inside the test.
- Never run wrangler against the account: no `wrangler deploy`, `secret`, `kv`, `tail`, `whoami`. Everything that drives wrangler is tested through a fake `Run`. `wrangler --help` is fine.
- The tool never reads, prints or stores a secret value; it handles secret names only.
- The tool contains no broker name (`discord`, `github`) and no mailroom source key (`channels`, `repos`) outside tests, fixtures and the example manifest.
- TypeScript in `packages/mailbox` is erasable syntax only (no `enum`, no parameter properties, no `namespace`), and relative imports carry the `.ts` extension, because Node runs the files as they are.
- New dependencies: `jsonc-parser` pinned `3.3.1` and `@types/node` `^22`, both in the root `devDependencies`. Nothing else.
- Exact names: generated broker config `brokers/<broker>/wrangler.<mailbox>.jsonc`; default Worker `<example name>-<mailbox>`; default KV title `<worker>-oauth`; default binding `<BROKER>_<MAILBOX>` upper-cased with `-` as `_`; mailbox names match `/^[a-z0-9-]{1,32}$/` and are not `example`.
- Every problem in a manifest is reported in one `ManifestError`, each line starting with the path of the offending value (`mailboxes.manus.brokers.discord.url: ...`).
- Every commit message ends with exactly this trailer and no other `Co-Authored-By` line: `Co-Authored-By: Claude & Lothrop (cycle.five@proton.me)`
- Write each test first and watch it fail before writing the code; the report quotes the failing run.

## Review Focus

1. A mailbox's `vars` has a misspelt key: an error naming the key, never a silently dropped variable. (Task 1)
2. A Worker that already exists has no KV namespace under its id or title: the tool refuses instead of creating an empty namespace, which would sign everyone out. (Task 3)
3. A first deploy fails with `[code: 10007]`: repeated once; if it fails again that copy is reported failed and the remaining copies still deploy. (Task 3)
4. A new custom domain is not answering yet: verification retries; when it never answers, the copy is reported deployed but unverified and the command exits non-zero. (Task 3)
5. A secret is missing and there is no terminal (or `--no-input`): no prompt, the copy lists the missing names with the command to set each, exit non-zero. (Task 3)

---

### Task 1: Package, manifest parsing and `check`

**Files:**
- Create: `packages/mailbox/package.json`, `packages/mailbox/tsconfig.json`, `packages/mailbox/vitest.config.ts`
- Create: `packages/mailbox/src/manifest.ts`, `packages/mailbox/src/cli.ts`
- Create: `packages/mailbox/test/manifest.test.ts`, `packages/mailbox/test/cli.test.ts`
- Create: `mailboxes.example.jsonc` (repository root)
- Modify: `package.json` (root: script `"mailbox": "node packages/mailbox/src/cli.ts"`, the two dev dependencies), `package-lock.json`, `.gitignore`
- Modify: `brokers/discord/wrangler.example.jsonc`, `brokers/github/wrangler.example.jsonc`

**Interfaces:**
- Produces (all exported from `packages/mailbox/src/manifest.ts`):

```ts
export interface BrokerEntry { worker?: string; url?: string; kv?: string; binding?: string; vars?: Record<string, string> }
export interface MailSource { type: string; broker: string; [key: string]: unknown }
export interface MailEntry { signin: string; sources: MailSource[] }
export interface MailboxEntry { brokers: Record<string, BrokerEntry>; mail?: MailEntry }
export interface MailroomEntry { dir: string; url?: string; retain_days?: number }
export interface Manifest { hostname?: string; mailroom?: MailroomEntry; lists?: Record<string, string[]>; mailboxes: Record<string, MailboxEntry> }

export class ManifestError extends Error { problems: string[] }   // message = problems.join("\n")

/** JSONC text to a checked Manifest with every "$lists.<name>" replaced. Throws ManifestError. */
export function parseManifest(text: string): Manifest;

/** What one broker's wrangler.example.jsonc contributes. */
export interface Template {
  broker: string;                    // directory name under brokers/
  dir: string;                       // absolute path of that directory
  name: string;                      // the example's "name", e.g. "discord-broker"
  vars: Record<string, string>;      // the example's vars, in file order
  secrets: string[];                 // the example's secrets.required
  config: Record<string, unknown>;   // the whole parsed example
}
export function readTemplate(broker: string, dir: string, text: string): Template;   // throws Error naming what is missing
export function loadTemplates(repoRoot: string): Template[];                          // every brokers/*/wrangler.example.jsonc, sorted by broker

/** One broker copy of one mailbox, fully resolved. */
export interface Copy {
  mailbox: string; broker: string; dir: string;
  service: string;        // template.name
  worker: string; url: string; host: string; customDomain: boolean;
  kvId?: string; kvTitle: string; binding: string;
  vars: Record<string, string>;   // every template key in template order, PUBLIC_URL = url
  secrets: string[];
  configPath: string;     // <dir>/wrangler.<mailbox>.jsonc
}
/** Mailboxes in manifest order, brokers in manifest order. Throws ManifestError. */
export function resolveCopies(manifest: Manifest, templates: Template[]): Copy[];
```

- Produces (from `packages/mailbox/src/cli.ts`):

```ts
export interface Args { command: "check" | "render" | "deploy" | "status"; names: string[]; manifest?: string; mailroom: boolean; input: boolean }
export function parseArgs(argv: string[]): Args;   // throws Error with a usage line on an unknown command or flag
export function manifestPath(args: Args, env: Record<string, string | undefined>, repoRoot: string): string;   // --manifest, else env.MAILBOXES, else <repoRoot>/mailboxes.jsonc
export async function main(argv: string[]): Promise<number>;   // exit code; this task implements "check" only
```

Rules `parseManifest` enforces (no filesystem):
- Top level: only `hostname`, `mailroom`, `lists`, `mailboxes`; `mailboxes` is a non-empty object.
- `hostname`, when present, contains both `{mailbox}` and `{broker}`.
- `mailroom`: `dir` is a non-empty string; `retain_days` a non-negative integer; `url` an https origin.
- `lists`: each value an array of strings. A string value under `mailboxes` that is exactly `$lists.<name>` is replaced by that list; an unknown name is a problem.
- Mailbox name: `/^[a-z0-9-]{1,32}$/`, not `example`. Mailbox keys: only `brokers` (non-empty object) and `mail`.
- Broker entry keys: only `worker`, `url`, `kv`, `binding`, `vars`. `url` is an https origin (`new URL(u).origin === u`: no path, no trailing slash). `binding` matches `/^[A-Z][A-Z0-9_]*$/`. `vars` values are strings.
- `mail`: `signin` names a broker of the same mailbox; `sources` is an array whose items have string `type` and a `broker` naming a broker of the same mailbox.

Rules `resolveCopies` adds:
- A broker key with no template: `unknown broker "<x>" (no brokers/<x>/wrangler.example.jsonc)`.
- `url` defaults to `https://` + `hostname` with both placeholders filled; neither given is a problem.
- `customDomain` is true unless `host` ends with `.workers.dev`.
- `vars`: a key that is not in the template is a problem; `PUBLIC_URL` given is a problem; a template key whose example value is not `""` and which the mailbox does not set is a problem (`PUBLIC_URL` excepted).
- `worker`, `url` and `binding` are each unique across all copies; a clash names both copies.

`readTemplate` requires: string `name`; object `vars` containing `PUBLIC_URL`; `secrets.required` an array of strings; `kv_namespaces` with exactly one entry.

- [ ] **Step 1: Scaffold the package**

`packages/mailbox/package.json`: name `mailbox-tool`, version `0.3.0`, `private`, `type: module`, `engines.node: ">=22.18"`, scripts `typecheck: tsc --noEmit` and `test: vitest run`. `tsconfig.json` extends `../../tsconfig.base.json` with `"types": ["node"]`, `"allowImportingTsExtensions": true`, `"erasableSyntaxOnly": true`, including `src/**/*.ts` and `test/**/*.ts`. `vitest.config.ts`: `include: ["test/**/*.test.ts"]`, `environment: "node"` (it does not use `vitest.shared.ts`). Add the root script and dev dependencies, run `npm install`, and add to `.gitignore`: `wrangler.*.jsonc`, `!wrangler.example.jsonc`, `mailboxes.jsonc`.

- [ ] **Step 2: Declare each broker's secrets in its example**

Add after `vars` in `brokers/discord/wrangler.example.jsonc`: `"secrets": { "required": ["DISCORD_BOT_TOKEN", "DISCORD_CLIENT_SECRET"] }`, and in `brokers/github/wrangler.example.jsonc`: `"secrets": { "required": ["GITHUB_APP_PRIVATE_KEY", "GITHUB_APP_CLIENT_SECRET"] }`. Keep the existing comment that says secrets are set with `wrangler secret put`.

- [ ] **Step 3: Write the failing tests** in `packages/mailbox/test/manifest.test.ts`

Use two in-test templates built with `readTemplate`: `alpha` (name `alpha-broker`, vars `PUBLIC_URL: "https://x"`, `ALPHA_ID: "<id>"`, `ALPHA_OPT: ""`, secrets `["ALPHA_TOKEN"]`) and `beta` (name `beta-broker`, vars `PUBLIC_URL`, `BETA_ID: "<id>"`, secrets `["BETA_KEY"]`).

```ts
it("resolves defaults from the hostname pattern", () => {
  const m = parseManifest(`{ "hostname": "{mailbox}-{broker}.w.example.com", // comment
    "mailboxes": { "m1": { "brokers": { "alpha": { "vars": { "ALPHA_ID": "7" } } } } } }`);
  expect(resolveCopies(m, templates)).toEqual([{
    mailbox: "m1", broker: "alpha", dir: "/repo/brokers/alpha", service: "alpha-broker",
    worker: "alpha-broker-m1", url: "https://m1-alpha.w.example.com", host: "m1-alpha.w.example.com", customDomain: true,
    kvId: undefined, kvTitle: "alpha-broker-m1-oauth", binding: "ALPHA_M1",
    vars: { PUBLIC_URL: "https://m1-alpha.w.example.com", ALPHA_ID: "7", ALPHA_OPT: "" },
    secrets: ["ALPHA_TOKEN"], configPath: "/repo/brokers/alpha/wrangler.m1.jsonc",
  }]);
});
it("keeps what a mailbox pins", ...)            // worker, url on *.workers.dev (customDomain false), kv, binding all taken from the entry
it("turns a dash in a mailbox name into an underscore in the binding", ...)   // "my-bot" + alpha -> "ALPHA_MY_BOT"
it("expands $lists references anywhere under mailboxes", ...)   // "repos": "$lists.r" -> the array; inside mail.sources
it("reports every problem at once, each with its path", () => {
  // one manifest with: unknown top-level key, mailbox "Bad_Name", mailbox "example", url with a trailing slash,
  // url with http:, binding "lower", "$lists.nope", mail.signin naming an absent broker, a source naming an absent broker
  // expect error.problems to have one line per defect and each line to start with the path given in Global Constraints
});
it("rejects a misspelt variable, a set PUBLIC_URL and a missing required variable", ...)   // three problems from resolveCopies, the first naming "ALPHA_IDD"
it("rejects an unknown broker", ...)            // message contains: unknown broker "gamma" (no brokers/gamma/wrangler.example.jsonc)
it("rejects two copies sharing a worker, a url or a binding", ...)   // each problem names both mailboxes
it("needs a hostname when a broker gives no url", ...)
it("readTemplate names what an example lacks", ...)   // no secrets.required; two kv_namespaces
it("loadTemplates reads this repository's brokers", () => {
  const t = loadTemplates(repoRoot);   // repoRoot from import.meta.url
  expect(t.map((x) => x.broker)).toEqual(["discord", "github"]);
  expect(t[0].secrets).toEqual(["DISCORD_BOT_TOKEN", "DISCORD_CLIENT_SECRET"]);
  expect(t[1].secrets).toEqual(["GITHUB_APP_PRIVATE_KEY", "GITHUB_APP_CLIENT_SECRET"]);
});
it("the committed example manifest resolves against the real brokers", ...)   // parse mailboxes.example.jsonc, resolveCopies does not throw, 4 copies
```

and in `packages/mailbox/test/cli.test.ts`:

```ts
it("parses a command, names and flags", () => {
  expect(parseArgs(["deploy", "manus", "claude", "--mailroom", "--no-input", "--manifest", "/x.jsonc"]))
    .toEqual({ command: "deploy", names: ["manus", "claude"], manifest: "/x.jsonc", mailroom: true, input: false });
  expect(parseArgs(["check"])).toEqual({ command: "check", names: [], manifest: undefined, mailroom: false, input: true });
});
it("refuses an unknown command or flag with the usage line", ...)   // throws; message contains "check | render | deploy | status"
it("finds the manifest: flag, then MAILBOXES, then the repository root", ...)
```

- [ ] **Step 4: Run them and see them fail**

Run: `npm test -w mailbox-tool`. Expected: FAIL, `manifest.ts` exports missing.

- [ ] **Step 5: Implement `manifest.ts` and `cli.ts`**

Parse with `jsonc-parser`'s `parse(text, errors, { allowTrailingComma: true })`; a syntax error is a `ManifestError` giving the offset's line. `main` for `check`: load, resolve, print one line per copy (`mailbox  broker  worker  url`) and return 0; on `ManifestError` print the problems to stderr and return 1. The other three commands print `not implemented` and return 1 until Task 3. The file ends by calling `main(process.argv.slice(2))` only when it is the entry script (`import.meta.main` is not available on Node 22: compare `process.argv[1]` with `fileURLToPath(import.meta.url)`).

- [ ] **Step 6: Write `mailboxes.example.jsonc`**

The manifest from the spec's "The manifest" section, extended to two mailboxes (`claude` pinning `worker`, `url` on `workers.dev`, `kv` and `binding` for both brokers; `manus` using every default), with placeholder ids, the `lists` block and a `mail` entry on each. Every optional key carries a one-line comment.

- [ ] **Step 7: Run everything**

Run: `npm run typecheck && npm test` at the root, then `npm run mailbox -- check --manifest mailboxes.example.jsonc`. Expected: all pass; `check` prints four copies and exits 0.

- [ ] **Step 8: Commit**

```bash
git add -A packages/mailbox mailboxes.example.jsonc package.json package-lock.json .gitignore brokers/discord/wrangler.example.jsonc brokers/github/wrangler.example.jsonc
git commit -m "feat(mailbox): manifest of mailboxes, resolved against each broker's example config"
```

---

### Task 2: Rendering wrangler configs

**Files:**
- Create: `packages/mailbox/src/render.ts`, `packages/mailbox/test/render.test.ts`

**Interfaces:**
- Consumes: `Manifest`, `Template`, `Copy` from `./manifest.ts`.
- Produces:

```ts
/** The wrangler config of one broker copy. */
export function renderBroker(copy: Copy, template: Template, kvId: string): Record<string, unknown>;
/** mailroom-core's wrangler config: `example` is mailroom's parsed wrangler.example.jsonc. Throws Error when no mailbox has "mail". */
export function renderMailroom(manifest: Manifest, copies: Copy[], example: Record<string, unknown>): Record<string, unknown>;
/** Text of a generated file: one header comment line, then JSON with two-space indent and a final newline. */
export function serialize(config: Record<string, unknown>, manifestPath: string): string;
```

`renderBroker`: a deep copy of `template.config` with `name = copy.worker`, `vars = copy.vars`, the single `kv_namespaces` entry keeping its `binding` and getting `id = kvId`. When `copy.customDomain`: `routes = [{ pattern: copy.host, custom_domain: true }]`, `workers_dev = false`, `preview_urls = false`; otherwise none of those three keys is added. Every other key is untouched and the template is not mutated.

`renderMailroom`: a deep copy of `example` with `$schema` removed; `services` = one `{ binding, service: worker, entrypoint: "Feed" }` for each copy that a `mail` entry refers to (as `signin` or as a source's `broker`), in copy order, once each; `vars.MAILROOM = { retain_days?, agents }` where `retain_days` appears only when `manifest.mailroom.retain_days` is set, and `agents[mailbox] = { signin: <binding>, sources: [each source with "broker" replaced by its binding, all other keys and their order kept] }` for each mailbox with `mail`, in manifest order. Other keys of `example.vars` are kept.

`serialize` header, exactly: ``// Generated by `npm run mailbox` from <manifestPath>. Do not edit: change the manifest and run it again.``

- [ ] **Step 1: Write the failing tests**

```ts
it("fills the example with the copy's name, vars and KV id", ...)
// alpha template config also has main, compatibility_date, observability: all three survive unchanged;
// name === "alpha-broker-m1"; vars deep-equals copy.vars; kv_namespaces === [{ binding: "OAUTH_KV", id: "kv123" }]
it("adds a custom-domain route only for a hostname that is not workers.dev", ...)
// custom: routes [{ pattern: "m1-alpha.w.example.com", custom_domain: true }], workers_dev false, preview_urls false
// workers.dev copy: "routes" in cfg === false, "workers_dev" in cfg === false, "preview_urls" in cfg === false
it("does not mutate the template", ...)
it("builds mailroom's services and agents from the mail entries", () => {
  // two mailboxes: m1 (alpha pinned binding "ALPHA", beta default) with mail signin alpha and sources on alpha and beta;
  // m2 (alpha only) with no mail. example = { $schema: "x", name: "mailroom-core", services: [{ binding: "OLD" }],
  //   vars: { OTHER: "keep", MAILROOM: { retain_days: 1, agents: { old: {} } } } }
  expect(out.$schema).toBeUndefined();
  expect(out.services).toEqual([
    { binding: "ALPHA", service: "alpha-broker-m1", entrypoint: "Feed" },
    { binding: "BETA_M1", service: "beta-broker-m1", entrypoint: "Feed" },
  ]);
  expect(out.vars).toEqual({ OTHER: "keep", MAILROOM: { retain_days: 30, agents: { m1: { signin: "ALPHA", sources: [
    { type: "a", broker: "ALPHA", every_secs: 120, things: ["1"] },
    { type: "b", broker: "BETA_M1", keep: "tagged" },
  ] } } } });
});
it("leaves retain_days out when the manifest does not give it", ...)
it("refuses to render mailroom when no mailbox has mail", ...)
it("serializes with the header line and a final newline", ...)   // first line equals the exact header; JSON.parse of the rest equals the config
it("renders this repository's example manifest for both real brokers", ...)
// loadTemplates + mailboxes.example.jsonc: every rendered config has main "src/index.ts", compatibility_flags
// ["global_fetch_strictly_public"], secrets.required equal to the template's, and vars.PUBLIC_URL equal to the copy's url
```

- [ ] **Step 2: Run and see them fail**

Run: `npm test -w mailbox-tool`. Expected: FAIL, `render.ts` missing.

- [ ] **Step 3: Implement `render.ts`** (`structuredClone` for the deep copies.)

- [ ] **Step 4: Run everything**

Run: `npm run typecheck && npm test`. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/mailbox
git commit -m "feat(mailbox): render broker and mailroom wrangler configs from the manifest"
```

---

### Task 3: Driving wrangler: `render`, `deploy`, `status`

**Files:**
- Create: `packages/mailbox/src/wrangler.ts`, `packages/mailbox/src/deploy.ts`
- Create: `packages/mailbox/test/wrangler.test.ts`, `packages/mailbox/test/deploy.test.ts`
- Modify: `packages/mailbox/src/cli.ts`, `packages/mailbox/test/cli.test.ts`

**Interfaces:**
- Consumes: Task 1's `manifest.ts` and `cli.ts`, Task 2's `render.ts`.
- Produces (`wrangler.ts`):

```ts
export interface RunResult { code: number; stdout: string; stderr: string }
/** Runs wrangler with these arguments. `interactive` hands it the terminal (stdout and stderr then come back empty). */
export type Run = (args: string[], opts: { cwd: string; interactive?: boolean }) => Promise<RunResult>;
export function wranglerRunner(repoRoot: string): Run;   // spawns <repoRoot>/node_modules/.bin/wrangler; not unit-tested

export async function kvNamespaces(run: Run, cwd: string): Promise<Map<string, string>>;   // title -> id; args ["kv","namespace","list"]
export async function createKv(run: Run, cwd: string, title: string): Promise<string>;      // ["kv","namespace","create",title], lists again, returns the id
/** null when the Worker does not exist; otherwise the names of the secrets it has. args ["secret","list","--name",worker] */
export async function secretNames(run: Run, cwd: string, worker: string): Promise<string[] | null>;
/** ["deploy","-c",configPath]; repeats once when the output contains "10007". Returns the Version ID if printed. Throws Error on failure. */
export async function deployConfig(run: Run, cwd: string, configPath: string): Promise<string | undefined>;
```

Output shapes (wrangler 4.157): `kv namespace list` prints a JSON array of `{ "id": "...", "title": "..." }`; `secret list` prints a JSON array of `{ "name": "...", "type": "secret_text" }`, or for a missing Worker an error containing `not found`; `deploy` prints `Current Version ID: <uuid>`. Parse JSON from the text between the first `[` and the last `]` of stdout. `secretNames` returns `null` when stdout plus stderr contains `not found`, and throws when the output is neither that nor a JSON array. A thrown deploy error carries the last 20 lines of the output.

- Produces (`deploy.ts`):

```ts
export interface Deps {
  run: Run; fetch: typeof fetch;
  log(line: string): void; sleep(ms: number): Promise<void>;
  read(path: string): string; write(path: string, text: string): void;
  interactive: boolean;       // a terminal is attached and --no-input was not given
  version: string;            // the version in the root package.json
  repoRoot: string; manifestPath: string;
}
export interface Report {
  mailbox: string; broker: string; worker: string; url: string;
  version?: string;           // what the banner says is deployed
  versionId?: string;         // from this run's deploy
  missingSecrets: string[];
  verified: boolean;          // banner shows deps.version and the issuer equals url
  error?: string;
}
/** One GET of `<url>/` and one of `<url>/.well-known/oauth-authorization-server`. Never throws. */
export async function probe(copy: Copy, deps: Deps): Promise<{ version?: string; issuer: boolean }>;
/** Probes up to `attempts` times, sleeping 5000 ms between, until the version is deps.version and the issuer matches. */
export async function verify(copy: Copy, deps: Deps, attempts: number): Promise<{ version?: string; verified: boolean }>;
export async function renderAll(manifest: Manifest, copies: Copy[], templates: Template[], deps: Deps): Promise<string[]>;   // paths written
export async function deployCopies(copies: Copy[], templates: Template[], deps: Deps): Promise<Report[]>;
export async function deployMailroom(manifest: Manifest, copies: Copy[], deps: Deps): Promise<void>;
export async function status(copies: Copy[], deps: Deps): Promise<Report[]>;
export function succeeded(reports: Report[]): boolean;   // no error, no missing secret, all verified
export function nextSteps(manifest: Manifest, copies: Copy[]): string[];
```

Behaviour:
- The banner is the text of `GET <url>/`; the deployed version is the capture of `^<service> (\S+):`. The issuer check is `issuer === url` in the JSON of the second GET. A network error or non-200 gives `{ issuer: false }` with no version.
- `deployCopies`, for each copy in order, inside its own try/catch so one failure never stops the rest:
  1. KV id: `copy.kvId`, else the namespace titled `copy.kvTitle` in one `kvNamespaces` listing made at the start. If there is none: when `secretNames` shows the Worker already exists, fail this copy with `worker <worker> exists but no KV namespace titled "<title>" was found; set "kv" for it in the manifest` and create nothing; when the Worker does not exist, `createKv`.
  2. Write `serialize(renderBroker(...))` to `copy.configPath`.
  3. `deployConfig` with `cwd = copy.dir`.
  4. Missing secrets = `copy.secrets` minus `secretNames`. When some are missing and `deps.interactive`, run `["secret","put",<name>,"--name",<worker>]` with `interactive: true` for each, then list again. Otherwise log, per missing name, the line `npx wrangler secret put <name> --name <worker>`.
  5. `verify(copy, deps, 24)`.
- `renderAll` writes every copy whose KV id is known (pinned, or found by title) and logs `not rendered: <mailbox>/<broker> (KV namespace "<title>" does not exist yet; deploy creates it)` for the others; when `manifest.mailroom` is set it also writes mailroom's config. It creates nothing and deploys nothing.
- Mailroom's directory is `manifest.mailroom.dir` resolved against the directory of `deps.manifestPath`; its example is `wrangler.example.jsonc` there (JSONC); the output is `wrangler.jsonc` there. `deployMailroom` writes it and calls `deployConfig(run, <that dir>, "wrangler.jsonc")`. Without `manifest.mailroom` it throws `the manifest has no "mailroom" entry`.
- `status` probes once per copy and lists secrets; it writes nothing.
- `nextSteps`: for each copy the two lines `<mailbox>/<broker>  connect: <url>/mcp` and `<mailbox>/<broker>  redirect to allow on the upstream application: <url>/callback`; when `manifest.mailroom.url` is set, for each mailbox with `mail`: `<mailbox>/mail  connect: <mailroom url>/<mailbox>/mcp` and `<mailbox>/mail  redirect to allow on the sign-in application: <mailroom url>/callback`.
- `cli.ts` `main`: `names` must all be mailboxes of the manifest (else exit 1 listing the known names); `render`, `deploy` and `status` act on the named mailboxes, or all. `deploy --mailroom` deploys mailroom only after every copy succeeded. Each command prints one line per `Report` (`mailbox  broker  worker  version  verified|UNVERIFIED  [missing: A, B]  [error]`), `deploy` then prints `nextSteps` for the mailboxes it deployed, and the exit code is 0 only when `succeeded`. `interactive` is `args.input && process.stdin.isTTY === true`.

- [ ] **Step 1: Write the failing tests**

A `fakeRun(script)` helper records every call's `args`, `cwd` and `interactive`, and answers from a function of the args. A `fakeFetch(map)` answers by URL. `sleep` records and returns at once. `write` stores into a `Map`.

`wrangler.test.ts`:

```ts
it("reads KV namespaces from JSON surrounded by other output", ...)        // stdout "banner\n[{...}]\n" -> Map
it("creates a namespace and returns the id found by listing again", ...)   // calls: create "t1", then list
it("fails when a created namespace does not appear in the listing", ...)
it("tells a Worker that does not exist from one with no secrets", ...)     // "not found" -> null ; "[]" -> []
it("throws on secret-list output it does not understand", ...)
it("returns the version id of a deploy", ...)
it("repeats a deploy once on code 10007", ...)                             // first result code 1 with "[code: 10007]", second ok: 2 deploy calls
it("gives up after the second failure, with the tail of the output", ...)  // throws; exactly 2 deploy calls
it("does not repeat a failure that is not 10007", ...)                     // 1 deploy call
```

`deploy.test.ts`:

```ts
it("deploys a new mailbox: creates the KV namespace, writes the config, deploys, verifies", ...)
// Worker absent, no namespace: run calls in order are kv list, secret list, kv create, kv list, deploy -c <configPath> (cwd copy.dir), secret list;
// the written config has the created id; report: versionId set, verified true, missingSecrets = copy.secrets, no error
it("never creates a KV namespace for a Worker that already exists", ...)
// Worker present, no namespace by id or title: no "create" call, no "deploy" call, nothing written,
// report.error contains 'set "kv" for it in the manifest'
it("uses a pinned KV id without listing by title", ...)
it("continues with the next copy when one fails to deploy", ...)           // copy 1 deploy fails twice with 10007; copy 2 deployed and verified
it("lists missing secrets with the command to set each when there is no terminal", ...)
// interactive false: no run call has interactive true; log contains "npx wrangler secret put ALPHA_TOKEN --name alpha-broker-m1"
it("hands missing secrets to wrangler at a terminal and lists again", ...)
// interactive true: a call ["secret","put","ALPHA_TOKEN","--name","alpha-broker-m1"] with interactive true; missingSecrets [] afterwards
it("keeps verifying until the new hostname answers", ...)                  // fetch fails twice then answers: verified true, 2 sleeps of 5000
it("reports a copy that never answers as deployed but unverified", ...)    // versionId set, verified false, succeeded(...) false, 24 probes
it("does not verify a banner with another version or a wrong issuer", ...)
it("renders without creating or deploying, and says which copies it skipped", ...)
it("writes mailroom's config next to its example and deploys from that directory", ...)
// manifestPath "/cfg/mailboxes.jsonc", mailroom.dir "../mr/worker": reads "/mr/worker/wrangler.example.jsonc",
// writes "/mr/worker/wrangler.jsonc", run deploy with cwd "/mr/worker" and args ["deploy","-c","wrangler.jsonc"]
it("status reads and writes nothing but the probes and the secret list", ...)
it("lists the addresses and redirects left to enter by hand", ...)         // exact lines for one mailbox with mail and a mailroom url
```

`cli.test.ts` additions: `main` with an unknown mailbox name returns 1 and names the known mailboxes (drive it with `--manifest` pointing at a fixture written to a temp directory; `check` only, so no wrangler is involved).

- [ ] **Step 2: Run and see them fail**

Run: `npm test -w mailbox-tool`. Expected: FAIL, `wrangler.ts` and `deploy.ts` missing.

- [ ] **Step 3: Implement `wrangler.ts`, `deploy.ts` and the three commands in `cli.ts`**

`wranglerRunner` uses `node:child_process` `spawn` with `stdio: "inherit"` when interactive, otherwise pipes collected as UTF-8. `main` builds the real `Deps` (`fetch` global, `sleep` from `node:timers/promises`, `read`/`write` from `node:fs`, `version` from the root `package.json`).

- [ ] **Step 4: Run everything**

Run: `npm run typecheck && npm test`, then `npm run mailbox -- check --manifest mailboxes.example.jsonc`. Expected: PASS, exit 0. Do not run `render`, `deploy` or `status`: they reach the account.

- [ ] **Step 5: Commit**

```bash
git add packages/mailbox
git commit -m "feat(mailbox): render, deploy and status commands driving wrangler"
```

---

### Task 4: Version 0.4.0 and documentation

**Files:**
- Modify: `packages/core/src/version.ts`, every `package.json` (root, `packages/core`, `packages/mailbox`, `brokers/discord`, `brokers/github`), `package-lock.json`
- Modify: `packages/core/test/version.test.ts`
- Modify: `README.md`, `brokers/discord/README.md`, `brokers/github/README.md`

**Interfaces:**
- Consumes: the commands of Tasks 1 and 3 as documented in the spec's "Commands" table.

- [ ] **Step 1: Make the version test find every package itself, and see it fail**

Replace the hand-written path list in `packages/core/test/version.test.ts` with: the root `package.json` plus every `package.json` directly inside each directory of `packages/` and `brokers/` (read the directories with `node:fs`), asserting each `version` equals `VERSION`, that at least five files were checked, and `expect(VERSION).toBe("0.4.0")`.

Run: `npm test -w broker-core`. Expected: FAIL (`0.3.0` is not `0.4.0`).

- [ ] **Step 2: Bump to 0.4.0**

`VERSION` in `packages/core/src/version.ts` and `version` in the five `package.json` files; `npm install` to refresh the lockfile. Update any test that states the banner or `serverInfo` version as a literal `0.3.0`.

Run: `npm run typecheck && npm test`. Expected: PASS.

- [ ] **Step 3: Document**

Root `README.md`: add `packages/mailbox` to the layout; replace the "Deploying" section with a "Mailboxes" section covering what a mailbox is, the manifest (point at `mailboxes.example.jsonc`; where the tool looks for it; that it is not committed here and why it must not live where the agents can write), the four commands, "Adding a mailbox" as numbered steps (create the Discord application and the GitHub App; add the entry; `npm run mailbox -- deploy <name> --mailroom`; type the secrets; enter the printed redirect URLs; connect the printed addresses), "Releasing" (`npm run mailbox -- deploy`, optionally one mailbox first), what a custom-domain hostname needs (the zone on the same Cloudflare account), and that a single hand-kept `wrangler.jsonc` per broker still works for someone running one copy. Add an "Adding a broker" section: the files a new `brokers/<name>` needs (`package.json`, `tsconfig.json`, `vitest.config.ts`, `wrangler.example.jsonc` with `vars`, one `kv_namespaces` entry and `secrets.required`, `src/index.ts` calling `createBroker`), that the mailbox tool and CI pick it up with no change, and that mailroom needs its own source type before it can read the new broker's `Feed`.

Each broker README: one sentence at the top of "Setup" saying that with more than one copy the root README's "Mailboxes" section replaces steps 2 to 5, and the `secrets.required` key mentioned where the example config is described.

- [ ] **Step 4: Commit**

```bash
git add -A README.md brokers/discord/README.md brokers/github/README.md packages brokers/discord/package.json brokers/github/package.json package.json package-lock.json
git commit -m "docs: mailboxes and adding a broker; version 0.4.0"
```

---

### Task 5: Declare each broker's secrets in its `package.json`

Added after the driver's smoke test: wrangler 4.157 refuses `wrangler deploy` for a config
that has `secrets.required` while a secret is unset (`The following required secrets have
not been set: ...`), and says a Worker that does not exist yet cannot be given secrets
with `wrangler secret put`. With the key in the example, a new mailbox can never have its
first deploy, and neither can someone following a broker README by hand. This task
supersedes Task 1 Step 2 and every mention of `secrets.required` in Tasks 1 to 4.

**Files:**
- Modify: `brokers/discord/wrangler.example.jsonc`, `brokers/github/wrangler.example.jsonc` (remove the `secrets` key added in Task 1; nothing else)
- Modify: `brokers/discord/package.json`, `brokers/github/package.json`
- Modify: `packages/mailbox/src/manifest.ts`, `packages/mailbox/test/manifest.test.ts`, `packages/mailbox/test/render.test.ts`, and any other test that builds a `Template`
- Modify: `README.md`, `brokers/discord/README.md`, `brokers/github/README.md`

**Interfaces:**
- Changes: `readTemplate(broker: string, dir: string, text: string, packageJson: string): Template`. `Template.secrets` is `JSON.parse(packageJson).broker.secrets`, which must be an array of strings (it may be empty); otherwise it throws an Error naming `brokers/<broker>/package.json` and `broker.secrets`. `readTemplate` no longer looks at a `secrets` key in the example, and a `secrets` key in an example is an Error (`brokers/<broker>/wrangler.example.jsonc must not have "secrets": wrangler would refuse the first deploy; declare them in package.json`).
- `loadTemplates(repoRoot)` reads `brokers/<name>/package.json` next to each example.
- Unchanged: `Template`, `Copy`, everything in `render.ts`, `wrangler.ts`, `deploy.ts`, `cli.ts`.

- [ ] **Step 1: Change the tests first and see them fail**

In-test templates pass a fourth argument, e.g. `'{ "broker": { "secrets": ["ALPHA_TOKEN"] } }'`, and their example text loses `secrets`. Add or change:

```ts
it("reads a broker's secret names from its package.json", ...)          // secrets equal the array
it("readTemplate names what a broker lacks", ...)                        // package.json without broker.secrets: message contains "brokers/alpha/package.json" and "broker.secrets"; two kv_namespaces still rejected
it("refuses an example that declares secrets to wrangler", ...)          // example with "secrets": { "required": [] } throws; message contains "must not have \"secrets\""
it("loadTemplates reads this repository's brokers", ...)                 // unchanged expectations: the two secret lists as before
it("no rendered config carries a secrets key", ...)                      // in render.test.ts, for both real brokers: "secrets" in cfg === false
```

Run: `npm test -w mailbox-tool`. Expected: FAIL (wrong arity, `secrets` still read from the example).

- [ ] **Step 2: Implement**

`"broker": { "secrets": ["DISCORD_BOT_TOKEN", "DISCORD_CLIENT_SECRET"] }` in `brokers/discord/package.json` and `"broker": { "secrets": ["GITHUB_APP_PRIVATE_KEY", "GITHUB_APP_CLIENT_SECRET"] }` in `brokers/github/package.json`; remove the `secrets` key from both examples; change `readTemplate` and `loadTemplates`.

- [ ] **Step 3: Correct the documentation**

Wherever the READMEs say the secrets are listed under `secrets.required` in the example, say instead that they are listed under `broker.secrets` in the broker's `package.json`, and in the root README's "Adding a broker" list give the reason in one sentence. In the root README's "Adding a mailbox" steps, make sure the order is stated as it happens: the first deploy creates the Worker, then the tool asks for each secret.

- [ ] **Step 4: Run everything and commit**

Run: `npm run typecheck && npm test`, `npm run mailbox -- check --manifest mailboxes.example.jsonc`, and `grep -rn "secrets.required\|\"required\"" README.md brokers/*/README.md brokers/*/wrangler.example.jsonc packages/mailbox` (expected: no match outside the refusal test and message).

```bash
git add -A brokers/discord/wrangler.example.jsonc brokers/github/wrangler.example.jsonc brokers/discord/package.json brokers/github/package.json packages/mailbox README.md brokers/discord/README.md brokers/github/README.md
git commit -m "fix(mailbox): declare a broker's secrets in package.json, not to wrangler"
```

---

## After the tasks (driver, not a subagent)

1. Write the real manifest from the live configs into `~/projects/mailboxes`, pinning every existing `worker`, `url`, `kv` and `binding`.
2. `render`, then show each generated broker config equal to the matching part of the hand-kept `wrangler.jsonc`, and the generated mailroom config equal to mailroom's live one.
3. Smoke-test a throwaway mailbox on `botnet-filref.com` (custom domain, KV creation, verification), then delete it.
4. PR, CI, merge; `npm run mailbox -- deploy` for 0.4.0 on the four live Workers; tag and release.
