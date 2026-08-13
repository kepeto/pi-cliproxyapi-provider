import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { DEFAULT_CONFIG, loadConfig } from "../src/config.ts";
import { ProviderCatalog } from "../src/catalog.ts";
import { ProviderRuntime } from "../src/runtime.ts";
import { buildProviderRegistration } from "../src/registration.ts";
import { buildUnavailableProviderModels } from "../src/provider.ts";
import { registerCliproxyapiCommand } from "../src/commands.ts";
import { getDiscoveryApiKey } from "../src/auth.ts";
import { loadProviderSettings } from "../src/settings.ts";
import { registerCodexCompatiblePayloadAdapter } from "../src/codex-compat.ts";

const extensionDir = dirname(fileURLToPath(import.meta.url));
const packageRoot = dirname(extensionDir);
const bundledModelsDevPath = join(packageRoot, "data", "models-dev-fallback.json");

export default async function (pi: ExtensionAPI) {
  let config = DEFAULT_CONFIG;
  try {
    const cwd = process.cwd();
    config = loadConfig(cwd);
    const settings = loadProviderSettings(cwd);
    const catalog = new ProviderCatalog({
      config,
      gpt56ContextWindow: settings.gpt56ContextWindow,
      bundledModelsDevPath,
      getApiKey: () => getDiscoveryApiKey(config.providerName),
    });
    const runtime = new ProviderRuntime({ pi, config, catalog });
    registerCodexCompatiblePayloadAdapter(pi, config.providerName);
    registerCliproxyapiCommand(pi, runtime, catalog);

    // Boot discovery: fetch models directly instead of waiting for omp's
    // refreshModels hook (which omp 17.3.x does not trigger with network/credential).
    const keyFn = () => getDiscoveryApiKey(config.providerName);
    try {
      await catalog.refresh("models", "manual", keyFn);
    } catch (e) {
      console.warn(`[pi-cliproxyapi-provider] boot model refresh failed: ${e instanceof Error ? e.message : String(e)}`);
    }

    pi.on("session_start", async () => {
      const snapshot = catalog.current();
      if (snapshot && snapshot.built.models.length > 0) return;
      try {
        await catalog.refresh("models", "manual", keyFn);
      } catch {
        // ignore — keep cached/placeholder models
      }
    });

    await runtime.start();
  } catch (error) {
    registerCodexCompatiblePayloadAdapter(pi, config.providerName);
    registerCliproxyapiCommand(pi);
    pi.registerProvider(config.providerName, buildProviderRegistration(config, buildUnavailableProviderModels()).config);
    console.warn(`[pi-cliproxyapi-provider] registered placeholder provider after startup failure: ${error instanceof Error ? error.message : String(error)}`);
  }
}
