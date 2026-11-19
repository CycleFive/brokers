# One repository for the brokers, with a shared core

Date: 2026-11-19. Status: approved in conversation (approach B, see Approaches); written
down here as the record the plan is built from.

## Intent

`discord-broker` and `github-broker` are the same program written twice. `src/mcp.ts` is
byte-identical in both, about half of `auth.ts` and most of `index.ts` differ only in the
word "Discord" or "GitHub", and in two weeks the copies have already drifted: one has
hardening the other lacks. Lothrop wants one repository where the common code exists once
and where a further broker is cheap to add.

This repository (`CycleFive/brokers`) already holds both brokers with their history, moved
to `brokers/discord` and `brokers/github` and otherwise untouched. Each is still a
standalone npm project. This design turns that into a workspace with a shared core.

## Goals

1. One npm workspace: one lockfile, one version of TypeScript, vitest and wrangler.
2. A `core` package holding what **both** brokers use today, including the sign-in flow and
   the request router, so the hardening lives in one place.
3. The drift is settled on purpose (list below), not carried over.
4. The same four live Workers are deployed from here with **no migration**: same Worker
   names, URLs, KV namespaces and secrets, and **every existing sign-in keeps working**.
5. Released as 0.3.0, the old two repositories archived with a pointer here.

## Non-goals

- No third broker, and nothing shaped for one. The rule for core: code goes in only if both
  existing brokers use it now. (Slack, Telegram and IRC were mentioned as possibilities;
  when one arrives, its real needs redraw the boundary.)
- No change to any MCP tool, its name, schema or output.
- No change to mailroom's contract with `Feed` (paths, status codes, answer shapes), and no
  change to mailroom's code.
- The brokers stay separate Workers. No shared deployment, no shared credentials.
- No publishing of `core` to a registry.

## Anti-goals

- Anything that forces a user or agent to sign in again, or that needs a secret re-entered.
- A `defineBroker` framework that swallows `Feed` or tool dispatch. The two `Feed`s differ
  on purpose, and each broker's `callTool` stays its own (about 30 near-duplicate lines,
  left alone deliberately).
- Loosening any security behaviour while moving it: allowlist re-check on every request,
  user token revoked after one use, CSP and `no-store` on pages, scope checks, read-only
  `Feed`.

## Constraints

- **Stored sign-ins.** The OAuth library keeps grants in `OAUTH_KV` with the user's props
  inside. Discord's are `{ id, username }`, GitHub's `{ login, id }`. Those shapes, the
  OAuth scope names (`discord`, `github`), the issuer (`PUBLIC_URL`), the resource
  (`PUBLIC_URL/mcp`), the endpoint paths and the token TTL must not change, or existing
  tokens stop validating. Core is therefore generic over the props type; it does not
  normalise them.
- **Live config is local.** Each broker's real `wrangler.jsonc` is git-ignored and lives
  only on Lothrop's machine, with a `manus` environment beside the top level. It moves to
  `brokers/<name>/wrangler.jsonc` by copy; only its `$schema` path changes.
- **Wrangler:** one config describes one Worker and there is no cross-file include, so
  there is one `wrangler.jsonc` and one `wrangler.example.jsonc` per broker, in the
  broker's directory. Wrangler bundles `core` straight from the workspace; core has no
  build step.
- **Tests run in Node** under vitest with a stub for `cloudflare:workers`, as now.
- Each broker's `test/flow.test.ts` drives the real Worker entry through the real OAuth
  library. Those tests are the safety net for the move: they must keep passing, edited
  only for import paths and for the behaviours this document changes on purpose.

## Approaches

- **A. Lift only identical code.** Core gets `mcp.ts`, tool types and validation, test
  stubs, configs. `auth.ts`, `index.ts`, `feed.ts` stay per broker and the hardening is
  copied across by hand. Smallest change; the files that drifted stay as two copies.
- **B. A, plus the sign-in and routing skeleton (chosen).** Core also owns the consent
  page, the upstream-state handling, the callback flow, the error pages and the fetch
  router. Each broker supplies a small sign-in object. More work, and it moves the most
  security-sensitive file, so it is done test-first. Chosen because the drift happened
  exactly in those files, and the interface is cut from two working implementations
  rather than guessed.
- **C. A full `defineBroker` framework** that also absorbs `Feed` and tool dispatch.
  Dropped as speculative.

Also ruled out earlier: a shared package across separate repositories (three places to bump
versions) and one Worker serving every broker (pools credentials kept apart on purpose).

## Layout

