# Brokers Monorepo and Shared Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the two imported brokers into one npm workspace with a `broker-core` package that holds everything both use, including the sign-in flow and the request router, and release it as 0.3.0 with no migration of the live Workers.

**Architecture:** `brokers/discord` and `brokers/github` stay separate Workers with their own wrangler config. `packages/core` exports TypeScript source (no build); wrangler bundles it from the workspace. Each broker supplies a `SignInProvider`, its tools and a context factory to core's `createBroker`, and keeps its own API client, tools, `callTool` and `Feed`.

**Tech Stack:** TypeScript 5.9, Cloudflare Workers, wrangler 4.157.0, `@cloudflare/workers-oauth-provider` 1.2.4, vitest 3.2 (Node environment), npm workspaces.

**Spec:** `docs/superpowers/specs/2026-11-19-brokers-monorepo-design.md`. Read it first; this plan argues from it.

## Global Constraints

- Core holds only what **both** brokers use today. Nothing is shaped for a third broker.
- No MCP tool changes: names, schemas, output and audit fields stay as they are.
- Stored sign-ins must keep working. These values are frozen: Discord props `{ id, username }`, GitHub props `{ login, id }`; scope names `discord` and `github` (each with `offline_access`); issuer `PUBLIC_URL`; resource `PUBLIC_URL + "/mcp"`; paths `/authorize`, `/callback`, `/mcp`, `/oauth/register`, `/oauth/token`; `accessTokenTTL: 3600`.
- `Feed` contract with mailroom is frozen: paths, status codes, answer shapes. Only the body of an *exception* answer becomes generic.
- Security behaviour is moved, never loosened: allowlist re-checked on every MCP request; the upstream user token is revoked in `waitUntil` after one use; pages send `Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'` and `Cache-Control: no-store`; `Feed` is read-only.
- `brokers/*/test/flow.test.ts` are the safety net. Allowed edits: import paths, swapping the local `MemoryKV` for core's, and assertions for behaviour this plan changes on purpose. Nothing else.
- Each broker's `callTool` and `Feed` routes stay in the broker.
- Locked versions must stay: wrangler 4.157.0, esbuild 0.28.2, typescript 5.9.3, vitest 3.2.7, `@cloudflare/workers-types` 5.20261104.1, `@modelcontextprotocol/client` 2.4.0, `@modelcontextprotocol/sdk` 1.32.2, `@cloudflare/workers-oauth-provider` 1.2.4.
- Never create, read or commit a real `wrangler.jsonc`, `.dev.vars` or `*.pem`. Never run `wrangler deploy` without `--dry-run`. Deploying is the driver's job.
- Every commit message ends with exactly this trailer and no other `Co-Authored-By`:
  `Co-Authored-By: Claude & Lothrop (cycle.five@proton.me)`
- Move code; do not rewrite it. A moved function keeps its body unless this plan says what changes.

## Review Focus

Conditions the spec implies that are most likely to bite, each pinned by a test in the task named.

1. **A token issued by 0.2.0 reaches 0.3.0.** It must validate and carry the same props. Pinned in Tasks 5 and 6 (`exchange` returns the frozen props; OAuth metadata lists the frozen scopes and endpoints).
2. **Someone is removed from the allowlist while signed in.** Their next MCP request is refused with 403. Pinned in Task 4.
3. **`PUBLIC_URL` is unset or has a trailing slash.** Unset gives a logged 500 on both brokers, not a crash; a trailing slash still yields one clean issuer. Pinned in Task 4.
4. **The upstream sign-in answers garbage or is cancelled.** The user sees the provider's authored message or is sent back with `access_denied`; nothing is thrown. Pinned in Task 4, and for GitHub's real exchange in Task 6.
5. **A `Feed` exception carries upstream detail.** The body is generic, the status is kept, the detail is in the log only. Pinned in Task 7.

---

## File map

```
package.json  package-lock.json  tsconfig.base.json  vitest.shared.ts
.gitignore  LICENSE  README.md  .github/workflows/ci.yml
packages/core/
  package.json  tsconfig.json  vitest.config.ts
  src/index.ts      re-exports everything below
  src/version.ts    VERSION
  src/util.ts       publicUrl, required, base64url
  src/tools.ts      JsonSchema, ToolDef, ToolResult, ToolInputError, validateArgs, truncate
  src/mcp.ts        handleMcp, McpTools, McpOptions, protocol versions
  src/pages.ts      escapeHtml, page, consentPage, errorPage
  src/signin.ts     SignInProvider, handleAuthorize, handleCallback
  src/worker.ts     BaseEnv, BrokerConfig, createBroker
  src/feed.ts       json, auditedFeed
  test-support/index.ts              MemoryKV, cookieHeader, signInDriver
  test-support/cloudflare-workers.ts the Node stand-in for "cloudflare:workers"
  test/*.test.ts
brokers/discord/src/  index.ts signin.ts feed.ts tools.ts env.ts shared.ts discord/
brokers/github/src/   index.ts signin.ts feed.ts tools.ts env.ts github/
```

