# Feed Search Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The GitHub broker's internal `Feed` also answers `GET /api/search/issues`, so mailroom can find labelled items across an organisation.

**Architecture:** One more allowed path in `brokers/github/src/feed.ts`, checked the same way `/repos/` is (on the path as GitHub will resolve it). Nothing else outside `/repos/` is opened.

**Tech Stack:** TypeScript, vitest, the existing `handleFeed` tests with `fake-github.ts`.

**Spec:** `CycleFive/mailroom` `docs/superpowers/specs/2026-11-20-label-claims-design.md`, section "Broker" (the text: "`Feed` of the GitHub broker allows `GET /api/search/issues` besides `/api/repos/...`. Nothing else outside `/repos/` is opened. The installation token already limits a search to what the app can read.")

## Global Constraints

- `Feed` stays read-only: only `GET`.
- Allowed upstream paths: anything under `/repos/`, and exactly `/search/issues`. `/search/code`, `/search/issues/x`, `/search`, `/installation/repositories` and every other path stay refused with 403.
- The refusal body becomes exactly `{"error": "feed reads /repos/ paths and /search/issues only"}`.
- The query string is passed through unchanged, as for `/repos/`.
- A caught exception still never reaches the response body.
- Version 0.5.0 in `packages/core/src/version.ts` and every `package.json`; `package-lock.json` changes only in this repository's own version fields.
- No change to any MCP tool, to the Discord broker's behaviour, or to `packages/mailbox`.
- Never read, create or commit `wrangler.jsonc`, `wrangler.<name>.jsonc`, `mailboxes.jsonc`, `.dev.vars` or `*.pem`; never run wrangler against the account or `npm run mailbox -- render|deploy|status`.
- Every commit message ends with exactly this trailer and no other `Co-Authored-By` line: `Co-Authored-By: Claude & Lothrop (cycle.five@proton.me)`
- Write each test first and see it fail; the report quotes the failing run.

## Review Focus

1. A path that looks like the search but resolves elsewhere (`/search/issues/../../user`, `/search/%69ssues/../code`, a doubled slash): refused, or resolved to exactly `/search/issues`, never to another endpoint.

---

### Task 1: Allow `/search/issues` and release 0.5.0

**Files:**
- Modify: `brokers/github/src/feed.ts`, `brokers/github/test/feed.test.ts`
- Modify: `brokers/github/README.md` (the "Internal feed (for mailroom)" table and prose)
- Modify: `packages/core/src/version.ts`, `packages/core/test/version.test.ts`, every `package.json`, `package-lock.json`

**Interfaces:**
- Produces: `GET /api/search/issues?<query>` on the GitHub broker's `Feed` answers with the upstream status and JSON body of `GET /search/issues?<query>`; mailroom's `FeedClient` calls it as `get("/search/issues", query)`.

- [ ] **Step 1: Write the failing tests** in `brokers/github/test/feed.test.ts`

```ts
it("passes a search of issues through with its query", ...)
// GET /api/search/issues?q=org%3AX+label%3A%22a%22&per_page=100 -> 200 with the fake's body; the upstream request went to
// /search/issues and carried q and per_page unchanged
it("refuses every other path outside /repos/ with the new message", ...)
// /api/search/code, /api/search, /api/search/issues/1, /api/installation/repositories, /api/user:
// each 403 with body { error: "feed reads /repos/ paths and /search/issues only" }
it("refuses a search path that resolves elsewhere", ...)
// /api/search/issues/../code, /api/search/issues/..%2F..%2Fuser, /api/search//issues, /api/search/%69ssues/../code:
// each is 400 or 403, and no upstream request is made for any of them
it("refuses a non-GET search", ...)   // POST /api/search/issues -> 405 { error: "feed is read-only" }
```

Update the existing assertion that expects the old refusal text.

- [ ] **Step 2: Run and see them fail** — `npm test -w github-broker`.
- [ ] **Step 3: Implement** in `feed.ts`: allowed when the normalised target and the pathname GitHub will resolve are both under `/repos/`, or both exactly `/search/issues`.
- [ ] **Step 4: Version 0.5.0** (constant, five `package.json` files, the version test's literal, `npm install` for the lockfile) and the README.
- [ ] **Step 5: Run** `npm run typecheck && npm test` at the root. Expected: PASS.
- [ ] **Step 6: Commit** — `git commit -m "feat(github): Feed answers /search/issues (0.5.0)"`
