// github-broker: a remote MCP server that lends Claude a GitHub App installation
// without ever handing over the app's private key. The OAuth endpoints, sign-in pages and
// /mcp router are broker-core's (createBroker); this file wires in what is GitHub-specific.

import { createBroker, required } from "broker-core";
import type { Env } from "./env";
import { tokens } from "./github/app";
import { GitHubClient } from "./github/client";
import { signIn, type AuthProps } from "./signin";
import { TOOLS, callTool } from "./tools";

export { Feed } from "./feed";

const INSTRUCTIONS =
  "Tools act as a GitHub App installation, with whatever permissions the app was granted (installation_info shows them). " +
  'Pass repositories as "OWNER/NAME" (or NAME when a default owner is configured). ' +
  "commit_files makes one commit with any number of file changes and never force-pushes. " +
  "github_request reaches any other REST endpoint.";

export default createBroker<Env, AuthProps, Awaited<ReturnType<typeof context>>>({
  name: "github-broker",
  title: "GitHub broker",
  instructions: INSTRUCTIONS,
  signIn,
  tools: { list: TOOLS, call: callTool },
  context,
});

function context(env: Env, user: AuthProps) {
  return {
    gh: new GitHubClient(
      {
        issuer: required(env, "GITHUB_APP_CLIENT_ID"),
        installationId: required(env, "GITHUB_INSTALLATION_ID"),
        privateKeyPem: required(env, "GITHUB_APP_PRIVATE_KEY"),
      },
      tokens,
    ),
    defaultOwner: env.GITHUB_DEFAULT_OWNER || undefined,
    user,
  };
}
