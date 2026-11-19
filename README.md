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
packages/         shared packages (none yet)
```

One npm workspace; `npm install` at the root installs everything.

## Commands

```sh
npm install
npm run typecheck   # both brokers
npm test            # both brokers
```

## Deploying

Run `npx wrangler deploy` inside a broker's directory (add `--env <name>` for an extra
environment). Each broker's `wrangler.jsonc` is git-ignored; copy it from
`wrangler.example.jsonc` and fill it in.