---

# Part 1: workspace layout (pull request 1)

### Task 1: One npm workspace, no source change

**Files:**
- Create: `package.json`, `package-lock.json` (generated), `tsconfig.base.json`, `.gitignore`, `README.md`, `.github/workflows/ci.yml`
- Move: `brokers/discord/LICENSE` → `LICENSE` (`git mv`); delete `brokers/github/LICENSE` (identical)
- Delete: `brokers/discord/package-lock.json`, `brokers/github/package-lock.json`, `brokers/discord/.gitignore`, `brokers/github/.gitignore`
- Modify: `brokers/*/package.json`, `brokers/*/tsconfig.json`, `brokers/*/wrangler.example.jsonc`, `brokers/*/README.md`
- Must not change: anything under `brokers/*/src` or `brokers/*/test`, and `brokers/*/vitest.config.ts`

**Interfaces:**
- Produces: `npm ci && npm run typecheck && npm test` at the root runs both brokers. Root `workspaces` is `["packages/*", "brokers/*"]` (the first glob matches nothing yet).

- [ ] **Step 1: Root `package.json`**

`name: "brokers"`, `version: "0.2.0"`, `private: true`, `license: "MIT"`, `type: "module"`, the workspaces above, scripts `typecheck: "npm run typecheck --workspaces --if-present"` and `test: "npm test --workspaces --if-present"`. `devDependencies` are the six from a broker's `package.json`, same caret ranges. Each broker's `package.json` loses `devDependencies` and keeps everything else (name, version 0.2.0, scripts, the `@cloudflare/workers-oauth-provider` dependency).

- [ ] **Step 2: Shared TypeScript settings**

`tsconfig.base.json` holds the `compilerOptions` both brokers have today (they are identical). Each `brokers/*/tsconfig.json` becomes `{ "extends": "../../tsconfig.base.json", "include": ["src/**/*.ts"] }`.

- [ ] **Step 3: Root `.gitignore`**

The five lines both broker `.gitignore`s share: `node_modules/`, `.wrangler/`, `.dev.vars`, `wrangler.jsonc`, `*.pem`. No leading slashes, so they apply at every depth.

- [ ] **Step 4: Install and lock**

Run: `rm -rf brokers/*/node_modules && npm install`
Then: `npm ls --depth=0 --workspaces --include-workspace-root` and `npm ls esbuild`
Expected: exactly the locked versions in Global Constraints. If npm chose a newer one, run `npm install -D <name>@<locked version>` for it and check again.

- [ ] **Step 5: Wrangler schema path and READMEs**

In each `wrangler.example.jsonc`, `$schema` becomes `../../node_modules/wrangler/config-schema.json`; nothing else in those files changes. In each broker `README.md`, fix the setup commands for the new layout: clone `CycleFive/brokers`, `npm install` at the root, then work in `brokers/<name>` (`cp wrangler.example.jsonc wrangler.jsonc`, `npx wrangler deploy`). Change no other prose.

- [ ] **Step 6: Root `README.md`**

Short: one paragraph on what a broker is, a two-row table linking each broker's README, the layout, and the three root commands (`npm install`, `npm run typecheck`, `npm test`). State that deploying is `npx wrangler deploy` (plus `--env <name>` for an extra environment) run inside a broker's directory, and that each broker's `wrangler.jsonc` is git-ignored.

- [ ] **Step 7: CI**

`.github/workflows/ci.yml`: name `CI`; on `push` to `master` and on `pull_request`; one job on `ubuntu-latest`: `actions/checkout@v4`, `actions/setup-node@v4` with `node-version: 22` and `cache: npm`, then `npm ci`, `npm run typecheck`, `npm test`.

- [ ] **Step 8: Verify**

