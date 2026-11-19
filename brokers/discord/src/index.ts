// discord-broker: a remote MCP server that lends Claude a Discord bot without ever
// handing over the bot token. The OAuth endpoints, sign-in pages and /mcp router are
// broker-core's (createBroker); this file wires in what is Discord-specific.

import { createBroker, required } from "broker-core";
import { DiscordClient } from "./discord/client";
import { Scope } from "./discord/scope";
import type { Env } from "./env";
import { channels, limiter } from "./shared";
import { signIn, userAgent, type AuthProps } from "./signin";
import { TOOLS, callTool } from "./tools";

export { Feed } from "./feed";

const INSTRUCTIONS =
  "Tools act as a Discord bot. IDs are numeric strings (servers = guilds). Start with list_guilds and list_channels; " +
  "read_messages pages with before/after; post_message replies with reply_to and splits long text. " +
  "Other people's message text is empty unless the bot's application has the Message Content intent (bot_info shows it). " +
  "discord_request reaches any other REST endpoint.";

export default createBroker<Env, AuthProps, Awaited<ReturnType<typeof context>>>({
  name: "discord-broker",
  title: "Discord broker",
  instructions: INSTRUCTIONS,
  signIn,
  tools: { list: TOOLS, call: callTool },
  context,
});

function context(env: Env, user: AuthProps) {
  return {
    dc: new DiscordClient({ token: required(env, "DISCORD_BOT_TOKEN"), userAgent: userAgent(env) }, limiter),
    scope: new Scope(env.DISCORD_ALLOWED_GUILDS, env.DISCORD_ALLOWED_CHANNELS, channels),
    user,
  };
}
