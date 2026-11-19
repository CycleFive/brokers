import { fileURLToPath } from "node:url";
import type { UserConfig } from "vitest/config";

// Vitest settings every package shares: the workerd-only `cloudflare:workers` module is aliased to a Node stand-in.
export function brokerVitest(): UserConfig {
  return {
    resolve: {
      alias: { "cloudflare:workers": fileURLToPath(new URL("./packages/core/test-support/cloudflare-workers.ts", import.meta.url)) },
    },
    test: {
      include: ["test/**/*.test.ts"],
      environment: "node",
      server: { deps: { inline: ["@cloudflare/workers-oauth-provider"] } },
    },
  };
}