Run: `npm ci && npm run typecheck && npm test`
Expected: typecheck clean for both; discord-broker 68 tests pass, github-broker 52 pass.
Run: `git diff --stat master -- 'brokers/*/src' 'brokers/*/test' 'brokers/*/vitest.config.ts'`
Expected: no output.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "chore: one npm workspace for both brokers"
```

**Driver, after Task 1 (not an implementer task):** copy the two real `wrangler.jsonc` files in and fix their `$schema`; `wrangler deploy --dry-run --outdir` for each broker and compare with the baseline bundles from the old repositories; open the pull request; when CI is green, merge; deploy all four Workers; verify. Part 2 starts only after that.

---

# Part 2: shared core, 0.3.0 (pull request 2)

### Task 2: `broker-core` with utilities, tool types and test support

**Files:**
- Create: `packages/core/package.json`, `packages/core/tsconfig.json`, `packages/core/vitest.config.ts`, `packages/core/src/{index,version,util,tools}.ts`, `packages/core/test-support/{index.ts,cloudflare-workers.ts}`, `packages/core/test/{version,util,tools}.test.ts`, `vitest.shared.ts`
- Modify: every `package.json` (version 0.3.0; brokers gain `"broker-core": "*"`), `brokers/*/vitest.config.ts`, `brokers/*/src/tools.ts`, `brokers/discord/src/auth.ts`, `brokers/github/src/auth.ts`, `brokers/github/src/github/app.ts`, `brokers/github/src/index.ts`, `brokers/*/src/index.ts`, `brokers/*/test/flow.test.ts` (MemoryKV import only), `README.md`
- Delete: `brokers/*/test/stubs/cloudflare-workers.ts`

**Interfaces:**
- Produces, all exported from `broker-core`:

```ts
export const VERSION = "0.3.0";
export function publicUrl(env: { PUBLIC_URL?: string }): string;      // throws "PUBLIC_URL is not set"; strips trailing slashes
export function required<E>(env: E, key: keyof E & string): string;  // throws `${key} is not set`
export function base64url(input: Uint8Array | string): string;       // GitHub's version (accepts a string too)

export type JsonSchema = { type: "object"; properties: Record<string, any>; required?: string[]; additionalProperties?: boolean };
export interface ToolDef<C> { name; title; description; inputSchema: JsonSchema; annotations: {...}; run(args: Record<string, any>, ctx: C): Promise<unknown> }
export interface ToolResult { content: { type: "text"; text: string }[]; isError: boolean }
export class ToolInputError extends Error {}
export function validateArgs(schema: JsonSchema, args: unknown): string | null;  // Discord's version: includes integer minimum/maximum
export function truncate(text: string, max: number): string;                     // identical in both today
```

- Produces from `broker-core/testing`: `class MemoryKV` (the class both flow tests define, verbatim).
- Produces `vitest.shared.ts` at the root: `export function brokerVitest(): UserConfig` with the `cloudflare:workers` alias pointing at `packages/core/test-support/cloudflare-workers.ts` (resolved from the root file's own URL), `test.include: ["test/**/*.test.ts"]`, `environment: "node"`, and `server.deps.inline: ["@cloudflare/workers-oauth-provider"]`. Each package's `vitest.config.ts` is `export default defineConfig(brokerVitest())`, importing by relative path.

Core's `package.json`: `name: "broker-core"`, `private: true`, `type: "module"`, `exports: { ".": "./src/index.ts", "./testing": "./test-support/index.ts" }`, scripts `typecheck` and `test` like a broker's, dependency `@cloudflare/workers-oauth-provider` `1.2.4`. Its `tsconfig.json` extends the base and includes `src` and `test-support`. The stub is Discord's version (typed `ctx`).

- [ ] **Step 1: Write the failing tests**

`test/version.test.ts`:

```ts
it("is the one version every package.json states", () => {
  for (const p of ["package.json", "packages/core/package.json", "brokers/discord/package.json", "brokers/github/package.json"]) {
    expect(JSON.parse(readFileSync(new URL(`../../../${p}`, import.meta.url), "utf8")).version, p).toBe(VERSION);
  }
  expect(VERSION).toBe("0.3.0");
});
```

`test/util.test.ts`:

```ts
expect(publicUrl({ PUBLIC_URL: "https://b.test//" })).toBe("https://b.test");
expect(() => publicUrl({})).toThrow("PUBLIC_URL is not set");
expect(required({ A: "x" }, "A")).toBe("x");
expect(() => required({ A: "" }, "A")).toThrow("A is not set");
expect(base64url(new Uint8Array([251, 255, 254]))).toBe("-__-");
expect(base64url("{}")).toBe("e30");
```

`test/tools.test.ts`: move GitHub's "validates required keys, types, enums and unknown keys" assertions here against a local schema, and add:

```ts
const s = { type: "object", properties: { n: { type: "integer", minimum: 1, maximum: 5 } }, additionalProperties: false } as const;
expect(validateArgs(s, { n: 0 })).toBe('argument "n" must be at least 1');
expect(validateArgs(s, { n: 6 })).toBe('argument "n" must be at most 5');
expect(validateArgs(s, { n: 3 })).toBeNull();
expect(truncate("abcdef", 3)).toMatch(/^abc\n\n\[truncated: 3 more characters/);
```

- [ ] **Step 2: Run them and see them fail**

Run: `npm test -w broker-core`
Expected: FAIL, modules not found.

- [ ] **Step 3: Implement core, bump every version to 0.3.0, run `npm install`**

Move the code; do not rewrite it. `npm install` links the new workspace package.

- [ ] **Step 4: Point the brokers at core**

