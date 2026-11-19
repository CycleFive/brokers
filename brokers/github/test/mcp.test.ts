// The real MCP SDK client against this broker's real tools. Protocol cases live in broker-core.

import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { describe, expect, it, vi } from "vitest";
import { handleMcp } from "broker-core";
import { TOOLS, callTool } from "../src/tools";
import { fakeGitHub, toolContext } from "./fake-github";

vi.spyOn(console, "log").mockImplementation(() => {});

const URL_ = "https://broker.test/mcp";
const opts = { serverInfo: { name: "github-broker", version: "0.0.0-test" }, instructions: "test" };

function serverFetch() {
  const gh = fakeGitHub();
  const ctx = toolContext(gh.fetchImpl);
  const f = async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    return handleMcp(req, { list: TOOLS, call: callTool }, () => ctx, opts);
  };
  return f as typeof fetch;
}

it("the MCP client lists the tools and calls a real one", async () => {
  const client = new Client({ name: "t", version: "1" });
  await client.connect(new StreamableHTTPClientTransport(new URL(URL_), { fetch: serverFetch() }));
  const tools = await client.listTools();
  expect(tools.tools.map((t) => t.name)).toEqual(TOOLS.map((t) => t.name));
  const res: any = await client.callTool({ name: "installation_info", arguments: {} });
  expect(res.isError).toBe(false);
  expect(res.content[0].text).toContain("workflows");
  const bad: any = await client.callTool({ name: "list_prs", arguments: {} });
  expect(bad.isError).toBe(true);
  await client.close();
});
