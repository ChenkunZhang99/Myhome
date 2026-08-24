import vinext from "vinext";
import { defineConfig } from "vite";

export default defineConfig(async () => {
  const integrationTest = process.env.HSP_INTEGRATION_TEST === "1";
  const integrationState = process.env.HSP_INTEGRATION_STATE?.trim();

  // Keep Wrangler and Miniflare state project-local. These are non-secret tool
  // settings; application environment belongs in ignored `.env*` files.
  process.env.WRANGLER_WRITE_LOGS ??= "false";
  process.env.WRANGLER_LOG_PATH ??= ".wrangler/logs";
  process.env.MINIFLARE_REGISTRY_PATH ??= ".wrangler/registry";

  // Wrangler snapshots its log path while the Cloudflare plugin is imported.
  const { cloudflare } = await import("@cloudflare/vite-plugin");

  return {
    plugins: [
      vinext(),
      // Bindings are read from wrangler.jsonc. During `npm run dev` they are
      // simulated by Miniflare against local files, so no Cloudflare account
      // and no real database id are required.
      cloudflare({
        // HTTP integration tests must never reuse the normal local D1/R2 state
        // or the production-shaped Wrangler configuration. The runner gives
        // every invocation a fresh temporary directory and a config with no
        // OpenAI secret binding.
        configPath: integrationTest ? "./tests/integration/wrangler.jsonc" : undefined,
        persistState: integrationState ? { path: integrationState } : undefined,
        viteEnvironment: { name: "rsc", childEnvironments: ["ssr"] },
      }),
    ],
  };
});