Each broker deletes its own copy and imports from `broker-core`: the tool types, `ToolInputError`, `validateArgs`, `truncate` in `tools.ts` (a broker's `ToolDef` becomes `ToolDef<ToolContext>`); `publicUrl`, `base64url` in `auth.ts`; `required` and `VERSION` in `index.ts` (and Discord's `userAgent`); `base64url` in `github/app.ts`. Keep re-exports where the broker's tests import a moved name from the broker's own module, so those tests need no edit. Switch both `vitest.config.ts` to `brokerVitest()`, delete both stubs, and replace the local `MemoryKV` class in both flow tests with the import.

- [ ] **Step 5: Run everything**

Run: `npm run typecheck && npm test`
Expected: all green; broker test counts unchanged except GitHub's moved `validateArgs` case if you removed it there.

- [ ] **Step 6: Add a "What is shared" section to the root README, then commit**

```bash
git add -A
git commit -m "feat: broker-core with shared utilities and tool types (0.3.0)"
```

### Task 3: The MCP server moves to core

**Files:**
- Create: `packages/core/src/mcp.ts`, `packages/core/test/mcp.test.ts`
- Delete: `brokers/*/src/mcp.ts`
- Modify: `packages/core/src/index.ts`, `brokers/*/src/index.ts`, `brokers/*/test/mcp.test.ts`

**Interfaces:**
- Consumes: `ToolDef`, `ToolResult` (Task 2).
- Produces:

```ts
export interface McpTools<C> {
  list: readonly ToolDef<C>[];
  call(name: string, args: unknown, ctx: C): Promise<ToolResult | null>;   // null = unknown tool
}
export function handleMcp<C>(request: Request, tools: McpTools<C>, getContext: () => C | Promise<C>, opts: McpOptions): Promise<Response>;
export { MODERN_VERSION, LEGACY_VERSIONS, SUPPORTED_VERSIONS, type McpOptions };
```

The file is today's `mcp.ts` (identical in both brokers) with one change: `TOOLS` and `callTool` come from the `tools` argument instead of an import.

- [ ] **Step 1: Move the protocol tests to core**

`packages/core/test/mcp.test.ts` is Discord's `test/mcp.test.ts` with a two-tool fake in place of the Discord fakes: `echo` (required string `text`, returns it) and `boom` (throws). The fake's `call` validates with `validateArgs` and returns `{ content, isError }` the way a broker's `callTool` does. Where the original called `bot_info` / `read_messages`, call `echo` with and without `text`. Add:

```ts
it("answers an unknown tool with -32602", async () => {
  const res = await post({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "nope" } });
  expect((await res.json()).error.code).toBe(-32602);
});
```

- [ ] **Step 2: Run, see it fail** (`npm test -w broker-core`: `handleMcp` not exported).

- [ ] **Step 3: Move `mcp.ts` to core with the new signature; update both `index.ts` to pass `{ list: TOOLS, call: callTool }`.**

- [ ] **Step 4: Trim each broker's `mcp.test.ts`** to the one test that connects the real MCP SDK client and calls a real tool (`bot_info`; `installation_info`), importing `handleMcp` from `broker-core`. The protocol cases now live in core.

- [ ] **Step 5: Run everything** (`npm run typecheck && npm test`, all green) **and commit**

```bash
git commit -am "refactor: one MCP server implementation in broker-core"
```

### Task 4: Sign-in flow and `createBroker` in core

Nothing in the brokers changes in this task. Core gains the flow, proven against a fake provider.

**Files:**
- Create: `packages/core/src/{pages,signin,worker}.ts`, `packages/core/test/{pages,worker}.test.ts`
- Modify: `packages/core/src/index.ts`, `packages/core/test-support/index.ts`

**Interfaces:**
- Consumes: `handleMcp`, `McpTools`, `publicUrl`, `VERSION`, `base64url`, `MemoryKV`.
- Produces:

```ts
// pages.ts
export function escapeHtml(s: string): string;
export function page(title: string, body: string, headers?: Headers, status?: number): Response;
export function consentPage(d: ConsentDescription, handle: string, headers: Headers,
                            text: { title: string; label: string; grants: string }): Response;
export function errorPage(message: string, status?: number): Response;   // title "Sign-in failed"

// signin.ts
export type Exchanged<P> = { ok: true; userId: string; props: P } | { ok: false; status: number; message: string };
export interface WaitUntil { waitUntil(p: Promise<unknown>): void }
export interface SignInProvider<E, P> {
  scope: string;
  label: string;
  grants: string;
  configProblem(env: E): string | null;
  pkce(env: E): boolean;
  authorizeUrl(env: E, p: { redirectUri: string; state: string; challenge?: string }): string;  // the complete upstream URL
  exchange(env: E, p: { code: string; redirectUri: string; verifier?: string }, ctx: WaitUntil, fetchImpl?: typeof fetch): Promise<Exchanged<P>>;
  isAllowed(env: E, props: P): boolean;
  refusal(props: P): string;
}
export function handleAuthorize<E extends BaseEnv, P>(request: Request, env: E, oauth: OAuthHelpers, signIn: SignInProvider<E, P>, title: string): Promise<Response>;
export function handleCallback<E extends BaseEnv, P>(request: Request, env: E, oauth: OAuthHelpers, ctx: WaitUntil, signIn: SignInProvider<E, P>, fetchImpl?: typeof fetch): Promise<Response>;

// worker.ts
export interface BaseEnv { OAUTH_KV: KVNamespace; PUBLIC_URL: string; ALLOWED_ORIGINS?: string; DISABLE_CIMD?: string }
export interface BrokerConfig<E extends BaseEnv, P, C> {
  name: string;            // "discord-broker": serverInfo.name and the "/" banner
  title: string;           // "Discord broker": serverInfo.title, resource_name, page headings
  instructions: string;
  signIn: SignInProvider<E, P>;
  tools: McpTools<C>;
  context(env: E, user: P): C;      // may throw; handleMcp reports it as "Server not configured: ..."
}
export function createBroker<E extends BaseEnv, P, C>(cfg: BrokerConfig<E, P, C>): { fetch(request: Request, env: E, ctx: ExecutionContext): Promise<Response> };
```