```
package.json               private; workspaces ["packages/*", "brokers/*"]; version 0.3.0
package-lock.json          the only lockfile
tsconfig.base.json
.gitignore  LICENSE  README.md
.github/workflows/ci.yml   npm ci, typecheck, test (see "My calls")
packages/core/             package "broker-core"; exports TypeScript source, no build
  src/  test/
brokers/discord/           package "discord-broker"
  src/  test/  README.md  wrangler.example.jsonc  .dev.vars.example  (wrangler.jsonc, ignored)
brokers/github/            package "github-broker"
  (same)
docs/superpowers/{specs,plans}/
```

## What core holds

Each item is used by both brokers today.

| Module | Contents | Comes from |
|---|---|---|
| `mcp` | `handleMcp`, protocol versions. Takes the tool list and a `call` function as arguments instead of importing `./tools`. | identical `src/mcp.ts` |
| `tools` | `JsonSchema`, `ToolDef<C>`, `ToolResult`, `ToolInputError`, `validateArgs`, `truncate` | duplicated top of each `tools.ts` |
| `pages` | `escapeHtml`, the page shell (CSP, `no-store`), `consentPage`, `errorPage` | both `auth.ts` |
| `signin` | `SignInProvider`, `handleAuthorize`, `handleCallback`, PKCE helpers | both `auth.ts` |
| `worker` | `createBroker(config)` returning the Worker's `fetch` handler: OAuth roles, routes, per-request allowlist re-check, top-level error catch, OAuth endpoint logging | both `index.ts` |
| `feed` | JSON answer helper and the audit-line wrapper only. The wrapper catches an exception, asks the broker for the status and generic text to answer with, and keeps the exception's message for the log line. | both `feed.ts` |
| `util` | `publicUrl`, `required`, `base64url`, `VERSION` | both |
| test support | `MemoryKV`, the `cloudflare:workers` stub, the shared vitest settings. The brokers' flow tests keep their own sign-in driver for now, so they stay untouched as the safety net. | both `test/` |

### The sign-in object

Cut from the two existing flows. `E` is the broker's `Env`, `P` its stored props.

```ts
interface SignInProvider<E, P> {
  scope: string;                    // "discord" | "github": the OAuth scope on this broker's tokens
  label: string;                    // "Discord" | "GitHub": used in page text
  grants: string;                   // consent-page sentence saying what is being granted
  configProblem(env: E): string | null;   // mistakes to catch before sending anyone upstream
  pkce(env: E): boolean;            // Discord: env.DISCORD_OAUTH_PKCE === "true"; GitHub: always
  authorizeUrl(env: E, p: { redirectUri: string; state: string; challenge?: string }): string;
  exchange(env: E, p: { code: string; redirectUri: string; verifier?: string },
           ctx: { waitUntil(p: Promise<unknown>): void }, fetchImpl: typeof fetch,
  ): Promise<{ ok: true; userId: string; props: P } | { ok: false; status: number; message: string }>;
  isAllowed(env: E, props: P): boolean;   // run at sign-in and again on every MCP request
  refusal(props: P): string;        // the refusal page's sentence for an account that is not allowed
}
```

`exchange` trades the code for an identity and revokes the user token in `waitUntil`, as
both do now. Discord's `Feed` keeps calling its own provider's `exchange` for mailroom's
`/signin` route, so the client secret still never leaves the broker.

### `createBroker`

```ts
createBroker<E extends BaseEnv, P, C>({
  name, title,            // "discord-broker", "Discord broker"
  instructions,
  signIn,                 // SignInProvider<E, P>
  tools, call,            // the broker's TOOLS and callTool
  context(env, user),     // builds the broker's ToolContext; may throw "X is not set"
})
```

`BaseEnv` is `{ OAUTH_KV; PUBLIC_URL; ALLOWED_ORIGINS?; DISABLE_CIMD? }`. A broker's
`index.ts` shrinks to this call plus `export { Feed }`.

## What stays in each broker

The API client (`discord/`, `github/`), `tools.ts` (the `TOOLS` list, its helpers and
`callTool` with that broker's audit fields), `env.ts`, the sign-in provider, `feed.ts`
(its routes and rules), the fakes and broker-specific tests, `README.md`, the wrangler
files.

## Drift, settled

| Behaviour | Today | After |
|---|---|---|
| `DISABLE_CIMD` switch and the page for an unfetchable client metadata document | Discord only | both (core) |
| Top-level catch that logs `unhandled` and answers 500 | Discord only | both (core) |
| `oauth_endpoint` log line for library-served endpoints | Discord only | both (core) |
| Log lines `authorize_error`, `authorize_exception`, `sign_in_cancelled`, `config_error` | Discord only | both (core) |
| Config check before redirecting upstream | Discord only | both; GitHub's checks client ID present, allowlist non-empty, client secret set |
| `validateArgs` integer `minimum` / `maximum` | Discord only | both (core) |
| `Feed` audit line | Discord lacks `method` | both `{ event, method, path, status, ms }` |
| `Feed` on an unexpected exception | Discord echoes the message in the body | both: generic body, message goes to the log line only |
| `VERSION` | one constant per broker, in different files | one, in core, checked against `package.json` |

The audit line's keys are written in exactly that order (GitHub's test asserts it). Only
people read these lines, in `wrangler tail`; nothing parses them.

