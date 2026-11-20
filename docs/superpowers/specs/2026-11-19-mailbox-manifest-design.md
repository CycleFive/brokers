# A manifest of mailboxes, and one command that deploys them

Date: 2026-11-19. Status: approved in conversation ("I agree with your recommendation,
you have a go to build that out"); written down here as the record the plan is built from.

## Intent

A *mailbox* is one agent's set of things: its own copy of every broker (its own Discord
bot, its own GitHub App) and its entry in mailroom. Lothrop expects to add mailboxes
often. Today a mailbox exists nowhere as one thing. It is an `env` block copied by hand
into each broker's git-ignored `wrangler.jsonc`, two service bindings and an entry in
mailroom's git-ignored config in another repository, two KV namespaces and four secrets
made by hand, and its name typed about nine times with nothing checking they agree. A
broker release is 2×N deploys and 2×N checks by hand.

The design makes the mailbox the unit: one manifest entry per mailbox, and one tool that
generates every config from it, deploys and verifies.

## Goals

1. One file, the manifest, holds everything that is not a secret about every mailbox.
2. Adding a mailbox is: write its entry, run one command, type its secrets when asked.
3. A broker release is one command for every copy, verified.
4. New mailboxes get hostnames on a domain Lothrop owns (`botnet-filref.com`), so the
   address no longer names the Worker behind it and the Worker topology can change later
   without clients reconnecting.
5. The tool knows nothing about any particular broker or about mailroom's source types:
   a third broker needs no change to it.

## Non-goals

- Moving the four live Workers to new hostnames. They keep their `workers.dev` addresses.
- Creating Discord applications or GitHub Apps. (GitHub's manifest flow could do the
  GitHub half later.)
- A shared multi-tenant broker, Workers for Platforms, parallel deploys, or a manifest in
  anything but one local file.
- Changing any Worker's behaviour. The only change inside a Worker is the version number.

## Anti-goals

- A deploy of an existing mailbox that silently points it at a new, empty KV namespace
  (everyone signed out) or drops a variable. Generated config for the live mailboxes must
  be shown equal to what is deployed before it is used.
- The tool reading, printing or storing a secret value. It only knows secret *names*.
- Renaming a live Worker, hostname or mailroom binding as a side effect of adopting the
  tool. Mailroom keys its read positions by binding name, so a rename loses them.

## Constraints

- Wrangler 4.157: one config file is one Worker (plus `env` blocks, which do not inherit
  `vars` or KV). `wrangler deploy -c <file>` deploys any config file; `main` resolves
  relative to that file.
- Secrets are per Worker, set with `wrangler secret put`. `wrangler secret list` prints
  `[{"name": "...", "type": "secret_text"}]`; for a Worker that does not exist it prints
  an error containing `not found`.
- A Worker's first deploy on this account can fail with `[code: 10007]`; the same deploy
  succeeds when repeated.
- A custom domain needs the zone on the same Cloudflare account as the Worker
  (`botnet-filref.com` is, on Enterprise) and is declared as
  `"routes": [{ "pattern": "<host>", "custom_domain": true }]`.
- Mailroom lives in another repository. Its Worker config is
  `<mailroom>/crates/worker/wrangler.jsonc`, git-ignored, next to a committed
  `wrangler.example.jsonc`. An agent there is `{ signin, sources }` and each source names
  its broker by service-binding name.
- The repository is public, so the manifest (allowlists, channel IDs) is not committed
  here. The agents' GitHub App has write access to every repository of the `CycleFive`
  organisation, and the manifest decides who may sign in to each broker, so it must not
  live where the agents can write.

## Approaches

1. **Manifest plus generator, a copy per mailbox (chosen).** Keeps each mailbox's
   credentials and token store in its own Worker; needs no migration; the manifest would
   feed either of the other two later.
2. **One Worker per broker serving every mailbox.** Two deploys per release whatever N
   is, but every mailbox's credentials in one Worker, a per-Worker cap of 64/128
   variables (secrets included), new addresses for every client, and a rewrite of the
   router, sign-in state and `Feed`.
3. **Workers for Platforms.** Copies without the 100/500 Workers-per-account cap; a paid
   add-on with a dispatcher in front. Not needed until the cap is near.

Lothrop picked 1, with own-domain hostnames for new mailboxes.

## The design

### The manifest

`mailboxes.jsonc` (JSON with comments). The tool reads the path given by `--manifest`,
else the `MAILBOXES` environment variable, else `./mailboxes.jsonc` at the repository
root (git-ignored). A committed `mailboxes.example.jsonc` documents it.