- Produces from `broker-core/testing`: `cookieHeader(res: Response, prior?: string): string` (as in both flow tests) and a small `signInDriver` for core's own test (register a client, get consent, approve, follow `/callback`, redeem the code). Shape it as the test needs; the brokers' flow tests do not use it.

**Behaviour, all taken from Discord's `auth.ts` and `index.ts` (the more complete of the two):**
- Consent page: heading and title `Connect ${title}`; sentence `<strong>${who}</strong> ${grants}`; button `Continue to ${label}`. Everything else as today.
- `POST /authorize`, approved: `approveConsent` with scope `[signIn.scope, "offline_access"]`; then `configProblem`, and if it returns text, log `{ event: "config_error", message }` and answer `errorPage(message, 500)`; then begin upstream with `data: { verifier }` where `verifier` is `""` when `pkce(env)` is false; redirect to `authorizeUrl(env, { redirectUri: publicUrl(env) + "/callback", state, challenge })`.
- `/callback`: cancelled or no `code` → log `sign_in_cancelled` and redirect with `access_denied`, description `${label} sign-in was cancelled`. Failed exchange → `errorPage(message, status)`. Not allowed → log `{ event: "sign_in_refused", ...props }`, `errorPage(signIn.refusal(props), 403)`. Otherwise `completeAuthorization({ request, userId, metadata: props, scope: authReq.scope, props })` and log `{ event: "sign_in", ...props, client }`.
- Errors from the library: `AuthorizationError` and `CimdFetchError` handled and logged exactly as Discord's `renderAuthError` does.
- `createBroker`: roles cached per `publicUrl(env) + "|" + (env.DISABLE_CIMD ?? "")`; `clientIdMetadataDocumentEnabled: env.DISABLE_CIMD !== "true"`; the frozen values from Global Constraints; the resource handler checks the scope, then `props && signIn.isAllowed(env, props)` (else 403 `Forbidden`), then `handleMcp` with `serverInfo: { name, title, version: VERSION }`, `instructions` and `allowedOrigins` parsed from `ALLOWED_ORIGINS`. Routes, the `/` banner (`${name} ${VERSION}: MCP endpoint at ${publicUrl(env)}/mcp\n`), the `oauth_endpoint` log line and the top-level catch (`unhandled`, 500 `Internal error: ${message}\n`) as in Discord's `index.ts`.

- [ ] **Step 1: Write the failing tests**

`test/pages.test.ts`: `escapeHtml` (the existing assertion from either `auth.test.ts`); `errorPage("x", 418)` has status 418, the CSP header and `no-store` from Global Constraints; `consentPage` with `text: { title: "Fake broker", label: "Fake", grants: "wants to test." }` contains `Connect Fake broker`, `wants to test.` and `Continue to Fake`.

`test/worker.test.ts` builds a broker over this provider and one `whoami` tool that returns its context:

