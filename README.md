# brokers

A broker is a remote MCP server on Cloudflare Workers that lends an MCP client (Claude) one
upstream account, a Discord bot or a GitHub App installation, behind an OAuth sign-in and an
allowlist, without ever exposing the upstream token or key.

| Broker | What it brokers |
| --- | --- |
| [`brokers/discord`](brokers/discord/README.md) | a Discord bot |
| [`brokers/github`](brokers/github/README.md) | a GitHub App installation |

## Layout

```
brokers/discord   Discord broker Worker
brokers/github    GitHub broker Worker
packages/core     broker-core: code both brokers share
packages/mailbox  the mailbox tool: renders configs from a manifest, deploys, verifies
```

One npm workspace; `npm install` at the root installs everything.

## What is shared

`packages/core` (`broker-core`) holds what both brokers use: the utilities (`publicUrl`, `required`, `base64url`) and `VERSION`; the tool types with `ToolInputError`, `validateArgs` and `truncate`; the MCP server; the sign-in flow and its pages; `createBroker`, the request router; the two `Feed` helpers; and, under `broker-core/testing`, the in-memory KV and sign-in driver the tests use. `vitest.shared.ts` holds the test settings every package shares, including the Node stand-in for `cloudflare:workers`. Every `package.json` states the same version, and a core test checks that.

## Commands

```sh
npm install
npm run typecheck   # core and both brokers
npm test            # core and both brokers
```

## Mailboxes

A mailbox is one agent's own copy of each broker (its own Worker, KV namespace, upstream
application and allowlist), plus its entry in the separate
[mailroom](https://github.com/CycleFive/mailroom) service. One manifest describes every
mailbox, and `npm run mailbox` generates each wrangler config from it, deploys and verifies.
It needs Node 22.18 or later, because it runs TypeScript directly.

### The manifest

Copy [`mailboxes.example.jsonc`](mailboxes.example.jsonc) to `mailboxes.jsonc` and fill it in.
The example comments every key. The tool looks for the manifest in this order:

1. `--manifest <path>`
2. the `MAILBOXES` environment variable
3. `mailboxes.jsonc` at the repository root (git-ignored; a symlink to a file kept elsewhere works)

The manifest holds no secret, but it decides who may sign in to each broker. Keep it out of
this public repository, and out of anywhere the brokered agents themselves can write.

### Commands

```sh
npm run mailbox -- <command> [mailbox...] [--manifest <path>] [--mailroom] [--allow-change] [--no-input]
```

Name one or more mailboxes to act on only those; name none to act on all of them.

| Command | What it does |
| --- | --- |
| `check` | Validates the manifest, including mailroom's part (its directory, its example and that some mailbox has `mail`), and prints each copy's mailbox, broker, Worker name and URL. Changes nothing. |
| `render` | Writes each broker's generated `wrangler.<mailbox>.jsonc`, and `wrangler.jsonc` in mailroom's directory when the manifest has a `mailroom` entry and no mailbox is named. Needs a logged-in wrangler, because it lists your KV namespaces. It skips, and says so, a copy whose KV namespace does not exist yet (the first `deploy` creates it), and then exits 1. |
| `deploy` | Creates a missing KV namespace, renders, deploys each copy, checks that its secrets are set, then verifies the running Worker (version and sign-in issuer). Prints the addresses to enter on the upstream applications. With `--mailroom`, then deploys `mailroom-core`: see below. |
| `status` | Reads each copy's secrets and running version without deploying, and exits 1 if anything is missing or unverified. |

`--no-input` stops `deploy` from prompting for missing secrets; it prints the
`wrangler secret put` commands instead. It does the same when there is no terminal.

`deploy --mailroom` deploys mailroom only when every chosen copy succeeded (deployed, no
missing secret, verified), and always with the entry of every mailbox in the manifest, not
only the chosen ones. So every mailbox with `mail` must already be deployed; otherwise
mailroom's own deploy fails and changes nothing. `--mailroom` is only for `deploy`, and it is
an error when the manifest has no `mailroom` entry. `check` validates the mailroom part, so
run it first.

**"this would change ... run again with --allow-change".** The tool refuses to overwrite a
generated `wrangler.<mailbox>.jsonc` whose Worker name, KV namespace or `PUBLIC_URL` differs
from what it is about to write, and refuses to rename a binding in mailroom's `wrangler.jsonc`
(mailroom would lose its read positions). Both usually mean the manifest was edited by
mistake. If the change is intended, run the same command again with `--allow-change`.

Check a manifest without touching Cloudflare: `npm run mailbox -- check --manifest mailboxes.example.jsonc`.

### Adding a mailbox

1. Create the upstream applications: a Discord application and a GitHub App, as each
   broker's README describes in its Setup step 1.
2. Add the mailbox to `mailboxes.jsonc`, with each broker's `vars` and, if agents read its
   mail, a `mail` entry. Run `npm run mailbox -- check` to see the names and URLs it will use.
3. Run `npm run mailbox -- deploy <name> --mailroom`. It creates each Worker and its KV
   namespace, asks for each secret (type them when it does), deploys and verifies each copy,
   then deploys mailroom with every mailbox's entry. A new hostname takes a few minutes to
   get its DNS record and certificate; the command waits up to ten minutes for it.
4. Enter what the command prints: on the Discord application and the GitHub App, each
   copy's redirect (`<url>/callback`); on mailroom's sign-in application, mailroom's redirect
   (`<mailroom url>/callback`); and connect each copy's `<url>/mcp` and mailroom's
   `<mailroom url>/<mailbox>/mcp` as connectors in the agent's client.

Run `npm run mailbox -- status <name>` afterwards to confirm everything verifies.

An existing copy, deployed before you used the manifest, must pin its `kv` id, and its
`worker`, `url` and `binding` wherever they differ from the defaults. The tool refuses to
create a KV namespace for a Worker that already exists, because an empty namespace signs
everyone out. Mailroom keys its read positions by binding name, so keep the existing `binding`.
The first time the tool writes mailroom's `wrangler.jsonc` over a hand-written one, it keeps
the old file once as `wrangler.jsonc.bak`.

A `hostname` that is not `*.workers.dev` becomes a Cloudflare custom domain. Its zone must be
on the same Cloudflare account as the Worker. The Worker then has no `workers.dev` address.

### Releasing

Run `npm run mailbox -- deploy` to deploy every broker copy of every mailbox. To try a
release on one copy first, run `npm run mailbox -- deploy <name>`, check it, then run the
full command.

### One copy, no manifest

Someone running a single copy can skip all of this: copy a broker's `wrangler.example.jsonc`
to `wrangler.jsonc` (git-ignored) and run `npx wrangler deploy` in the broker's directory.
Each broker's README walks through it.

## Adding a broker

Make a directory `brokers/<name>` with:

- `package.json` and `tsconfig.json`, copied from an existing broker
- `vitest.config.ts`
- `wrangler.example.jsonc`, with `vars` (which must contain `PUBLIC_URL`) and one
  `kv_namespaces` entry, and no `secrets` key; its `"name"` must equal the name you give
  `createBroker`, because verification reads the service name from the banner
- in `package.json`, `"broker": { "secrets": [...] }` naming the secrets the mailbox tool must
  find set (wrangler refuses to deploy a config that requires secrets before they exist, and a
  new Worker cannot have secrets until it is deployed, so they cannot go in the example)
- `src/index.ts`, which calls `createBroker`

The mailbox tool and CI find the new broker with no change. Mailroom does not read its
`Feed` until mailroom gains a source type for it.