The config check runs where Discord's runs now: on `POST /authorize`, after consent is
approved and before the redirect upstream. It answers with the error page and status 500.

One version everywhere: the root and all three packages' `package.json` say 0.3.0, and
core's `VERSION` is checked against the root one. It is what the `/` banner, MCP
`serverInfo.version` and Discord's User-Agent report.

"Never echo" covers exceptions only. Upstream HTTP answers the `Feed` passes through, and
the `Feed`'s own authored refusals (bad path, outside the allowlist, read-only, and the
`{ ok: false, status, message }` a sign-in `exchange` returns) are unchanged, with the
same status codes and text. For a `DiscordError` raised
inside the Discord `Feed`, the upstream status code is kept and the body becomes generic.
Mailroom reads `Feed` error bodies only into its own logs, so this changes no behaviour
there.

## The live Workers

Four, all on one Cloudflare account, all running the same code as their sibling:

| Worker | Config | Used by |
|---|---|---|
| `discord-broker` | `brokers/discord/wrangler.jsonc`, top level | Claude |
| `discord-broker-manus` | same file, `env.manus` | Manus |
| `github-broker` | `brokers/github/wrangler.jsonc`, top level | Claude |
| `github-broker-manus` | same file, `env.manus` | Manus |

Each has its own name, URL, `OAUTH_KV` namespace, vars and secrets; the `manus` environment
differs from the top level in values only. Core therefore reads everything from `env` per
request and holds no configuration of its own. The OAuth roles are cached per isolate keyed
on `PUBLIC_URL` and `DISABLE_CIMD`, as Discord does now.

The real `wrangler.jsonc` files exist only on Lothrop's machine, in the old checkouts at
`~/projects/discord-broker` and `~/projects/github-broker`. Everything that needs them
(copying them in, the bundle comparison, deploying, verifying) is done by the session
driving this work, on that machine, not by an implementer working from the repository
alone. Lothrop has authorised that session to merge and deploy.

## Delivery

Two pull requests, so a layout problem can never be confused with a code problem. The
second starts only after the first has been deployed and verified.

1. **Workspace layout, no source change.** Root `package.json`, one lockfile, shared
   tsconfig and vitest settings, CI. Check: both test suites pass, and
   `wrangler deploy --dry-run --outdir` produces the same bundle as the old repository for
   each broker. "Same" means identical once the module-path comments esbuild writes are
   set aside; any difference in actual code has to be explained (a dependency resolved to
   a different version, say) before going on. After merge, deploy all four Workers from
   here unchanged and verify. This deploy is required, not optional: it proves the layout
   before any code moves. No version bump (nothing shipped changes).
2. **Core extraction and drift (0.3.0).** One module at a time, tests green after each,
   new behaviour test-first. After merge: deploy all four, verify, tag `v0.3.0`, release.

Verification after each deploy: the `/` banner and OAuth metadata on all four Workers; an
MCP tool call through the already-connected Claude connectors (proves stored sign-ins
survived); `feed` log lines with status 200 from mailroom's polling on all four.

Afterwards: a pointer in each old repository's README, then archive both; fix the two
links in mailroom's README; the old `v0.2.0` tags stay in the archived repositories and are
not copied here.

Rollback at any point: `wrangler rollback` per Worker. The old checkouts stay on disk
until 0.3.0 has been live and quiet.

## My calls (not discussed; say if any is wrong)

- **CI is added** (`npm ci`, typecheck, tests, on pull requests and master). Neither old
  repository had any; with the sign-in flow now shared, an unchecked change breaks both
  brokers at once.
- **History** was imported by merging the two original histories, so the original commits
  and their signatures are intact; files were then moved in one commit per broker.
- **No root "deploy everything" script.** The environments (`manus`) exist only in the
  ignored config, so the deploy stays `npx wrangler deploy [--env manus]` run in a
  broker's directory, documented in the README.
- **Core's package name** is `broker-core`; it is private and never published.
- GitHub's grant metadata gains the `id` beside `login` (core stores the whole props
  object as metadata). Display-only; existing grants are unaffected.

## Left to the builder

- How `VERSION` is tied to `package.json` (import or a test that fails on mismatch).
- The exact file split inside `packages/core/src` and how vitest settings are shared.
- Wording of GitHub's new config-check messages.
- Whether broker tests that are near-copies (`mcp.test.ts`) move to core against a tiny
  fake tool list, keeping one smoke test per broker.