```ts
type P = { id: string; name: string };
interface TestEnv extends BaseEnv { ALLOWED: string; BROKEN?: string; PKCE?: string }
const signIn: SignInProvider<TestEnv, P> = {
  scope: "fake", label: "Fake", grants: "wants to test.",
  configProblem: (e) => (e.BROKEN ? "BROKEN is set" : null),
  pkce: (e) => e.PKCE === "true",
  authorizeUrl: (_e, p) => `https://up.test/authorize?${new URLSearchParams({ state: p.state, redirect_uri: p.redirectUri, ...(p.challenge ? { code_challenge: p.challenge } : {}) })}`,
  exchange: async (_e, p) => { seen.push(p); return p.code === "bad" ? { ok: false, status: 502, message: "Fake did not return a token." } : { ok: true, userId: p.code, props: { id: p.code, name: "n" } }; },
  isAllowed: (e, u) => e.ALLOWED.split(",").includes(u.id),
  refusal: (u) => `Fake account ${u.id} is not allowed.`,
};
// name "fake-broker", title "Fake broker", BASE "https://broker.test", ALLOWED "u1"
```

Tests, one `it` each:

| Name | Asserts |
|---|---|
| signs in and serves MCP | after the flow with code `u1`, `tools/call whoami` returns text containing `"id": "u1"`; `GET /` body is `` `fake-broker ${VERSION}: MCP endpoint at https://broker.test/mcp\n` `` |
| hands the provider's props to the context unchanged | `context` was called with `toEqual({ id: "u1", name: "n" })` |
| re-checks the allowlist on every request | sign in, set `env.ALLOWED = ""`, the next `/mcp` POST is 403 |
| stops at the config check before going upstream | `BROKEN: "1"` → approving gives status 500, body contains `BROKEN is set`, no `Location` header, a `config_error` line logged |
| sends a PKCE challenge only when the provider asks | default: upstream URL has no `code_challenge` and `exchange` saw `verifier` falsy; `PKCE: "true"`: it has one and SHA-256 of the `verifier` `exchange` saw, base64url, equals it |
| refuses an account the provider rejects | code `u2` → 403 page containing `Fake account u2 is not allowed.` |
| sends a cancelled sign-in back as access_denied | `/callback?error=access_denied&state=…` → 302 whose `Location` starts with the client redirect and has `error=access_denied` |
| shows the provider's message when the exchange fails | code `bad` → status 502, body contains `Fake did not return a token.` |
| DISABLE_CIMD turns client metadata documents off | `/.well-known/oauth-authorization-server`: `client_id_metadata_document_supported` is `true` by default and not `true` with `DISABLE_CIMD: "true"`; both list `scopes_supported` `["fake", "offline_access"]` |
| an exception becomes a logged 500 | `PUBLIC_URL: ""`, `GET /` → 500, body `Internal error: PUBLIC_URL is not set\n`, an `unhandled` line logged |
| a trailing slash on PUBLIC_URL still gives one issuer | `PUBLIC_URL: "https://broker.test/"` → metadata `issuer` is `https://broker.test` |
| escapes the client's name on the consent page | register `client_name: "<script>x</script>"` → consent HTML has `&lt;script&gt;` and no `<script>` |
| logs each library-served OAuth endpoint | `POST /oauth/register` logs `{ event: "oauth_endpoint", method: "POST", path: "/oauth/register", status: 201 }` |

- [ ] **Step 2: Run, see them fail** (`npm test -w broker-core`).

- [ ] **Step 3: Implement `pages.ts`, `signin.ts`, `worker.ts`** by moving Discord's code and replacing the Discord-specific parts with calls on `signIn` and `cfg`.

- [ ] **Step 4: Run** `npm run typecheck && npm test` (all green; broker suites untouched).

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: sign-in flow and request router in broker-core"
```

### Task 5: Discord broker on `createBroker`

**Files:**
- Create: `brokers/discord/src/signin.ts`
- Delete: `brokers/discord/src/auth.ts`
- Rename: `brokers/discord/test/auth.test.ts` → `test/signin.test.ts`
- Modify: `brokers/discord/src/{index,feed,env}.ts`, `brokers/discord/test/{flow,feed}.test.ts` (imports only, plus the additions below), `brokers/discord/package.json` (the OAuth library dependency goes; core has it)

**Interfaces:**
- Consumes: `createBroker`, `SignInProvider`, `BaseEnv`, `VERSION`, `publicUrl` (Tasks 2 and 4).
- Produces from `src/signin.ts`: `interface AuthProps { id: string; username: string }`, `signIn: SignInProvider<Env, AuthProps>`, and, still exported for tests and `feed.ts`: `parseAllowlist`, `isAllowed`, `configProblem`, `userAgent`, the four `DISCORD_*` URL constants.

Provider values: `scope: "discord"`, `label: "Discord"`, `grants: "wants to act as this server's Discord bot: read and post wherever the bot is allowed."`, `pkce: env.DISCORD_OAUTH_PKCE === "true"`, `refusal: (u) => \`Discord account ${u.username} (ID ${u.id}) is not in ALLOWED_DISCORD_USERS.\``. `authorizeUrl` builds today's URL (`client_id`, `response_type=code`, `redirect_uri`, `scope=identify`, `state`, and both `code_challenge` params when a challenge is given). `exchange` is today's `exchangeDiscordCode` returning `{ ok: true, userId: id, props: { id, username } }`. `Env` extends `BaseEnv`. `index.ts` becomes `export default createBroker({...})` plus `export { Feed }`, with `name: "discord-broker"`, `title: "Discord broker"`, today's `INSTRUCTIONS` and today's context factory. `feed.ts` calls `signIn.exchange` for `/signin` and answers `{ id, username }` from the props as now.

- [ ] **Step 1: Add the failing tests to `test/signin.test.ts`**