```jsonc
{
  // Hostname of a broker copy that gives no "url".
  "hostname": "{mailbox}-{broker}.workers.botnet-filref.com",
  // Optional. Without it the tool manages brokers only.
  "mailroom": {
    "dir": "../mailroom/crates/worker",   // relative to this file
    "url": "https://mailroom.example.workers.dev",
    "retain_days": 30
  },
  // Named lists. The string "$lists.<name>" anywhere under "mailboxes" stands for one.
  "lists": { "repos": ["org/a", "org/b"] },
  "mailboxes": {
    "manus": {
      "brokers": {
        "discord": {
          "vars": { "DISCORD_CLIENT_ID": "1", "ALLOWED_DISCORD_USERS": "2" }
          // Optional, to pin what already exists:
          //   "worker":  default "<example name>-<mailbox>", e.g. discord-broker-manus
          //   "url":     default https://<hostname with {mailbox} and {broker} filled in>
          //   "kv":      namespace id; default the namespace titled "<worker>-oauth", created when missing
          //   "binding": mailroom's service binding; default <BROKER>_<MAILBOX>, e.g. DISCORD_MANUS
        },
        "github": { "vars": { "GITHUB_APP_CLIENT_ID": "x", "GITHUB_INSTALLATION_ID": "3", "ALLOWED_GITHUB_USERS": "4" } }
      },
      // Optional: this mailbox's mailroom entry. "signin" and each source's "broker" name a
      // broker of this mailbox; every other key of a source is passed to mailroom untouched.
      "mail": {
        "signin": "discord",
        "sources": [
          { "type": "discord", "broker": "discord", "channels": ["5"] },
          { "type": "github", "broker": "github", "repos": "$lists.repos", "keep": "tagged" }
        ]
      }
    }
  }
}
```

### What each broker contributes

A broker is a directory `brokers/<name>` with a `wrangler.example.jsonc`. The tool takes
everything broker-specific from that file:

- its `name` (`discord-broker`) is the service name in the banner and the stem of the
  default Worker name;
- the keys of its `vars` are the only variables a mailbox may set; a key whose example
  value is `""` is optional and defaults to `""`, any other is required; `PUBLIC_URL` is
  always set by the tool;
- `"secrets": { "required": [...] }` (a wrangler config key, added to both examples) lists
  the secret names;
- everything else (`main`, compatibility date and flags, observability) is copied.

### Generated files

- `brokers/<broker>/wrangler.<mailbox>.jsonc` per copy, git-ignored: the example with
  `name`, `vars`, the KV id and, for a hostname that is not `*.workers.dev`,
  `routes` (custom domain), `workers_dev: false` and `preview_urls: false`.
- `<mailroom dir>/wrangler.jsonc`: mailroom's own `wrangler.example.jsonc` with
  `services` and `vars.MAILROOM` replaced from the manifest and `$schema` removed.

Both start with a comment saying they are generated and from which manifest. The
hand-kept `brokers/*/wrangler.jsonc` is retired once the manifest is shown equal to it.

### Commands

`npm run mailbox -- <command> [mailbox...] [--manifest <path>] [--mailroom] [--no-input]`

| Command | Does |
| --- | --- |
| `check` | Validates the manifest against the broker examples. Offline. |
| `render` | Writes every generated file, deploys nothing. Looks KV ids up, creates none. |
| `deploy` | For each copy of the named mailboxes (default all): make sure the KV namespace exists, write the config, deploy (once more on code 10007), list missing secrets and, at a terminal, hand each to `wrangler secret put`, then verify. With `--mailroom`, afterwards write mailroom's config and deploy `mailroom-core`. Ends with the addresses and redirect URLs still to be entered by hand. |
| `status` | For every copy: deployed version from the banner, issuer, missing secrets. Read-only. |

Verify means: `GET <url>/` starts with `<example name> <version>:` and
`GET <url>/.well-known/oauth-authorization-server` has `issuer` equal to `<url>`, retried
for up to two minutes because a new custom domain takes time to come up.

The command exits non-zero when any copy failed to deploy, failed verification or lacks
a secret.

### Where the tool lives

`packages/mailbox`, a workspace package in TypeScript run directly by Node (type
stripping, Node 22.18 or later). Wrangler is driven through one injected `run` function
and HTTP through an injected `fetch`, so the orchestration is tested without an account.

## My calls

- **A hostname per broker per mailbox** (`manus-discord.workers.botnet-filref.com`), not
  one per mailbox (`manus.workers.botnet-filref.com`) with brokers on paths. A path would
  put a path in the OAuth issuer, which neither the brokers' router nor the clients have
  been tried with; a hostname needs no Worker change. The pattern is one line of the
  manifest and can change until the first mailbox uses it.
- **KV namespaces are found by title, not auto-provisioned.** Wrangler can create a
  namespace when the id is left out, but I have not seen what it does on a second deploy,
  and a wrong guess signs everyone out.
- **The manifest is a local file in its own local git repository** (`~/projects/mailboxes`),
  with no remote. Where to push it is Lothrop's decision; not `CycleFive`.
- **`deploy` covers both adding and releasing**; `--mailroom` is explicit rather than
  inferred from a diff.
- **Sources name brokers of their own mailbox only.** Sharing one broker between
  mailboxes is no longer done live.
- **Version 0.4.0**, and the version test finds every `package.json` itself.
- **JSONC is read with `jsonc-parser`**; generated files lose the example's inner comments.

## Left to the builder

File layout inside `packages/mailbox`, error wording, the look of the tables the commands
print.
