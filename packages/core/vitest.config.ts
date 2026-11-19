import { defineConfig, mergeConfig } from "vitest/config";
import { brokerVitest } from "../../vitest.shared";

export default defineConfig(mergeConfig(brokerVitest(), { test: { setupFiles: ["./test-support/workers-flags.ts"] } }));