```ts
it("keeps the props and scope that stored sign-ins rely on", async () => {
  expect(signIn.scope).toBe("discord");
  const fetchImpl = fake({ token: { access_token: "t" }, me: { id: "800000000000000001", username: "lothrop" } });
  const r = await signIn.exchange(env, { code: "c", redirectUri: "https://b.test/callback" }, ctx, fetchImpl);
  expect(r).toEqual({ ok: true, userId: "800000000000000001", props: { id: "800000000000000001", username: "lothrop" } });
});
it("revokes the user token after reading the account", async () => { /* the revoke URL was called with token=t, via waitUntil */ });
```

and to `test/flow.test.ts`:

```ts
it("advertises the same scopes and endpoints as 0.2.0", async () => {
  const m = await (await call(env(), "/.well-known/oauth-authorization-server")).json();
  expect(m.issuer).toBe(BASE);
  expect(m.scopes_supported).toEqual(["discord", "offline_access"]);
  expect(m.token_endpoint).toBe(`${BASE}/oauth/token`);
  expect(m.registration_endpoint).toBe(`${BASE}/oauth/register`);
  expect(m.authorization_endpoint).toBe(`${BASE}/authorize`);
});
```

- [ ] **Step 2: Run** `npm test -w discord-broker`: the metadata test passes already (it pins current behaviour; keep it), the `signIn` ones fail.

- [ ] **Step 3: Implement** as described under Interfaces.

- [ ] **Step 4: Run** `npm run typecheck && npm test`. Every pre-existing Discord test passes with import edits only.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "refactor(discord): run on broker-core's sign-in flow and router"
```

### Task 6: GitHub broker on `createBroker`, gaining the hardening

**Files:**
- Create: `brokers/github/src/signin.ts`
- Delete: `brokers/github/src/auth.ts`
- Rename: `brokers/github/test/auth.test.ts` → `test/signin.test.ts`
- Modify: `brokers/github/src/{index,env}.ts`, `brokers/github/test/flow.test.ts`, `brokers/github/wrangler.example.jsonc`, `brokers/github/README.md`, `brokers/github/package.json`

**Interfaces:**
- Consumes: as Task 5.
- Produces from `src/signin.ts`: `interface AuthProps { login: string; id: string }`, `signIn: SignInProvider<Env, AuthProps>`, `parseAllowlist`, `isAllowed`, `configProblem`.

Provider values: `scope: "github"`, `label: "GitHub"`, `grants: "wants to use this server's GitHub App installation: everything the app is permitted to do on its repositories."`, `pkce: () => true`, `refusal: (u) => \`GitHub account ${u.login} is not allowed on this server.\``. `authorizeUrl` and `exchange` are today's code from `handleAuthorize` / `handleCallback` (`allow_signup=false`; JSON token request; `DELETE /applications/{client_id}/token` revoke), returning `props: { login, id: String(id) }` and, on failure, today's two messages with status 502. `isAllowed` keeps IDs-or-logins, case-insensitive. `Env` extends `BaseEnv`, which brings `DISABLE_CIMD`. `index.ts` as in Task 5 with `name: "github-broker"`, `title: "GitHub broker"`.

`configProblem(env)`, in this order: `GITHUB_APP_CLIENT_ID` empty → a message naming `GITHUB_APP_CLIENT_ID`; allowlist with no entries → `ALLOWED_GITHUB_USERS is empty, so nobody could sign in.`; `GITHUB_APP_CLIENT_SECRET` empty → `GITHUB_APP_CLIENT_SECRET is not set (wrangler secret put GITHUB_APP_CLIENT_SECRET).`

- [ ] **Step 1: Write the failing tests**

`test/signin.test.ts`:

```ts
const base = { GITHUB_APP_CLIENT_ID: "Iv23x", ALLOWED_GITHUB_USERS: "4242", GITHUB_APP_CLIENT_SECRET: "s" } as Env;
it("passes a sane config", () => expect(configProblem(base)).toBeNull());
it("spots a missing client ID", () => expect(configProblem({ ...base, GITHUB_APP_CLIENT_ID: "" })).toMatch(/GITHUB_APP_CLIENT_ID/));
it("spots an empty allowlist", () => expect(configProblem({ ...base, ALLOWED_GITHUB_USERS: " " })).toMatch(/nobody could sign in/));
it("spots a missing client secret", () => expect(configProblem({ ...base, GITHUB_APP_CLIENT_SECRET: "" })).toMatch(/wrangler secret put/));
it("keeps the props and scope that stored sign-ins rely on", async () => {
  expect(signIn.scope).toBe("github");
  const r = await signIn.exchange(env, { code: "c", redirectUri: "https://b.test/callback", verifier: "v" }, ctx, fake({ token: { access_token: "t" }, user: { id: 4242, login: "lothrop" } }));
  expect(r).toEqual({ ok: true, userId: "4242", props: { login: "lothrop", id: "4242" } });
});
it("answers a token refusal with its own message, not a crash", async () => {
  const r = await signIn.exchange(env, { code: "c", redirectUri: "u", verifier: "v" }, ctx, fake({ token: "not json" }));
  expect(r).toMatchObject({ ok: false, status: 502 });
});
```

`test/flow.test.ts` additions: the metadata test from Task 5 with `["github", "offline_access"]`; and

```ts
it("explains an empty allowlist instead of sending you to GitHub", async () => { /* env("") → approving consent gives 500 and the text "nobody could sign in" */ });
it("answers an exception with a logged 500", async () => { /* PUBLIC_URL "" → GET / is 500 "Internal error: PUBLIC_URL is not set\n" */ });
```

- [ ] **Step 2: Run, see them fail** (`npm test -w github-broker`).

- [ ] **Step 3: Implement** as described. Add `DISABLE_CIMD` to `wrangler.example.jsonc` with Discord's comment and `""`, and a matching line in the README's configuration table.

- [ ] **Step 4: Run** `npm run typecheck && npm test`. Every pre-existing GitHub flow test passes with import edits only.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(github): run on broker-core; gains DISABLE_CIMD, config checks and the error catch"
```

### Task 7: Shared `Feed` helpers; Discord stops echoing exceptions

**Files:**
- Create: `packages/core/src/feed.ts`, `packages/core/test/feed.test.ts`
- Modify: `packages/core/src/index.ts`, `brokers/*/src/feed.ts`, `brokers/*/test/feed.test.ts`

**Interfaces:**
- Produces:

```ts
/** JSON answer; no body for 204, 205 and 304. Content-Type "application/json; charset=utf-8". */
export function json(body: unknown, status?: number): Response;
/**
 * Runs a Feed route and writes one audit line: { event: "feed", method, path, status, ms }, in that key order,
 * path without the query. If `run` throws, answers json({ error: f.error }, f.status) where f = failure(e),
 * and adds the exception's message to the log line as a last key, `message`. The message never reaches the body.
 */
export function auditedFeed(request: Request, run: () => Promise<Response>, failure: (e: unknown) => { status: number; error: string }): Promise<Response>;
```

Broker `failure` functions: GitHub `() => ({ status: 502, error: "upstream unavailable" })` (today's answer). Discord: a `DiscordError` → `{ status: e.status, error: "discord error" }`, anything else → `{ status: 500, error: "internal error" }`. In Discord's `Feed` class, building the client moves inside `run`, so a missing `DISCORD_BOT_TOKEN` is answered the same generic way. Authored refusals inside the routes (400, 403, 404, 405, and `/signin`'s failure text) are unchanged.

- [ ] **Step 1: Write the failing tests**

`packages/core/test/feed.test.ts`:

```ts
it("writes the audit line with these keys in this order, without the query", async () => {
  await auditedFeed(new Request("https://x/api/a?secret=1"), async () => json({ ok: 1 }), fail);
  const line = JSON.parse(log.mock.calls[0][0]);
  expect(Object.keys(line)).toEqual(["event", "method", "path", "status", "ms"]);
  expect(line).toMatchObject({ event: "feed", method: "GET", path: "/api/a", status: 200 });
});
it("keeps an exception's message out of the body and in the log", async () => {
  const res = await auditedFeed(new Request("https://x/identity"), async () => { throw new Error("token abc123 rejected"); }, () => ({ status: 502, error: "upstream unavailable" }));
  expect(res.status).toBe(502);
  expect(await res.text()).toBe('{"error":"upstream unavailable"}');
  expect(JSON.parse(log.mock.calls[0][0])).toMatchObject({ status: 502, message: "token abc123 rejected" });
});
it("sends no body with 204 and 304", () => { expect(json({}, 204).body).toBeNull(); expect(json({}, 304).body).toBeNull(); });
```

`brokers/discord/test/feed.test.ts` additions:

```ts
it("keeps the upstream status but not the upstream text when Discord fails", async () => { /* /identity with Discord answering 403 {"message":"Missing Access"} → status 403, body {"error":"discord error"} */ });
it("does not echo an unexpected failure", async () => { /* fetch throws Error("boom detail") → status 500, body {"error":"internal error"} */ });
it("includes the method in the audit line", async () => { /* Object.keys of the logged line toEqual ["event","method","path","status","ms"] */ });
```

- [ ] **Step 2: Run, see them fail.**

- [ ] **Step 3: Implement core's `feed.ts`; switch both `Feed`s to `json` and `auditedFeed`.** GitHub's existing audit-line test must pass unchanged.

- [ ] **Step 4: Run** `npm run typecheck && npm test` (all green).

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: shared Feed helpers; Discord's Feed no longer echoes exceptions"
```

**Driver, after Task 7:** whole-branch review; dry-run both bundles; pull request; CI green; merge; deploy all four; verify; tag `v0.3.0`; release; archive the old repositories with a pointer; fix mailroom's README links.
